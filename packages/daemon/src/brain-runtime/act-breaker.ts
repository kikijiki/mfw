import type { ProjectDbHandle } from "@mfw/db/client";
import { brainActions, engineKv } from "@mfw/db/schema";
import { eq, gte } from "drizzle-orm";

/**
 * The act breaker (DESIGN W2 "decision rights with taint and the breaker"):
 * repeated failed or rejected actions, an act rate, or brain spend above a
 * threshold pauses this project's act tools. Read tools keep working.
 *
 * It closes by the owner's reset, or by one cool-down. A second trip within
 * `latchMs` of the first has no cool-down: only the owner closes it.
 *
 * The counters are derived from `brain_actions`, so a restart cannot lose
 * them. Only the open/closed state is stored, in `engine_kv`.
 */

export const ACT_BREAKER_KEY = "brain_act_breaker";

export interface ActBreakerConfig {
	windowMs: number;
	/** Rejected or failed actions in the window. */
	maxFailures: number;
	/** Act calls of any outcome in the window. */
	maxActs: number;
	/** Brain spend over the last 24 hours. */
	maxBrainUsdPerDay: number;
	cooldownMs: number;
	latchMs: number;
}

export const DEFAULT_ACT_BREAKER: ActBreakerConfig = {
	windowMs: 10 * 60_000,
	maxFailures: 15,
	maxActs: 120,
	maxBrainUsdPerDay: 100,
	cooldownMs: 60 * 60_000,
	latchMs: 24 * 60 * 60_000,
};

export type BreakerCause = "failures" | "act_rate" | "spend";

export interface ActBreakerState {
	open: boolean;
	cause?: BreakerCause;
	detail?: string;
	trippedAt?: number;
	/** When the cool-down closes it; null = only the owner can. */
	until?: number | null;
	/** Rows before this do not count: the last reset or cool-down. */
	countFrom: number;
	lastTripAt?: number;
}

const CLOSED: ActBreakerState = { open: false, countFrom: 0 };

type Db = Pick<ProjectDbHandle, "db" | "withTx">;

async function stored(handle: Db): Promise<ActBreakerState> {
	const [row] = await handle.db
		.select()
		.from(engineKv)
		.where(eq(engineKv.key, ACT_BREAKER_KEY));
	return (row?.value as ActBreakerState | undefined) ?? CLOSED;
}

async function write(
	handle: Db,
	state: ActBreakerState,
	now: number,
): Promise<void> {
	const value = state as unknown as Record<string, unknown>;
	await handle.db
		.insert(engineKv)
		.values({ key: ACT_BREAKER_KEY, value, updatedAt: new Date(now) })
		.onConflictDoUpdate({
			target: engineKv.key,
			set: { value, updatedAt: new Date(now) },
		});
}

/** The state as of `now`, without writing: a lapsed cool-down reads as closed. */
export async function readActBreaker(
	handle: Db,
	now: number,
): Promise<ActBreakerState> {
	const s = await stored(handle);
	if (s.open && typeof s.until === "number" && now >= s.until) {
		return {
			open: false,
			countFrom: s.until,
			...(s.lastTripAt !== undefined ? { lastTripAt: s.lastTripAt } : {}),
		};
	}
	return s;
}

export class ActBreaker {
	readonly config: ActBreakerConfig;

	constructor(
		private readonly deps: {
			handle: Db;
			now: () => number;
			/** Brain spend over the last 24 hours. */
			brainSpendUsd: () => Promise<number>;
			onTrip?: (state: ActBreakerState) => void;
		},
		config: Partial<ActBreakerConfig> = {},
	) {
		this.config = { ...DEFAULT_ACT_BREAKER, ...config };
	}

	status(): Promise<ActBreakerState> {
		return readActBreaker(this.deps.handle, this.deps.now());
	}

	/** Count what the last act call added, and trip when a threshold is reached. */
	async observe(): Promise<ActBreakerState> {
		const state = await this.status();
		if (state.open) return state;
		const now = this.deps.now();
		const c = this.config;
		const from = Math.max(now - c.windowMs, state.countFrom);
		const rows = (
			await this.deps.handle.db
				.select({
					status: brainActions.status,
					rejection: brainActions.rejection,
					createdAt: brainActions.createdAt,
				})
				.from(brainActions)
				.where(gte(brainActions.createdAt, new Date(from)))
		).filter(
			(r) =>
				r.rejection?.code !== "breaker_open" &&
				// Strictly after: what happened in the reset's own millisecond is before it.
				r.createdAt.getTime() > state.countFrom,
		);
		const failures = rows.filter(
			(r) => r.status === "rejected" || r.status === "failed",
		).length;
		let cause: BreakerCause | null = null;
		let detail = "";
		const mins = Math.round(c.windowMs / 60_000);
		if (failures >= c.maxFailures) {
			cause = "failures";
			detail = `${failures} rejected or failed actions in ${mins} minutes`;
		} else if (rows.length >= c.maxActs) {
			cause = "act_rate";
			detail = `${rows.length} act calls in ${mins} minutes`;
		} else {
			const usd = await this.deps.brainSpendUsd();
			if (usd >= c.maxBrainUsdPerDay) {
				cause = "spend";
				detail = `$${usd.toFixed(2)} of brain spend in 24 hours`;
			}
		}
		if (!cause) return state;
		const latched =
			state.lastTripAt !== undefined && now - state.lastTripAt < c.latchMs;
		const next: ActBreakerState = {
			open: true,
			cause,
			detail,
			trippedAt: now,
			until: latched ? null : now + c.cooldownMs,
			countFrom: state.countFrom,
			lastTripAt: now,
		};
		await write(this.deps.handle, next, now);
		this.deps.onTrip?.(next);
		return next;
	}

	/** The owner closes the breaker. Earlier failures stop counting. */
	async reset(): Promise<ActBreakerState> {
		const now = this.deps.now();
		const cur = await stored(this.deps.handle);
		const next: ActBreakerState = {
			open: false,
			countFrom: now,
			...(cur.lastTripAt !== undefined ? { lastTripAt: cur.lastTripAt } : {}),
		};
		await write(this.deps.handle, next, now);
		return next;
	}
}
