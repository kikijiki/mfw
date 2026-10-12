import type { TaskStatus } from "../../components/StatusPill";

/**
 * The board's columns, from `board.schema`: one column per status the
 * project's own `board.yaml` declares, in its declared order, with the daemon
 * role each one reads as. Pure, so the page, the drop rules and the tests all
 * read the same table.
 *
 * Tasks (`tasks.list`) carry the daemon ROLE, not the board's raw value, so a
 * task sits in the column whose role it has and that the daemon writes for
 * that role (`writable`). Other columns that read as the same role (aliases),
 * or that read as no role at all, stay visible but refuse drops with a reason.
 */

/** The shape of `board.schema`'s `statuses[]`, as far as columns care. */
export interface SchemaStatus {
	value: string;
	label: string;
	role: string | null;
	writable: boolean;
	terminal: boolean;
	order: number;
}

export interface BoardColumn {
	/** The board's own value (`doing`); the key of the column. */
	value: string;
	label: string;
	role: TaskStatus | null;
	writable: boolean;
	terminal: boolean;
	/** Collapsed until the person opens it, unless they chose otherwise. */
	collapsedByDefault: boolean;
}

const CANONICAL: readonly { role: TaskStatus; label: string }[] = [
	{ role: "draft", label: "Draft" },
	{ role: "backlog", label: "Backlog" },
	{ role: "ready", label: "Ready" },
	{ role: "in_progress", label: "In progress" },
	{ role: "blocked", label: "Blocked" },
	{ role: "review", label: "Review" },
	{ role: "done", label: "Done" },
	{ role: "archived", label: "Archived" },
];

const ROLES = new Set<string>(CANONICAL.map((c) => c.role));
const isRole = (v: string | null): v is TaskStatus =>
	v !== null && ROLES.has(v);

/** What to draw until `board.schema` arrives (or when it fails): the canonical eight. */
export const CANONICAL_COLUMNS: readonly BoardColumn[] = CANONICAL.map((c) => ({
	value: c.role,
	label: c.label,
	role: c.role,
	writable: true,
	terminal: c.role === "done" || c.role === "archived",
	collapsedByDefault: c.role === "done" || c.role === "archived",
}));

export function boardColumns(
	statuses: readonly SchemaStatus[] | undefined,
): BoardColumn[] {
	if (!statuses || statuses.length === 0) return [...CANONICAL_COLUMNS];
	return [...statuses]
		.sort((a, b) => a.order - b.order)
		.map((s) => ({
			value: s.value,
			label: s.label,
			role: isRole(s.role) ? s.role : null,
			writable: s.writable,
			terminal: s.terminal,
			collapsedByDefault: s.terminal,
		}));
}

/** Column values collapsed when nothing is stored for the project yet. */
export function defaultCollapsed(columns: readonly BoardColumn[]): string[] {
	return columns.filter((c) => c.collapsedByDefault).map((c) => c.value);
}

/** The column a task sits in: the writable column of its role, else any column of the role. */
export function columnOfRole(
	columns: readonly BoardColumn[],
	role: string,
): BoardColumn | undefined {
	return (
		columns.find((c) => c.role === role && c.writable) ??
		columns.find((c) => c.role === role)
	);
}

/** Tasks per column value. A task whose role no column carries is left out (and counted by the caller if it cares). */
export function tasksByColumn<T extends { status: string }>(
	columns: readonly BoardColumn[],
	tasks: readonly T[],
): Map<string, T[]> {
	const out = new Map<string, T[]>(columns.map((c) => [c.value, []]));
	for (const task of tasks) {
		const col = columnOfRole(columns, task.status);
		if (col) out.get(col.value)?.push(task);
	}
	return out;
}

export type DropVerdict = { ok: true } | { ok: false; reason: string };

/**
 * May `task` be dropped on `column`? Decided client-side so a refusal names
 * its reason instead of failing on the server (or silently not happening).
 */
export function dropVerdict(
	column: BoardColumn,
	task: { status: string },
): DropVerdict {
	if (column.role === null) {
		return {
			ok: false,
			reason: `mfw cannot place "${column.label}" on a stage of work, so nothing can be moved there. Map it in board.yaml (x-mfw-daemon.statusMap).`,
		};
	}
	if (!column.writable) {
		return {
			ok: false,
			reason: `"${column.label}" is read as ${column.role.replace("_", " ")} but this board writes that stage as another status. Drop the task on that column instead.`,
		};
	}
	if (column.role === "in_progress") {
		return {
			ok: false,
			reason: `Tasks enter ${column.label} when a run starts.`,
		};
	}
	if (column.role === "draft") {
		return {
			ok: false,
			reason: "Drafts can only be created through capture.",
		};
	}
	if (task.status === "draft" && column.role !== "archived") {
		return {
			ok: false,
			reason: `A draft can only be archived until its expansion finishes; it moves on by itself.`,
		};
	}
	return { ok: true };
}

