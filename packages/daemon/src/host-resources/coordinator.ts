import type { HostProbeKind } from "@mfw/core/host-observation";
import {
	HostObservationService,
	type HostObservationServiceOptions,
} from "../host-observation-service.ts";
import {
	type DetectedResourceApplyOptions,
	type DetectedResourceApplyResult,
	type DetectedResourcesApplyResult,
	type HostBindingWriteOptions,
	type HostDefinitionWriteOptions,
	type HostResourceStore,
	HostStoreError,
} from "./store.ts";
import type {
	ActiveLease,
	Grant,
	Held,
	HostAdmissionSnapshot,
	HostAuditEntry,
	HostLease,
	HostResourceBinding,
	HostResourceCoordinatorPort,
	HostResourceDefinition,
	HostResourceReadModel,
	ImmutableHostRequest,
	LeaseLivenessInspector,
	LivenessEvidence,
	OwnerProof,
	ProjectIdentity,
	ReconcileCause,
	ReconcileReport,
	RunRef,
	Unsubscribe,
	Waiter,
} from "./types.ts";

export type HostTransition =
	| "provisional"
	| "active"
	| "renewed"
	| "releasing"
	| "released"
	| "reclaimed"
	| "uncertain"
	| "force_released";

export interface HostResourceCoordinatorOptions {
	liveness: LeaseLivenessInspector;
	now?: () => number;
	leaseMs?: number;
	livenessMaxAgeMs?: number;
	clockSkewMs?: number;
	observations?: HostObservationServiceOptions;
	/** Deterministic crash seam used by transition-by-transition restart tests. */
	afterTransition?: (
		transition: HostTransition,
		lease: HostLease,
	) => void | Promise<void>;
}

/**
 * Process-global owner of the durable host ledger. Projects receive only this
 * class through HostResourceCoordinatorPort; it contains no scheduler or
 * ProjectServices reference and wakeups are one-way subscriptions.
 */
export class HostResourceCoordinator implements HostResourceCoordinatorPort {
	private model: HostResourceReadModel;
	private readonly now: () => number;
	private readonly leaseMs: number;
	private readonly livenessMaxAgeMs: number;
	private readonly clockSkewMs: number;
	private readonly subscriptions = new Map<string, Set<() => void>>();
	private wakeQueued = false;
	readonly observations: HostObservationService;

	private constructor(
		readonly store: HostResourceStore,
		private readonly options: HostResourceCoordinatorOptions,
		model: HostResourceReadModel,
	) {
		this.model = model;
		this.now = options.now ?? (() => Date.now());
		this.leaseMs = options.leaseMs ?? 15 * 60_000;
		this.livenessMaxAgeMs = options.livenessMaxAgeMs ?? 30_000;
		this.clockSkewMs = options.clockSkewMs ?? 1_000;
		this.observations = new HostObservationService(
			store,
			async (meaningful) => {
				await this.refresh();
				if (meaningful) this.wakeAll();
			},
			options.observations,
		);
	}

	static async create(
		store: HostResourceStore,
		options: HostResourceCoordinatorOptions,
	): Promise<HostResourceCoordinator> {
		return new HostResourceCoordinator(store, options, await store.readModel());
	}

	get hostId(): string {
		return this.model.hostId;
	}

	get coordinatorId(): string {
		return this.model.coordinatorId;
	}

	readModel(): HostResourceReadModel {
		return structuredClone(this.model);
	}

	captureAdmissionSnapshot(): HostAdmissionSnapshot {
		const health = Object.fromEntries(
			this.model.health.map((item) => {
				const generation = item.detail?.generation;
				const rawSequence =
					generation && typeof generation === "object"
						? (generation as Record<string, unknown>).sequence
						: null;
				const sequence =
					typeof rawSequence === "string" &&
					/^(?:0|[1-9][0-9]*)$/.test(rawSequence)
						? BigInt(rawSequence)
						: null;
				return [
					item.kind,
					{ checkedAt: item.checkedAt, sequence, result: item.result },
				];
			}),
		);
		return {
			generation: this.model.generation,
			capturedAt: this.now(),
			processBootId: this.model.processBootId,
			kernelBootId: this.model.kernelBootId,
			definitions: Object.fromEntries(
				this.model.definitions.map((item) => [item.id, item.version]),
			),
			bindings: Object.fromEntries(
				this.model.bindings.map((item) => [item.id, item.version]),
			),
			health,
			observations: Object.fromEntries(
				this.model.observations.map((item) => [item.bindingId, item.sequence]),
			),
		};
	}

