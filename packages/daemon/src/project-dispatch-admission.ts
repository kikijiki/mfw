import { createHash } from "node:crypto";
import type { ProjectDbHandle } from "@mfw/db/client";
import { appendEvent, type EventBus } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import {
	type DispatchAdmissionState,
	type DispatchCompensationTarget,
	dispatchAdmissions,
} from "@mfw/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { ResolvedExecutionTarget } from "./execution-target.ts";
import type {
	HostAdmissionSnapshot,
	HostHoldDiagnostic,
	HostLease,
	HostRequirement,
	HostResourceCoordinatorPort,
	HostResourceReadModel,
	Waiter,
} from "./host-resources/index.ts";
import {
	parseIecBytes,
	parseIntegerQuantity,
	QuantityParseError,
} from "./host-resources/quantity.ts";
import type { Logger } from "./log.ts";
import type { ProjectResourceSlots } from "./project-resource-slots.ts";
import type { RunEngine, TaskDispatchAdmissionPort } from "./run-engine.ts";
import type { RunRegistry } from "./run-registry.ts";
import type { StatusActor, TaskService } from "./task-service.ts";

export type AdmissionRecord = typeof dispatchAdmissions.$inferSelect;
type AdmissionRow = AdmissionRecord;
type AuthoredHostRequirement = {
	resourceId: string;
	amount?: number | string;
};

const OPEN_STATES: DispatchAdmissionState[] = [
	"resolving",
	"waiting_host",
	"host_granted",
	"prepared",
	"project_acquired",
	"host_active",
	"launched",
	"compensating",
];

export type AdmissionTransition = DispatchAdmissionState;

export class AdmissionHeldError extends Error {
	constructor(
		readonly taskId: string,
		readonly scope: "project" | "host",
		readonly waitingFor: string[],
		readonly code: string,
		message: string,
		readonly diagnostics: HostHoldDiagnostic[] = [],
		readonly snapshotGeneration: bigint | null = null,
	) {
		super(message);
		this.name = "AdmissionHeldError";
	}
}

/** Deliberately bypasses compensation to model process death after a commit. */
export class InjectedAdmissionCrashError extends Error {
	constructor(
		readonly transition: AdmissionTransition,
		cause: unknown,
	) {
		super(`injected crash after admission transition '${transition}'`, {
			cause,
		});
		this.name = "InjectedAdmissionCrashError";
	}
}

export class AdmissionCompensationPendingError extends Error {
	constructor(
		readonly admissionId: string,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "AdmissionCompensationPendingError";
	}
}

export interface ProjectDispatchAdmissionOptions {
	now?: () => number;
	afterTransition?: (
		transition: AdmissionTransition,
		row: AdmissionRow,
	) => void | Promise<void>;
}

/**
 * One durable, fenced project-to-host admission owner. Queue policy decides
 * which task gets a turn; this class is the shared safety boundary for both
 * that automatic turn and the manual Run button.
 */
export class ProjectDispatchAdmission implements TaskDispatchAdmissionPort {
	private readonly now: () => number;
	private hostDispatchReady = false;

	constructor(
		private readonly deps: {
			projectId: string;
			projectName: string;
			handle: ProjectDbHandle;
			bus: EventBus;
			tasks: TaskService;
			registry: RunRegistry;
			engine: RunEngine;
			host: HostResourceCoordinatorPort;
			projectSlots: ProjectResourceSlots;
			sessionId: (runId: string) => string;
			log: Logger;
		},
		private readonly options: ProjectDispatchAdmissionOptions = {},
	) {
		this.now = options.now ?? (() => Date.now());
	}

	async startTask(
		taskId: string,
		opts: {
			model?: string;
			actor?: StatusActor;
			hostSnapshot?: HostAdmissionSnapshot;
		} = {},
	): Promise<{ runId: string }> {
		const actor = opts.actor ?? "scheduler";
		const target = await this.deps.engine.resolveTaskExecutionTarget(taskId);
		let normalized: ReturnType<ProjectDispatchAdmission["normalize"]>;
		let invalid: AdmissionHeldError | null = null;
		try {
			normalized = this.normalize(target);
		} catch (error) {
			if (!(error instanceof AdmissionHeldError)) throw error;
			invalid = error;
			normalized = {
				project: [
					...new Set(
						target.requirements.projectSemaphores.map((item) => item.id),
					),
				].sort(),
				host: [],
				hash: createHash("sha256").update(JSON.stringify(target)).digest("hex"),
			};
		}
		let row = await this.openForTask(taskId);
		if (row?.state === "compensating") {
			await this.retryCompensation(row);
			row = null;
		}
		if (row && row.requirementsHash !== normalized.hash) {
			await this.cancelWaiting(row, "task admission requirements changed");
			row = null;
		}
		if (!row) row = await this.create(taskId, actor, target, normalized.hash);
		if (invalid) {
			throw await this.hold(
				row,
				invalid.scope,
				invalid.waitingFor,
				invalid.code,
				invalid.message,
			);
		}

		try {
			const existingRun = await this.deps.registry.get(row.runId);
			if (!existingRun && !row.hostLeaseId) {
				const preflight = await this.deps.projectSlots.plan(
					normalized.project,
					taskId,
				);
				if ("blockedBy" in preflight) {
					const held = await this.hold(
						row,
						"project",
						preflight.blockedBy,
						"capacity",
						`project resource capacity is unavailable: ${preflight.blockedBy.join(", ")}`,
					);
					if (row.waiterId) {
						await this.cancelWaiting(
							(await this.byId(row.id)) ?? row,
							"project resource became unavailable while waiting for host capacity",
						);
					}
					throw held;
				}
			}
			return await this.continue(row, target, normalized, opts);
		} catch (error) {
			if (error instanceof AdmissionHeldError) {
				const current = (await this.byId(row.id)) ?? row;
				if (current.state === "cancelled") throw error;
				throw await this.hold(
					current,
					error.scope,
					error.waitingFor,
					error.code,
					error.message,
					error.diagnostics,
					error.snapshotGeneration,
				);
			}
			if (error instanceof InjectedAdmissionCrashError) throw error;
			if (await this.preserveLiveLaunch(row, error)) throw error;
			await this.compensate(row.id, `admission failed: ${message(error)}`);
			throw error;
		}
	}

