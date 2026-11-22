import type { CallContext } from "../common.ts";
import type {
	CostQuote,
	Dimension,
	DimensionObservation,
	Observation,
	PoolProposal,
	ResourcePlugin,
	Shape,
	UsageReport,
	UsageTarget,
} from "../resource.ts";

/**
 * A scriptable `mfw.resource/v1` plugin for core tests. Pools and observations
 * are plain data the test edits; nothing here touches the network or disk.
 */
export class FakeResource implements ResourcePlugin {
	readonly calls: { method: string; operationId: string }[] = [];
	readonly pools = new Map<string, PoolProposal>();
	/** Observed dimensions per pool; defaults to "exactly what was declared". */
	readonly observed = new Map<string, DimensionObservation[]>();
	health: Observation["health"] = "ok";
	/** Dollars per unit-hour for `quote`; null makes the quote unknown. */
	usdPerUnitHour: number | null = 1;
	usageUsd: number | null = null;
	failNextObserve = false;

	constructor(proposals: PoolProposal[] = []) {
		for (const p of proposals) this.pools.set(p.poolId, p);
	}

	private record(name: string, ctx: CallContext) {
		this.calls.push({ method: name, operationId: ctx.operationId });
	}

	async discover(_p: Record<string, never>, ctx: CallContext) {
		this.record("discover", ctx);
		return [...this.pools.values()];
	}

	async observe(
		params: { poolId: string },
		ctx: CallContext,
	): Promise<Observation> {
		this.record("observe", ctx);
		if (this.failNextObserve) {
			this.failNextObserve = false;
			throw new Error("fake resource: observe failed");
		}
		const pool = this.pools.get(params.poolId);
		if (!pool) throw new Error(`unknown pool ${params.poolId}`);
		return {
			poolId: pool.poolId,
			observedAt: ctx.host.clock.now(),
			health: this.health,
			dimensions:
				this.observed.get(params.poolId) ??
				pool.dimensions.map(declaredAsObserved),
		};
	}

	async quote(
		params: { poolId: string; shape: Shape },
		ctx: CallContext,
	): Promise<CostQuote> {
		this.record("quote", ctx);
		const hours = (params.shape.maxRuntimeSeconds ?? 3600) / 3600;
		const rate = this.usdPerUnitHour;
		return {
			poolId: params.poolId,
			currency: "usd",
			perUnitHour: rate,
			worstCase: rate === null ? null : rate * params.shape.units * hours,
			asOf: ctx.host.clock.now(),
		};
	}

	async usage(
		params: { target: UsageTarget },
		ctx: CallContext,
	): Promise<UsageReport> {
		this.record("usage", ctx);
		return {
			poolId: params.target.poolId,
			usd: this.usageUsd,
			tokens: null,
			requests: null,
			slotHours: null,
			asOf: ctx.host.clock.now(),
		};
	}
}

export function declaredAsObserved(d: Dimension): DimensionObservation {
	switch (d.kind) {
		case "slot":
			return { kind: "slot", name: d.name, total: d.total, occupied: [] };
		case "quantity":
			return { kind: "quantity", name: d.name, total: d.total, used: null };
		case "window":
			return { kind: "window", name: d.name, settled: null, remaining: null };
		case "meter":
			return { kind: "meter", name: d.name, fraction: null, resetsAt: null };
	}
}
