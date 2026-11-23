import type { CallContext } from "../../../../plugin-api/src/common.ts";
import {
	type ExternalObject,
	type MachinePlugin,
	OwnershipTokenSchema,
	type ProvisionResult,
	type TeardownResult,
} from "../../../../plugin-api/src/machine.ts";
import { formatPoolId } from "../../../../plugin-api/src/pool-id.ts";
import type {
	CostQuote,
	Dimension,
	DimensionObservation,
	Observation,
	PoolProposal,
	Shape,
	UsageReport,
	UsageTarget,
} from "../../../../plugin-api/src/resource.ts";
import type { MachineEndpoint } from "../../../../plugin-api/src/target.ts";
import {
	EXPERIMENTAL_REMOTE_ENV,
	remoteTargetEnabled,
} from "../../remote-experimental.ts";
import type { RunPodProviderClient } from "../../runpod-account-service.ts";
import type { RunPodPod } from "../../runpod-client.ts";
import { RUNPOD_OWNERSHIP_ENV } from "../../runpod-ownership.ts";
import {
	type EnabledRunPodMachinePolicy,
	effectiveRunPodPolicy,
	enforceRunPodRequest,
	type RunPodMachinePolicy,
	type RunPodPlacementRequest,
	RunPodPlacementRequestSchema,
	RunPodPolicyError,
} from "../../runpod-policy.ts";

export interface RunPodResourceOptions {
	policy: RunPodMachinePolicy;
	/** Credentials stay behind this port; the plugin never holds the key. */
	client: RunPodProviderClient;
	/** Omitted reads the experimental-remote switch; off by default. */
	remoteEnabled?: boolean;
}

/** Shape attribute carrying the validated placement request as JSON. */
export const RUNPOD_REQUEST_ATTRIBUTE = "request";

const OWNERSHIP_PREFIX = "v2";

/**
 * `runpod`: the account-level machine resource. Cleanup records, leases and
 * caps live in the core. Remote targets stay off unless the experimental
 * switch is set, and only creation is gated: inventory and teardown always
 * work, so an existing machine can always be cleaned up.
 */
export class RunPodResource implements MachinePlugin {
	readonly poolId: string | null;
	private readonly policy: EnabledRunPodMachinePolicy | null;
	private readonly remoteEnabled: boolean;

	constructor(private readonly options: RunPodResourceOptions) {
		this.policy = options.policy.enabled ? options.policy : null;
		this.poolId = this.policy
			? formatPoolId({
					plugin: "runpod",
					instance: this.policy.accountId.toLowerCase(),
				})
			: null;
		this.remoteEnabled = remoteTargetEnabled(options.remoteEnabled);
	}

	private dimensions(policy: EnabledRunPodMachinePolicy): Dimension[] {
		const out: Dimension[] = [
			{
				kind: "quantity",
				name: "burn",
				unit: "usd_per_hour",
				total: policy.maxAggregateHourlyPrice,
			},
		];
		if (policy.maxConcurrentPods !== undefined) {
			out.push({
				kind: "quantity",
				name: "pods",
				unit: "pod",
				total: policy.maxConcurrentPods,
			});
		}
		if (policy.maxDailySpend !== undefined) {
			out.push({
				kind: "window",
				name: "daily",
				unit: "usd",
				limit: policy.maxDailySpend,
				window: { type: "calendar", period: "day" },
			});
		}
		return out;
	}

	async discover(
		_params: Record<string, never>,
		_ctx: CallContext,
	): Promise<PoolProposal[]> {
		if (!this.policy || !this.poolId) return [];
		return [
			{
				poolId: this.poolId,
				title: `RunPod ${this.policy.accountId}`,
				providerHardLimit: false,
				dimensions: this.dimensions(this.policy),
			},
		];
	}

	private requirePolicy(poolId: string): EnabledRunPodMachinePolicy {
		if (!this.policy || poolId !== this.poolId) {
			throw new Error(`unknown pool ${poolId}`);
		}
		return this.policy;
	}

	/** The token on a pod, or null when the pod is not in our namespace. */
	private tokenOf(pod: RunPodPod): string | null {
		const prefix = `${OWNERSHIP_PREFIX}:${this.policy?.ownershipNamespace}:`;
		const value = pod.env[RUNPOD_OWNERSHIP_ENV];
		if (!this.policy || !value?.startsWith(prefix)) return null;
		const token = OwnershipTokenSchema.safeParse(value.slice(prefix.length));
		return token.success ? token.data : null;
	}

	async observe(
		params: { poolId: string },
		ctx: CallContext,
	): Promise<Observation> {
		const policy = this.requirePolicy(params.poolId);
		const observedAt = ctx.host.clock.now();
		const pods = await this.options.client.listPods();
		// Our own pods are already counted by their leases. Anything else on the
		// account narrows capacity, and an unpriced pod makes the burn unknowable.
		const foreign = pods.filter((pod) => this.tokenOf(pod) === null);
		const prices = foreign.map((pod) => pod.adjustedCostPerHr ?? pod.costPerHr);
		const unknownBurn = prices.some((price) => price === null);
		const foreignBurn = prices.reduce<number>((sum, p) => sum + (p ?? 0), 0);
		const dimensions: DimensionObservation[] = [
			{
				kind: "quantity",
				name: "burn",
				total: unknownBurn
					? 0
					: Math.max(0, policy.maxAggregateHourlyPrice - foreignBurn),
				used: unknownBurn ? null : foreignBurn,
			},
		];
		if (policy.maxConcurrentPods !== undefined) {
			dimensions.push({
				kind: "quantity",
				name: "pods",
				total: Math.max(0, policy.maxConcurrentPods - foreign.length),
				used: foreign.length,
			});
		}
		if (policy.maxDailySpend !== undefined) {
			dimensions.push({
				kind: "window",
				name: "daily",
				settled: null,
				remaining: null,
			});
		}
		return {
			poolId: params.poolId,
			observedAt,
			health: unknownBurn ? "degraded" : "ok",
			dimensions,
			...(unknownBurn
				? { detail: "a pod on this account has no trustworthy hourly price" }
				: {}),
		};
	}

