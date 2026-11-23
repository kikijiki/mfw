import type { RunPodProviderClient } from "../runpod-account-service.ts";
import type { RunPodPod } from "../runpod-client.ts";
import { RUNPOD_OWNERSHIP_ENV } from "../runpod-ownership.ts";
import {
	type RunPodMachinePolicy,
	RunPodPlacementRequestSchema,
} from "../runpod-policy.ts";
import { RunPodResource } from "./builtin/runpod.ts";
import type { ResourceCoordinator } from "./coordinator.ts";
import { type Claim, ResourceError, type ResourceLease } from "./types.ts";

/** How long one provider inventory serves pool observations. */
const OBSERVED_PODS_TTL_MS = 15_000;

/** What the RunPod control plane reports to the resource core. */
export interface RunPodCorePort {
	/** Commits the cleanup record; throws if no live lease covers this run. */
	beforeCreate(runId: string, ref: string): Promise<void>;
	created(ref: string, podId: string): Promise<void>;
	/** Closes the record against a fresh inventory, then frees the capacity. */
	absent(ref: string, ownershipEncoded: string): Promise<void>;
	/** Records whose lease the control plane already knows is gone. */
	settle(isAbsent: (ref: string) => Promise<string | null>): Promise<void>;
	policyChanged(policy: RunPodMachinePolicy): Promise<void>;
}

/**
 * Connects the RunPod control plane to the core. The control plane keeps the
 * provider protocol (ownership proof, SSH bootstrap, delete confirmation); the
 * core owns the account's capacity and the cleanup record, so a lease keeps
 * its capacity until an inventory proves its machine is gone.
 */
export class RunPodCoreBridge implements RunPodCorePort {
	private plugin: RunPodResource;
	private policy: RunPodMachinePolicy;
	private observed: { at: number; pods: Promise<RunPodPod[]> } | null = null;

	constructor(
		private readonly deps: {
			coordinator: ResourceCoordinator;
			client: RunPodProviderClient;
			policy: RunPodMachinePolicy;
			now: () => number;
		},
	) {
		this.policy = deps.policy;
		this.plugin = this.pluginFor(deps.policy);
	}

	private pluginFor(policy: RunPodMachinePolicy): RunPodResource {
		const { client } = this.deps;
		return new RunPodResource({
			policy,
			client: {
				credentialReady: () => client.credentialReady(),
				getAccountBalance: () => client.getAccountBalance(),
				createPod: (input) => client.createPod(input),
				deletePod: (podId) => client.deletePod(podId),
				listPods: () => this.podsOutsideLeases(),
			},
		});
	}

	/**
	 * What narrows the account beyond our own leases. A pod bound to an open
	 * cleanup record is already counted by its lease.
	 */
	private async podsOutsideLeases(): Promise<RunPodPod[]> {
		const pods = await this.observedPods();
		const leased = new Set(
			(await this.deps.coordinator.store.openCleanups()).map(
				(record) => record.externalId,
			),
		);
		return pods.filter((pod) => !leased.has(pod.id));
	}

	/** Pool observations share one recent inventory instead of polling RunPod. */
	private observedPods(): Promise<RunPodPod[]> {
		const now = this.deps.now();
		if (this.observed && now - this.observed.at < OBSERVED_PODS_TTL_MS) {
			return this.observed.pods;
		}
		const pods = this.deps.client.listPods();
		this.observed = { at: now, pods };
		pods.catch(() => {
			if (this.observed?.pods === pods) this.observed = null;
		});
		return pods;
	}

	get poolId(): string | null {
		return this.plugin.poolId;
	}

	async start(): Promise<void> {
		// Freshness is enforced where it matters: provisioning re-reads inventory.
		try {
			await this.deps.coordinator.registerPlugin(this.plugin, {
				maxObservationAgeMs: null,
			});
		} catch (error) {
			if (!(error instanceof ResourceError) || error.code !== "CONFLICT") {
				throw error;
			}
			// A cap the owner removed keeps its dimension, since past charges
			// refer to it. New claims follow the policy and no longer use it.
			if (this.poolId) {
				this.deps.coordinator.setPoolPlugin(this.poolId, this.plugin);
			}
		}
	}

