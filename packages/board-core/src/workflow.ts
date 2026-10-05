import type { BoardConfig } from "./config.ts";
import {
	type BoardDocument,
	type BoardStore,
	UnknownTypeError,
	type ValidationIssue,
} from "./store.ts";

/**
 * Readiness, liveness and transitions over a config-declared workflow (see
 * `workflow-config.ts`). The pure functions take a flat array of documents
 * from ALL types of the board (a parent and its children, or a dependency,
 * may live in different types). Ids are assumed unique across the array; on a
 * duplicate (e.g. an `inherit`ed id) the first document wins.
 */

export type StatusClass = "terminal" | "live" | "parked" | "other";

/** The slice of a hierarchy relation this module needs. Read defensively so it
 * works whether or not `BoardConfig.hierarchy` exists in this build. */
interface HierarchyLike {
	children: string;
}

function hierarchyOf(config: BoardConfig): HierarchyLike | undefined {
	return (config as { hierarchy?: HierarchyLike }).hierarchy;
}

export function statusClassOf(
	config: BoardConfig,
	typeName: string,
	status: unknown,
): StatusClass {
	const c = config.types[typeName]?.workflow?.classes;
	if (!c || typeof status !== "string") return "other";
	if (c.terminal.includes(status)) return "terminal";
	if (c.live.includes(status)) return "live";
	if (c.parked.includes(status)) return "parked";
	return "other";
}

export const isTerminal = (c: BoardConfig, t: string, s: unknown) =>
	statusClassOf(c, t, s) === "terminal";
export const isLive = (c: BoardConfig, t: string, s: unknown) =>
	statusClassOf(c, t, s) === "live";
export const isParked = (c: BoardConfig, t: string, s: unknown) =>
	statusClassOf(c, t, s) === "parked";
export function isQueued(
	config: BoardConfig,
	typeName: string,
	status: unknown,
): boolean {
	return (
		typeof status === "string" &&
		(config.types[typeName]?.workflow?.classes.queued.includes(status) ?? false)
	);
}

function statusOf(config: BoardConfig, doc: BoardDocument): unknown {
	const field = config.types[doc.type]?.workflow?.statusField ?? "status";
	return doc.fields[field];
}

const docTerminal = (config: BoardConfig, d: BoardDocument) =>
	isTerminal(config, d.type, statusOf(config, d));
const docLive = (config: BoardConfig, d: BoardDocument) =>
	isLive(config, d.type, statusOf(config, d));

export function idsIn(value: unknown): string[] {
	if (typeof value === "string") return value ? [value] : [];
	if (Array.isArray(value)) {
		return value.filter((v): v is string => typeof v === "string" && v !== "");
	}
	return [];
}

export function childrenOf(config: BoardConfig, doc: BoardDocument): string[] {
	const field = hierarchyOf(config)?.children;
	return field ? idsIn(doc.fields[field]) : [];
}

export function uniqueById(docs: readonly BoardDocument[]): BoardDocument[] {
	const seen = new Set<string>();
	return docs.filter((d) => !seen.has(d.id) && seen.add(d.id));
}

/** Each document's dependency field UNION its hierarchy children, deduped. */
export function effectiveDependencies(
	config: BoardConfig,
	docs: readonly BoardDocument[],
): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const doc of uniqueById(docs)) {
		const depField =
			config.types[doc.type]?.workflow?.ready.dependsOn ?? "depends_on";
		out.set(doc.id, [
			...new Set([...idsIn(doc.fields[depField]), ...childrenOf(config, doc)]),
		]);
	}
	return out;
}

/** Transitive descendants of `root` via hierarchy children (root excluded). */
export function descendantIds(
	config: BoardConfig,
	docs: readonly BoardDocument[],
	root: string,
): Set<string> {
	const byId = new Map(docs.map((d) => [d.id, d] as const));
	const seen = new Set<string>();
	const queue = [root];
	for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
		const doc = byId.get(id);
		if (!doc) continue;
		for (const child of childrenOf(config, doc)) {
			if (child === root || seen.has(child)) continue;
			seen.add(child);
			queue.push(child);
		}
	}
	return seen;
}

function scoped(
	config: BoardConfig,
	docs: readonly BoardDocument[],
	under: string | undefined,
): BoardDocument[] {
	if (under === undefined) return [...docs];
	const ids = descendantIds(config, docs, under);
	return docs.filter((d) => ids.has(d.id));
}

/**
 * Documents eligible to START: status in the type's `queued` class and every
 * effective dependency present and terminal. Sorted by id. `under` limits
 * candidates to descendants of that id; dependencies still resolve board-wide.
 */
