import { randomUUID } from "node:crypto";
import type {
	CallContext,
	HostServices,
} from "../../../plugin-api/src/common.ts";
import type { ResourcePlugin } from "../../../plugin-api/src/resource.ts";
import type { ResourceStore } from "./store.ts";
import {
	type Actual,
	type AdmissionVerdict,
	type ClaimSetRequest,
	type HoldActor,
	type LeaseEvidence,
	type LeaseEvidenceReport,
	type PoolHold,
	type PoolSummary,
	ResourceError,
	type ResourceHeld,
	type ResourceLease,
	type ResourceReconcileReport,
	type ResourceWaiter,
	type RunIdentity,
} from "./types.ts";

export interface LeaseLiveness {
	/** A bare status means "checked just now". */
	inspect(lease: ResourceLease): Promise<LeaseEvidence | LeaseEvidenceReport>;
}

export interface ResourceCoordinatorOptions {
	host: HostServices;
	liveness: LeaseLiveness;
	plugins?: readonly ResourcePlugin[];
	leaseMs?: number;
	/** Observations older than this hold the pool. */
	maxObservationAgeMs?: number;
	callTimeoutMs?: number;
	/** How old liveness evidence may be and still authorize a force release. */
	livenessMaxAgeMs?: number;
	/** How far ahead of this clock an evidence timestamp may be. */
	clockSkewMs?: number;
}

const DEFAULT_LEASE_MS = 15 * 60_000;
const DEFAULT_OBSERVATION_AGE_MS = 30_000;
const DEFAULT_LIVENESS_MAX_AGE_MS = 30_000;
const DEFAULT_CLOCK_SKEW_MS = 1_000;

/**
 * The process-global owner of admission. The scheduler and projects use only
 * this class; it talks to plugins, and a plugin's answer can narrow capacity
 * or hold a pool but never grant, release or clear anything.
 */
export class ResourceCoordinator {
	private readonly leaseMs: number;
	private readonly plugins = new Map<string, ResourcePlugin>();
	private readonly subscriptions = new Map<string, Set<() => void>>();
	private wakeQueued = false;
	private model: {
		waiters: ResourceWaiter[];
		leases: ResourceLease[];
	} = { waiters: [], leases: [] };

	constructor(
		readonly store: ResourceStore,
		private readonly options: ResourceCoordinatorOptions,
	) {
		this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
	}

	/** Reloads the cached ledger the dispatch saga reads synchronously. */
	async refresh(): Promise<void> {
		this.model = await this.store.readLedger();
		await this.afterRefresh?.();
	}

	/** Lets a read model built on this ledger follow every transition. */
	afterRefresh: (() => Promise<void>) | null = null;

	readModel(): {
		processBootId: string;
		kernelBootId: string | null;
		waiters: ResourceWaiter[];
		leases: ResourceLease[];
	} {
		return {
			processBootId: this.store.processBootId,
			kernelBootId: this.store.kernelBootId,
			...structuredClone(this.model),
		};
	}

	private ctx(operation: string): CallContext {
		const timeout = this.options.callTimeoutMs ?? 10_000;
		return {
			operationId: `${operation}-${randomUUID()}`,
			deadline: this.options.host.clock.now() + timeout,
			signal: AbortSignal.timeout(timeout),
			host: this.options.host,
		};
	}

	/** Registers each plugin's proposed pools, which the owner's config named. */
	async registerPlugins(): Promise<void> {
		for (const plugin of this.options.plugins ?? []) {
			await this.registerPlugin(plugin);
		}
	}

