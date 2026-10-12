import { type BoardAgents, boardAgents, type CardRun } from "./boardAgents";

/**
 * The board at a past instant (design §6, U2-03): the cards are the tasks
 * that existed at `t`, in the column their status then put them in, with the
 * agents that were live then. It is derived from `flow.at`'s nodes; nothing
 * here asks the server for a second shape.
 */

/** The slice of a `flow.at` node the board reads. */
export interface AtNode {
	ref: string;
	parent: string | null;
	kind: string;
	status?: { value: string } | undefined;
	historyPips?: readonly { ref: string; glyph: string }[] | undefined;
	run?:
		| {
				state: string;
				activity: string | null;
				harness: string | null;
				model: string;
				startedAt: Date;
				liveCostUsd: number | null;
		  }
		| undefined;
}

const TASK_PREFIX = "task:";

/**
 * Tasks as they stood at `t`: those with a node in the as-of tree, carrying
 * the status that node reports. Tasks not in the tree did not exist yet (or
 * were deleted) and are dropped; everything else about a card stays current.
 */
export function tasksAt<T extends { id: string; status: string }>(
	tasks: readonly T[],
	nodes: readonly AtNode[],
): T[] {
	const statusById = new Map<string, string>();
	for (const n of nodes) {
		if (!n.ref.startsWith(TASK_PREFIX) || !n.status) continue;
		statusById.set(n.ref.slice(TASK_PREFIX.length), n.status.value);
	}
	const out: T[] = [];
	for (const t of tasks) {
		const status = statusById.get(t.id);
		if (status === undefined) continue;
		out.push(status === t.status ? t : { ...t, status });
	}
	return out;
}

/** The nearest `task:` ancestor of a node (runs chain through runs). */
function taskOf(
	ref: string,
	byRef: ReadonlyMap<string, AtNode>,
): string | null {
	const seen = new Set<string>();
	let cur: string | null = ref;
	while (cur && !seen.has(cur)) {
		seen.add(cur);
		if (cur.startsWith(TASK_PREFIX)) return cur.slice(TASK_PREFIX.length);
		cur = byRef.get(cur)?.parent ?? null;
	}
	return null;
}

const LIVE = new Set(["starting", "running", "ended", "finalizing", "merging"]);

/** The agents of the board at `t`: live runs and history pips from the as-of tree. */
export function boardAgentsAt(
	project: string,
	nodes: readonly AtNode[],
): BoardAgents {
	const byRef = new Map(nodes.map((n) => [n.ref, n]));
	const active: ({ project: string } & CardRun)[] = [];
	const pips: Record<string, { ref: string; glyph: string }[]> = {};
	for (const n of nodes) {
		if (n.ref.startsWith(TASK_PREFIX) && n.historyPips?.length) {
			pips[n.ref.slice(TASK_PREFIX.length)] = [...n.historyPips];
		}
		if (n.kind !== "run" || !n.run || !LIVE.has(n.run.state)) continue;
		active.push({
			project,
			runId: n.ref.slice("run:".length),
			state: n.run.state,
			activity: n.run.activity,
			taskId: taskOf(n.ref, byRef),
			providerId: n.run.harness,
			model: n.run.model,
			startedAt: n.run.startedAt.getTime(),
			liveCostUsd: null,
		});
	}
	return boardAgents(project, active, [], pips);
}
