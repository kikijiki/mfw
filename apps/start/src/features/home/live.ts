import { buildFlow, type FlowNodeIn, type FlowRow } from "../flow/flowModel";

/**
 * Home's live section, pure. It does not keep a grouping of its own: it reads
 * `flow.live` (the Flow tree restricted to live runs and their ancestors) and
 * flattens it with the same `buildFlow` the Flow lens uses, so a run is the
 * same row here and there (design §4.2).
 */

/** Projects with at least one live run, by name, with their run counts. */
export function liveProjects(
	runs: readonly { project: string }[] | undefined,
): { project: string; runCount: number }[] {
	const counts = new Map<string, number>();
	for (const r of runs ?? [])
		counts.set(r.project, (counts.get(r.project) ?? 0) + 1);
	return [...counts.entries()]
		.map(([project, runCount]) => ({ project, runCount }))
		.sort((a, b) => a.project.localeCompare(b.project));
}

/**
 * The rows for one project's live subset. Ancestors of live runs are open by
 * default, so this is the live tree fully expanded: epic, task, then its
 * runs oldest first.
 */
export function liveRows(
	nodes: readonly FlowNodeIn[] | undefined,
	now: number = Date.now(),
): FlowRow[] {
	return buildFlow(nodes ?? [], { now, foldDone: false }).rows;
}
