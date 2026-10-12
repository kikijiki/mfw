/**
 * Ordering of a batch of tasks that are created together.
 *
 * A new task has no id until it is written, so tasks in one `create_tasks`
 * call name each other by a local `ref`. A `parent` or `depends_on` entry that
 * equals another task's `ref` points inside the batch; anything else is an id
 * already on the board. Refs are lowercase and board ids are not, so the two
 * cannot collide.
 *
 * The write order is parents and dependencies first (the board refuses a
 * reference to a document that does not exist yet). A cycle through the batch
 * can be decided here, before anything is written, which is what makes
 * "all or none" cheap for the case that matters.
 */

export const REF_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;

export interface BatchNode {
	ref?: string | undefined;
	parent?: string | null | undefined;
	dependsOn?: readonly string[] | undefined;
}

export type BatchOrder =
	| { ok: true; order: number[] }
	| {
			ok: false;
			code: "duplicate_ref" | "dependency_cycle" | "hierarchy_cycle";
			message: string;
	  };

export function orderBatch(nodes: readonly BatchNode[]): BatchOrder {
	const byRef = new Map<string, number>();
	for (const [i, n] of nodes.entries()) {
		if (n.ref === undefined) continue;
		if (byRef.has(n.ref)) {
			return {
				ok: false,
				code: "duplicate_ref",
				message: `two tasks in the batch use ref '${n.ref}'`,
			};
		}
		byRef.set(n.ref, i);
	}
	// edge i -> j: j must exist before i
	const needs: { to: number; kind: "parent" | "depends_on" }[][] = nodes.map(
		(n) => {
			const out: { to: number; kind: "parent" | "depends_on" }[] = [];
			const p = n.parent ? byRef.get(n.parent) : undefined;
			if (p !== undefined) out.push({ to: p, kind: "parent" });
			for (const d of n.dependsOn ?? []) {
				const j = byRef.get(d);
				if (j !== undefined) out.push({ to: j, kind: "depends_on" });
			}
			return out;
		},
	);
	const state: (0 | 1 | 2)[] = nodes.map(() => 0);
	const order: number[] = [];
	const name = (i: number) => nodes[i]?.ref ?? `#${i}`;
	let cycle: { path: number[]; kinds: Set<string> } | null = null;
	const visit = (i: number, path: number[]): boolean => {
		if (state[i] === 2) return true;
		if (state[i] === 1) {
			const at = path.indexOf(i);
			const loop = [...path.slice(at), i];
			const kinds = new Set<string>();
			for (let k = 0; k < loop.length - 1; k++) {
				for (const e of needs[loop[k] as number] ?? []) {
					if (e.to === loop[k + 1]) kinds.add(e.kind);
				}
			}
			cycle = { path: loop, kinds };
			return false;
		}
		state[i] = 1;
		for (const e of needs[i] ?? []) {
			if (!visit(e.to, [...path, i])) return false;
		}
		state[i] = 2;
		order.push(i);
		return true;
	};
	for (let i = 0; i < nodes.length; i++) {
		if (!visit(i, [])) {
			const c = cycle as unknown as { path: number[]; kinds: Set<string> };
			return {
				ok: false,
				code: c.kinds.has("depends_on")
					? "dependency_cycle"
					: "hierarchy_cycle",
				message: `the batch has a cycle: ${c.path.map(name).join(" -> ")}`,
			};
		}
	}
	return { ok: true, order };
}
