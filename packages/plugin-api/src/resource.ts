import { z } from "zod";
import {
	type CallContext,
	type ContractSpec,
	EpochMs,
	Id,
	LIMITS,
	Measured,
	method,
	Text,
} from "./common.ts";
import { PoolIdSchema } from "./pool-id.ts";

/**
 * `mfw.resource/v1`: describes and observes capacity the core accounts for.
 *
 * May narrow capacity, report actuals and refuse a shape. May not grant,
 * renew, release or clear a hold. A stale observation holds the pool; a crash
 * makes its pools `uncertain` (no new grants, live leases continue).
 */

export const WindowUnit = z.enum(["usd", "tokens", "requests", "slot_hours"]);
export type WindowUnit = z.infer<typeof WindowUnit>;

/** Rolling (`seconds`) or calendar-aligned (`period`) window. */
export const WindowSpec = z.union([
	z.object({
		type: z.literal("rolling"),
		seconds: z.number().int().positive(),
	}),
	z.object({
		type: z.literal("calendar"),
		period: z.enum(["day", "week", "month"]),
		/** IANA zone; the host defaults to the machine zone. */
		tz: z.string().max(64).optional(),
	}),
]);

/**
 * The four dimensions of a pool. A lock is a one-unit slot. Meters are never
 * leased: they only gate admission.
 */
export const DimensionSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("slot"),
		name: Id,
		total: z.number().int().nonnegative(),
		/** Identity-bearing units (GPU index, fleet dir), when they have names. */
		units: z.array(Id).max(LIMITS.list).optional(),
	}),
	z.object({
		kind: z.literal("quantity"),
		name: Id,
		unit: Id,
		total: z.number().nonnegative(),
	}),
	z.object({
		kind: z.literal("window"),
		name: Id,
		unit: WindowUnit,
		limit: z.number().nonnegative(),
		window: WindowSpec,
	}),
	z.object({ kind: z.literal("meter"), name: Id }),
]);
export type Dimension = z.infer<typeof DimensionSchema>;

/** What the owner may request of a pool; enforced by the core, never the plugin. */
export const ShapeSchema = z.object({
	units: z.number().int().positive().default(1),
	attributes: z
		.record(Id, z.union([z.string().max(LIMITS.text), z.number(), z.boolean()]))
		.default({}),
	maxRuntimeSeconds: z.number().int().positive().optional(),
});
export type Shape = z.infer<typeof ShapeSchema>;

export const PoolProposalSchema = z.object({
	poolId: PoolIdSchema,
	title: Text,
	dimensions: z.array(DimensionSchema).min(1).max(16),
	/** Whether a provider-side key limit backs the pool's windows. */
	providerHardLimit: z.boolean().default(false),
});
export type PoolProposal = z.infer<typeof PoolProposalSchema>;

export const HealthSchema = z.enum(["ok", "degraded", "down", "unknown"]);

/** One dimension's observed state. `null` is unknown, never 0. */
export const DimensionObservationSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("slot"),
		name: Id,
		/** Capacity the plugin believes exists; the core takes the minimum. */
		total: z.number().int().nonnegative(),
		occupied: z.array(Id).max(LIMITS.list).default([]),
	}),
	z.object({
		kind: z.literal("quantity"),
		name: Id,
		total: z.number().nonnegative(),
		used: Measured,
	}),
	z.object({
		kind: z.literal("window"),
		name: Id,
		/** Plugin-reported; advisory next to the ledger's actuals. */
		settled: Measured,
		remaining: Measured,
	}),
	z.object({
		kind: z.literal("meter"),
		name: Id,
		/** Fraction consumed in [0, 1]; `null` is unknown (admits and shows unknown). */
		fraction: z.number().min(0).max(1).nullable(),
		resetsAt: EpochMs.nullable().default(null),
	}),
]);
export type DimensionObservation = z.infer<typeof DimensionObservationSchema>;

export const ObservationSchema = z.object({
	poolId: PoolIdSchema,
	observedAt: EpochMs,
	health: HealthSchema,
	dimensions: z.array(DimensionObservationSchema).max(16),
	detail: Text.optional(),
});
export type Observation = z.infer<typeof ObservationSchema>;

export const CostQuoteSchema = z.object({
	poolId: PoolIdSchema,
	currency: z.literal("usd"),
	/** Price per unit-hour (machines) or per unit (providers); null if unknown. */
	perUnitHour: Measured,
	/** Worst case for the requested shape at its max runtime; null refuses. */
	worstCase: Measured,
	asOf: EpochMs,
});
export type CostQuote = z.infer<typeof CostQuoteSchema>;

export const LeaseRefSchema = z.object({ leaseId: Id, poolId: PoolIdSchema });
export type LeaseRef = z.infer<typeof LeaseRefSchema>;

export const UsageTargetSchema = z.union([
	LeaseRefSchema,
	z.object({ poolId: PoolIdSchema, from: EpochMs, to: EpochMs }),
]);
export type UsageTarget = z.infer<typeof UsageTargetSchema>;

/** Actuals for settlement. Every amount is nullable: unknown is not 0. */
export const UsageReportSchema = z.object({
	poolId: PoolIdSchema,
	usd: Measured,
	tokens: Measured,
	requests: Measured,
	slotHours: Measured,
	asOf: EpochMs,
});
export type UsageReport = z.infer<typeof UsageReportSchema>;

export const resourceContract = {
	kind: "resource",
	methods: {
		discover: method(
			z.object({}),
			z.array(PoolProposalSchema).max(LIMITS.list),
		),
		observe: method(z.object({ poolId: PoolIdSchema }), ObservationSchema),
		quote: method(
			z.object({ poolId: PoolIdSchema, shape: ShapeSchema }),
			CostQuoteSchema,
			{ optional: true },
		),
		usage: method(z.object({ target: UsageTargetSchema }), UsageReportSchema, {
			optional: true,
		}),
	},
} satisfies ContractSpec;

export interface ResourcePlugin {
	/** Pool definitions the owner confirms; the plugin never creates pools. */
	discover(
		params: Record<string, never>,
		ctx: CallContext,
	): Promise<PoolProposal[]>;
	observe(params: { poolId: string }, ctx: CallContext): Promise<Observation>;
	quote?(
		params: { poolId: string; shape: Shape },
		ctx: CallContext,
	): Promise<CostQuote>;
	usage?(
		params: { target: UsageTarget },
		ctx: CallContext,
	): Promise<UsageReport>;
}

/**
 * Host rule T7: observations only narrow. Returns the names of dimensions
 * whose observed capacity exceeds what the pool declared (the core clamps to
 * the minimum and records a violation). Dimensions missing from the proposal
 * are also reported, since a plugin cannot invent capacity.
 */
export function capacityRaised(
	declared: readonly Dimension[],
	observed: readonly DimensionObservation[],
): string[] {
	const byName = new Map(declared.map((d) => [d.name, d]));
	const raised: string[] = [];
	for (const o of observed) {
		const d = byName.get(o.name);
		if (!d || d.kind !== o.kind) {
			raised.push(o.name);
			continue;
		}
		if (
			(d.kind === "slot" && o.kind === "slot" && o.total > d.total) ||
			(d.kind === "quantity" && o.kind === "quantity" && o.total > d.total)
		)
			raised.push(o.name);
	}
	return raised;
}
