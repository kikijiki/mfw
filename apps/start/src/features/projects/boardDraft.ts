/**
 * The pure half of the project settings "Board" section: the editable
 * status list as rows, the operations on it (add, rename, reorder, remove,
 * role), and the patch `boardConfig.preview`/`boardConfig.save` take. No
 * React, so the rules are testable without a DOM.
 */

/** The daemon roles a board status can play, in daemon order. */
export const BOARD_ROLES = [
	"draft",
	"backlog",
	"ready",
	"in_progress",
	"blocked",
	"review",
	"done",
	"archived",
] as const;
export type BoardRole = (typeof BOARD_ROLES)[number];

export const ROLE_HINTS: Record<BoardRole, string> = {
	draft: "Being written, not yet planned.",
	backlog: "Planned but not queued for an agent.",
	ready: "Queued: the scheduler may dispatch it.",
	in_progress: "An agent (or person) is working on it.",
	blocked: "Waiting on something outside the task.",
	review: "Work done, waiting for review.",
	done: "Finished and accepted.",
	archived: "Shelved or retired for good.",
};

export interface BoardView {
	statuses: { value: string; role: BoardRole | null; tasks: number }[];
	taskTypes: string[] | null;
	hierarchy: { maxDepth: number | null } | null;
}

export interface StatusRow {
	/** Stable React key; survives renames and reorders. */
	key: string;
	value: string;
	role: BoardRole;
	/** The status value on disk this row started as; null for a new row. */
	original: string | null;
	/** Tasks currently on `original`. */
	tasks: number;
}

export interface BoardDraft {
	rows: StatusRow[];
	types: string[];
	/** Text of the depth input; "" = no limit. */
	maxDepth: string;
	/** Removed status -> status its tasks move to. */
	remap: Record<string, string>;
}