	captureAdmissionSnapshot(): HostAdmissionSnapshot {
		return this.deps.host.captureAdmissionSnapshot();
	}

	/**
	 * Repair/resume/unblock starts transfer admission by releasing the proven-
	 * ended parent first, then putting the child back through the same FIFO and
	 * prepare/acquire/activate/launch sequence. No stale parent fence is reused.
	 */
	async startContinuation(input: {
		taskId: string;
		parentRunId: string;
		runId: string;
		target: ResolvedExecutionTarget;
		prepare: () => Promise<import("./run-engine.ts").PreparedTaskRun>;
	}): Promise<{ runId: string }> {
		if (input.parentRunId) {
			await this.releaseRun(
				input.parentRunId,
				`admission transferred to continuation ${input.runId}`,
			);
		}
		const normalized = this.normalize(input.target);
		let row = await this.openForTask(input.taskId);
		if (row?.state === "compensating") {
			await this.retryCompensation(row);
			row = null;
		}
		if (row && row.runId !== input.runId) {
			await this.cancelWaiting(row, "superseded by a continuation run");
			row = null;
		}
		if (!row) {
			row = await this.create(
				input.taskId,
				"scheduler",
				input.target,
				normalized.hash,
				input.runId,
			);
		}
		try {
			const existing = await this.deps.registry.get(row.runId);
			if (!existing && !row.hostLeaseId) {
				const preflight = await this.deps.projectSlots.plan(
					normalized.project,
					input.taskId,
				);
				if ("blockedBy" in preflight) {
					const held = await this.hold(
						row,
						"project",
						preflight.blockedBy,
						"capacity",
						`project resource capacity is unavailable: ${preflight.blockedBy.join(", ")}`,
					);
					if (row.waiterId) {
						await this.cancelWaiting(
							(await this.byId(row.id)) ?? row,
							"project resource became unavailable while waiting for host capacity",
						);
					}
					throw held;
				}
			}
			return await this.continue(
				row,
				input.target,
				normalized,
				{},
				input.prepare,
			);
		} catch (error) {
			if (error instanceof AdmissionHeldError) {
				const current = (await this.byId(row.id)) ?? row;
				if (current.state === "cancelled") throw error;
				throw await this.hold(
					current,
					error.scope,
					error.waitingFor,
					error.code,
					error.message,
					error.diagnostics,
					error.snapshotGeneration,
				);
			}
			if (error instanceof InjectedAdmissionCrashError) throw error;
			if (await this.preserveLiveLaunch(row, error)) throw error;
			await this.compensate(
				row.id,
				`continuation admission failed: ${message(error)}`,
			);
			throw error;
		}
	}

	private normalize(target: ResolvedExecutionTarget): {
		project: string[];
		host: AuthoredHostRequirement[];
		hash: string;
	} {
		const project = [
			...new Set(target.requirements.projectSemaphores.map((item) => item.id)),
		].sort();
		const rawHost = [
			...target.requirements.executionHost,
			...target.requirements.localStaging,
		];
		const seen = new Set<string>();
		const host = rawHost
			.map((item): AuthoredHostRequirement => {
				if (seen.has(item.id)) {
					throw new AdmissionHeldError(
						"",
						"host",
						[item.id],
						"duplicate",
						`duplicate host requirement '${item.id}'`,
					);
				}
				seen.add(item.id);
				return {
					resourceId: item.id,
					...(item.amount === undefined ? {} : { amount: item.amount }),
				};
			})
			.sort((a, b) => a.resourceId.localeCompare(b.resourceId));
		const canonical = JSON.stringify({
			kind: target.kind,
			project,
			host: host.map((item) => [
				item.resourceId,
				item.amount === undefined ? null : item.amount,
			]),
		});
		return {
			project,
			host,
			hash: createHash("sha256").update(canonical).digest("hex"),
		};
	}

