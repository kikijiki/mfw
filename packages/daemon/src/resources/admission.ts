import type {
	AdmissionVerdict,
	Blocker,
	Claim,
	HoldReason,
	QuotaScope,
} from "./types.ts";

/**
 * The admission decision as a pure function over a snapshot, so routing,
 * granting and the model tests all use the same rule.
 *
 * Amounts here are stored units (see amounts.ts).
 */

export interface LevelState {
	/** `machine`, or a quota key such as `project:mfw`. */
	level: string;
	limit: number;
	/** Live allocations, or settled plus outstanding reservations. */
	used: number;
	/** The part of `used` that cannot come back (settled window spend). */
	settled: number;
}

export interface DimensionState {
	kind: "slot" | "quantity" | "window" | "meter";
	capacity: number;
	used: number;
	settled: number;
	/** Quota levels by key; only levels with a configured limit appear. */
	quotas: Map<string, { limit: number; used: number; settled: number }>;
	/** Named units, when the slot has identities. */
	units?: string[];
	/** Units neither leased nor externally occupied. */
	freeUnits?: string[];
	meterFraction?: number | null;
	meterResetsAt?: number | null;
}

export interface PoolState {
	holds: HoldReason[];
	dimensions: Map<string, DimensionState>;
}

export type AdmissionSnapshot = Map<string, PoolState>;

export interface QueuedWaiter {
	id: string;
	sequence: number;
	claims: readonly Claim[];
	scopes: readonly QuotaScope[];
}

export function dimensionKey(poolId: string, dimension: string): string {
	return `${poolId}\0${dimension}`;
}

export function scopeKey(scope: QuotaScope): string {
	return `${scope.scope}:${scope.name}`;
}

function levelsFor(
	state: DimensionState,
	scopes: readonly QuotaScope[],
): LevelState[] {
	const levels: LevelState[] = [
		{
			level: "machine",
			limit: state.capacity,
			used: state.used,
			settled: state.settled,
		},
	];
	for (const scope of scopes) {
		const key = scopeKey(scope);
		const quota = state.quotas.get(key);
		if (quota) levels.push({ level: key, ...quota });
	}
	return levels;
}

/** Whether `amount` more fits at every quota level right now. */
export function fitsEveryLevel(
	state: DimensionState,
	scopes: readonly QuotaScope[],
	amount: number,
): boolean {
	return levelsFor(state, scopes).every((l) => l.used + amount <= l.limit);
}

/** Evaluates one claim set, ignoring queue order. */
export function evaluateClaims(
	snapshot: AdmissionSnapshot,
	claims: readonly Claim[],
	scopes: readonly QuotaScope[],
	now: number,
): AdmissionVerdict {
	const parked: Blocker[] = [];
	const blocked: Blocker[] = [];
	const units = new Map<string, string[]>();

	for (const claim of claims) {
		const { poolId, dimension } = claim;
		const pool = snapshot.get(poolId);
		if (!pool) {
			parked.push({ code: "unknown-pool", poolId });
			continue;
		}
		for (const reason of pool.holds) {
			parked.push({ code: "held", poolId, detail: reason });
		}
		const state = pool.dimensions.get(dimension);
		if (!state) {
			parked.push({ code: "unknown-dimension", poolId, dimension });
			continue;
		}
		if (state.kind === "meter") {
			// The one deliberate fail-open: an unknown meter admits. A reading
			// past its reset time says nothing about now, so it is unknown too.
			const expired = state.meterResetsAt != null && state.meterResetsAt <= now;
			if (!expired && state.meterFraction != null && state.meterFraction >= 1) {
				parked.push({ code: "exhausted", poolId, dimension, detail: "meter" });
			}
			continue;
		}
		const amount = claim.amount ?? 0;
		for (const level of levelsFor(state, scopes)) {
			if (amount + level.settled > level.limit) {
				// Even if every outstanding hold on this level came back, the claim
				// would not fit: waiting in line cannot help.
				parked.push({
					code: "exhausted",
					poolId,
					dimension,
					detail: level.level,
				});
			} else if (amount + level.used > level.limit) {
				blocked.push({
					code: "capacity",
					poolId,
					dimension,
					detail: level.level,
				});
			}
		}
		if (state.kind === "slot" && state.units) {
			const free = state.freeUnits ?? [];
			if (claim.unit !== undefined) {
				if (!state.units.includes(claim.unit)) {
					parked.push({
						code: "unknown-dimension",
						poolId,
						dimension,
						detail: claim.unit,
					});
				} else if (!free.includes(claim.unit)) {
					blocked.push({
						code: "unit-unavailable",
						poolId,
						dimension,
						detail: claim.unit,
					});
				} else {
					units.set(dimensionKey(poolId, dimension), [claim.unit]);
				}
			} else if (free.length < amount) {
				blocked.push({ code: "unit-unavailable", poolId, dimension });
			} else {
				units.set(dimensionKey(poolId, dimension), free.slice(0, amount));
			}
		}
	}
	if (parked.length > 0) {
		return { status: "parked", blockers: [...parked, ...blocked], units };
	}
	if (blocked.length > 0)
		return { status: "blocked", blockers: blocked, units };
	return { status: "grantable", blockers: [], units };
}

function leasedDimensions(
	snapshot: AdmissionSnapshot,
	claims: readonly Claim[],
): Set<string> {
	const out = new Set<string>();
	for (const claim of claims) {
		const kind = snapshot
			.get(claim.poolId)
			?.dimensions.get(claim.dimension)?.kind;
		// Meters are not leased, so sharing one never orders two waiters.
		if (kind !== "meter") out.add(dimensionKey(claim.poolId, claim.dimension));
	}
	return out;
}

/**
 * FIFO over claim sets. An older waiter blocks a younger one on any shared
 * leased dimension unless it is parked. A parked waiter keeps its sequence, so
 * it regains its place as soon as its hold clears.
 */
export function decide(
	snapshot: AdmissionSnapshot,
	queue: readonly QueuedWaiter[],
	target: Pick<QueuedWaiter, "sequence" | "claims" | "scopes">,
	now: number,
): AdmissionVerdict {
	const own = evaluateClaims(snapshot, target.claims, target.scopes, now);
	if (own.status === "parked") return own;
	const mine = leasedDimensions(snapshot, target.claims);
	const fifo: Blocker[] = [];
	for (const other of queue) {
		if (other.sequence >= target.sequence) continue;
		const shared = [...leasedDimensions(snapshot, other.claims)].filter((k) =>
			mine.has(k),
		);
		if (shared.length === 0) continue;
		if (
			evaluateClaims(snapshot, other.claims, other.scopes, now).status ===
			"parked"
		)
			continue;
		for (const key of shared) {
			const [poolId, dimension] = key.split("\0") as [string, string];
			fifo.push({ code: "fifo", poolId, dimension, detail: other.id });
		}
	}
	if (fifo.length === 0) return own;
	return {
		status: "blocked",
		blockers: [...fifo, ...own.blockers],
		units: own.units,
	};
}