	private async refresh(): Promise<void> {
		this.model = await this.store.readModel();
	}

	async registerProject(input: {
		identity: ProjectIdentity;
		root: string;
		displayName: string;
		metadata?: Record<string, unknown>;
	}): Promise<void> {
		await this.store.registerProject(input);
		await this.refresh();
	}

	async detachProject(projectId: string): Promise<void> {
		await this.store.detachProject(projectId);
		this.subscriptions.delete(projectId);
		await this.refresh();
	}

	async putDefinition(
		definition: HostResourceDefinition,
		options: HostDefinitionWriteOptions = {},
	): Promise<HostResourceDefinition> {
		const result = await this.store.putDefinition(definition, options);
		await this.refresh();
		this.wakeAll();
		return result;
	}

	async putBinding(
		binding: HostResourceBinding,
		options: HostBindingWriteOptions = {},
	): Promise<HostResourceBinding> {
		const result = await this.store.putBinding(binding, options);
		await this.refresh();
		this.wakeAll();
		return result;
	}

	async applyDetectedResource(
		definition: HostResourceDefinition,
		bindings: readonly HostResourceBinding[],
		options: DetectedResourceApplyOptions,
	): Promise<DetectedResourceApplyResult> {
		const result = await this.store.applyDetectedResource(
			definition,
			bindings,
			options,
		);
		await this.refresh();
		this.wakeAll();
		return result;
	}

	async applyDetectedResources(
		resources: readonly {
			definition: HostResourceDefinition;
			bindings: readonly HostResourceBinding[];
		}[],
		options: DetectedResourceApplyOptions,
	): Promise<DetectedResourcesApplyResult> {
		const result = await this.store.applyDetectedResources(resources, options);
		await this.refresh();
		this.wakeAll();
		return result;
	}

	async setDefinitionDrain(input: {
		resourceId: string;
		expectedVersion: bigint;
		draining: boolean;
		actor: string;
		reason?: string;
	}): Promise<HostResourceDefinition> {
		const definition = this.model.definitions.find(
			(item) => item.id === input.resourceId,
		);
		if (!definition) {
			throw new HostStoreError(
				`unknown host resource '${input.resourceId}'`,
				"NOT_FOUND",
			);
		}
		return this.putDefinition(
			{ ...definition, draining: input.draining },
			{
				expectedVersion: input.expectedVersion,
				actor: input.actor,
				reason:
					input.reason ??
					(input.draining ? "operator enabled drain" : "operator ended drain"),
			},
		);
	}

	async setDefinitionEnabled(input: {
		resourceId: string;
		expectedVersion: bigint;
		enabled: boolean;
		actor: string;
		reason: string;
	}): Promise<HostResourceDefinition> {
		const definition = this.model.definitions.find(
			(item) => item.id === input.resourceId,
		);
		if (!definition) {
			throw new HostStoreError(
				`unknown host resource '${input.resourceId}'`,
				"NOT_FOUND",
			);
		}
		return this.putDefinition(
			{ ...definition, enabled: input.enabled },
			{
				expectedVersion: input.expectedVersion,
				actor: input.actor,
				reason: input.reason,
			},
		);
	}

	async refreshObservations(): Promise<HostResourceReadModel> {
		await this.observations.refresh();
		await this.refresh();
		return this.readModel();
	}

	/** Returns which adapters participated in the refresh (the same set for every caller coalesced onto one poll), so detection never mistakes an older stored probe for fresh evidence. */
	async refreshObservationsForDetection(): Promise<{
		model: HostResourceReadModel;
		probedKinds: readonly HostProbeKind[];
	}> {
		const probedKinds = await this.observations.refresh();
		await this.refresh();
		return { model: this.readModel(), probedKinds };
	}

