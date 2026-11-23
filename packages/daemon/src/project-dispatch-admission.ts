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
import { DispatchPreflightError } from "./dispatch-preflight.ts";
import type { ResolvedExecutionTarget } from "./execution-target.ts";
import type { Logger } from "./log.ts";
import { type RefusalFix, refusalFix } from "./refusal-fix.ts";
import { projectClaim } from "./resources/claims.ts";
import type { ResourceCoordinator } from "./resources/coordinator.ts";
import { poolIdOf } from "./resources/host-definitions.ts";
import type { HostResourceReadModel } from "./resources/host-types.ts";
import { QuantityParseError } from "./resources/quantity.ts";
import {
	type Blocker,
	type Claim,
	REMOTE_RUN_SESSION_PREFIX,
	ResourceError,
	type ResourceLease,
	type ResourceWaiter,
	type RunIdentity,
} from "./resources/types.ts";
import type { RunEngine, TaskDispatchAdmissionPort } from "./run-engine.ts";
import type { RunRegistry } from "./run-registry.ts";
import {
	runHoldsClaim,
	type StatusActor,
	type TaskService,
} from "./task-service.ts";

export type AdmissionRecord = typeof dispatchAdmissions.$inferSelect;
type AdmissionRow = AdmissionRecord;
type AuthoredHostRequirement = {
	resourceId: string;
	amount?: number | string;
};

/** The coordinator surface one project's admission saga uses. */
export type AdmissionLedger = Pick<
	ResourceCoordinator,
	| "readModel"
	| "putWaiter"
	| "tryGrant"
	| "activate"
	| "renewOrAdopt"
	| "cancelWaiter"
	| "release"
>;

/** The refusal code for what stands between a claim set and its grant. */
function blockerCode(blocker: Blocker | undefined): string {
	switch (blocker?.code) {
		case "held":
			return blocker.detail === "budget" ? "budget_exhausted" : "pool_held";
		case "exhausted":
			return "budget_exhausted";
		case "unknown-pool":
		case "unknown-dimension":
			return "definition";
		case "fifo":
			return "fifo";
		default:
			return "capacity";
	}
}

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

/**
 * Every host-coordinator requirement of a resolved target: daemon-host
 * execution capacity, local staging, and a remote host's own slots
 * (`remote.<id>.slots`), so remote capacity waits in the same FIFO ledger.
 */
export function targetHostRequirements(target: ResolvedExecutionTarget) {
	return [
		...target.requirements.executionHost,
		...target.requirements.localStaging,
		...(target.requirements.targetCapacity ?? []),
	];
}

export class AdmissionHeldError extends Error {
	/** The exact remedy for this refusal, derived from `code`. */
	readonly fix: RefusalFix;
	constructor(
		readonly taskId: string,
		readonly scope: "project" | "host",
		readonly waitingFor: string[],
		readonly code: string,
		message: string,
		readonly diagnostics: Blocker[] = [],
	) {
		super(message);
		this.name = "AdmissionHeldError";
		this.fix = refusalFix(code, waitingFor);
	}
}