	private validateDefinitions(
		taskId: string,
		host: readonly AuthoredHostRequirement[],
	): { model: HostResourceReadModel; host: HostRequirement[] } {
		if (!this.hostDispatchReady) {
			throw new AdmissionHeldError(
				taskId,
				"host",
				host.map((item) => item.resourceId),
				"reconciliation",
				"host admission recovery has not completed; project-only work remains available",
			);
		}
		const model = this.deps.host.readModel();
		const definitions = new Map(
			model.definitions.map((item) => [item.id, item]),
		);
		const normalized: HostRequirement[] = [];
		for (const requirement of host) {
			const definition = definitions.get(requirement.resourceId);
			let reason: string | null = null;
			if (!definition) reason = "is not registered on this host";
			else if (!definition.enabled) reason = "is disabled";
			else if (definition.draining) reason = "is draining";
			else if (definition.provisioning === "dynamic") {
				reason =
					"is dynamic but no provisioner is installed; dynamic is lifecycle metadata, not free capacity";
			}
			if (reason) {
				throw new AdmissionHeldError(
					taskId,
					"host",
					[requirement.resourceId],
					"definition",
					`host resource '${requirement.resourceId}' ${reason}`,
				);
			}
			if (!definition) continue;
			try {
				if (definition.accounting === "slot") {
					if (requirement.amount !== undefined && requirement.amount !== 1) {
						throw new QuantityParseError(
							"slot resources must omit amount or request the numeric value 1",
						);
					}
					normalized.push({ resourceId: requirement.resourceId, amount: 1n });
				} else if (definition.quantityUnit === "integer") {
					if (requirement.amount === undefined) {
						throw new QuantityParseError(
							"integer quantity resources require an explicit amount",
						);
					}
					normalized.push({
						resourceId: requirement.resourceId,
						amount: parseIntegerQuantity(
							requirement.amount,
							`amount for '${requirement.resourceId}'`,
						),
					});
				} else if (definition.quantityUnit === "bytes") {
					if (requirement.amount === undefined) {
						throw new QuantityParseError(
							"RAM quantity resources require an explicit IEC byte amount",
						);
					}
					normalized.push({
						resourceId: requirement.resourceId,
						amount: parseIecBytes(
							requirement.amount,
							`RAM amount for '${requirement.resourceId}'`,
						),
					});
				} else {
					throw new QuantityParseError(
						"quantity definition has no canonical base unit",
					);
				}
			} catch (error) {
				throw new AdmissionHeldError(
					taskId,
					"host",
					[requirement.resourceId],
					"invalid_amount",
					`host resource '${requirement.resourceId}' has an invalid amount: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return { model, host: normalized };
	}

	private async continue(
		initial: AdmissionRow,
		target: ResolvedExecutionTarget,
		normalized: { project: string[]; host: AuthoredHostRequirement[] },
		opts: {
			model?: string;
			actor?: StatusActor;
			hostSnapshot?: HostAdmissionSnapshot;
		},
		prepare?: () => Promise<import("./run-engine.ts").PreparedTaskRun>,
	): Promise<{ runId: string }> {
		let row = (await this.byId(initial.id)) ?? initial;
		let lease: HostLease | null = null;
		if (normalized.host.length > 0) {
			const validated = this.validateDefinitions(row.taskId, normalized.host);
			const grant = await this.ensureGrant(
				row,
				validated.host,
				validated.model,
				opts.hostSnapshot,
			);
			row = grant.row;
			lease = grant.lease;
		} else if (row.state === "resolving" || row.state === "waiting_host") {
			row = await this.transition(row, "host_granted");
		}

		let run = await this.deps.registry.get(row.runId);
		if (!run) {
			if (prepare) await prepare();
			else {
				await this.deps.engine.prepareTaskRun(row.taskId, {
					...opts,
					target,
					runId: row.runId,
				});
			}
			run = await this.deps.registry.get(row.runId);
			if (!run) throw new Error(`prepared run ${row.runId} was not persisted`);
		}
		if (run.state === "running") {
			return { runId: run.id };
		}
		if (run.state !== "starting") {
			throw new Error(`admission run ${run.id} is ${run.state}`);
		}
		if (row.state === "host_granted")
			row = await this.transition(row, "prepared");

		const slots = await this.deps.projectSlots.ensure(
			row.runId,
			normalized.project,
		);
		if (slots.blockedBy.length > 0) {
			throw new Error(
				`project slot race after preparation: ${slots.blockedBy.join(", ")}`,
			);
		}
		if (row.state === "prepared") {
			row = await this.transition(row, "project_acquired");
		}

		if (lease) {
			lease = this.leaseFor(row) ?? lease;
			if (lease.state === "uncertain") {
				throw new Error("pre-launch host lease is uncertain after recovery");
			}
			if (lease.state === "provisional") {
				try {
					lease = await this.deps.host.activate(
						lease.id,
						lease.fence,
						this.runRef(row.runId),
					);
				} catch (error) {
					const persisted = this.leaseFor(row);
					if (persisted?.state === "active") {
						row = await this.linkLease(row, persisted, "host_active");
						throw new InjectedAdmissionCrashError("host_active", error);
					}
					throw error;
				}
			}
			if (lease.state !== "active") {
				throw new Error(`host lease ${lease.id} is ${lease.state}`);
			}
			row = await this.linkLease(row, lease, "host_active");
		} else if (row.state === "project_acquired") {
			row = await this.transition(row, "host_active");
		}

		await this.deps.engine.launchPreparedRun({ runId: row.runId });
		if (row.state !== "launched") row = await this.transition(row, "launched");
		return { runId: row.runId };
	}

	private async ensureGrant(
		row: AdmissionRow,
		requirements: readonly HostRequirement[],
		model: HostResourceReadModel,
		snapshot?: HostAdmissionSnapshot,
	): Promise<{ row: AdmissionRow; lease: HostLease }> {
		let waiter = row.waiterId
			? model.waiters.find((item) => item.id === row.waiterId)
			: model.waiters.find((item) => item.requestKey === row.requestKey);
		if (!waiter) {
			waiter = await this.deps.host.putWaiter({
				requestKey: row.requestKey,
				projectId: this.deps.projectId,
				requirements,
				metadata: { taskId: row.taskId, runId: row.runId },
			});
			row = await this.linkWaiter(row, waiter);
		}
		const existing = this.leaseFor(row, waiter.id);
		if (existing) {
			if (["provisional", "active", "uncertain"].includes(existing.state)) {
				let linked = row;
				if (
					existing.state === "provisional" &&
					(row.state === "resolving" || row.state === "waiting_host")
				) {
					linked = await this.linkLease(row, existing, "host_granted");
				} else if (
					existing.state !== "provisional" &&
					[
						"resolving",
						"waiting_host",
						"host_granted",
						"prepared",
						"project_acquired",
					].includes(row.state)
				) {
					linked = await this.linkLease(row, existing, "host_active");
				}
				return {
					row: linked,
					lease: existing,
				};
			}
			throw new Error(`host lease ${existing.id} is already ${existing.state}`);
		}

		for (let attempt = 0; attempt < 2; attempt++) {
			const generation =
				snapshot?.generation ?? this.deps.host.readModel().generation;
			try {
				const result = await this.deps.host.tryGrant(
					waiter.id,
					generation,
					snapshot,
				);
				if (!("kind" in result)) {
					return {
						row: await this.linkLease(row, result, "host_granted"),
						lease: result,
					};
				}
				if (result.reason === "generation" && attempt === 0 && !snapshot)
					continue;
				throw await this.hold(
					row,
					"host",
					result.blockedBy.length > 0
						? result.blockedBy
						: requirements.map((item) => item.resourceId),
					result.diagnostics[0]?.reason ?? result.reason,
					result.diagnostics[0]?.message ??
						`host admission is waiting (${result.reason})`,
					result.diagnostics,
					result.generation,
				);
			} catch (error) {
				if (error instanceof AdmissionHeldError) throw error;
				const persisted = this.leaseFor(row, waiter.id);
				if (persisted?.state === "provisional") {
					await this.linkLease(row, persisted, "host_granted");
					throw new InjectedAdmissionCrashError("host_granted", error);
				}
				throw await this.hold(
					row,
					"host",
					requirements.map((item) => item.resourceId),
					"coordinator",
					`host coordinator is unavailable: ${message(error)}`,
				);
			}
		}
		throw new Error("unreachable host grant retry");
	}

	private leaseFor(
		row: AdmissionRow,
		waiterId = row.waiterId,
	): HostLease | null {
		const model = this.deps.host.readModel();
		return (
			model.leases.find((item) => item.id === row.hostLeaseId) ??
			model.leases.find((item) => item.waiterId === waiterId) ??
			null
		);
	}

	private runRef(runId: string) {
		const model = this.deps.host.readModel();
		return {
			runId,
			runDir: this.deps.registry.runDir(runId),
			sessionId: this.deps.sessionId(runId),
			kernelBootId: model.kernelBootId,
		};
	}

	async releaseRun(runId: string, reason = "run reached a terminal state") {
		if (await this.deps.registry.hasPendingCleanup(runId)) return;
		const row = await this.byRun(runId);
		if (!row) {
			await this.deps.projectSlots.release(runId);
			return;
		}
		if (["released", "cancelled", "failed"].includes(row.state)) return;
		await this.beginCompensation(row, "released", reason);
	}

	async renewRun(runId: string): Promise<void> {
		const row = await this.byRun(runId);
		if (!row?.hostLeaseId || row.state !== "launched") return;
		const lease = this.leaseFor(row);
		if (!lease || (lease.state !== "active" && lease.state !== "uncertain")) {
			return;
		}
		const model = this.deps.host.readModel();
		try {
			await this.deps.host.renewOrAdopt(lease.id, lease.fence, {
				...this.runRef(runId),
				processBootId: model.processBootId,
				observedAt: this.now(),
			});
			if (row.holdCode === "renewal_uncertain") {
				await this.deps.handle.db
					.update(dispatchAdmissions)
					.set({
						holdCode: null,
						holdReason: null,
						updatedAt: new Date(this.now()),
					})
					.where(eq(dispatchAdmissions.id, row.id));
			}
			this.hostDispatchReady = await this.dispatchBoundariesAreSafe();
		} catch (error) {
			this.hostDispatchReady = false;
			await this.setIssue(
				row,
				"renewal_uncertain",
				`host admission renewal is uncertain: ${message(error)}`,
			);
			throw error;
		}
	}

	/** Recover every cross-store boundary before this project's scheduler runs. */
	async reconcile(): Promise<{
		resumed: number;
		compensated: number;
		adopted: number;
	}> {
		const report = { resumed: 0, compensated: 0, adopted: 0 };
		const rows = await this.openRows();
		let safeForHostDispatch = true;
		for (const row of rows) {
			try {
				const run = await this.deps.registry.get(row.runId);
				if (row.state === "compensating") {
					if (run?.state === "running") {
						const lease =
							row.waiterId || row.hostLeaseId ? this.leaseFor(row) : null;
						await this.ensureRecoveryOwnership(row, lease);
						await this.recoverLaunched(row);
						await this.renewRun(row.runId);
						await this.recoveryEvent(row, "adopted");
						report.adopted++;
						continue;
					}
					await this.retryCompensation(row);
					report.compensated++;
					continue;
				}
				const lease =
					row.waiterId || row.hostLeaseId ? this.leaseFor(row) : null;
				if (run?.state === "running") {
					await this.ensureRecoveryOwnership(row, lease);
					const current = await this.byId(row.id);
					if (current && current.state !== "launched") {
						await this.transition(current, "launched", "live run adopted");
					}
					if (lease?.state === "active") await this.renewRun(row.runId);
					await this.recoveryEvent(row, "adopted");
					report.adopted++;
					continue;
				}
				if (run?.state === "starting" && lease?.state === "active") {
					await this.ensureRecoveryOwnership(row, lease);
					await this.deps.engine.launchPreparedRun({ runId: run.id });
					const current = await this.byId(row.id);
					if (current)
						await this.transition(current, "launched", "launch resumed");
					await this.recoveryEvent(row, "resumed");
					report.resumed++;
					continue;
				}
				if (run && !["starting", "running"].includes(run.state)) {
					await this.releaseRun(row.runId, "recovery found a non-live run");
					continue;
				}
				if (
					lease &&
					[
						"active",
						"uncertain",
						"releasing",
						"released",
						"reclaimed",
						"force_released",
					].includes(lease.state)
				) {
					await this.compensate(
						row.id,
						`recovery found host lease ${lease.state}`,
					);
					await this.recoveryEvent(row, "compensated");
					report.compensated++;
				}
				if (row.holdCode === "reconciliation_uncertain") {
					await this.deps.handle.db
						.update(dispatchAdmissions)
						.set({
							holdCode: null,
							holdReason: null,
							updatedAt: new Date(this.now()),
						})
						.where(eq(dispatchAdmissions.id, row.id));
				}
			} catch (error) {
				safeForHostDispatch = false;
				this.deps.log.error(
					{ error, admissionId: row.id },
					"dispatch admission reconciliation failed",
				);
				const current = (await this.byId(row.id)) ?? row;
				if (
					current.state !== "compensating" &&
					current.holdCode !== "project_slot_recovery"
				) {
					await this.setIssue(
						current,
						"reconciliation_uncertain",
						message(error),
					);
				}
			}
		}
		this.hostDispatchReady =
			safeForHostDispatch && (await this.dispatchBoundariesAreSafe());
		return report;
	}

	async syncEligibleTasks(taskIds: readonly string[]): Promise<void> {
		const eligible = new Set(taskIds);
		for (const row of await this.openRows()) {
			if (eligible.has(row.taskId)) continue;
			if (await this.deps.registry.get(row.runId)) continue;
			await this.cancelWaiting(row, "task is no longer eligible for dispatch");
		}
	}

	async health() {
		const rows = await this.openRows();
		const hostIncidents = this.deps.host
			.readModel()
			.incidents.filter((incident) => incident.state === "open");
		const byState: Record<string, number> = {};
		for (const row of rows) byState[row.state] = (byState[row.state] ?? 0) + 1;
		return {
			hostDispatchReady: this.hostDispatchReady,
			byState,
			issues: rows.filter((row) => row.holdCode != null).length,
			hostIncidents,
		};
	}

	async issues(): Promise<
		Array<{
			id: string;
			taskId: string;
			runId: string;
			holdReason: string | null;
			updatedAt: Date;
		}>
	> {
		const rows = await this.openRows();
		const issues: Array<{
			id: string;
			taskId: string;
			runId: string;
			holdReason: string | null;
			updatedAt: Date;
		}> = rows.filter(
			(row) =>
				row.holdCode != null &&
				!["capacity", "fifo", "generation"].includes(row.holdCode),
		);
		const model = this.deps.host.readModel();
		for (const incident of model.incidents.filter(
			(item) => item.state === "open",
		)) {
			const lease = model.leases.find(
				(item) =>
					item.projectId === this.deps.projectId &&
					item.allocations.some(
						(allocation) => allocation.resourceId === incident.resourceId,
					),
			);
			const row = rows.find((item) => item.hostLeaseId === lease?.id);
			if (!row) continue;
			issues.push({
				id: `host:${incident.key}`,
				taskId: row.taskId,
				runId: row.runId,
				holdReason:
					incident.kind === "ram-low-headroom"
						? `RAM headroom is below the promised safety floor: observed=${incident.context.memAvailableBytes} B, configured=${incident.context.configuredQuotaBytes} B, reserved=${incident.context.durablePromisesBytes} B, safety=${incident.context.safetyHeadroomBytes} B`
						: incident.kind === "cpu-pressure"
							? "CPU pressure exceeded the configured host admission threshold"
							: "external or unknown GPU occupancy conflicts with an active host lease",
				updatedAt: new Date(incident.updatedAt),
			});
		}
		return issues;
	}

	private async preserveLiveLaunch(
		row: AdmissionRow,
		error: unknown,
	): Promise<boolean> {
		const run = await this.deps.registry.get(row.runId);
		if (run?.state !== "running") return false;
		this.hostDispatchReady = false;
		await this.setIssue(
			(await this.byId(row.id)) ?? row,
			"launch_journal",
			`run ${row.runId} launched but admission journaling failed: ${message(error)}`,
		);
		return true;
	}

	private async ensureRecoveryOwnership(
		row: AdmissionRow,
		lease: HostLease | null,
	): Promise<void> {
		const target = row.resolution as unknown as ResolvedExecutionTarget;
		const normalized = this.normalize(target);
		if (normalized.host.length > 0 && lease?.state !== "active") {
			throw new Error(`live run ${row.runId} has no active fenced host lease`);
		}
		const slots = await this.deps.projectSlots.ensure(
			row.runId,
			normalized.project,
		);
		if (slots.blockedBy.length > 0) {
			await this.setIssue(
				row,
				"project_slot_recovery",
				`live/prepared run ${row.runId} is missing project capacity for: ${slots.blockedBy.join(", ")}`,
			);
			throw new Error(
				`cannot adopt or launch ${row.runId}; expected project slots are unavailable: ${slots.blockedBy.join(", ")}`,
			);
		}
		if (
			[
				"project_slot_recovery",
				"reconciliation_uncertain",
				"launch_journal",
			].includes(row.holdCode ?? "")
		) {
			await this.deps.handle.db
				.update(dispatchAdmissions)
				.set({
					holdCode: null,
					holdReason: null,
					updatedAt: new Date(this.now()),
				})
				.where(eq(dispatchAdmissions.id, row.id));
		}
	}

	private async recoverLaunched(row: AdmissionRow): Promise<AdmissionRow> {
		const emitted = await this.deps.handle.withTx(async (tx) => {
			const [next] = await tx
				.update(dispatchAdmissions)
				.set({
					state: "launched",
					compensationTarget: null,
					holdCode: null,
					holdReason: null,
					updatedAt: new Date(this.now()),
				})
				.where(eq(dispatchAdmissions.id, row.id))
				.returning();
			if (!next) throw new Error(`admission ${row.id} disappeared`);
			const event = await appendEvent(tx, {
				type: "admission.state_changed",
				taskId: row.taskId,
				runId: row.runId,
				payload: {
					admissionId: row.id,
					from: row.state,
					to: "launched",
					reason: "demonstrably live launch adopted during compensation",
				},
			});
			return { next, event };
		});
		this.deps.bus.publish([emitted.event]);
		return emitted.next;
	}

	private async beginCompensation(
		row: AdmissionRow,
		target: DispatchCompensationTarget,
		reason: string,
	): Promise<void> {
		let current = (await this.byId(row.id)) ?? row;
		if (["released", "cancelled", "failed"].includes(current.state)) return;
		if (current.state !== "compensating") {
			const emitted = await this.deps.handle.withTx(async (tx) => {
				const [next] = await tx
					.update(dispatchAdmissions)
					.set({
						state: "compensating",
						compensationTarget: target,
						holdCode: "compensation",
						holdReason: reason,
						updatedAt: new Date(this.now()),
					})
					.where(eq(dispatchAdmissions.id, current.id))
					.returning();
				if (!next) throw new Error(`admission ${current.id} disappeared`);
				const event = await appendEvent(tx, {
					type: "admission.state_changed",
					taskId: current.taskId,
					runId: current.runId,
					payload: {
						admissionId: current.id,
						from: current.state,
						to: "compensating",
						reason,
					},
				});
				return { next, event };
			});
			this.deps.bus.publish([emitted.event]);
			current = emitted.next;
			await this.after("compensating", current);
		} else if (!current.compensationTarget) {
			const [next] = await this.deps.handle.db
				.update(dispatchAdmissions)
				.set({ compensationTarget: target, updatedAt: new Date(this.now()) })
				.where(eq(dispatchAdmissions.id, current.id))
				.returning();
			if (next) current = next;
		}
		await this.retryCompensation(current);
	}

	private async retryCompensation(row: AdmissionRow): Promise<void> {
		const current = (await this.byId(row.id)) ?? row;
		if (current.state !== "compensating") return;
		const target = current.compensationTarget;
		if (!target) {
			throw new AdmissionCompensationPendingError(
				current.id,
				`admission ${current.id} has no durable compensation target`,
			);
		}
		const reason = current.holdReason ?? `complete ${target} compensation`;
		try {
			await this.releaseHostForCompensation(current, reason);
			await this.deps.projectSlots.release(current.runId);
			if ((await this.deps.projectSlots.held(current.runId)).length > 0) {
				throw new Error("project resource slots remain after release");
			}
			if (target !== "released") {
				await this.deps.engine.abortPreparedTaskRun(
					current.taskId,
					current.runId,
					reason,
					current.actor as StatusActor,
				);
				const [task, run] = await Promise.all([
					this.deps.tasks.get(current.taskId),
					this.deps.registry.get(current.runId),
				]);
				if (task?.claimedByRunId === current.runId) {
					throw new Error("task claim remains after prepared-run abort");
				}
				if (run?.state === "starting" || run?.state === "running") {
					throw new Error(`run remains ${run.state} after prepared-run abort`);
				}
			}

			const emitted = await this.deps.handle.withTx(async (tx) => {
				const [next] = await tx
					.update(dispatchAdmissions)
					.set({
						state: target,
						holdCode: null,
						holdReason: null,
						updatedAt: new Date(this.now()),
					})
					.where(eq(dispatchAdmissions.id, current.id))
					.returning();
				if (!next) throw new Error(`admission ${current.id} disappeared`);
				const event = await appendEvent(tx, {
					type: "admission.state_changed",
					taskId: current.taskId,
					runId: current.runId,
					payload: {
						admissionId: current.id,
						from: "compensating",
						to: target,
						reason,
					},
				});
				return { next, event };
			});
			this.deps.bus.publish([emitted.event]);
			await this.after(target, emitted.next);
			this.hostDispatchReady = await this.dispatchBoundariesAreSafe();
		} catch (error) {
			if (error instanceof InjectedAdmissionCrashError) throw error;
			const detail = `${target} cleanup is pending: ${message(error)}`;
			this.hostDispatchReady = false;
			await this.setIssue(current, "compensation", detail);
			this.deps.log.error(
				{ error, admissionId: current.id, target },
				"dispatch admission compensation remains pending",
			);
			throw new AdmissionCompensationPendingError(current.id, detail, {
				cause: error,
			});
		}
	}

	private async dispatchBoundariesAreSafe(): Promise<boolean> {
		for (const row of await this.openRows()) {
			if (
				row.state === "compensating" ||
				[
					"compensation",
					"project_slot_recovery",
					"launch_journal",
					"renewal_uncertain",
					"reconciliation_uncertain",
				].includes(row.holdCode ?? "")
			) {
				return false;
			}
			const lease = row.waiterId || row.hostLeaseId ? this.leaseFor(row) : null;
			if (lease && ["uncertain", "releasing"].includes(lease.state))
				return false;
		}
		return true;
	}

	private async releaseHostForCompensation(
		row: AdmissionRow,
		reason: string,
	): Promise<void> {
		let model = this.deps.host.readModel();
		let lease =
			model.leases.find((item) => item.id === row.hostLeaseId) ??
			model.leases.find((item) => item.waiterId === row.waiterId) ??
			null;
		if (lease && !isReleasedLease(lease)) {
			await this.deps.host.cancelOrRelease(lease.id, lease.fence, reason);
			model = this.deps.host.readModel();
			lease = model.leases.find((item) => item.id === lease?.id) ?? null;
			if (!lease || !isReleasedLease(lease)) {
				throw new Error("host lease release is not durably proven");
			}
			return;
		}
		if (lease) return;
		if (!row.waiterId) return;
		let waiter = model.waiters.find((item) => item.id === row.waiterId);
		if (!waiter) throw new Error("host waiter is missing from the coordinator");
		if (waiter.state === "waiting") {
			await this.deps.host.cancelOrRelease(
				waiter.id,
				waiter.generation,
				reason,
			);
			model = this.deps.host.readModel();
			waiter = model.waiters.find((item) => item.id === row.waiterId);
		}
		if (waiter?.state !== "cancelled") {
			throw new Error(
				`host waiter cancellation is not proven (state ${waiter?.state ?? "missing"})`,
			);
		}
	}

	private async compensate(admissionId: string, reason: string): Promise<void> {
		const row = await this.byId(admissionId);
		if (!row || ["released", "cancelled", "failed"].includes(row.state)) return;
		await this.beginCompensation(row, "failed", reason);
	}

	private async cancelWaiting(
		row: AdmissionRow,
		reason: string,
	): Promise<void> {
		await this.beginCompensation(row, "cancelled", reason);
	}

	private async create(
		taskId: string,
		actor: StatusActor,
		target: ResolvedExecutionTarget,
		requirementsHash: string,
		plannedRunId?: string,
	): Promise<AdmissionRow> {
		const id = ulid();
		const runId = plannedRunId ?? ulid();
		const now = new Date(this.now());
		const requestKey = `${this.deps.projectId}/${taskId}/${id}`;
		const emitted = await this.deps.handle.withTx(async (tx) => {
			const [row] = await tx
				.insert(dispatchAdmissions)
				.values({
					id,
					taskId,
					runId,
					actor,
					state: "resolving",
					requestKey,
					requirementsHash,
					resolution: target as unknown as Record<string, unknown>,
					createdAt: now,
					updatedAt: now,
				})
				.returning();
			if (!row) throw new Error("admission insert returned no row");
			const event = await appendEvent(tx, {
				type: "admission.state_changed",
				taskId,
				runId,
				payload: { admissionId: id, from: "none", to: "resolving" },
			});
			return { row, event };
		});
		this.deps.bus.publish([emitted.event]);
		await this.after("resolving", emitted.row);
		return emitted.row;
	}

	private async transition(
		row: AdmissionRow,
		to: DispatchAdmissionState,
		reason?: string,
	): Promise<AdmissionRow> {
		if (row.state === to && !reason) return row;
		const from = row.state;
		const emitted = await this.deps.handle.withTx(async (tx) => {
			const [next] = await tx
				.update(dispatchAdmissions)
				.set({
					state: to,
					updatedAt: new Date(this.now()),
					...(reason ? { holdReason: reason } : {}),
				})
				.where(eq(dispatchAdmissions.id, row.id))
				.returning();
			if (!next) throw new Error(`admission ${row.id} disappeared`);
			const event = await appendEvent(tx, {
				type: "admission.state_changed",
				taskId: row.taskId,
				runId: row.runId,
				payload: { admissionId: row.id, from, to, reason },
			});
			return { next, event };
		});
		this.deps.bus.publish([emitted.event]);
		await this.after(to, emitted.next);
		return emitted.next;
	}

	private async linkWaiter(
		row: AdmissionRow,
		waiter: Waiter,
	): Promise<AdmissionRow> {
		const emitted = await this.deps.handle.withTx(async (tx) => {
			const [next] = await tx
				.update(dispatchAdmissions)
				.set({
					waiterId: waiter.id,
					waiterGeneration: waiter.generation.toString(),
					state: "waiting_host",
					updatedAt: new Date(this.now()),
				})
				.where(eq(dispatchAdmissions.id, row.id))
				.returning();
			if (!next) throw new Error(`admission ${row.id} disappeared`);
			const event =
				row.state === "waiting_host"
					? null
					: await appendEvent(tx, {
							type: "admission.state_changed",
							taskId: row.taskId,
							runId: row.runId,
							payload: {
								admissionId: row.id,
								from: row.state,
								to: "waiting_host",
							},
						});
			return { next, event };
		});
		if (emitted.event) this.deps.bus.publish([emitted.event]);
		await this.after("waiting_host", emitted.next);
		return emitted.next;
	}

	private async linkLease(
		row: AdmissionRow,
		lease: HostLease,
		state: "host_granted" | "host_active",
	): Promise<AdmissionRow> {
		const emitted = await this.deps.handle.withTx(async (tx) => {
			const [next] = await tx
				.update(dispatchAdmissions)
				.set({
					hostLeaseId: lease.id,
					hostFence: lease.fence.toString(),
					state,
					ownerBootId: this.deps.host.readModel().processBootId,
					holdCode: null,
					holdReason: null,
					updatedAt: new Date(this.now()),
				})
				.where(eq(dispatchAdmissions.id, row.id))
				.returning();
			if (!next) throw new Error(`admission ${row.id} disappeared`);
			const event =
				row.state === state
					? null
					: await appendEvent(tx, {
							type: "admission.state_changed",
							taskId: row.taskId,
							runId: row.runId,
							payload: { admissionId: row.id, from: row.state, to: state },
						});
			return { next, event };
		});
		if (emitted.event) this.deps.bus.publish([emitted.event]);
		if (row.state !== state) await this.after(state, emitted.next);
		return emitted.next;
	}

	private async hold(
		row: AdmissionRow,
		scope: "project" | "host",
		waitingFor: string[],
		code: string,
		reason: string,
		diagnostics: HostHoldDiagnostic[] = [],
		snapshotGeneration: bigint | null = null,
	): Promise<AdmissionHeldError> {
		const key = `${scope}:${code}:${[...waitingFor].sort().join(",")}:${reason}`;
		const previous =
			row.holdCode && row.holdReason
				? `${scope}:${row.holdCode}:${[...waitingFor].sort().join(",")}:${row.holdReason}`
				: null;
		if (previous !== key) {
			const emitted = await this.deps.handle.withTx(async (tx) => {
				await tx
					.update(dispatchAdmissions)
					.set({
						state: "waiting_host",
						holdCode: code,
						holdReason: reason,
						updatedAt: new Date(this.now()),
					})
					.where(eq(dispatchAdmissions.id, row.id));
				const held = await appendEvent(tx, {
					type: "task.held_for_resource",
					taskId: row.taskId,
					payload: {
						waitingFor,
						scope,
						reason,
						code,
						snapshotGeneration: snapshotGeneration?.toString(),
						diagnostics: diagnostics.map((diagnostic) =>
							JSON.parse(
								JSON.stringify(diagnostic, (_key, value) =>
									typeof value === "bigint" ? value.toString() : value,
								),
							),
						),
					},
				});
				const state =
					row.state === "waiting_host"
						? null
						: await appendEvent(tx, {
								type: "admission.state_changed",
								taskId: row.taskId,
								runId: row.runId,
								payload: {
									admissionId: row.id,
									from: row.state,
									to: "waiting_host",
									reason,
								},
							});
				return state ? [held, state] : [held];
			});
			this.deps.bus.publish(emitted);
		}
		return new AdmissionHeldError(
			row.taskId,
			scope,
			waitingFor,
			code,
			reason,
			diagnostics,
			snapshotGeneration,
		);
	}

	private async setIssue(row: AdmissionRow, code: string, reason: string) {
		await this.deps.handle.db
			.update(dispatchAdmissions)
			.set({
				holdCode: code,
				holdReason: reason,
				updatedAt: new Date(this.now()),
			})
			.where(eq(dispatchAdmissions.id, row.id));
	}

	private async recoveryEvent(
		row: AdmissionRow,
		action: "resumed" | "compensated" | "adopted",
	) {
		const event = await this.deps.handle.withTx((tx) =>
			appendEvent(tx, {
				type: "admission.recovered",
				taskId: row.taskId,
				runId: row.runId,
				payload: { admissionId: row.id, action },
			}),
		);
		this.deps.bus.publish([event]);
	}

	private async after(state: AdmissionTransition, row: AdmissionRow) {
		try {
			await this.options.afterTransition?.(state, row);
		} catch (error) {
			throw new InjectedAdmissionCrashError(state, error);
		}
	}

	private async byId(id: string): Promise<AdmissionRow | null> {
		const [row] = await this.deps.handle.db
			.select()
			.from(dispatchAdmissions)
			.where(eq(dispatchAdmissions.id, id));
		return row ?? null;
	}

	private async byRun(runId: string): Promise<AdmissionRow | null> {
		const [row] = await this.deps.handle.db
			.select()
			.from(dispatchAdmissions)
			.where(eq(dispatchAdmissions.runId, runId));
		return row ?? null;
	}

	private async openForTask(taskId: string): Promise<AdmissionRow | null> {
		const [row] = await this.deps.handle.db
			.select()
			.from(dispatchAdmissions)
			.where(
				and(
					eq(dispatchAdmissions.taskId, taskId),
					inArray(dispatchAdmissions.state, OPEN_STATES),
				),
			)
			.orderBy(desc(dispatchAdmissions.createdAt));
		return row ?? null;
	}

	private async openRows(): Promise<AdmissionRow[]> {
		return this.deps.handle.db
			.select()
			.from(dispatchAdmissions)
			.where(inArray(dispatchAdmissions.state, OPEN_STATES))
			.orderBy(dispatchAdmissions.createdAt);
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isReleasedLease(lease: HostLease): boolean {
	return ["released", "reclaimed", "force_released"].includes(lease.state);
}