	auditEntries(
		input: { after?: bigint; limit?: number } = {},
	): Promise<HostAuditEntry[]> {
		return this.store.auditEntries(input);
	}

	async putWaiter(request: ImmutableHostRequest): Promise<Waiter> {
		const waiter = await this.store.putWaiter(request);
		await this.refresh();
		this.wakeProject(request.projectId);
		return waiter;
	}

	async tryGrant(
		waiterId: string,
		expectedGeneration: bigint,
		snapshot?: HostAdmissionSnapshot,
	): Promise<Grant | Held> {
		const result = await this.store.tryGrant(
			waiterId,
			expectedGeneration,
			snapshot,
		);
		await this.refresh();
		if (!("kind" in result)) {
			await this.options.afterTransition?.("provisional", result);
		}
		return result;
	}

	async activate(
		grantId: string,
		fence: bigint,
		run: RunRef,
	): Promise<ActiveLease> {
		const lease = await this.store.activate(grantId, fence, run, this.leaseMs);
		await this.refresh();
		await this.options.afterTransition?.("active", lease);
		return lease;
	}

	async renewOrAdopt(
		leaseId: string,
		fence: bigint,
		owner: OwnerProof,
	): Promise<void> {
		await this.store.renewOrAdopt(leaseId, fence, owner, this.leaseMs);
		await this.refresh();
		const lease = await this.store.lease(leaseId);
		if (lease) await this.options.afterTransition?.("renewed", lease);
	}

	async cancelOrRelease(
		id: string,
		fence: bigint,
		reason: string,
	): Promise<void> {
		const waiterResult = await this.store.cancelWaiter(id, fence, reason);
		if (waiterResult !== "not_waiter") {
			await this.refresh();
			if (waiterResult === "cancelled") this.wakeAll();
			return;
		}
		const releasing = await this.store.markReleasing(id, fence, reason);
		await this.refresh();
		if (releasing.state !== "releasing") return; // terminal idempotent retry
		await this.options.afterTransition?.("releasing", releasing);
		await this.store.finishRelease(id, fence);
		await this.refresh();
		const released = await this.store.lease(id);
		if (released) await this.options.afterTransition?.("released", released);
		this.wakeAll();
	}

	private evidenceIsFresh(evidence: LivenessEvidence): boolean {
		const age = this.now() - evidence.checkedAt;
		return age >= -this.clockSkewMs && age <= this.livenessMaxAgeMs;
	}

	/** Guarded override only; this method has no process-signalling dependency. */
	async forceRelease(input: {
		leaseId: string;
		expectedFence: bigint;
		actor: string;
		reason: string;
	}): Promise<boolean> {
		if (!input.actor.trim() || !input.reason.trim()) {
			throw new HostStoreError("force release requires actor and reason");
		}
		const lease = await this.store.lease(input.leaseId);
		if (!lease)
			throw new HostStoreError(`unknown lease '${input.leaseId}'`, "NOT_FOUND");
		if (lease.fence !== input.expectedFence) {
			throw new HostStoreError("force release fence is stale", "STALE_FENCE");
		}
		if (lease.state === "force_released") return false;
		if (["released", "reclaimed"].includes(lease.state)) {
			throw new HostStoreError(
				`lease is already ${lease.state}`,
				"INVALID_TRANSITION",
			);
		}
		const evidence = await this.options.liveness.inspect(lease);
		if (
			!this.evidenceIsFresh(evidence) ||
			(evidence.status !== "live" && evidence.status !== "absent")
		) {
			throw new HostStoreError(
				"force release requires fresh conclusive liveness evidence",
				"INVALID_TRANSITION",
			);
		}
		const changed = await this.store.forceRelease(
			input.leaseId,
			input.expectedFence,
			input.actor,
			input.reason,
			{ liveness: evidence },
		);
		await this.refresh();
		const released = await this.store.lease(input.leaseId);
		if (released)
			await this.options.afterTransition?.("force_released", released);
		this.wakeAll();
		return changed;
	}