/** Deliberately bypasses compensation to model process death after a commit. */
/** An open admission problem for the inbox, with its exact remedy. */
export interface AdmissionIssue {
	id: string;
	taskId: string;
	runId: string;
	holdReason: string | null;
	fix: RefusalFix;
	updatedAt: Date;
}

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
			host: AdmissionLedger;
			/** Resolves a host requirement; refuses anything it cannot honour. */
			claimFor: (resourceId: string, amount?: number | string) => Claim;
			/** Capacity a target reserves on its provider's account pool. */
			targetClaims?: (target: ResolvedExecutionTarget) => Claim[];
			/** The project semaphores a lease holds, for their audit events. */
			/** The operator read model: incidents and host-unit allocations. */
			hostModel: () => HostResourceReadModel;
			projectSlotsOf?: (
				leaseId: string,
			) => Promise<{ resourceId: string; slot: number }[]>;
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
				account: [],
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
				// Before any lease: a start that cannot succeed is a hold with a fix.
				try {
					await this.deps.engine.preflightTask(
						row.runId,
						target,
						taskId,
						actor,
					);
				} catch (error) {
					if (!(error instanceof DispatchPreflightError)) throw error;
					throw new AdmissionHeldError(
						taskId,
						"project",
						error.waitingFor,
						error.code,
						error.message,
					);
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
				);
			}
			if (error instanceof InjectedAdmissionCrashError) throw error;
			if (await this.preserveLiveLaunch(row, error)) throw error;
			await this.compensate(row.id, `admission failed: ${message(error)}`);
			throw error;
		}
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

	/**
	 * One run of a task that may have live siblings (an attempt group): keyed
	 * by its planned run id alone, so it neither supersedes nor is superseded
	 * by another open admission of the same task. Replays resume the same row.
	 */
	async startRun(input: {
		taskId: string;
		runId: string;
		target: ResolvedExecutionTarget;
		prepare: () => Promise<import("./run-engine.ts").PreparedTaskRun>;
	}): Promise<{ runId: string }> {
		const normalized = this.normalize(input.target);
		let row = await this.byRun(input.runId);
		if (row?.state === "compensating") {
			await this.retryCompensation(row);
			row = await this.byRun(input.runId);
		}
		if (row && !OPEN_STATES.includes(row.state)) {
			throw new Error(
				`admission for run ${input.runId} already ended as ${row.state}`,
			);
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
			try {
				return await this.continue(
					row,
					input.target,
					normalized,
					{},
					input.prepare,
				);
			} catch (error) {
				// A held route found while preparing is a hold with a fix, not a failure.
				if (error instanceof DispatchPreflightError) {
					throw new AdmissionHeldError(
						input.taskId,
						"project",
						error.waitingFor,
						error.code,
						error.message,
					);
				}
				throw error;
			}
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
				);
			}
			if (error instanceof InjectedAdmissionCrashError) throw error;
			if (await this.preserveLiveLaunch(row, error)) throw error;
			await this.compensate(
				row.id,
				`group run admission failed: ${message(error)}`,
			);
			throw error;
		}
	}

	private normalize(target: ResolvedExecutionTarget): {
		project: string[];
		host: AuthoredHostRequirement[];
		account: Claim[];
		hash: string;
	} {
		const project = [
			...new Set(target.requirements.projectSemaphores.map((item) => item.id)),
		].sort();
		const rawHost = targetHostRequirements(target);
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
		let account: Claim[];
		try {
			account = this.deps.targetClaims?.(target) ?? [];
		} catch (error) {
			throw new AdmissionHeldError(
				"",
				"host",
				[target.kind],
				"definition",
				message(error),
			);
		}
		const canonical = JSON.stringify({
			kind: target.kind,
			project,
			host: host.map((item) => [
				item.resourceId,
				item.amount === undefined ? null : item.amount,
			]),
			...(account.length > 0 ? { account } : {}),
		});
		return {
			project,
			host,
			account,
			hash: createHash("sha256").update(canonical).digest("hex"),
		};
	}

	/** Every requirement as one claim set; an unusable one is a hold with a fix. */
	private claimsOf(
		taskId: string,
		normalized: {
			project: string[];
			host: AuthoredHostRequirement[];
			account?: readonly Claim[];
		},
	): Claim[] {
		if (!this.hostDispatchReady) {
			throw new AdmissionHeldError(
				taskId,
				"host",
				[
					...normalized.project,
					...normalized.host.map((item) => item.resourceId),
				],
				"reconciliation",
				"resource recovery has not completed; work needing no resources remains available",
			);
		}
		const claims = normalized.project.map((name) =>
			projectClaim(this.deps.projectId, name),
		);
		claims.push(...(normalized.account ?? []));
		for (const requirement of normalized.host) {
			try {
				claims.push(
					this.deps.claimFor(requirement.resourceId, requirement.amount),
				);
			} catch (error) {
				if (
					!(error instanceof ResourceError) &&
					!(error instanceof QuantityParseError)
				) {
					throw error;
				}
				throw new AdmissionHeldError(
					taskId,
					"host",
					[requirement.resourceId],
					error instanceof QuantityParseError ? "invalid_amount" : "definition",
					`host resource '${requirement.resourceId}': ${error.message}`,
				);
			}
		}
		return claims;
	}

	private async continue(
		initial: AdmissionRow,
		target: ResolvedExecutionTarget,
		normalized: { project: string[]; host: AuthoredHostRequirement[] },
		opts: {
			model?: string;
			actor?: StatusActor;
		},
		prepare?: () => Promise<import("./run-engine.ts").PreparedTaskRun>,
	): Promise<{ runId: string }> {
		let row = (await this.byId(initial.id)) ?? initial;
		let lease: ResourceLease | null = null;
		if (normalized.host.length + normalized.project.length > 0) {
			const claims = this.claimsOf(row.taskId, normalized);
			const grant = await this.ensureGrant(row, claims);
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
						lease,
						this.runRef(row.runId, target.kind),
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
			const firstActivation = row.state !== "host_active";
			row = await this.linkLease(row, lease, "host_active");
			if (firstActivation) await this.announceLocked(row.runId, lease.id);
		} else if (row.state === "project_acquired") {
			row = await this.transition(row, "host_active");
		}

		await this.deps.engine.launchPreparedRun({ runId: row.runId });
		if (row.state !== "launched") row = await this.transition(row, "launched");
		return { runId: row.runId };
	}

	private async ensureGrant(
		row: AdmissionRow,
		claims: readonly Claim[],
	): Promise<{ row: AdmissionRow; lease: ResourceLease }> {
		const model = this.deps.host.readModel();
		let waiter = row.waiterId
			? model.waiters.find((item) => item.id === row.waiterId)
			: model.waiters.find((item) => item.requestKey === row.requestKey);
		if (!waiter) {
			try {
				waiter = await this.deps.host.putWaiter({
					requestKey: row.requestKey,
					projectId: this.deps.projectId,
					claims,
				});
			} catch (error) {
				if (!(error instanceof ResourceError) || error.code !== "REFUSED") {
					throw error;
				}
				// An unknown pool or an underivable estimate never admits.
				throw await this.hold(
					row,
					"host",
					claims.map((item) => item.poolId),
					"definition",
					error.message,
				);
			}
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
				return { row: linked, lease: existing };
			}
			throw new Error(`lease ${existing.id} is already ${existing.state}`);
		}
		try {
			const result = await this.deps.host.tryGrant(waiter.id);
			if (!("kind" in result)) {
				return {
					row: await this.linkLease(row, result, "host_granted"),
					lease: result,
				};
			}
			const first = result.blockers[0];
			const waitingFor = [...new Set(result.blockers.map((b) => b.poolId))];
			throw await this.hold(
				row,
				"host",
				waitingFor.length > 0 ? waitingFor : claims.map((c) => c.poolId),
				this.hostHoldCode(first, claims),
				`admission is ${result.status}: ${result.blockers
					.map((b) => `${b.poolId} (${b.detail ?? b.code})`)
					.join(", ")}`,
				result.blockers,
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
				claims.map((item) => item.poolId),
				"coordinator",
				`resource coordinator is unavailable: ${message(error)}`,
			);
		}
	}

	/**
	 * Names RAM that the quota still allows but the machine cannot give, so
	 * the fix says to free memory instead of waiting for another run.
	 */
	private hostHoldCode(
		blocker: Blocker | undefined,
		claims: readonly Claim[],
	): string {
		const code = blockerCode(blocker);
		if (code !== "capacity" || !blocker) return code;
		const formula = this.deps
			.hostModel()
			.effectiveCapacities.find(
				(item) => poolIdOf(item.resourceId) === blocker.poolId,
			)?.ramFormula;
		const claim = claims.find((item) => item.poolId === blocker.poolId);
		if (!formula || claim?.amount == null) return code;
		const requested = BigInt(Math.ceil(claim.amount)) * 1024n * 1024n;
		return formula.quotaRemainingBytes >= requested
			? "headroom-exhausted"
			: code;
	}

	private leaseFor(
		row: AdmissionRow,
		waiterId = row.waiterId,
	): ResourceLease | null {
		const model = this.deps.host.readModel();
		return (
			model.leases.find((item) => item.id === row.hostLeaseId) ??
			model.leases.find((item) => item.waiterId === waiterId) ??
			null
		);
	}

	/**
	 * The lease's run identity. A run on a registry SSH host has no local
	 * session or process and survives a reboot of this machine, so it gets a
	 * remote marker and no kernel boot id: local evidence never frees its
	 * slot, project recovery adopts or releases it (`liveness.ts`).
	 */
	private runRef(runId: string, targetKind?: string): RunIdentity {
		const model = this.deps.host.readModel();
		const remote = targetKind === "ssh";
		return {
			runId,
			runDir: this.deps.registry.runDir(runId),
			sessionId: remote
				? `${REMOTE_RUN_SESSION_PREFIX}${targetKind}`
				: this.deps.sessionId(runId),
			kernelBootId: remote ? null : model.kernelBootId,
		};
	}

	private targetKindOf(row: AdmissionRow): string | undefined {
		return (row.resolution as unknown as ResolvedExecutionTarget | null)?.kind;
	}

	async releaseRun(runId: string, reason = "run reached a terminal state") {
		if (await this.deps.registry.hasPendingCleanup(runId)) return;
		const row = await this.byRun(runId);
		if (!row) return;
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
		try {
			await this.deps.host.renewOrAdopt(
				lease,
				this.runRef(runId, this.targetKindOf(row)),
			);
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
					if (
						lease?.state === "active" ||
						(lease?.state === "uncertain" && this.targetKindOf(row) === "ssh")
					)
						await this.renewRun(row.runId);
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
		const hostIncidents = this.deps
			.hostModel()
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

	async issues(): Promise<AdmissionIssue[]> {
		const rows = await this.openRows();
		const issues: AdmissionIssue[] = rows
			.filter(
				(row) =>
					row.holdCode != null &&
					!["capacity", "fifo", "generation"].includes(row.holdCode),
			)
			.map((row) => ({
				id: row.id,
				taskId: row.taskId,
				runId: row.runId,
				holdReason: row.holdReason,
				fix: refusalFix(row.holdCode),
				updatedAt: row.updatedAt,
			}));
		const model = this.deps.hostModel();
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
				fix: refusalFix(
					incident.kind === "ram-low-headroom"
						? "headroom-exhausted"
						: incident.kind === "cpu-pressure"
							? "cpu-pressure"
							: "external-occupancy",
					[incident.resourceId],
				),
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
		lease: ResourceLease | null,
	): Promise<void> {
		const target = row.resolution as unknown as ResolvedExecutionTarget;
		const normalized = this.normalize(target);
		// A remote run's lease is uncertain after a restart by design; the
		// caller adopts it (renewOrAdopt) once the run is known to be live.
		const adoptable =
			lease?.state === "active" ||
			(lease?.state === "uncertain" && target.kind === "ssh");
		if (normalized.host.length + normalized.project.length > 0 && !adoptable) {
			throw new Error(`live run ${row.runId} has no active fenced lease`);
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
				if (
					runHoldsClaim(task, run ?? { id: current.runId }) &&
					!(await this.deps.tasks.siblingsLive(current.runId))
				) {
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
		const lease = this.leaseFor(row);
		if (lease) {
			if (isReleasedLease(lease)) return;
			const slots = (await this.deps.projectSlotsOf?.(lease.id)) ?? [];
			await this.deps.host.release(lease, reason);
			const after = this.leaseFor(row);
			if (!after || !isReleasedLease(after)) {
				throw new Error("lease release is not durably proven");
			}
			await this.announceReleased(row.runId, slots);
			return;
		}
		if (!row.waiterId) return;
		const find = (): ResourceWaiter | undefined =>
			this.deps.host.readModel().waiters.find((w) => w.id === row.waiterId);
		const waiter = find();
		if (!waiter) throw new Error("waiter is missing from the coordinator");
		if (waiter.state === "waiting") {
			await this.deps.host.cancelWaiter(waiter.id, reason);
		}
		const after = find();
		if (after?.state !== "cancelled") {
			throw new Error(
				`waiter cancellation is not proven (state ${after?.state ?? "missing"})`,
			);
		}
	}

	private async announceLocked(runId: string, leaseId: string): Promise<void> {
		const slots = (await this.deps.projectSlotsOf?.(leaseId)) ?? [];
		if (slots.length === 0) return;
		const emitted = await this.deps.handle.withTx(async (tx) => {
			const out = [];
			for (const slot of slots) {
				out.push(
					await appendEvent(tx, {
						type: "resource.locked",
						runId,
						payload: slot,
					}),
				);
			}
			return out;
		});
		this.deps.bus.publish(emitted);
	}

	private async announceReleased(
		runId: string,
		slots: readonly { resourceId: string; slot: number }[],
	): Promise<void> {
		if (slots.length === 0) return;
		const emitted = await this.deps.handle.withTx(async (tx) => {
			const out = [];
			for (const slot of slots) {
				out.push(
					await appendEvent(tx, {
						type: "resource.released",
						payload: { ...slot, runId, forced: false },
					}),
				);
			}
			return out;
		});
		this.deps.bus.publish(emitted);
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
		waiter: ResourceWaiter,
	): Promise<AdmissionRow> {
		const emitted = await this.deps.handle.withTx(async (tx) => {
			const [next] = await tx
				.update(dispatchAdmissions)
				.set({
					waiterId: waiter.id,
					waiterGeneration: waiter.sequence.toString(),
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
		lease: ResourceLease,
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
		diagnostics: Blocker[] = [],
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
						fix: refusalFix(code, waitingFor),
						diagnostics: diagnostics.map((item) => ({ ...item })),
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

function isReleasedLease(lease: ResourceLease): boolean {
	return ["released", "reclaimed", "force_released"].includes(lease.state);
}
