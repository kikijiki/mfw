import type { TaskStatus } from "./types.ts";

/** Minimal node shape needed for dependency-graph reasoning. */
export interface GraphNode {
	id: string;
	status: TaskStatus;
	depends_on: string[];
}

export class CycleError extends Error {
	constructor(public readonly cycle: string[]) {
		super(`dependency cycle: ${cycle.join(" -> ")}`);
	}
}

function index<T extends GraphNode>(nodes: T[]): Map<string, T> {
	const m = new Map<string, T>();
	for (const n of nodes) m.set(n.id, n);
	return m;
}

/**
 * Detect the first dependency cycle, if any, via DFS with a recursion stack.
 * Edges that reference unknown ids are ignored here (validated separately).
 */
export function findCycle(nodes: GraphNode[]): string[] | null {
	const byId = index(nodes);
	const WHITE = 0,
		GRAY = 1,
		BLACK = 2;
	const color = new Map<string, number>();
	const stack: string[] = [];

	const visit = (id: string): string[] | null => {
		color.set(id, GRAY);
		stack.push(id);
		for (const dep of byId.get(id)?.depends_on ?? []) {
			if (!byId.has(dep)) continue;
			const c = color.get(dep) ?? WHITE;
			if (c === GRAY) {
				const from = stack.indexOf(dep);
				return [...stack.slice(from), dep];
			}
			if (c === WHITE) {
				const found = visit(dep);
				if (found) return found;
			}
		}
		stack.pop();
		color.set(id, BLACK);
		return null;
	};

	for (const n of nodes) {
		if ((color.get(n.id) ?? WHITE) === WHITE) {
			const cyc = visit(n.id);
			if (cyc) return cyc;
		}
	}
	return null;
}

/** Validate that every dependency references a known task id. */
export function findDanglingDeps(
	nodes: GraphNode[],
): { id: string; missing: string }[] {
	const ids = new Set(nodes.map((n) => n.id));
	const out: { id: string; missing: string }[] = [];
	for (const n of nodes) {
		for (const dep of n.depends_on) {
			if (!ids.has(dep)) out.push({ id: n.id, missing: dep });
		}
	}
	return out;
}

/** Kahn topological order. Throws CycleError if the graph is cyclic. */
export function topoSort(nodes: GraphNode[]): string[] {
	const byId = index(nodes);
	const indeg = new Map<string, number>();
	const dependents = new Map<string, string[]>();

	for (const n of nodes) indeg.set(n.id, 0);
	for (const n of nodes) {
		for (const dep of n.depends_on) {
			if (!byId.has(dep)) continue;
			const existing = dependents.get(dep);
			if (existing) {
				existing.push(n.id);
			} else {
				dependents.set(dep, [n.id]);
			}
			indeg.set(n.id, (indeg.get(n.id) ?? 0) + 1);
		}
	}

	// Process ready nodes in id order for determinism.
	const queue = [...nodes.map((n) => n.id)]
		.filter((id) => indeg.get(id) === 0)
		.sort();
	const order: string[] = [];
	while (queue.length) {
		const id = queue.shift();
		if (id === undefined) break;
		order.push(id);
		for (const d of dependents.get(id) ?? []) {
			indeg.set(d, (indeg.get(d) ?? 0) - 1);
			if (indeg.get(d) === 0) {
				const i = queue.findIndex((q) => q > d);
				if (i === -1) queue.push(d);
				else queue.splice(i, 0, d);
			}
		}
	}

	if (order.length !== nodes.length) {
		const cyc = findCycle(nodes);
		throw new CycleError(cyc ?? []);
	}
	return order;
}

/** Tasks in `ready/` whose every dependency is in `done/` (claimable). */
export function readySet(nodes: GraphNode[]): GraphNode[] {
	const byId = index(nodes);
	return nodes.filter((n) => {
		if (n.status !== "ready") return false;
		return n.depends_on.every((dep) => byId.get(dep)?.status === "done");
	});
}

/** Dependency ids not yet in `done/` (empty means unblocked). */
export function blockingDeps(node: GraphNode, all: GraphNode[]): string[] {
	const byId = index(all);
	return node.depends_on.filter((dep) => byId.get(dep)?.status !== "done");
}