export function readyDocuments(
	config: BoardConfig,
	docs: readonly BoardDocument[],
	opts: { under?: string } = {},
): BoardDocument[] {
	const all = uniqueById(docs);
	const deps = effectiveDependencies(config, all);
	const terminal = new Set(
		all.filter((d) => docTerminal(config, d)).map((d) => d.id),
	);
	return scoped(config, all, opts.under)
		.filter((d) => isQueued(config, d.type, statusOf(config, d)))
		.filter((d) => (deps.get(d.id) ?? []).every((x) => terminal.has(x)))
		.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Simulate every runnable document completing, in waves, from the board's
 * actual terminal set. Only a LIVE document can join the simulated set (a
 * parked one needs a human). Returns the LIVE documents that can never drain
 * (dangling dependency, dependency on a parked document, cycle) mapped to
 * their still-unresolved effective dependencies. Parked/terminal documents are
 * never reported. `under` limits only what is reported, not the simulation.
 */
export function blockedAfterCompletion(
	config: BoardConfig,
	docs: readonly BoardDocument[],
	opts: { under?: string } = {},
): Map<string, string[]> {
	const all = uniqueById(docs);
	const deps = effectiveDependencies(config, all);
	const done = new Set(
		all.filter((d) => docTerminal(config, d)).map((d) => d.id),
	);
	const live = all.filter((d) => docLive(config, d));
	for (let grew = true; grew; ) {
		grew = false;
		for (const d of live) {
			if (done.has(d.id)) continue;
			if ((deps.get(d.id) ?? []).every((x) => done.has(x))) {
				done.add(d.id);
				grew = true;
			}
		}
	}
	const blocked = new Map<string, string[]>();
	for (const d of live) {
		if (done.has(d.id)) continue;
		blocked.set(
			d.id,
			(deps.get(d.id) ?? []).filter((x) => !done.has(x)),
		);
	}
	if (opts.under === undefined) return blocked;
	const within = descendantIds(config, all, opts.under);
	return new Map([...blocked].filter(([id]) => within.has(id)));
}

/**
 * Level = longest chain of effective dependencies down to a leaf (0 for none).
 * A cycle contributes 0 for the node found mid-cycle; never recurses forever.
 */
export function computeLevels(
	config: BoardConfig,
	docs: readonly BoardDocument[],
): Map<string, number> {
	const deps = effectiveDependencies(config, docs);
	const levels = new Map<string, number>();
	const visiting = new Set<string>();
	function levelOf(id: string): number {
		const cached = levels.get(id);
		if (cached !== undefined) return cached;
		const edges = deps.get(id);
		if (!edges || visiting.has(id)) return 0;
		visiting.add(id);
		let level = 0;
		for (const d of edges) level = Math.max(level, 1 + levelOf(d));
		visiting.delete(id);
		levels.set(id, level);
		return level;
	}
	for (const id of deps.keys()) levelOf(id);
	return levels;
}

/** Cycles in the effective dependency graph (depends_on + children edges). */
export function workflowIssues(
	config: BoardConfig,
	docs: readonly BoardDocument[],
): ValidationIssue[] {
	const all = uniqueById(docs);
	const byId = new Map(all.map((d) => [d.id, d] as const));
	const deps = effectiveDependencies(config, all);
	const issues: ValidationIssue[] = [];
	const reported = new Set<string>();
	const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = finished
	const stack: string[] = [];

	function report(cycle: string[]): void {
		const start = cycle.indexOf([...cycle].sort()[0] as string);
		const rotated = [...cycle.slice(start), ...cycle.slice(0, start)];
		const key = rotated.join(">");
		if (reported.has(key)) return;
		reported.add(key);
		const first = rotated[0] as string;
		const doc = byId.get(first);
		issues.push({
			kind: "cycle",
			type: doc?.type ?? "",
			id: first,
			path: doc?.path ?? "",
			message: `dependency cycle: ${[...rotated, first].join(" -> ")} (depends_on and hierarchy children both count as dependencies)`,
		});
	}

	function visit(id: string): void {
		state.set(id, 1);
		stack.push(id);
		for (const next of deps.get(id) ?? []) {
			if (!deps.has(next)) continue;
			const s = state.get(next);
			if (s === 1) report(stack.slice(stack.indexOf(next)));
			else if (s === undefined) visit(next);
		}
		stack.pop();
		state.set(id, 2);
	}
	for (const id of [...deps.keys()].sort()) {
		if (!state.has(id)) visit(id);
	}
	return issues;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export class UnknownTransitionError extends Error {
	constructor(
		readonly type: string,
		readonly verb: string,
		readonly available: readonly string[],
	) {
		super(
			`type '${type}' has no transition '${verb}'` +
				(available.length > 0
					? ` (available: ${available.join(", ")})`
					: " (it declares none)"),
		);
		this.name = "UnknownTransitionError";
	}
}

export class TransitionArgError extends Error {
	constructor(
		readonly verb: string,
		message: string,
	) {
		super(`transition '${verb}': ${message}`);
		this.name = "TransitionArgError";
	}
}

export class TransitionPreconditionError extends Error {
	constructor(
		readonly id: string,
		readonly from: readonly string[],
		readonly actual: string,
	) {
		super(`${id}: expected status ${from.join(" or ")}, got '${actual}'`);
		this.name = "TransitionPreconditionError";
	}
}

export class ChildrenOpenError extends Error {
	constructor(
		readonly id: string,
		readonly openChildIds: readonly string[],
	) {
		super(
			`${id}: cannot reach a terminal status while children are not terminal: ${openChildIds.join(", ")}`,
		);
		this.name = "ChildrenOpenError";
	}
}

export function todayUtc(): string {
	return new Date().toISOString().slice(0, 10);
}

/** Is `s` (`YYYY-MM-DD`) a real calendar date (no `2026-02-31`, `2026-99-99`)? */
export function isCalendarDate(s: string): boolean {
	const d = new Date(`${s}T00:00:00Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

async function findDocument(
	store: BoardStore,
	config: BoardConfig,
	ref: readonly string[] | "any" | undefined,
	id: string,
): Promise<BoardDocument | null> {
	const typeNames = ref && ref !== "any" ? ref : Object.keys(config.types);
	for (const t of typeNames) {
		const doc = await store.readDocument(t, id);
		if (doc) return doc;
	}
	return null;
}

/**
 * Run transition `verb` on one document. The `from` precondition and the
 * built-in children rule are checked inside `store.transact`, so they are
 * race-free; any failure throws and writes nothing. Returns the new document.
 */
export async function applyTransition(
	store: BoardStore,
	config: BoardConfig,
	typeName: string,
	id: string,
	verb: string,
	arg?: string,
	opts: { date?: string } = {},
): Promise<BoardDocument> {
	const type = config.types[typeName];
	if (!type) throw new UnknownTypeError(typeName);
	const wf = type.workflow;
	const t = wf?.transitions[verb];
	if (!wf || !t) {
		throw new UnknownTransitionError(
			typeName,
			verb,
			Object.keys(wf?.transitions ?? {}),
		);
	}
	if (t.arg !== undefined && (arg === undefined || arg.trim() === "")) {
		throw new TransitionArgError(verb, `requires an argument (${t.arg})`);
	}
	if (t.arg === undefined && arg !== undefined) {
		throw new TransitionArgError(verb, "takes no argument");
	}
	if (opts.date !== undefined) {
		if (t.date === undefined) {
			throw new TransitionArgError(
				verb,
				"declares no date field, so takes no date",
			);
		}
		if (!isCalendarDate(opts.date)) {
			throw new TransitionArgError(
				verb,
				`date must be a real calendar date as YYYY-MM-DD, got '${opts.date}'`,
			);
		}
	}
	const toTerminal = wf.classes.terminal.includes(t.to);
	const childField = hierarchyOf(config)?.children;
	const childRef = childField
		? (() => {
				const f = type.fields[childField];
				return f?.kind === "ref" ? f.ref : undefined;
			})()
		: undefined;

	let actual = "";
	const next = await store.transact(typeName, id, async (current) => {
		actual = String(current.fields[wf.statusField]);
		if (!t.from.includes(actual)) return null;
		if (toTerminal && childField) {
			const open: string[] = [];
			for (const cid of idsIn(current.fields[childField])) {
				const child = await findDocument(store, config, childRef, cid);
				if (!child || !docTerminal(config, child)) open.push(cid);
			}
			if (open.length > 0) throw new ChildrenOpenError(id, open);
		}
		const fields: Record<string, unknown> = { [wf.statusField]: t.to };
		if (t.arg !== undefined) fields[t.arg] = arg;
		// The date is never inferred from the text: today, or the explicit one.
		if (t.date !== undefined) fields[t.date] = opts.date ?? todayUtc();
		for (const f of t.clear) fields[f] = null;
		return { fields };
	});
	if (!next) throw new TransitionPreconditionError(id, t.from, actual);
	return next;
}