export interface BoardPatch {
	statuses?: { value: string; role: BoardRole }[];
	types?: string[];
	maxDepth?: number | null;
	remapTo?: Record<string, string>;
	renames?: Record<string, string>;
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

let nextKey = 0;
const newKey = () => `row-${nextKey++}`;

/** A status whose role the daemon could not place defaults to "backlog". */
export function draftFromView(view: BoardView): BoardDraft {
	return {
		rows: view.statuses.map((s) => ({
			key: newKey(),
			value: s.value,
			role: s.role ?? "backlog",
			original: s.value,
			tasks: s.tasks,
		})),
		types: [...(view.taskTypes ?? [])],
		maxDepth: view.hierarchy?.maxDepth ? String(view.hierarchy.maxDepth) : "",
		remap: {},
	};
}

export function addRow(
	draft: BoardDraft,
	value = "",
	role: BoardRole = "backlog",
): BoardDraft {
	return {
		...draft,
		rows: [
			...draft.rows,
			{ key: newKey(), value, role, original: null, tasks: 0 },
		],
	};
}

export function setRowValue(
	draft: BoardDraft,
	key: string,
	value: string,
): BoardDraft {
	return mapRow(draft, key, (r) => ({ ...r, value }));
}

export function setRowRole(
	draft: BoardDraft,
	key: string,
	role: BoardRole,
): BoardDraft {
	return mapRow(draft, key, (r) => ({ ...r, role }));
}

function mapRow(
	draft: BoardDraft,
	key: string,
	fn: (row: StatusRow) => StatusRow,
): BoardDraft {
	return { ...draft, rows: draft.rows.map((r) => (r.key === key ? fn(r) : r)) };
}

export function moveRow(
	draft: BoardDraft,
	key: string,
	by: -1 | 1,
): BoardDraft {
	const i = draft.rows.findIndex((r) => r.key === key);
	const j = i + by;
	if (i < 0 || j < 0 || j >= draft.rows.length) return draft;
	const rows = [...draft.rows];
	[rows[i], rows[j]] = [rows[j] as StatusRow, rows[i] as StatusRow];
	return { ...draft, rows };
}

export function removeRow(draft: BoardDraft, key: string): BoardDraft {
	return { ...draft, rows: draft.rows.filter((r) => r.key !== key) };
}

export interface BoardTemplateView {
	statuses: { value: string; role: BoardRole }[];
	types: string[] | null;
}

/**
 * Start from a template: the template's statuses and roles replace the list.
 * A template status that the board already has keeps its link to the
 * existing status (and its tasks); the rest are new. Statuses the template
 * lacks become removals, which the orphan safety then deals with.
 */
export function draftFromTemplate(
	draft: BoardDraft,
	view: BoardView,
	template: BoardTemplateView,
): BoardDraft {
	return {
		...draft,
		rows: template.statuses.map((s) => {
			const known = view.statuses.find((v) => v.value === s.value);
			return {
				key: newKey(),
				value: s.value,
				role: s.role,
				original: known ? known.value : null,
				tasks: known?.tasks ?? 0,
			};
		}),
		types: template.types && view.taskTypes ? [...template.types] : draft.types,
		remap: {},
	};
}

export function setTypes(draft: BoardDraft, types: string[]): BoardDraft {
	return { ...draft, types };
}

/** Original statuses with no row left, and how many tasks sit on each. */
export function removedStatuses(
	draft: BoardDraft,
	view: BoardView,
): { status: string; tasks: number; renamedTo: string | null }[] {
	return view.statuses
		.filter((s) => !draft.rows.some((r) => r.value === s.value))
		.map((s) => ({
			status: s.value,
			tasks: s.tasks,
			renamedTo: draft.rows.find((r) => r.original === s.value)?.value ?? null,
		}));
}

/** What is wrong with the draft, in words; empty when it can be previewed. */
export function draftProblems(draft: BoardDraft, view: BoardView): string[] {
	const problems: string[] = [];
	if (draft.rows.length === 0)
		problems.push("A board needs at least one status.");
	const seen = new Set<string>();
	for (const r of draft.rows) {
		const v = r.value.trim();
		if (!v) {
			problems.push("A status has no name.");
			continue;
		}
		if (!NAME_RE.test(v)) {
			problems.push(
				`'${v}': use letters, digits, '_' or '-', starting with a letter.`,
			);
		}
		if (seen.has(v)) problems.push(`'${v}' appears twice.`);
		seen.add(v);
	}
	// A rename onto a name the board already has (even one being removed)
	// would be a swap or a merge; it takes two steps.
	for (const r of draft.rows) {
		const v = r.value.trim();
		if (
			r.original &&
			r.original !== v &&
			view.statuses.some((s) => s.value === v)
		) {
			problems.push(
				`'${v}' is already a status on this board; rename in two steps.`,
			);
		}
	}
	if (draft.maxDepth.trim() !== "") {
		const n = Number(draft.maxDepth);
		if (!Number.isInteger(n) || n < 1) {
			problems.push("Maximum depth must be a whole number of 1 or more.");
		}
	}
	const typeSeen = new Set<string>();
	for (const t of draft.types) {
		if (!t.trim()) problems.push("A task type has no name.");
		else if (typeSeen.has(t)) problems.push(`Task type '${t}' appears twice.`);
		typeSeen.add(t);
	}
	return problems;
}

/** Advisories: legal, but the daemon will not be able to do something. */
export function roleAdvice(draft: BoardDraft): string[] {
	const advice: string[] = [];
	const has = (role: BoardRole) => draft.rows.some((r) => r.role === role);
	if (!has("ready")) {
		advice.push("No status has the Ready role: nothing can be dispatched.");
	}
	if (!has("in_progress")) {
		advice.push("No status has the In progress role: runs cannot start tasks.");
	}
	if (!has("done"))
		advice.push("No status has the Done role: tasks cannot finish.");
	return advice;
}

/** The patch for what differs from `view`; `{}` when nothing does. */
export function buildPatch(draft: BoardDraft, view: BoardView): BoardPatch {
	const patch: BoardPatch = {};
	const rows = draft.rows.map((r) => ({ value: r.value.trim(), role: r.role }));
	const same =
		rows.length === view.statuses.length &&
		rows.every((r, i) => {
			const s = view.statuses[i];
			return s && s.value === r.value && (s.role ?? "backlog") === r.role;
		});
	if (!same) {
		patch.statuses = rows;
		const renames: Record<string, string> = {};
		for (const r of draft.rows) {
			if (r.original && r.original !== r.value.trim()) {
				renames[r.original] = r.value.trim();
			}
		}
		if (Object.keys(renames).length > 0) patch.renames = renames;
		const remapTo: Record<string, string> = {};
		for (const gone of removedStatuses(draft, view)) {
			if (gone.renamedTo !== null) continue;
			const target = draft.remap[gone.status];
			if (target && rows.some((r) => r.value === target)) {
				remapTo[gone.status] = target;
			}
		}
		if (Object.keys(remapTo).length > 0) patch.remapTo = remapTo;
	}
	if (
		view.taskTypes &&
		JSON.stringify(draft.types) !== JSON.stringify(view.taskTypes)
	) {
		patch.types = draft.types;
	}
	if (view.hierarchy) {
		const next = draft.maxDepth.trim() === "" ? null : Number(draft.maxDepth);
		if (next !== view.hierarchy.maxDepth) patch.maxDepth = next;
	}
	return patch;
}

export const isEmptyPatch = (patch: BoardPatch): boolean =>
	Object.keys(patch).length === 0;

/** A short description of the removed statuses that still hold tasks and have no target yet. */
export function unresolvedRemovals(
	draft: BoardDraft,
	view: BoardView,
): string[] {
	return removedStatuses(draft, view)
		.filter(
			(g) =>
				g.tasks > 0 &&
				g.renamedTo === null &&
				!draft.rows.some((r) => r.value === draft.remap[g.status]),
		)
		.map((g) => g.status);
}
