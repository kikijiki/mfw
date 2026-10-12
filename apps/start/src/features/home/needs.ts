import type { InboxItem, InboxKind } from "@mfw/daemon/inbox";

import { nodeRef } from "../../lib/nodeRef";
import { href } from "../../routes";

/**
 * The needs-you queue's rules, pure. The list IS `inbox.list` (the server's
 * derivation the shell badge also reads), so the badge and the list cannot
 * disagree. Nothing here adds or removes rows.
 */

/** Items answered in place (an answer box on Home) rather than opened elsewhere. */
export function answersInPlace(kind: InboxKind): boolean {
	return kind === "clarify" || kind === "needs_answer";
}

/** The oldest item first: what `n` jumps to. Ties keep list order. */
export function oldestFirst<T extends { ts: number }>(
	items: readonly T[],
): T[] {
	return items
		.map((item, i) => ({ item, i }))
		.sort((a, b) => a.item.ts - b.item.ts || a.i - b.i)
		.map((x) => x.item);
}

/**
 * Where an item leads. Review items open the task inspector's Changes tab; a
 * question is answered on Home, so its target is Home itself.
 */
export function needTarget(item: InboxItem): string {
	const { project, taskId, runId } = item;
	switch (item.kind) {
		case "review":
			return taskId ? href.changes(project, taskId) : href.board(project);
		case "clarify":
		case "needs_answer":
			return href.home();
		case "approval_pending":
		case "stalled":
		case "admission":
		case "failed_run":
		case "merge_parked":
			if (runId) return href.run(project, runId);
			return taskId ? href.task(project, taskId) : href.board(project);
		case "trigger_disarmed":
		case "trigger_failed":
			return item.defId
				? href.triggers(project, item.defId)
				: href.triggers(project);
		case "blocked":
		case "verify_infra":
		case "draft_failed":
		case "ownership_conflict":
		case "main_red":
			return taskId ? href.task(project, taskId) : href.board(project);
		case "brain_stuck":
			return href.flow(project, { node: nodeRef.brain() });
		case "brain_notice":
			// What it blocks, when it names a task; else the brain's own decisions.
			return taskId
				? href.task(project, taskId)
				: href.flow(project, { node: nodeRef.brain() });
		case "sweep_infra":
		case "followups":
			return href.board(project);
		case "budget":
			return href.projectSettings(project);
	}
}

/** The target of `n`: the oldest waiting item, or null when nothing waits. */
export function nextNeedTarget(items: readonly InboxItem[]): string | null {
	const first = oldestFirst(items)[0];
	return first ? needTarget(first) : null;
}