	/** Null age: the pool stays usable between observations of a slow provider. */
	async registerPlugin(
		plugin: ResourcePlugin,
		options: { maxObservationAgeMs?: number | null } = {},
	): Promise<void> {
		const maxObservationAgeMs =
			options.maxObservationAgeMs === undefined
				? (this.options.maxObservationAgeMs ?? DEFAULT_OBSERVATION_AGE_MS)
				: options.maxObservationAgeMs;
		for (const proposal of await plugin.discover({}, this.ctx("discover"))) {
			await this.store.definePool({
				id: proposal.poolId,
				title: proposal.title,
				dimensions: proposal.dimensions,
				providerHardLimit: proposal.providerHardLimit,
				maxObservationAgeMs,
			});
			this.plugins.set(proposal.poolId, plugin);
		}
	}

	/**
	 * One observation pass. A failing plugin places an `observation-failed`
	 * hold: no new grants, live leases continue. Only a later good observation
	 * lifts it, and that never touches a hold of any other reason.
	 */
	async observeAll(): Promise<void> {
		let changed = false;
		for (const [poolId, plugin] of this.plugins) {
			try {
				const seen = await plugin.observe({ poolId }, this.ctx("observe"));
				if (seen.poolId !== poolId) {
					throw new Error(`observation answered for ${seen.poolId}`);
				}
				await this.store.recordObservation(seen);
				if (await this.store.clearHold(poolId, "observation-failed", "core")) {
					changed = true;
				}
			} catch (error) {
				await this.store.placeHold({
					poolId,
					reason: "observation-failed",
					actor: "core",
					detail: error instanceof Error ? error.message : String(error),
				});
			}
		}
		if (changed) this.wakeAll();
	}

	/** Binds a pool to the plugin that observes it; null makes it declared-only. */
	setPoolPlugin(poolId: string, plugin: ResourcePlugin | null): void {
		if (plugin) this.plugins.set(poolId, plugin);
		else this.plugins.delete(poolId);
	}

	canAdmit(
		request: Pick<ClaimSetRequest, "projectId" | "claims" | "scopes">,
	): Promise<AdmissionVerdict> {
		return this.store.canAdmit(request);
	}

	async putWaiter(request: ClaimSetRequest): Promise<ResourceWaiter> {
		const waiter = await this.store.putWaiter(request);
		await this.refresh();
		this.wakeProject(request.projectId);
		return waiter;
	}

	async tryGrant(waiterId: string): Promise<ResourceLease | ResourceHeld> {
		const result = await this.store.tryGrant(waiterId);
		await this.refresh();
		return result;
	}

	async activate(
		lease: Pick<ResourceLease, "id" | "fence">,
		run: RunIdentity,
	): Promise<ResourceLease> {
		const active = await this.store.activate(
			lease.id,
			lease.fence,
			run.runId,
			this.leaseMs,
			run,
		);
		await this.refresh();
		return active;
	}

	async renewOrAdopt(
		lease: Pick<ResourceLease, "id" | "fence">,
		run: RunIdentity,
	): Promise<void> {
		await this.store.renewOrAdopt(
			lease.id,
			lease.fence,
			run.runId,
			this.leaseMs,
			run,
		);
		await this.refresh();
	}

	/** Cancels a waiter. Parked and blocked waiters leave the queue the same way. */
	async cancelWaiter(waiterId: string, reason: string): Promise<boolean> {
		const cancelled = await this.store.cancelWaiter(waiterId, reason);
		await this.refresh();
		if (cancelled) this.wakeAll();
		return cancelled;
	}

	/**
	 * Releases a lease and settles its reservations. Unknown actuals stand as
	 * estimated charges. A lease with an open cleanup record stays `releasing`
	 * until its machine is proven gone, so its capacity is not reused early.
	 */
	async release(
		lease: Pick<ResourceLease, "id" | "fence">,
		reason: string,
		actuals: readonly Actual[] = [],
	): Promise<boolean> {
		// A grant that never activated launched nothing: its reservation is void.
		const current = await this.store.lease(lease.id);
		if (current?.state === "provisional") {
			const voided = await this.store.releaseUnlaunched(
				lease.id,
				lease.fence,
				reason,
			);
			await this.refresh();
			this.wakeAll();
			return voided;
		}
		const marked = await this.store.markReleasing(
			lease.id,
			lease.fence,
			reason,
		);
		await this.refresh();
		if (marked.state !== "releasing") return false;
		if ((await this.store.openCleanups()).some((r) => r.leaseId === lease.id)) {
			return false;
		}
		const done = await this.store.finishRelease(lease.id, lease.fence, actuals);
		await this.refresh();
		this.wakeAll();
		return done;
	}

