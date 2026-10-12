import type { FlowNode } from "@mfw/daemon/flow";

import { STATE_LOOK } from "../../components/agent/look";
import type { GlyphName } from "../../components/icons/glyphs";

/**
 * The Flow lens's view model, pure (design §5.3). `flow.tree` returns a flat
 * array of nodes with `parent` refs; this turns it, plus what the person
 * expanded and filtered, into the flat array of VISIBLE rows the virtual
 * grid renders.
 *
 * Rules, in one place so the lens and Home's live section cannot drift:
 * - default expansion is "follow what matters": the strict ancestors of live
 *   and needs-me nodes are open, everything else is closed (ended subtrees
 *   collapse, which is also the aggregated view of a lineage: `3 runs` plus one outcome icon each); an explicit toggle (`overrides`) beats the default;
 * - done / archived task siblings fold into one `37 done tasks` row per
 *   parent, unless they are active or a filter is on;
 * - a filter keeps the ancestors of its matches, dimmed, so position stays
 *   legible, and opens them so the matches are visible.
 */

export type FlowNodeIn = FlowNode;

export const LIVE_RUN_STATES: ReadonlySet<string> = new Set([
	"starting",
	"running",
	"ended",
	"finalizing",
	"merging",
]);
/** Board status roles whose tasks fold away. */
export const TERMINAL_STATUS_ROLES: ReadonlySet<string> = new Set([
	"done",
	"archived",
	"dropped",
	"cancelled",
]);
const CHAIN_RELATIONS: ReadonlySet<string> = new Set([
	"continue",
	"repair",
	"resume",
	"answer",
	"unblock",
]);
/** Folding fewer than this many siblings would hide as much as it saves. */
export const FOLD_MIN = 2;
const CHAIN_GLYPHS_MAX = 6;

export const isTaskNode = (n: FlowNodeIn): boolean =>
	n.kind === "epic" || n.kind === "group_task" || n.kind === "task";
export const isRunNode = (n: FlowNodeIn): boolean =>
	n.kind === "run" || n.kind === "judge";
export const isSubNode = (n: FlowNodeIn): boolean => n.kind === "sub";

/** A subagent that ended less than this ago still keeps its run's row open (a fork count after it). */
export const SUB_LINGER_MS = 30_000;

/** A subagent that is running, or ended within `SUB_LINGER_MS`. */
export function isActiveSub(n: FlowNodeIn, now: number): boolean {
	const sub = n.sub;
	if (!sub) return false;
	if (sub.status === "running") return true;
	return sub.endedAt !== null && now - sub.endedAt.getTime() < SUB_LINGER_MS;
}
export const isLiveNode = (n: FlowNodeIn): boolean =>
	n.run !== undefined && LIVE_RUN_STATES.has(n.run.state);
const isTerminalTask = (n: FlowNodeIn): boolean =>
	isTaskNode(n) &&
	n.status !== undefined &&
	TERMINAL_STATUS_ROLES.has(n.status.role ?? n.status.value);

// ---------------------------------------------------------------------------
// filter (the `f` URL param)
// ---------------------------------------------------------------------------

export interface FlowFilter {
	needsMe?: boolean;
	live?: boolean;
	status?: string;
	role?: string;
	harness?: string;
	model?: string;
	host?: string;
	/** A duration (`30m`, `2h`, `7d`): only nodes touched within it. */
	since?: string;
	/** Free text over id, title and label. */
	q?: string;
}

const VALUE_KEYS = [
	"status",
	"role",
	"harness",
	"model",
	"host",
	"since",
] as const satisfies readonly (keyof FlowFilter)[];