	async reconcile(cause: ReconcileCause): Promise<ReconcileReport> {
		const report: ReconcileReport = {
			cause,
			examined: 0,
			adopted: 0,
			reclaimed: 0,
			uncertain: 0,
			released: 0,
			unchanged: 0,
		};
		for (const lease of await this.store.liveLeases()) {
			report.examined++;
			if (lease.state === "releasing") {
				const changed = await this.store.finishRelease(
					lease.id,
					lease.fence,
					"recovery",
				);
				if (changed) report.released++;
				else report.unchanged++;
				continue;
			}
			// The admission saga activates a grant before launching work, so a
			// provisional lease has no external owner: reclaim it after a crash
			// without consulting project state or a TTL.
			if (lease.state === "provisional" && lease.run === null) {
				const changed = await this.store.recoveryTransition(
					lease.id,
					lease.fence,
					"reclaimed",
					"recovery",
					"unactivated provisional grant from an earlier process boot",
				);
				if (changed) report.reclaimed++;
				else report.unchanged++;
				continue;
			}
			if (
				lease.run?.kernelBootId &&
				this.store.identity.kernelBootId &&
				lease.run.kernelBootId !== this.store.identity.kernelBootId
			) {
				const changed = await this.store.recoveryTransition(
					lease.id,
					lease.fence,
					"reclaimed",
					"recovery",
					"kernel boot id changed",
				);
				if (changed) {
					report.reclaimed++;
					await this.options.afterTransition?.(
						"reclaimed",
						(await this.store.lease(lease.id)) as HostLease,
					);
				} else report.unchanged++;
				continue;
			}

			const evidence = await this.options.liveness.inspect(lease);
			const status = this.evidenceIsFresh(evidence)
				? evidence.status
				: "unavailable";
			if (status === "absent") {
				const changed = await this.store.recoveryTransition(
					lease.id,
					lease.fence,
					"reclaimed",
					"recovery",
					evidence.detail ?? "process absence proven",
				);
				if (changed) report.reclaimed++;
				else report.unchanged++;
			} else if (status === "live" && lease.run) {
				const changed = await this.store.recoveryTransition(
					lease.id,
					lease.fence,
					"active",
					"recovery",
					"live run adopted",
				);
				if (
					changed ||
					lease.ownerProcessBootId !== this.store.identity.processBootId
				)
					report.adopted++;
				else report.unchanged++;
			} else {
				const changed = await this.store.recoveryTransition(
					lease.id,
					lease.fence,
					"uncertain",
					"recovery",
					evidence.detail ?? "liveness unavailable",
				);
				if (changed) report.uncertain++;
				else report.unchanged++;
			}
		}
		await this.refresh();
		if (report.reclaimed > 0 || report.released > 0) this.wakeAll();
		return report;
	}

	subscribe(projectId: string, wake: () => void): Unsubscribe {
		let listeners = this.subscriptions.get(projectId);
		if (!listeners) {
			listeners = new Set();
			this.subscriptions.set(projectId, listeners);
		}
		listeners.add(wake);
		return () => {
			listeners?.delete(wake);
			if (listeners?.size === 0) this.subscriptions.delete(projectId);
		};
	}

	private wakeProject(projectId: string): void {
		for (const wake of this.subscriptions.get(projectId) ?? []) wake();
	}

	private wakeAll(): void {
		if (this.wakeQueued) return;
		this.wakeQueued = true;
		queueMicrotask(() => {
			this.wakeQueued = false;
			for (const listeners of this.subscriptions.values()) {
				for (const wake of listeners) wake();
			}
		});
	}

	close(): void {
		void this.observations.stop();
		this.subscriptions.clear();
		this.store.close();
	}

	async shutdown(): Promise<void> {
		await this.observations.stop();
		this.subscriptions.clear();
		this.store.close();
	}
}

export { HostObservationService } from "../host-observation-service.ts";