	/** The owner's override. It needs conclusive evidence about the run. */
	async forceRelease(input: {
		leaseId: string;
		expectedFence: number;
		actor: string;
		reason: string;
	}): Promise<boolean> {
		const lease = await this.store.lease(input.leaseId);
		if (!lease) {
			throw new ResourceError(`unknown lease '${input.leaseId}'`, "NOT_FOUND");
		}
		if (lease.fence !== input.expectedFence) {
			throw new ResourceError("force release fence is stale", "STALE_FENCE");
		}
		if (lease.state === "force_released") return false;
		if (lease.state === "released" || lease.state === "reclaimed") {
			throw new ResourceError(
				`lease is already ${lease.state}`,
				"INVALID_TRANSITION",
			);
		}
		const evidence = this.reportOf(await this.options.liveness.inspect(lease));
		if (evidence.status === "unknown" || !this.isFresh(evidence)) {
			throw new ResourceError(
				"force release requires fresh conclusive liveness evidence",
				"INVALID_TRANSITION",
			);
		}
		const done = await this.store.forceRelease(
			lease.id,
			lease.fence,
			input.actor,
			input.reason,
			{
				expectedFence: String(input.expectedFence),
				actualFence: String(lease.fence),
				liveness: evidence,
			},
		);
		await this.refresh();
		this.wakeAll();
		return done;
	}

	private reportOf(
		evidence: LeaseEvidence | LeaseEvidenceReport,
	): LeaseEvidenceReport {
		return typeof evidence === "string"
			? { status: evidence, checkedAt: this.options.host.clock.now() }
			: evidence;
	}

	/** Neither old evidence nor a clock that moved backwards can authorize. */
	private isFresh(evidence: LeaseEvidenceReport): boolean {
		const now = this.options.host.clock.now();
		const maxAge = this.options.livenessMaxAgeMs ?? DEFAULT_LIVENESS_MAX_AGE_MS;
		const skew = this.options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
		return (
			evidence.checkedAt <= now + skew && now - evidence.checkedAt <= maxAge
		);
	}

	async reconcile(): Promise<ResourceReconcileReport> {
		const report = await this.store.reconcile(async (lease) => {
			const evidence = this.reportOf(
				await this.options.liveness.inspect(lease),
			);
			// Stale evidence proves nothing, so it can neither adopt nor reclaim.
			return this.isFresh(evidence) ? evidence.status : "unknown";
		});
		await this.refresh();
		if (report.reclaimed > 0 || report.released > 0) this.wakeAll();
		return report;
	}

	/** Takes a pool out of service. The brain may add this hold, never clear it. */
	async placeOperatorHold(input: {
		poolId: string;
		actor: Exclude<HoldActor, "core">;
		detail?: string;
		until?: number | null;
	}): Promise<PoolHold> {
		const hold = await this.store.placeHold({ ...input, reason: "operator" });
		await this.refresh();
		return hold;
	}

	async clearOperatorHold(poolId: string): Promise<boolean> {
		const cleared = await this.store.clearHold(poolId, "operator", "owner");
		await this.refresh();
		if (cleared) this.wakeAll();
		return cleared;
	}

	summaries(): Promise<PoolSummary[]> {
		return this.store.summaries();
	}

	subscribe(projectId: string, wake: () => void): () => void {
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

	/** Tells every project that capacity may have changed. */
	wake(): void {
		this.wakeAll();
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
		this.subscriptions.clear();
		this.store.close();
	}
}
