import type { ProjectDb } from "@mfw/db/client";
import { decisions, runs } from "@mfw/db/schema";
import { and, desc, eq, inArray, isNotNull, max } from "drizzle-orm";

/**
 * Read models the UI folds from the brain's rows (U3). Nothing here writes or
 * acts: the brain runtime owns the tables, this file only says how they read.
 */

/** Which of an act call's states a decision row carries (`brain_actions.status`, mirrored in `decisions.output.status`). */
export type BrainActionState =
	| "proposed"
	| "applied"
	| "accepted"
	| "rejected"
	| "failed";

const ACTION_STATES: ReadonlySet<string> = new Set([
	"proposed",
	"applied",
	"accepted",
	"rejected",
	"failed",
]);

/** The action state recorded on a decision's `output`, or null (legacy and non-brain rows). */
export function actionStateOf(
	output: Record<string, unknown> | null | undefined,
): BrainActionState | null {
	const v = output?.status;
	return typeof v === "string" && ACTION_STATES.has(v)
		? (v as BrainActionState)
		: null;
}

/** The brain's standing intent for a task: its newest action, when no run has started since. */
export interface BrainIntent {
	taskId: string;
	decisionId: number;
	tool: string;
	rationale: string;
	confidence: "low" | "medium" | "high" | null;
	state: BrainActionState | null;
	at: Date;
}

/**
 * For every task, the newest non-rejected brain action about it that is newer
 * than the task's latest run. One pass over `decisions` and one grouped read
 * of `runs`, never per task. A rejected call changed nothing and is not an
 * intent. `note` and `plan` decisions are memory, not intent, so only
 * `kind = action` counts.
 */
export async function brainIntents(
	db: ProjectDb,
	opts: { limit?: number } = {},
): Promise<BrainIntent[]> {
	const rows = await db
		.select({
			id: decisions.id,
			ts: decisions.ts,
			taskId: decisions.taskId,
			action: decisions.action,
			reason: decisions.reason,
			confidence: decisions.confidence,
			output: decisions.output,
		})
		.from(decisions)
		.where(
			and(
				eq(decisions.role, "brain"),
				eq(decisions.kind, "action"),
				isNotNull(decisions.taskId),
			),
		)
		.orderBy(desc(decisions.id))
		.limit(Math.min(opts.limit ?? 2000, 5000));

	const newest = new Map<string, (typeof rows)[number]>();
	for (const r of rows) {
		if (!r.taskId || newest.has(r.taskId)) continue;
		if (actionStateOf(r.output) === "rejected") continue;
		newest.set(r.taskId, r);
	}
	if (newest.size === 0) return [];

	const ids = [...newest.keys()];
	const lastRun = new Map<string, number>();
	for (let i = 0; i < ids.length; i += 400) {
		const part = ids.slice(i, i + 400);
		for (const r of await db
			.select({ taskId: runs.taskId, at: max(runs.startedAt) })
			.from(runs)
			.where(inArray(runs.taskId, part))
			.groupBy(runs.taskId)) {
			if (r.taskId && r.at) lastRun.set(r.taskId, Number(r.at));
		}
	}
	const out: BrainIntent[] = [];
	for (const [taskId, d] of newest) {
		const ran = lastRun.get(taskId);
		if (ran !== undefined && ran >= d.ts.getTime()) continue;
		out.push({
			taskId,
			decisionId: d.id,
			tool: d.action ?? "decision",
			rationale: (d.reason ?? "").slice(0, 280),
			confidence: d.confidence,
			state: actionStateOf(d.output),
			at: d.ts,
		});
	}
	return out;
}

/** What the rail, presence bar and project header need of a project's brain. */
export interface BrainSummary {
	/** False when `brain.routes` is not configured: show no glyph, only a hint. */
	enabled: boolean;
	state: "off" | "idle" | "turn" | "paused" | "failed";
	generation: number | null;
	liveTurnRunId: string | null;
	failures: number;
	/** The last failed turn's error, for the needs-me line. */
	error: string | null;
}

/** Fold `BrainRuntime.view()` into the summary; pure. */
export function summarizeBrain(view: {
	enabled: boolean;
	session: {
		status: string;
		generation: number;
		consecutiveFailures: number;
		liveTurnRunId: string | null;
		lastTurn: { status: string; error: string | null } | null;
	} | null;
}): BrainSummary {
	if (!view.enabled) {
		return {
			enabled: false,
			state: "off",
			generation: null,
			liveTurnRunId: null,
			failures: 0,
			error: null,
		};
	}
	const s = view.session;
	if (!s) {
		return {
			enabled: true,
			state: "idle",
			generation: null,
			liveTurnRunId: null,
			failures: 0,
			error: null,
		};
	}
	const state =
		s.status === "turn" ||
		s.status === "paused" ||
		s.status === "failed" ||
		s.status === "idle"
			? s.status
			: "idle";
	return {
		enabled: true,
		state,
		generation: s.generation,
		liveTurnRunId: s.liveTurnRunId,
		failures: s.consecutiveFailures,
		error: state === "failed" ? (s.lastTurn?.error ?? null) : null,
	};
}
