import type { ProjectDb } from "@mfw/db/client";
import type { RunState } from "@mfw/db/schema";
import { sql } from "drizzle-orm";

/**
 * History pips for board cards: one glyph per settled task run, oldest first,
 * with the brain's decisions about the task (◇) interleaved by time. One query
 * for every task (a window function caps each task's runs at its newest
 * `PIPS_PER_TASK`), so a 900-task board costs one round trip.
 */

export const PIPS_PER_TASK = 12;

/** `winner` arrives with run groups. */
export type PipGlyph =
	| "ok"
	| "fail"
	| "stopped"
	| "rate"
	| "winner"
	| "decision";

export interface RunPip {
	/** `run:<id>` or `decision:<n>`, the node the pip selects. */
	ref: string;
	glyph: PipGlyph;
}

/**
 * Settled states only. A run that is still starting, running or finalizing has
 * no verdict yet and is the agent strip's business, not a pip.
 */
const GLYPH: Partial<Record<RunState, PipGlyph>> = {
	completed: "ok",
	failed: "fail",
	finalize_error: "fail",
	needs_review: "fail",
	killed: "stopped",
	interrupted: "stopped",
	rate_limited: "rate",
};

const SETTLED = Object.keys(GLYPH) as RunState[];

/**
 * The same pips over rows already in memory (the as-of tree filters and
 * re-states runs, so a SQL pass over the live table would show the future).
 */
export function pipsFromRuns(
	rows: readonly {
		id: string;
		kind: string;
		taskId: string | null;
		state: string;
		startedAt: Date;
	}[],
): Record<string, RunPip[]> {
	const byTask = new Map<string, (typeof rows)[number][]>();
	for (const r of rows) {
		if (r.kind !== "task" || !r.taskId || !GLYPH[r.state as RunState]) continue;
		const list = byTask.get(r.taskId) ?? [];
		list.push(r);
		byTask.set(r.taskId, list);
	}
	const out: Record<string, RunPip[]> = {};
	for (const [taskId, list] of byTask) {
		list.sort(
			(a, b) =>
				a.startedAt.getTime() - b.startedAt.getTime() ||
				a.id.localeCompare(b.id),
		);
		out[taskId] = list.slice(-PIPS_PER_TASK).map((r) => ({
			ref: `run:${r.id}`,
			glyph: GLYPH[r.state as RunState] as PipGlyph,
		}));
	}
	return out;
}

export async function runPipsByTask(
	db: ProjectDb,
	opts: { taskIds?: readonly string[] } = {},
): Promise<Record<string, RunPip[]>> {
	if (opts.taskIds && opts.taskIds.length === 0) return {};
	const states = sql.join(
		SETTLED.map((s) => sql`${s}`),
		sql`, `,
	);
	const only = opts.taskIds
		? sql` AND task_id IN (${sql.join(
				opts.taskIds.map((t) => sql`${t}`),
				sql`, `,
			)})`
		: sql``;
	// One round trip: settled runs (the newest PIPS_PER_TASK of each task) and
	// the brain's decisions about a task, UNIONed and ordered by time. A
	// rejected call changed nothing, so it is not a pip. A decision row carries
	// `state = 'decision'`, a value no run has.
	const rows = await db.all<{
		id: string;
		task_id: string;
		state: string;
		at: number;
	}>(
		sql`SELECT id, task_id, state, at FROM (
			SELECT id, task_id, state, at FROM (
				SELECT id, task_id, state, started_at AS at,
					ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY started_at DESC, id DESC) AS n
				FROM runs
				WHERE kind = 'task' AND task_id IS NOT NULL AND state IN (${states})${only}
			) WHERE n <= ${PIPS_PER_TASK}
			UNION ALL
			SELECT CAST(id AS TEXT) AS id, task_id, 'decision' AS state, ts AS at
			FROM decisions
			WHERE role = 'brain' AND kind = 'action' AND task_id IS NOT NULL
				AND COALESCE(json_extract(output, '$.status'), '') != 'rejected'${only}
		) ORDER BY task_id, at ASC, (state = 'decision') ASC, id ASC`,
	);
	const timed: Record<string, RunPip[]> = {};
	for (const r of rows) {
		const glyph = GLYPH[r.state as RunState];
		const pip: RunPip | null =
			r.state === "decision"
				? { ref: `decision:${r.id}`, glyph: "decision" }
				: glyph
					? { ref: `run:${r.id}`, glyph }
					: null;
		if (!pip) continue;
		const list = timed[r.task_id] ?? [];
		list.push(pip);
		timed[r.task_id] = list;
	}
	const out: Record<string, RunPip[]> = {};
	for (const [taskId, list] of Object.entries(timed)) {
		out[taskId] = list.slice(-PIPS_PER_TASK);
	}
	return out;
}
