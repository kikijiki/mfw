import type { CallContext } from "../../../../plugin-api/src/common.ts";
import { formatPoolId } from "../../../../plugin-api/src/pool-id.ts";
import type {
	Dimension,
	DimensionObservation,
	Observation,
	PoolProposal,
	ResourcePlugin,
	UsageReport,
	UsageTarget,
} from "../../../../plugin-api/src/resource.ts";
import type { OpenRouterAccountReadModel } from "../../openrouter-account-service.ts";
import type {
	OpenRouterClientPort,
	OpenRouterKeyUsage,
} from "../../openrouter-client.ts";

export interface OpenRouterResourceOptions {
	/** Credentials stay behind this port; the plugin never holds the key. */
	client: Pick<
		OpenRouterClientPort,
		"credentialReady" | "getCurrentKey" | "getCredits"
	>;
	instance?: string;
	/** Owner-set spend limits in USD; each one becomes a calendar window. */
	limits?: { dailyUsd?: number; weeklyUsd?: number; monthlyUsd?: number };
	tz?: string;
}

/**
 * A client over the account service's last refresh, so observing this pool
 * never adds a request to OpenRouter. What it has not read reads as unavailable.
 */
export function openRouterPoolClient(
	model: () => OpenRouterAccountReadModel,
): OpenRouterResourceOptions["client"] {
	return {
		credentialReady: async () => model().credential.ready,
		getCurrentKey: async () => {
			const { key, fresh } = model();
			if (!key || !fresh) throw new Error("no fresh OpenRouter key usage");
			return key;
		},
		getCredits: async () => {
			const { credits } = model();
			if (
				!credits.available ||
				credits.totalCredits === null ||
				credits.totalUsage === null
			) {
				throw new Error("OpenRouter credits are unavailable");
			}
			return {
				totalCredits: credits.totalCredits,
				totalUsage: credits.totalUsage,
			};
		},
	};
}

const PERIODS = [
	["daily", "dailyUsd", "day", "usageDaily"],
	["weekly", "weeklyUsd", "week", "usageWeekly"],
	["monthly", "monthlyUsd", "month", "usageMonthly"],
] as const;

/**
 * `openrouter`: spend windows plus a credits meter. Provider figures are
 * advisory next to the core's ledger, and anything unreadable stays unknown.
 */
export class OpenRouterResource implements ResourcePlugin {
	readonly poolId: string;

	constructor(private readonly options: OpenRouterResourceOptions) {
		this.poolId = formatPoolId({
			plugin: "openrouter",
			instance: options.instance ?? "main",
		});
	}

	private dimensions(): Dimension[] {
		const out: Dimension[] = [];
		for (const [name, key, period] of PERIODS) {
			const limit = this.options.limits?.[key];
			if (limit === undefined) continue;
			out.push({
				kind: "window",
				name,
				unit: "usd",
				limit,
				window: {
					type: "calendar",
					period,
					...(this.options.tz ? { tz: this.options.tz } : {}),
				},
			});
		}
		out.push({ kind: "meter", name: "credits" });
		return out;
	}

	async discover(
		_params: Record<string, never>,
		_ctx: CallContext,
	): Promise<PoolProposal[]> {
		let providerHardLimit = false;
		if (await this.options.client.credentialReady()) {
			const key = await this.options.client.getCurrentKey().catch(() => null);
			providerHardLimit = key?.limit != null;
		}
		return [
			{
				poolId: this.poolId,
				title: "OpenRouter",
				providerHardLimit,
				dimensions: this.dimensions(),
			},
		];
	}

	async observe(
		params: { poolId: string },
		ctx: CallContext,
	): Promise<Observation> {
		this.assertPool(params.poolId);
		const observedAt = ctx.host.clock.now();
		if (!(await this.options.client.credentialReady())) {
			return {
				poolId: this.poolId,
				observedAt,
				health: "down",
				detail: "OpenRouter credential is not configured",
				dimensions: this.unknownDimensions(),
			};
		}
		let key: OpenRouterKeyUsage;
		try {
			key = await this.options.client.getCurrentKey();
		} catch {
			return {
				poolId: this.poolId,
				observedAt,
				health: "down",
				detail: "OpenRouter key usage could not be read",
				dimensions: this.unknownDimensions(),
			};
		}
		const credits = await this.options.client.getCredits().catch(() => null);
		const fraction =
			credits && credits.totalCredits > 0
				? Math.min(1, credits.totalUsage / credits.totalCredits)
				: key.limit && key.limitRemaining !== null
					? Math.min(1, Math.max(0, 1 - key.limitRemaining / key.limit))
					: null;
		const dimensions: DimensionObservation[] = [];
		for (const [name, optionKey, , usageKey] of PERIODS) {
			const limit = this.options.limits?.[optionKey];
			if (limit === undefined) continue;
			dimensions.push({
				kind: "window",
				name,
				settled: key[usageKey],
				remaining: Math.max(0, limit - key[usageKey]),
			});
		}
		dimensions.push({
			kind: "meter",
			name: "credits",
			fraction,
			resetsAt: null,
		});
		return { poolId: this.poolId, observedAt, health: "ok", dimensions };
	}

	/** OpenRouter reports no per-lease or arbitrary-range cost: unknown, not 0. */
	async usage(
		params: { target: UsageTarget },
		ctx: CallContext,
	): Promise<UsageReport> {
		this.assertPool(params.target.poolId);
		return {
			poolId: this.poolId,
			usd: null,
			tokens: null,
			requests: null,
			slotHours: null,
			asOf: ctx.host.clock.now(),
		};
	}

	private unknownDimensions(): DimensionObservation[] {
		return this.dimensions().map((d) =>
			d.kind === "window"
				? { kind: "window", name: d.name, settled: null, remaining: null }
				: { kind: "meter", name: d.name, fraction: null, resetsAt: null },
		);
	}

	private assertPool(poolId: string): void {
		if (poolId !== this.poolId) throw new Error(`unknown pool ${poolId}`);
	}
}