	private requestOf(shape: Shape): RunPodPlacementRequest {
		const raw = shape.attributes[RUNPOD_REQUEST_ATTRIBUTE];
		if (typeof raw !== "string") {
			throw new RunPodPolicyError(
				"request_missing",
				"shape carries no RunPod placement request",
			);
		}
		return RunPodPlacementRequestSchema.parse(JSON.parse(raw));
	}

	async quote(
		params: { poolId: string; shape: Shape },
		ctx: CallContext,
	): Promise<CostQuote> {
		this.requirePolicy(params.poolId);
		const request = this.requestOf(params.shape);
		const hours = request.maxRuntimeMinutes / 60;
		return {
			poolId: params.poolId,
			currency: "usd",
			perUnitHour: request.maxHourlyPrice,
			worstCase: Math.min(request.maxSpend, request.maxHourlyPrice * hours),
			asOf: ctx.host.clock.now(),
		};
	}

	/** RunPod reports no per-lease actuals here: unknown stands as the estimate. */
	async usage(
		params: { target: UsageTarget },
		ctx: CallContext,
	): Promise<UsageReport> {
		this.requirePolicy(params.target.poolId);
		return {
			poolId: params.target.poolId,
			usd: null,
			tokens: null,
			requests: null,
			slotHours: null,
			asOf: ctx.host.clock.now(),
		};
	}

	async provision(
		params: {
			leaseId: string;
			poolId: string;
			shape: Shape;
			ownershipToken: string;
			sshPublicKey: string;
		},
		_ctx: CallContext,
	): Promise<ProvisionResult> {
		const policy = this.requirePolicy(params.poolId);
		if (!this.remoteEnabled) {
			return {
				status: "refused",
				reason: `remote targets are experimental and off; set ${EXPERIMENTAL_REMOTE_ENV}=1 to enable them`,
			};
		}
		let request: RunPodPlacementRequest;
		try {
			request = enforceRunPodRequest(
				this.requestOf(params.shape),
				effectiveRunPodPolicy(policy),
			);
		} catch (error) {
			return {
				status: "refused",
				reason: error instanceof Error ? error.message : String(error),
			};
		}
		// The token is the idempotency key: a retry finds the pod it already made.
		let existing: RunPodPod | undefined;
		try {
			existing = (await this.options.client.listPods()).find(
				(pod) => this.tokenOf(pod) === params.ownershipToken,
			);
		} catch {
			// Without an inventory a create could duplicate a billing pod.
			return { status: "failed", reason: "RunPod inventory is unavailable" };
		}
		if (existing) return { status: "created", externalId: existing.id };
		try {
			const pod = await this.options.client.createPod({
				name: `mfw-${params.leaseId.slice(0, 40)}`,
				request,
				createEnv: {
					[RUNPOD_OWNERSHIP_ENV]: `${OWNERSHIP_PREFIX}:${policy.ownershipNamespace}:${params.ownershipToken}`,
					SSH_PUBLIC_KEY: params.sshPublicKey,
					PUBLIC_KEY: params.sshPublicKey,
				},
			});
			return { status: "created", externalId: pod.id };
		} catch {
			// The create may have landed; the core inventories by token.
			return {
				status: "ambiguous",
				detail: "RunPod create had no clear reply",
			};
		}
	}

	async inventory(
		params: { poolId: string },
		ctx: CallContext,
	): Promise<ExternalObject[]> {
		this.requirePolicy(params.poolId);
		const objects: ExternalObject[] = [];
		for (const pod of await this.options.client.listPods()) {
			const ownershipToken = this.tokenOf(pod);
			if (ownershipToken === null) continue;
			objects.push({
				externalId: pod.id,
				ownershipToken,
				state: podState(pod.desiredStatus),
				createdAt: ctx.host.clock.now(),
				usdPerHour: pod.adjustedCostPerHr ?? pod.costPerHr,
			});
		}
		return objects;
	}

	async teardown(
		params: { externalId: string; ownershipToken: string },
		_ctx: CallContext,
	): Promise<TeardownResult> {
		const pod = (await this.options.client.listPods()).find(
			(item) => item.id === params.externalId,
		);
		if (!pod) return { status: "not-found" };
		if (this.tokenOf(pod) !== params.ownershipToken) {
			return { status: "failed", detail: "ownership token mismatch" };
		}
		try {
			await this.options.client.deletePod(pod.id);
		} catch {
			return { status: "failed", detail: "RunPod delete failed" };
		}
		return { status: "deleting" };
	}

	async endpoint(
		params: { externalId: string },
		_ctx: CallContext,
	): Promise<MachineEndpoint> {
		const pod = (await this.options.client.listPods()).find(
			(item) => item.id === params.externalId,
		);
		const port = pod?.portMappings["22"];
		if (!pod?.publicIp || !port) {
			throw new Error(`machine ${params.externalId} has no ssh endpoint yet`);
		}
		// The key comes from a network scan, so it is trust-on-first-use.
		return { host: pod.publicIp, port, hostKeySource: "tofu" };
	}
}

function podState(status: string): ExternalObject["state"] {
	switch (status.toUpperCase()) {
		case "RUNNING":
			return "running";
		case "EXITED":
		case "STOPPED":
			return "stopped";
		case "TERMINATED":
			return "deleting";
		case "CREATED":
		case "RESTARTING":
			return "creating";
		default:
			return "error";
	}
}
