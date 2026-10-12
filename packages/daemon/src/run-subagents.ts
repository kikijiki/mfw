import type { ProjectDb, ProjectDbTx } from "@mfw/db/client";
import { appendEvent, type StoredEvent } from "@mfw/db/eventlog";
import { runSubagents, runs } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import type { SubagentFold } from "./agents/activity.ts";

/**
 * `run_subagents` (U7): one row per subagent a run started. The run-event tail
 * folds them out of `events.jsonl` (`SubagentFold`); this module is the one
 * place they are written and read back. A row is keyed by its run and the
 * subagent's starting tool call, so every write is an idempotent upsert and a
 * transcript re-read converges to the same rows.
 */

export type RunSubagentRow = typeof runSubagents.$inferSelect;

/** A subagent's flow ref: `sub:<runId>/<toolUseId>`. */
export const subRef = (runId: string, toolUseId: string): string =>
	`sub:${runId}/${toolUseId}`;

/** Parse `sub:<runId>/<toolUseId>`; the call id may itself contain `/`. */
export function parseSubRef(
	ref: string,
): { runId: string; toolUseId: string } | null {
	const m = /^sub:([^/]+)\/(.+)$/.exec(ref);
	return m ? { runId: m[1] as string, toolUseId: m[2] as string } : null;
}

/**
 * Upsert a run's subagents. Returns the `run.subagents_changed` event when a
 * subagent started or finished (a changed tool count alone is silent), else
 * null. Call inside the transaction the caller publishes from.
 */
export async function writeRunSubagents(
	tx: ProjectDbTx,
	runId: string,
	subs: readonly SubagentFold[],
): Promise<StoredEvent | null> {
	if (subs.length === 0) return null;
	const [run] = await tx
		.select({ taskId: runs.taskId })
		.from(runs)
		.where(eq(runs.id, runId));
	if (!run) return null;
	const have = new Map(
		(
			await tx
				.select({
					toolUseId: runSubagents.toolUseId,
					status: runSubagents.status,
				})
				.from(runSubagents)
				.where(eq(runSubagents.runId, runId))
		).map((r) => [r.toolUseId, r.status]),
	);
	let shapeChanged = false;
	for (const s of subs) {
		if (have.get(s.toolUseId) !== s.status) shapeChanged = true;
		const values = {
			runId,
			toolUseId: s.toolUseId,
			parentToolUseId: s.parentToolUseId,
			agentType: s.agentType,
			description: s.description,
			startedAt: new Date(Date.parse(s.startedAt)),
			endedAt: s.endedAt ? new Date(Date.parse(s.endedAt)) : null,
			status: s.status,
			tools: s.tools,
			entryFromSeq: s.entryFromSeq,
			entryToSeq: s.entryToSeq,
		};
		await tx
			.insert(runSubagents)
			.values(values)
			.onConflictDoUpdate({
				target: [runSubagents.runId, runSubagents.toolUseId],
				set: {
					parentToolUseId: values.parentToolUseId,
					agentType: values.agentType,
					description: values.description,
					startedAt: values.startedAt,
					endedAt: values.endedAt,
					status: values.status,
					tools: values.tools,
					entryFromSeq: values.entryFromSeq,
					entryToSeq: values.entryToSeq,
				},
			});
	}
	if (!shapeChanged) return null;
	return appendEvent(tx, {
		type: "run.subagents_changed",
		runId,
		...(run.taskId ? { taskId: run.taskId } : {}),
		payload: {
			total: subs.length,
			running: subs.filter((s) => s.status === "running").length,
		},
	});
}

/** Every subagent row of the project (the flow tree filters to its shown runs). */
export function listRunSubagents(db: ProjectDb): Promise<RunSubagentRow[]> {
	return db.select().from(runSubagents);
}

/** One run's subagents, in start order. */
export async function runSubagentsOf(
	db: ProjectDb,
	runId: string,
): Promise<RunSubagentRow[]> {
	const rows = await db
		.select()
		.from(runSubagents)
		.where(eq(runSubagents.runId, runId));
	return rows.sort(
		(a, b) =>
			a.startedAt.getTime() - b.startedAt.getTime() ||
			a.entryFromSeq - b.entryFromSeq,
	);
}
