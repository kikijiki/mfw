import type { BoardConfig } from "./config.ts";
import {
	isExempt,
	type OwnershipExemptions,
	overlappingPatterns,
} from "./ownership.ts";
import type { BoardDocument } from "./store.ts";
import {
	childrenOf,
	descendantIds,
	effectiveDependencies,
	idsIn,
	isLive,
	isQueued,
	isTerminal,
	readyDocuments,
	type StatusClass,
	statusClassOf,
	uniqueById,
} from "./workflow.ts";

/**
 * Scheduling views over the workflow: the dependency graph, how much finishing
 * a document unblocks, and a conflict-free set of ready documents to start in
 * parallel (file scopes from a type's `ownership` field). Pure functions over
 * documents; the CLI loads them.
 */

const statusOf = (config: BoardConfig, d: BoardDocument): string => {
	const f = config.types[d.type]?.workflow?.statusField ?? "status";
	const v = d.fields[f];
	return typeof v === "string" ? v : "";
};

const titleOf = (d: BoardDocument): string =>
	typeof d.fields.title === "string" ? d.fields.title : "";

export interface GraphNode {
	id: string;
	type: string;
	title: string;
	status: string;
	class: StatusClass;
	ready: boolean;
}

export interface GraphEdge {
	/** The document that has to wait. */
	dependent: string;
	/** What it waits for. */
	dependency: string;
	kind: "depends_on" | "child";
}

