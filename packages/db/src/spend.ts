import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { ProjectDb, ProjectDbTx } from "./client.ts";
import { ulid } from "./ids.ts";
import { type SpendKind, type SpendSource, spendLedger } from "./schema.ts";

/**
 * Writers and readers for `spend_ledger`. A run's usage is a final total, so
 * `recordRunUsage` upserts on `(run_id, source)`: re-running finalize ingest
 * never adds a second row. A resumed brain session reports a cumulative total
 * (`total_cost_usd` is the conversation's running sum), so
 * `recordBrainUsage` writes only the delta against the previous total.
 */

type Writer = ProjectDb | ProjectDbTx;

/** A usage envelope in the run-usage vocabulary (`runs.usage`, `decisions.usage`). */
export type SpendUsage = Partial<
	Record<"inputTokens" | "outputTokens" | "costUsd", number>
> &
	Record<string, number | undefined>;

export interface SpendInput {
	kind: SpendKind;
	accountKey: string;
	source: SpendSource;
	runId?: string | null;
	brainSessionId?: string | null;
	taskId?: string | null;
	usd?: number | null;
	tokensIn?: number | null;
	tokensOut?: number | null;
	estimated?: boolean;
	ts?: Date;
}

function finite(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Insert one ledger row. With a run id, `(run_id, source)` is unique: `onConflict` picks keep-first or replace. */
export async function recordSpend(
	db: Writer,
	input: SpendInput,
	onConflict: "keep" | "replace" = "keep",
): Promise<void> {
	const row = {
		id: ulid(),
		ts: input.ts ?? new Date(),
		kind: input.kind,
		accountKey: input.accountKey,
		runId: input.runId ?? null,
		brainSessionId: input.brainSessionId ?? null,
		taskId: input.taskId ?? null,
		usd: finite(input.usd),
		tokensIn: finite(input.tokensIn),
		tokensOut: finite(input.tokensOut),
		estimated: input.estimated ?? false,
		source: input.source,
	};
	const q = db.insert(spendLedger).values(row);
	if (onConflict === "keep" || !row.runId) {
		await q.onConflictDoNothing({
			target: [spendLedger.runId, spendLedger.source],
		});
		return;
	}
	await q.onConflictDoUpdate({
		target: [spendLedger.runId, spendLedger.source],
		set: {
			usd: row.usd,
			tokensIn: row.tokensIn,
			tokensOut: row.tokensOut,
			accountKey: row.accountKey,
			taskId: row.taskId,
		},
	});
}

/** A finished run's usage at finalize ingest: exactly one `run_usage` row per run, however often ingest repeats. */
export async function recordRunUsage(
	db: Writer,
	input: {
		runId: string;
		taskId?: string | null;
		accountKey: string;
		usage: SpendUsage | null | undefined;
		ts?: Date;
	},
): Promise<void> {
	const u = input.usage;
	if (!u || Object.keys(u).length === 0) return;
	await recordSpend(
		db,
		{
			kind: "agent",
			accountKey: input.accountKey,
			source: "run_usage",
			runId: input.runId,
			taskId: input.taskId,
			usd: finite(u.costUsd),
			tokensIn: finite(u.inputTokens),
			tokensOut: finite(u.outputTokens),
			// A subscription CLI that reports tokens but no dollars is not a measured cost.
			estimated: finite(u.costUsd) === null,
			ts: input.ts,
		},
		"replace",
	);
}

/**
 * Delta of a cumulative figure against the previous cumulative total of the
 * same native session. A total that went backwards means the session
 * restarted (rollover), so the new total is all new spend.
 */
export function cumulativeDelta(
	cumulative: number | null | undefined,
	previous: number | null | undefined,
): number | null {
	const now = finite(cumulative);
	if (now === null) return null;
	const before = finite(previous) ?? 0;
	return now >= before ? round(now - before) : now;
}

/** Float noise from subtracting two running sums must not leak into a budget. */
function round(n: number): number {
	return Math.round(n * 1e9) / 1e9;
}

/**
 * A brain call's usage. `cumulative` is the usage as reported (a resumed
 * session's running total); `previous` is the total the last call reported.
 * Pass `previous: null` for a one-shot call, whose usage is its own spend.
 * Returns the delta that was written, so the caller can store `cumulative` as
 * the session's new `last_cost_total`.
 */
export async function recordBrainUsage(
	db: Writer,
	input: {
		runId: string;
		accountKey: string;
		brainSessionId?: string | null;
		taskId?: string | null;
		cumulative: SpendUsage | null | undefined;
		previous?: SpendUsage | null;
		ts?: Date;
	},
): Promise<{ usd: number | null; tokensIn: number | null } | null> {
	const c = input.cumulative;
	if (!c || Object.keys(c).length === 0) return null;
	const p = input.previous ?? null;
	const usd = p ? cumulativeDelta(c.costUsd, p.costUsd) : finite(c.costUsd);
	const tokensIn = p
		? cumulativeDelta(c.inputTokens, p.inputTokens)
		: finite(c.inputTokens);
	const tokensOut = p
		? cumulativeDelta(c.outputTokens, p.outputTokens)
		: finite(c.outputTokens);
	await recordSpend(db, {
		kind: "brain",
		accountKey: input.accountKey,
		source: "brain_usage",
		runId: input.runId,
		brainSessionId: input.brainSessionId,
		taskId: input.taskId,
		usd,
		tokensIn,
		tokensOut,
		estimated: finite(c.costUsd) === null,
		ts: input.ts,
	});
	return { usd, tokensIn };
}

export interface SpendTotals {
	usd: number;
	tokensIn: number;
	tokensOut: number;
	rows: number;
}

/** Sum of ledger rows with `ts` in `[since, until)`, optionally for one account, kind or source. */
export async function spendTotals(
	db: Writer,
	opts: {
		since: Date;
		until?: Date;
		accountKey?: string;
		kind?: SpendKind;
		source?: SpendSource;
	},
): Promise<SpendTotals> {
	const where = and(
		gte(spendLedger.ts, opts.since),
		opts.until ? lt(spendLedger.ts, opts.until) : undefined,
		opts.accountKey ? eq(spendLedger.accountKey, opts.accountKey) : undefined,
		opts.kind ? eq(spendLedger.kind, opts.kind) : undefined,
		opts.source ? eq(spendLedger.source, opts.source) : undefined,
	);
	const [row] = await db
		.select({
			usd: sql<number>`COALESCE(SUM(${spendLedger.usd}), 0)`,
			tokensIn: sql<number>`COALESCE(SUM(${spendLedger.tokensIn}), 0)`,
			tokensOut: sql<number>`COALESCE(SUM(${spendLedger.tokensOut}), 0)`,
			rows: sql<number>`count(*)`,
		})
		.from(spendLedger)
		.where(where);
	return {
		usd: Number(row?.usd ?? 0),
		tokensIn: Number(row?.tokensIn ?? 0),
		tokensOut: Number(row?.tokensOut ?? 0),
		rows: Number(row?.rows ?? 0),
	};
}
