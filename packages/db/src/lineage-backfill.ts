import { eq, isNull } from "drizzle-orm";
import type { ProjectDb } from "./client.ts";
import {
	clarifications,
	type RunKind,
	type RunRelation,
	runs,
	sessions,
	triggerDeliveries,
} from "./schema.ts";

/**
 * Typed run lineage (data-and-api §2.1). `parent_run_id` alone is overloaded:
 * worktree continuation for task children, source plan for re-plans, subject
 * run for brain runs. These rules read the same signals the engine writes
 * (kind + label suffix), so old rows classify exactly as new ones are written.
 */

/** Relations whose run reuses its parent's worktree: they extend a chain. */
export const CHAIN_RELATIONS: ReadonlySet<RunRelation> = new Set([
	"continue",
	"repair",
	"resume",
	"answer",
	"unblock",
]);

export interface RelationInput {
	kind: RunKind;
	label: string;
	parentRunId: string | null | undefined;
}

/** The relation a run has to its parent, from its kind, label and parent link. */
export function relationOf(run: RelationInput): RunRelation {
	switch (run.kind) {
		case "brain":
			return "judge";
		case "repair":
			return run.label.startsWith("recovery:") ? "recovery" : "repair";
		case "task": {
			if (run.label.endsWith("#repair")) return "repair";
			if (run.label.endsWith("#resume")) return "resume";
			if (run.label.endsWith("#answer")) return "answer";
			if (run.label.endsWith("#unblock")) return "unblock";
			return run.parentRunId ? "continue" : "fresh";
		}
		case "plan":
			return run.parentRunId || run.label.endsWith("#replan")
				? "replan"
				: "fresh";
		case "action":
			return run.label === "session" ? "session" : "fresh";
		default:
			return "fresh";
	}
}

interface LineageRun {
	id: string;
	kind: RunKind;
	taskId: string | null;
	parentRunId: string | null;
	label: string;
	relation: RunRelation | null;
	chainRootId: string | null;
	originRef: string | null;
}

/**
 * Fill `relation`, `chain_root_id` and `origin_ref` on rows that predate them
 * (those with a NULL `relation`). Idempotent: a second call finds nothing to do.
 * The chain root follows `attemptChainRoot`: only same-task task runs chain, and
 * a pruned or foreign parent ends the walk, making the run its own root.
 * Returns the number of rows written.
 */
export async function backfillLineage(db: ProjectDb): Promise<number> {
	const pending = await db
		.select({ id: runs.id })
		.from(runs)
		.where(isNull(runs.relation))
		.limit(1);
	if (pending.length === 0) return 0;

	const all: LineageRun[] = await db
		.select({
			id: runs.id,
			kind: runs.kind,
			taskId: runs.taskId,
			parentRunId: runs.parentRunId,
			label: runs.label,
			relation: runs.relation,
			chainRootId: runs.chainRootId,
			originRef: runs.originRef,
		})
		.from(runs);
	const byId = new Map(all.map((r) => [r.id, r]));

	const origins = new Map<string, string>();
	// Lowest priority first; later writes win.
	for (const c of await db
		.select({
			runId: clarifications.runId,
			continuationRunId: clarifications.continuationRunId,
		})
		.from(clarifications)) {
		if (c.continuationRunId)
			origins.set(c.continuationRunId, `clarify:${c.runId}`);
	}
	for (const t of await db
		.select({ id: triggerDeliveries.id, runId: triggerDeliveries.runId })
		.from(triggerDeliveries)) {
		if (t.runId) origins.set(t.runId, `trigger:${t.id}`);
	}
	for (const s of await db
		.select({ id: sessions.id, openedRunId: sessions.openedRunId })
		.from(sessions)) {
		if (s.openedRunId) origins.set(s.openedRunId, `session:${s.id}`);
	}

	const rootOf = (run: LineageRun): string => {
		if (run.kind !== "task" || !run.taskId) return run.id;
		const seen = new Set<string>();
		let cur = run;
		while (cur.parentRunId && !seen.has(cur.id)) {
			seen.add(cur.id);
			const parent = byId.get(cur.parentRunId);
			if (parent?.kind !== "task" || parent.taskId !== cur.taskId) break;
			cur = parent;
		}
		return cur.id;
	};

	let written = 0;
	for (const run of all) {
		if (run.relation !== null) continue;
		const origin = run.originRef ?? origins.get(run.id) ?? null;
		let relation = relationOf(run);
		if (origin?.startsWith("session:")) relation = "session";
		else if (origin?.startsWith("trigger:") && run.kind === "action")
			relation = "trigger";
		await db
			.update(runs)
			.set({
				relation,
				chainRootId: run.chainRootId ?? rootOf(run),
				originRef: origin,
			})
			.where(eq(runs.id, run.id));
		written++;
	}
	return written;
}