export interface DependencyGraph {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

/**
 * The dependency graph of the workflow documents: an edge for each
 * `depends_on` entry and one for each hierarchy child (a parent waits for its
 * children). Finished documents are left out unless `all`, since they block
 * nothing. `under` keeps that document and its descendants.
 */
export function dependencyGraph(
	config: BoardConfig,
	docs: readonly BoardDocument[],
	opts: { under?: string; all?: boolean } = {},
): DependencyGraph {
	const all = uniqueById(docs).filter((d) => config.types[d.type]?.workflow);
	const within =
		opts.under === undefined
			? undefined
			: new Set([opts.under, ...descendantIds(config, all, opts.under)]);
	const readySet = new Set(readyDocuments(config, all).map((d) => d.id));
	const kept = all.filter(
		(d) =>
			(within === undefined || within.has(d.id)) &&
			(opts.all || !isTerminal(config, d.type, statusOf(config, d))),
	);
	const ids = new Set(kept.map((d) => d.id));
	const nodes: GraphNode[] = kept
		.map((d) => ({
			id: d.id,
			type: d.type,
			title: titleOf(d),
			status: statusOf(config, d),
			class: statusClassOf(config, d.type, statusOf(config, d)),
			ready: readySet.has(d.id),
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
	const edges: GraphEdge[] = [];
	for (const d of kept) {
		const depField =
			config.types[d.type]?.workflow?.ready.dependsOn ?? "depends_on";
		for (const dep of new Set(idsIn(d.fields[depField]))) {
			if (ids.has(dep)) {
				edges.push({ dependent: d.id, dependency: dep, kind: "depends_on" });
			}
		}
		for (const child of new Set(childrenOf(config, d))) {
			if (ids.has(child)) {
				edges.push({ dependent: d.id, dependency: child, kind: "child" });
			}
		}
	}
	edges.sort(
		(a, b) =>
			a.dependency.localeCompare(b.dependency) ||
			a.dependent.localeCompare(b.dependent),
	);
	return { nodes, edges };
}

const clip = (s: string, n = 48) =>
	s.length > n ? `${s.slice(0, n - 1)}…` : s;

/** Mermaid `graph LR`; arrows run dependency -> dependent (execution order). */
export function renderMermaid(g: DependencyGraph): string {
	const ref = (id: string) => id.replace(/[^A-Za-z0-9_]/g, "_");
	const lines = ["graph LR"];
	for (const n of g.nodes) {
		const label = `${n.id}${n.title ? `<br/>${clip(n.title).replace(/["<>]/g, "'")}` : ""}`;
		const cls = n.ready ? "ready" : n.class;
		lines.push(`  ${ref(n.id)}["${label}"]:::${cls}`);
	}
	for (const e of g.edges) {
		lines.push(
			`  ${ref(e.dependency)} ${e.kind === "child" ? "-.->" : "-->"} ${ref(e.dependent)}`,
		);
	}
	lines.push(
		"  classDef ready fill:#c8e6c9,stroke:#2e7d32",
		"  classDef live fill:#fff9c4,stroke:#f9a825",
		"  classDef parked fill:#eeeeee,stroke:#9e9e9e,stroke-dasharray:4",
		"  classDef terminal fill:#bbdefb,stroke:#1565c0",
		"  classDef other fill:#ffffff,stroke:#616161",
	);
	return lines.join("\n");
}

/** Graphviz DOT; arrows run dependency -> dependent, child edges are dashed. */
export function renderDot(g: DependencyGraph): string {
	const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	const fill: Record<string, string> = {
		ready: "#c8e6c9",
		live: "#fff9c4",
		parked: "#eeeeee",
		terminal: "#bbdefb",
		other: "#ffffff",
	};
	const lines = [
		"digraph board {",
		"  rankdir=LR;",
		"  node [shape=box, style=filled];",
	];
	for (const n of g.nodes) {
		const label = n.title ? `${n.id}\n${clip(n.title)}` : n.id;
		lines.push(
			`  ${q(n.id)} [label=${q(label)}, fillcolor=${q(fill[n.ready ? "ready" : n.class] as string)}];`,
		);
	}
	for (const e of g.edges) {
		lines.push(
			`  ${q(e.dependency)} -> ${q(e.dependent)}${e.kind === "child" ? " [style=dashed]" : ""};`,
		);
	}
	lines.push("}");
	return lines.join("\n");
}

export interface Impact {
	/** Open documents that transitively wait on this one. */
	unblocks: number;
	/** Longest chain of open documents that can only follow this one. */
	height: number;
}

/**
 * For every open (not finished) workflow document: how many open documents
 * transitively depend on it, and the longest chain behind it. Finishing a
 * document with a large count or a tall chain frees the most work.
 */
export function impactOf(
	config: BoardConfig,
	docs: readonly BoardDocument[],
): Map<string, Impact> {
	const all = uniqueById(docs).filter((d) => config.types[d.type]?.workflow);
	const open = new Set(
		all
			.filter((d) => !isTerminal(config, d.type, statusOf(config, d)))
			.map((d) => d.id),
	);
	const deps = effectiveDependencies(config, all);
	const waiting = new Map<string, string[]>(); // dependency -> dependents
	for (const [id, ds] of deps) {
		if (!open.has(id)) continue;
		for (const dep of ds) {
			if (!open.has(dep)) continue;
			const list = waiting.get(dep) ?? [];
			list.push(id);
			waiting.set(dep, list);
		}
	}
	const heights = new Map<string, number>();
	const visiting = new Set<string>();
	const height = (id: string): number => {
		const known = heights.get(id);
		if (known !== undefined) return known;
		if (visiting.has(id)) return 0; // a cycle is the validator's problem
		visiting.add(id);
		let h = 0;
		for (const next of waiting.get(id) ?? []) h = Math.max(h, 1 + height(next));
		visiting.delete(id);
		heights.set(id, h);
		return h;
	};
	const out = new Map<string, Impact>();
	for (const id of open) {
		const seen = new Set<string>();
		const stack = [...(waiting.get(id) ?? [])];
		while (stack.length > 0) {
			const next = stack.pop() as string;
			if (seen.has(next) || next === id) continue;
			seen.add(next);
			stack.push(...(waiting.get(next) ?? []));
		}
		out.set(id, { unblocks: seen.size, height: height(id) });
	}
	return out;
}

export interface PlanItem {
	id: string;
	type: string;
	title: string;
	unblocks: number;
	height: number;
	scope: string[];
}

export interface PlanSkip {
	id: string;
	reason: string;
}

export interface Plan {
	/** Start these together: no two share a file scope, and none collides with work in progress. */
	picked: PlanItem[];
	skipped: PlanSkip[];
	/** Live documents already started (their scopes are off limits). */
	inProgress: string[];
	/** Ready documents that merely wait to be closed (all children finished); never scheduled. */
	toClose: string[];
	/**
	 * In-progress documents that other open work waits on, biggest first: how
	 * many documents wait behind each, and which become ready the moment it
	 * finishes. This is the scheduling question when the graph is serial.
	 */
	blockers: { id: string; unblocks: number; next: string[] }[];
}

/**
 * A conflict-free batch of ready documents to start now. Candidates are the
 * ready documents that have no children (a ready parent only waits to be
 * closed), ranked by what they unblock, then by the chain behind them, then
 * id. Each is taken unless its file scope overlaps (after exemptions) work in
 * progress or an earlier pick, or `max` is reached. Documents without a scope
 * never conflict.
 */
export function planParallel(
	config: BoardConfig,
	docs: readonly BoardDocument[],
	opts: {
		under?: string;
		max?: number;
		exemptions?: (typeName: string) => OwnershipExemptions | undefined;
	} = {},
): Plan {
	const all = uniqueById(docs).filter((d) => config.types[d.type]?.workflow);
	const impact = impactOf(config, all);
	const scopeOf = (d: BoardDocument): string[] => {
		const field = config.types[d.type]?.ownership?.field;
		return field ? idsIn(d.fields[field]) : [];
	};
	const ready = readyDocuments(
		config,
		all,
		opts.under ? { under: opts.under } : {},
	);
	const toClose = ready
		.filter((d) => childrenOf(config, d).length > 0)
		.map((d) => d.id);
	const candidates = ready
		.filter((d) => childrenOf(config, d).length === 0)
		.sort((a, b) => {
			const ia = impact.get(a.id) ?? { unblocks: 0, height: 0 };
			const ib = impact.get(b.id) ?? { unblocks: 0, height: 0 };
			return (
				ib.unblocks - ia.unblocks ||
				ib.height - ia.height ||
				a.id.localeCompare(b.id)
			);
		});
	const inProgress = all.filter((d) => {
		const s = statusOf(config, d);
		return isLive(config, d.type, s) && !isQueued(config, d.type, s);
	});
	const holders: { doc: BoardDocument; how: string }[] = inProgress.map(
		(doc) => ({
			doc,
			how: "in progress",
		}),
	);
	const picked: PlanItem[] = [];
	const skipped: PlanSkip[] = [];
	const conflict = (c: BoardDocument): string | null => {
		const mine = scopeOf(c);
		if (mine.length === 0) return null;
		for (const h of holders) {
			const ex = h.doc.type === c.type ? opts.exemptions?.(c.type) : undefined;
			const hit = overlappingPatterns(mine, scopeOf(h.doc)).find(
				([pa, pb]) => !(ex && isExempt(ex, c.id, h.doc.id, pa, pb)),
			);
			if (hit)
				return `overlaps ${h.doc.id} (${h.how}) on ${hit[0]} ~ ${hit[1]}`;
		}
		return null;
	};
	for (const c of candidates) {
		if (opts.max !== undefined && picked.length >= opts.max) {
			skipped.push({ id: c.id, reason: `over --max ${opts.max}` });
			continue;
		}
		const why = conflict(c);
		if (why) {
			skipped.push({ id: c.id, reason: why });
			continue;
		}
		const i = impact.get(c.id) ?? { unblocks: 0, height: 0 };
		picked.push({
			id: c.id,
			type: c.type,
			title: titleOf(c),
			unblocks: i.unblocks,
			height: i.height,
			scope: scopeOf(c),
		});
		holders.push({ doc: c, how: "picked" });
	}
	const deps = effectiveDependencies(config, all);
	const finished = new Set(
		all
			.filter((d) => isTerminal(config, d.type, statusOf(config, d)))
			.map((d) => d.id),
	);
	const blockers = inProgress
		.map((d) => ({
			id: d.id,
			unblocks: impact.get(d.id)?.unblocks ?? 0,
			// ready as soon as this one finishes: queued, and this is its only open dependency
			next: all
				.filter((x) => {
					const xs = deps.get(x.id) ?? [];
					return (
						isQueued(config, x.type, statusOf(config, x)) &&
						xs.includes(d.id) &&
						xs.every((y) => y === d.id || finished.has(y))
					);
				})
				.map((x) => x.id)
				.sort(),
		}))
		.filter((b) => b.unblocks > 0)
		.sort((a, b) => b.unblocks - a.unblocks || a.id.localeCompare(b.id));
	return {
		picked,
		skipped,
		inProgress: inProgress.map((d) => d.id).sort(),
		toClose,
		blockers,
	};
}