/** `needs:me live status:doing host:local build the thing` to a filter. Unknown `key:value` tokens are free text. */
export function parseFlowFilter(f: string | undefined): FlowFilter {
	const out: FlowFilter = {};
	const words: string[] = [];
	for (const token of (f ?? "").split(/\s+/)) {
		if (token === "") continue;
		if (token === "needs:me") {
			out.needsMe = true;
			continue;
		}
		if (token === "live") {
			out.live = true;
			continue;
		}
		const colon = token.indexOf(":");
		const key = colon > 0 ? token.slice(0, colon) : "";
		const value = colon > 0 ? token.slice(colon + 1) : "";
		if (value !== "" && (VALUE_KEYS as readonly string[]).includes(key)) {
			out[key as (typeof VALUE_KEYS)[number]] = value;
			continue;
		}
		words.push(token);
	}
	if (words.length > 0) out.q = words.join(" ");
	return out;
}

/** The canonical string for a filter; `undefined` when empty so the URL stays clean. */
export function formatFlowFilter(filter: FlowFilter): string | undefined {
	const parts: string[] = [];
	if (filter.needsMe) parts.push("needs:me");
	if (filter.live) parts.push("live");
	for (const key of VALUE_KEYS) {
		const v = filter[key];
		if (v) parts.push(`${key}:${v}`);
	}
	if (filter.q) parts.push(filter.q);
	return parts.length > 0 ? parts.join(" ") : undefined;
}

export const isFilterEmpty = (f: FlowFilter): boolean =>
	formatFlowFilter(f) === undefined;

const UNIT_MS: Record<string, number> = {
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
	w: 7 * 86_400_000,
};

/** `90m`, `2h`, `7d` in ms; anything else is null. */
export function parseDuration(text: string): number | null {
	const m = /^(\d{1,4})([mhdw])$/.exec(text);
	return m ? Number(m[1]) * (UNIT_MS[m[2] as string] as number) : null;
}