/** A column a bulk move can start from or land on (neighbour controls). */
export function bulkMoveTarget(
	from: BoardColumn,
	to: BoardColumn | undefined,
	direction: "previous" | "next",
): { ok: true } | { ok: false; title: string } {
	if (!to) {
		return {
			ok: false,
			title: direction === "previous" ? "First column" : "Last column",
		};
	}
	if (direction === "next" && from.role === "draft") {
		return {
			ok: false,
			title: "Expansion moves Drafts to their selected destination",
		};
	}
	const verdict = dropVerdict(to, { status: from.role ?? "" });
	if (!verdict.ok) return { ok: false, title: verdict.reason };
	return { ok: true };
}

/** Column header counts from the caches: live runs and what needs a person. */
export interface ColumnCounts {
	total: number;
	live: number;
	needs: number;
}

export function columnCounts(
	tasks: readonly { id: string }[],
	signals: {
		/** Live runs of a task (the strip's chips). */
		liveRuns: (taskId: string) => number;
		/** A person is the next move on this task. */
		needsHuman: (taskId: string) => boolean;
	},
): ColumnCounts {
	let live = 0;
	let needs = 0;
	for (const t of tasks) {
		live += signals.liveRuns(t.id);
		if (signals.needsHuman(t.id)) needs += 1;
	}
	return { total: tasks.length, live, needs };
}

/** The column menu's two switches (design §6.1). */
export interface ColumnViewOptions {
	/** Only tasks with a live run or a question waiting. */
	onlyAgents: boolean;
	/** Needs-you first, then most live runs, then most recently changed. */
	byActivity: boolean;
}

/**
 * The tasks a column shows after its menu. Pure and stable: with both
 * switches off the input is returned in order, untouched.
 */
export function columnView<T extends { statusChangedAt?: unknown }>(
	tasks: readonly T[],
	options: ColumnViewOptions,
	signals: {
		liveRuns: (task: T) => number;
		needsHuman: (task: T) => boolean;
	},
): T[] {
	let out = [...tasks];
	if (options.onlyAgents) {
		out = out.filter((t) => signals.liveRuns(t) > 0 || signals.needsHuman(t));
	}
	if (options.byActivity) {
		const changed = (t: T) => {
			const v = t.statusChangedAt;
			if (v instanceof Date) return v.getTime();
			return typeof v === "number" ? v : 0;
		};
		out = out
			.map((t, i) => ({ t, i }))
			.sort(
				(a, b) =>
					Number(signals.needsHuman(b.t)) - Number(signals.needsHuman(a.t)) ||
					signals.liveRuns(b.t) - signals.liveRuns(a.t) ||
					changed(b.t) - changed(a.t) ||
					a.i - b.i,
			)
			.map((x) => x.t);
	}
	return out;
}

/**
 * Is a column drawn as a rail? One with no tasks always is, unless the person
 * opened it on purpose (`expandedEmpty`); otherwise the per-project collapsed
 * set decides (terminal columns start in it).
 */
export function isColumnCollapsed(
	value: string,
	taskCount: number,
	collapsed: ReadonlySet<string>,
	expandedEmpty: ReadonlySet<string>,
): boolean {
	if (collapsed.has(value)) return true;
	return taskCount === 0 && !expandedEmpty.has(value);
}

/** The two sets after a click on a column's rail or collapse button. */
export function toggleColumnState(
	value: string,
	taskCount: number,
	collapsed: ReadonlySet<string>,
	expandedEmpty: ReadonlySet<string>,
): { collapsed: Set<string>; expandedEmpty: Set<string> } {
	const nextCollapsed = new Set(collapsed);
	const nextExpanded = new Set(expandedEmpty);
	if (isColumnCollapsed(value, taskCount, collapsed, expandedEmpty)) {
		nextCollapsed.delete(value);
		if (taskCount === 0) nextExpanded.add(value);
	} else if (taskCount === 0) {
		nextExpanded.delete(value);
	} else {
		nextCollapsed.add(value);
	}
	return { collapsed: nextCollapsed, expandedEmpty: nextExpanded };
}