	async policyChanged(policy: RunPodMachinePolicy): Promise<void> {
		this.policy = policy;
		this.plugin = this.pluginFor(policy);
		await this.start();
	}

	/** The account capacity one placement reserves until its machine is gone. */
	claimsFor(requestedShape: unknown): Claim[] {
		const poolId = this.poolId;
		if (!poolId) return [];
		const parsed = RunPodPlacementRequestSchema.safeParse(requestedShape);
		if (!parsed.success) {
			throw new ResourceError(
				"the RunPod placement request is invalid",
				"REFUSED",
			);
		}
		const request = parsed.data;
		const claims: Claim[] = [
			{ poolId, dimension: "burn", amount: request.maxHourlyPrice },
		];
		if (this.policy.enabled && this.policy.maxConcurrentPods !== undefined) {
			claims.push({ poolId, dimension: "pods", amount: 1 });
		}
		if (this.policy.enabled && this.policy.maxDailySpend !== undefined) {
			const worstCase = Math.min(
				request.maxSpend,
				request.maxHourlyPrice * (request.maxRuntimeMinutes / 60),
			);
			claims.push({ poolId, dimension: "daily", amount: worstCase });
		}
		return claims;
	}

	private leaseOf(runId: string, poolId: string): ResourceLease | null {
		const model = this.deps.coordinator.readModel();
		for (const lease of model.leases) {
			if (lease.runId !== runId || lease.state !== "active") continue;
			const waiter = model.waiters.find((w) => w.id === lease.waiterId);
			if (waiter?.claims.some((claim) => claim.poolId === poolId)) return lease;
		}
		return null;
	}

	async beforeCreate(runId: string, ref: string): Promise<void> {
		const poolId = this.poolId;
		if (!poolId) {
			throw new ResourceError("RunPod is not enabled", "REFUSED");
		}
		await this.deps.coordinator.refresh();
		const lease = this.leaseOf(runId, poolId);
		if (!lease) {
			throw new ResourceError(
				`run ${runId} holds no active lease on ${poolId}`,
				"REFUSED",
				"Start the task through dispatch admission so its RunPod capacity is reserved.",
			);
		}
		await this.deps.coordinator.store.openCleanup({
			leaseId: lease.id,
			fence: lease.fence,
			poolId,
			ownershipToken: ref,
		});
		await this.deps.coordinator.refresh();
	}

	async created(ref: string, podId: string): Promise<void> {
		try {
			await this.deps.coordinator.store.bindCleanup(ref, podId);
		} catch (error) {
			// A pod adopted from before this record existed has nothing to bind.
			if (!(error instanceof ResourceError) || error.code !== "NOT_FOUND") {
				throw error;
			}
		}
	}

	async absent(ref: string, ownershipEncoded: string): Promise<void> {
		const { coordinator, client } = this.deps;
		const record = (await coordinator.store.openCleanups()).find(
			(item) => item.ownershipToken === ref,
		);
		if (!record) return;
		const pods = await client.listPods();
		this.observed = null;
		await coordinator.store.closeCleanup(
			ref,
			pods.map((pod) => ({
				externalId: pod.id,
				ownershipToken:
					pod.env[RUNPOD_OWNERSHIP_ENV] === ownershipEncoded ? ref : null,
			})),
		);
		await coordinator.refresh();
		const lease = coordinator
			.readModel()
			.leases.find((item) => item.id === record.leaseId);
		if (lease?.state === "releasing") {
			await coordinator.release(lease, "machine proven gone");
		}
	}

	async settle(
		isAbsent: (ref: string) => Promise<string | null>,
	): Promise<void> {
		const poolId = this.poolId;
		if (!poolId) return;
		for (const record of await this.deps.coordinator.store.openCleanups(
			poolId,
		)) {
			const encoded = await isAbsent(record.ownershipToken);
			if (encoded !== null) await this.absent(record.ownershipToken, encoded);
		}
	}
}