function matches(n: FlowNodeIn, f: FlowFilter, now: number): boolean {
	if (f.needsMe && !n.needsMe) return false;
	if (f.live && !isLiveNode(n)) return false;
	if (f.status) {
		const have = n.status?.value ?? n.run?.state;
		if (have !== f.status) return false;
	}
	if (f.role && n.run?.role !== f.role) return false;
	if (f.harness) {
		const h = n.run?.harness?.toLowerCase();
		if (!h?.includes(f.harness.toLowerCase())) return false;
	}
	if (f.model && !n.run?.model.toLowerCase().includes(f.model.toLowerCase()))
		return false;
	if (f.host && n.run?.host !== f.host) return false;
	if (f.since) {
		const ms = parseDuration(f.since);
		if (ms !== null && n.lastAt.getTime() < now - ms) return false;
	}
	if (f.q) {
		const needle = f.q.toLowerCase();
		const hay = `${n.ref} ${n.title} ${n.run?.label ?? ""}`.toLowerCase();
		if (!hay.includes(needle)) return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// flatten
// ---------------------------------------------------------------------------

export interface FlowRow {
	/** The node's ref, or `fold:<parentRef|root>` for a fold row. */
	key: string;
	kind: "node" | "fold";
	node?: FlowNodeIn;
	/** 0 for a root; `aria-level` is `depth + 1`. */
	depth: number;
	/** Has something to open (children, or a fold's hidden siblings). */
	expandable: boolean;
	expanded: boolean;
	/** Kept only to place a filter match; drawn greyed. */
	dim: boolean;
	posInSet: number;
	setSize: number;
	/** Key of the row this one hangs under (the `h` key's target). */
	parentKey: string | null;
	/** A live or needs-me node is this row or below it. */
	active: boolean;
	/** Fold rows: how many siblings are hidden. */
	fold?: { count: number; refs: string[] };
	/** Collapsed rows with runs below: `3 runs` plus an icon per outcome. */
	chain?: { count: number; glyphs: GlyphName[]; labels: string[] };
	/** Epics and group tasks: leaf tasks done of total. */
	progress?: { done: number; total: number };
	/** Runs and subagents with subagents below: a fork count (and how many are still going). */
	subs?: { count: number; running: number };
}

export interface FlowView {
	rows: FlowRow[];
	/** Nodes matching the filter (all nodes when none is set). */
	matchCount: number;
	indexByKey: ReadonlyMap<string, number>;
}

export interface FlowViewOptions {
	/** Explicit open/closed per key; beats the default. */
	overrides?: ReadonlyMap<string, boolean> | Readonly<Record<string, boolean>>;
	filter?: FlowFilter;
	now?: number;
	foldDone?: boolean;
}

const KIND_RANK: Record<string, number> = {
	brain: -1,
	epic: 0,
	group_task: 0,
	task: 0,
	group: 1,
	sub: 1,
	run: 2,
	judge: 2,
	decision: 3,
};

function overrideOf(
	overrides: FlowViewOptions["overrides"],
	key: string,
): boolean | undefined {
	if (!overrides) return undefined;
	return overrides instanceof Map
		? overrides.get(key)
		: (overrides as Record<string, boolean>)[key];
}

export function buildFlow(
	nodes: readonly FlowNodeIn[],
	opts: FlowViewOptions = {},
): FlowView {
	const now = opts.now ?? Date.now();
	const filter = opts.filter ?? {};
	const filtering = !isFilterEmpty(filter);
	const foldDone = (opts.foldDone ?? true) && !filtering;

	const byRef = new Map<string, FlowNodeIn>();
	for (const n of nodes) byRef.set(n.ref, n);
	const children = new Map<string | null, FlowNodeIn[]>();
	for (const n of nodes) {
		const p = n.parent !== null && byRef.has(n.parent) ? n.parent : null;
		const list = children.get(p);
		if (list) list.push(n);
		else children.set(p, [n]);
	}
	// Stable: tasks, then the folded history, then runs by start.
	for (const list of children.values()) {
		const input = new Map(list.map((n, i) => [n.ref, i]));
		list.sort(
			(a, b) =>
				(KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) ||
				(a.run && b.run
					? a.run.startedAt.getTime() - b.run.startedAt.getTime()
					: 0) ||
				(input.get(a.ref) as number) - (input.get(b.ref) as number),
		);
	}

	// A pre-order of the forest (cycle safe), walked backwards for bottom-up folds.
	const order: FlowNodeIn[] = [];
	const seen = new Set<string>();
	const stack: FlowNodeIn[] = [...(children.get(null) ?? [])].reverse();
	while (stack.length > 0) {
		const n = stack.pop() as FlowNodeIn;
		if (seen.has(n.ref)) continue;
		seen.add(n.ref);
		order.push(n);
		const kids = children.get(n.ref);
		if (kids)
			for (let i = kids.length - 1; i >= 0; i--)
				stack.push(kids[i] as FlowNodeIn);
	}

	// --- bottom-up facts ---------------------------------------------------
	const activeSub = new Set<string>(); // self or below is live / needs me
	const matchSub = new Set<string>(); // self or below matches the filter
	const matchSelf = new Set<string>();
	const runsBelow = new Map<string, FlowNodeIn[]>();
	const progress = new Map<string, { done: number; total: number }>();
	const subsBelow = new Map<string, { count: number; running: number }>();
	for (let i = order.length - 1; i >= 0; i--) {
		const n = order[i] as FlowNodeIn;
		const kids = children.get(n.ref) ?? [];
		if (isLiveNode(n) || n.needsMe !== null || isActiveSub(n, now))
			activeSub.add(n.ref);
		// Subagents hang off the run (or subagent) that started them: count the
		// ones below this row, not those of runs that continue it.
		let subCount = 0;
		let subRunning = 0;
		for (const k of kids) {
			if (!isSubNode(k)) continue;
			const deeper = subsBelow.get(k.ref);
			subCount += 1 + (deeper?.count ?? 0);
			subRunning +=
				(k.sub?.status === "running" ? 1 : 0) + (deeper?.running ?? 0);
		}
		if (subCount > 0)
			subsBelow.set(n.ref, { count: subCount, running: subRunning });
		if (filtering && matches(n, filter, now)) matchSelf.add(n.ref);
		if (matchSelf.has(n.ref)) matchSub.add(n.ref);
		const below: FlowNodeIn[] = [];
		let done = 0;
		let total = 0;
		for (const k of kids) {
			if (activeSub.has(k.ref)) activeSub.add(n.ref);
			if (matchSub.has(k.ref)) matchSub.add(n.ref);
			if (isRunNode(k)) below.push(k);
			const deeper = runsBelow.get(k.ref);
			if (deeper) below.push(...deeper);
			if (isTaskNode(k)) {
				const p = progress.get(k.ref);
				if (p) {
					done += p.done;
					total += p.total;
				} else {
					total += 1;
					if (isTerminalTask(k)) done += 1;
				}
			}
		}
		if (below.length > 0) runsBelow.set(n.ref, below);
		if (total > 0) progress.set(n.ref, { done, total });
	}

	const chainOf = (ref: string): FlowRow["chain"] => {
		const below = runsBelow.get(ref);
		if (!below || below.length === 0) return undefined;
		const sorted = [...below].sort(
			(a, b) =>
				(a.run?.startedAt.getTime() ?? 0) - (b.run?.startedAt.getTime() ?? 0),
		);
		const tail = sorted.slice(-CHAIN_GLYPHS_MAX);
		const lookOf = (r: FlowNodeIn) =>
			STATE_LOOK[r.run?.state as keyof typeof STATE_LOOK] ?? STATE_LOOK.ended;
		return {
			count: sorted.length,
			glyphs: tail.map((r) => lookOf(r).glyph),
			labels: tail.map((r) => lookOf(r).label),
		};
	};

	// --- flatten -----------------------------------------------------------
	const rows: FlowRow[] = [];
	const visibleKids = (ref: string | null): FlowNodeIn[] => {
		const kids = children.get(ref) ?? [];
		return filtering ? kids.filter((k) => matchSub.has(k.ref)) : kids;
	};

	const emit = (
		n: FlowNodeIn,
		depth: number,
		parentKey: string | null,
		posInSet: number,
		setSize: number,
	) => {
		const kids = visibleKids(n.ref);
		const expandable = kids.length > 0;
		// The brain is the root of everything: closed, the tree would be one row.
		const byDefault =
			filtering || n.kind === "brain"
				? expandable
				: kids.some((k) => activeSub.has(k.ref));
		const expanded =
			expandable && (overrideOf(opts.overrides, n.ref) ?? byDefault);
		const chain = expandable && !expanded ? chainOf(n.ref) : undefined;
		const prog = progress.get(n.ref);
		const subs = subsBelow.get(n.ref);
		rows.push({
			key: n.ref,
			kind: "node",
			node: n,
			depth,
			expandable,
			expanded,
			dim: filtering && !matchSelf.has(n.ref),
			posInSet,
			setSize,
			parentKey,
			active: activeSub.has(n.ref),
			...(chain ? { chain } : {}),
			...(prog && n.kind !== "task" ? { progress: prog } : {}),
			...(subs ? { subs } : {}),
		});
		if (expanded) emitList(kids, depth + 1, n.ref);
	};

	const emitList = (
		list: readonly FlowNodeIn[],
		depth: number,
		parent: string | null,
	) => {
		const foldable = foldDone
			? list.filter((k) => isTerminalTask(k) && !activeSub.has(k.ref))
			: [];
		const folding = foldable.length >= FOLD_MIN;
		const foldKey = `fold:${parent ?? "root"}`;
		const foldOpen = folding && overrideOf(opts.overrides, foldKey) === true;
		const members = new Set(foldable.map((k) => k.ref));
		const shown =
			folding && !foldOpen ? list.filter((k) => !members.has(k.ref)) : list;
		const setSize = shown.length + (folding ? 1 : 0);
		let pos = 0;
		let foldEmitted = false;
		const emitFold = () => {
			foldEmitted = true;
			rows.push({
				key: foldKey,
				kind: "fold",
				depth,
				expandable: true,
				expanded: foldOpen,
				dim: false,
				posInSet: ++pos,
				setSize,
				parentKey: parent,
				active: false,
				fold: { count: foldable.length, refs: foldable.map((k) => k.ref) },
			});
		};
		for (const k of shown) {
			// The fold row sits where the history would: after the tasks, before runs.
			if (folding && !foldEmitted && (KIND_RANK[k.kind] ?? 9) > 0) emitFold();
			emit(k, depth, parent, ++pos, setSize);
		}
		if (folding && !foldEmitted) emitFold();
	};
	emitList(visibleKids(null), 0, null);

	const indexByKey = new Map<string, number>();
	for (let i = 0; i < rows.length; i++)
		indexByKey.set((rows[i] as FlowRow).key, i);
	return {
		rows,
		matchCount: filtering ? matchSelf.size : order.length,
		indexByKey,
	};
}

// ---------------------------------------------------------------------------
// follow
// ---------------------------------------------------------------------------

/**
 * What follow mode keeps in view: the newest live run, else the most recently
 * touched node that needs a person. `null` when nothing is active.
 */
export function followTarget(nodes: readonly FlowNodeIn[]): string | null {
	let live: FlowNodeIn | null = null;
	let needs: FlowNodeIn | null = null;
	for (const n of nodes) {
		if (isLiveNode(n)) {
			if (
				!live ||
				(n.run?.startedAt.getTime() ?? 0) > (live.run?.startedAt.getTime() ?? 0)
			)
				live = n;
		} else if (n.needsMe && (!needs || n.lastAt > needs.lastAt)) needs = n;
	}
	return (live ?? needs)?.ref ?? null;
}

/** The row index showing `ref`, or the nearest visible ancestor's when it is hidden. -1 when neither is. */
export function rowIndexFor(
	view: FlowView,
	nodes: readonly FlowNodeIn[],
	ref: string,
): number {
	const direct = view.indexByKey.get(ref);
	if (direct !== undefined) return direct;
	const byRef = new Map(nodes.map((n) => [n.ref, n]));
	let at = byRef.get(ref)?.parent ?? null;
	const guard = new Set<string>();
	while (at && !guard.has(at)) {
		guard.add(at);
		const i = view.indexByKey.get(at);
		if (i !== undefined) return i;
		at = byRef.get(at)?.parent ?? null;
	}
	return -1;
}

// ---------------------------------------------------------------------------
// keyboard (WAI-ARIA treegrid)
// ---------------------------------------------------------------------------

export type TreeKey =
	| "next"
	| "prev"
	| "first"
	| "last"
	| "open"
	| "close"
	| "select"
	| "actions";

/** Map a physical key to the tree's verbs: `j k h l Enter .` and the arrows. */
export function treeKeyFor(key: string): TreeKey | null {
	switch (key) {
		case "j":
		case "ArrowDown":
			return "next";
		case "k":
		case "ArrowUp":
			return "prev";
		case "l":
		case "ArrowRight":
			return "open";
		case "h":
		case "ArrowLeft":
			return "close";
		case "Home":
			return "first";
		case "End":
			return "last";
		case "Enter":
			return "select";
		case ".":
			return "actions";
		default:
			return null;
	}
}

export interface TreeStep {
	/** The row to focus. */
	focus: number;
	/** A key to open or close. */
	toggle?: { key: string; open: boolean };
	/** Select this node (opens the inspector). */
	select?: string;
	/** Open this node's actions. */
	actions?: string;
}

/**
 * One keypress against the visible rows, per the treegrid pattern: `l` opens
 * a closed row and otherwise steps into its first child; `h` closes an open
 * row and otherwise steps to its parent.
 */
export function stepTree(
	rows: readonly FlowRow[],
	focus: number,
	key: TreeKey,
): TreeStep {
	if (rows.length === 0) return { focus: -1 };
	const at = Math.max(0, Math.min(focus, rows.length - 1));
	const row = rows[at] as FlowRow;
	switch (key) {
		case "next":
			return { focus: Math.min(at + 1, rows.length - 1) };
		case "prev":
			return { focus: Math.max(at - 1, 0) };
		case "first":
			return { focus: 0 };
		case "last":
			return { focus: rows.length - 1 };
		case "open": {
			if (row.expandable && !row.expanded)
				return { focus: at, toggle: { key: row.key, open: true } };
			const next = rows[at + 1];
			if (row.expanded && next && next.depth > row.depth)
				return { focus: at + 1 };
			return { focus: at };
		}
		case "close": {
			if (row.expandable && row.expanded)
				return { focus: at, toggle: { key: row.key, open: false } };
			const parent = row.parentKey
				? rows.findIndex((r) => r.key === row.parentKey)
				: -1;
			return { focus: parent >= 0 ? parent : at };
		}
		case "select":
			return { focus: at, select: row.node?.ref ?? row.key };
		case "actions":
			return { focus: at, actions: row.node?.ref ?? row.key };
	}
}

// ---------------------------------------------------------------------------
// lineage (the run inspector's header)
// ---------------------------------------------------------------------------

export interface Lineage {
	/** Root first, the node last. */
	crumbs: FlowNodeIn[];
	/** The worktree chain the run belongs to, oldest first (includes the run). Empty unless it has siblings. */
	family: FlowNodeIn[];
	/** The run it continues, when it is a chain link. */
	continues: FlowNodeIn | null;
}

/** Breadcrumb from tree parents and the chain a run sits in. Pure over `flow.tree` nodes. */
export function lineageOf(
	nodes: readonly FlowNodeIn[],
	ref: string,
): Lineage | null {
	const byRef = new Map(nodes.map((n) => [n.ref, n]));
	const node = byRef.get(ref);
	if (!node) return null;
	const crumbs: FlowNodeIn[] = [];
	const guard = new Set<string>();
	for (
		let at: FlowNodeIn | undefined = node;
		at && !guard.has(at.ref);
		at = at.parent ? byRef.get(at.parent) : undefined
	) {
		guard.add(at.ref);
		crumbs.unshift(at);
	}
	const isChainLink = (n: FlowNodeIn) =>
		n.kind === "run" &&
		n.run !== undefined &&
		CHAIN_RELATIONS.has(n.run.relation);
	let family: FlowNodeIn[] = [];
	let continues: FlowNodeIn | null = null;
	if (node.kind === "run") {
		// Up to the chain's first run, then down through chain links.
		let root: FlowNodeIn = node;
		const up = new Set<string>();
		while (isChainLink(root) && root.parent && !up.has(root.ref)) {
			up.add(root.ref);
			const p = byRef.get(root.parent);
			if (p?.kind !== "run") break;
			root = p;
		}
		const kids = new Map<string, FlowNodeIn[]>();
		for (const n of nodes) {
			if (n.parent && isChainLink(n)) {
				const list = kids.get(n.parent);
				if (list) list.push(n);
				else kids.set(n.parent, [n]);
			}
		}
		const seen = new Set<string>();
		const walk = [root];
		while (walk.length > 0) {
			const n = walk.pop() as FlowNodeIn;
			if (seen.has(n.ref)) continue;
			seen.add(n.ref);
			family.push(n);
			walk.push(...(kids.get(n.ref) ?? []));
		}
		family.sort(
			(a, b) =>
				(a.run?.startedAt.getTime() ?? 0) - (b.run?.startedAt.getTime() ?? 0),
		);
		if (family.length < 2) family = [];
		if (isChainLink(node) && node.parent) {
			const p = byRef.get(node.parent);
			if (p?.kind === "run") continues = p;
		}
	}
	return { crumbs, family, continues };
}
