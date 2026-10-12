import { describe, expect, test } from "bun:test";

import {
	type BoardColumn,
	boardColumns,
	bulkMoveTarget,
	CANONICAL_COLUMNS,
	columnCounts,
	columnOfRole,
	columnView,
	defaultCollapsed,
	dropVerdict,
	type SchemaStatus,
	tasksByColumn,
} from "./columns";

const status = (
	value: string,
	role: string | null,
	extra: Partial<SchemaStatus> = {},
): SchemaStatus => ({
	value,
	label: value.charAt(0).toUpperCase() + value.slice(1),
	role,
	writable: role !== null,
	terminal: role === "done" || role === "archived",
	order: 0,
	...extra,
});

/** `kanban` template: todo, doing, review, done. */
const KANBAN: SchemaStatus[] = [
	status("todo", "ready", { order: 0 }),
	status("doing", "in_progress", { order: 1 }),
	status("review", "review", { order: 2 }),
	status("done", "done", { order: 3 }),
];

describe("columns from board.schema", () => {
	test("a kanban board renders its 4 columns in declared order, not the canonical eight", () => {
		const columns = boardColumns(KANBAN);
		expect(columns.map((c) => c.value)).toEqual([
			"todo",
			"doing",
			"review",
			"done",
		]);
		expect(columns.map((c) => c.role)).toEqual([
			"ready",
			"in_progress",
			"review",
			"done",
		]);
	});

	test("declared order wins over array order", () => {
		const columns = boardColumns([
			status("done", "done", { order: 2 }),
			status("todo", "ready", { order: 0 }),
			status("doing", "in_progress", { order: 1 }),
		]);
		expect(columns.map((c) => c.value)).toEqual(["todo", "doing", "done"]);
	});

	test("terminal columns are collapsed by default; others are not", () => {
		const columns = boardColumns(KANBAN);
		expect(defaultCollapsed(columns)).toEqual(["done"]);
		const canonical = defaultCollapsed([...CANONICAL_COLUMNS]);
		expect(canonical.sort()).toEqual(["archived", "done"]);
	});

	test("before the schema arrives the canonical eight are drawn", () => {
		expect(boardColumns(undefined).map((c) => c.value)).toEqual([
			"draft",
			"backlog",
			"ready",
			"in_progress",
			"blocked",
			"review",
			"done",
			"archived",
		]);
		expect(boardColumns([])).toHaveLength(8);
	});

	test("a role the daemon does not know reads as no role", () => {
		const [c] = boardColumns([status("weird", "not-a-role")]);
		expect(c?.role).toBeNull();
	});
});

describe("tasks land in the column of their role", () => {
	const columns = boardColumns([
		status("planned", "ready", { order: 0 }),
		// An alias: also reads as ready, but the board writes `planned`.
		status("queued", "ready", { order: 1, writable: false }),
		status("doing", "in_progress", { order: 2 }),
	]);

	test("the writable column of the role gets the task; the alias stays empty", () => {
		const map = tasksByColumn(columns, [
			{ id: "A", status: "ready" },
			{ id: "B", status: "in_progress" },
			{ id: "C", status: "archived" },
		]);
		expect(map.get("planned")?.map((t) => t.id)).toEqual(["A"]);
		expect(map.get("queued")).toEqual([]);
		expect(map.get("doing")?.map((t) => t.id)).toEqual(["B"]);
	});

	test("columnOfRole falls back to any column of the role", () => {
		const only = boardColumns([status("queued", "ready", { writable: false })]);
		expect(columnOfRole(only, "ready")?.value).toBe("queued");
		expect(columnOfRole(only, "done")).toBeUndefined();
	});
});

describe("drop rules", () => {
	const col = (over: Partial<BoardColumn>): BoardColumn => ({
		value: "x",
		label: "X",
		role: "review",
		writable: true,
		terminal: false,
		collapsedByDefault: false,
		...over,
	});

	test("an ordinary writable column accepts a drop", () => {
		expect(dropVerdict(col({}), { status: "ready" })).toEqual({ ok: true });
	});

	test("a column that is not writable is refused with a reason", () => {
		const v = dropVerdict(col({ writable: false, label: "Queued" }), {
			status: "backlog",
		});
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.reason).toContain("Queued");
	});

	test("a column the board cannot place on a role is refused with a reason", () => {
		const v = dropVerdict(col({ role: null, writable: false }), {
			status: "ready",
		});
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.reason).toContain("statusMap");
	});

	test("in progress is entered by runs, draft by capture", () => {
		const inProgress = dropVerdict(
			col({ role: "in_progress", label: "Doing" }),
			{ status: "ready" },
		);
		expect(inProgress).toEqual({
			ok: false,
			reason: "Tasks enter Doing when a run starts.",
		});
		const draft = dropVerdict(col({ role: "draft" }), { status: "backlog" });
		expect(draft.ok).toBe(false);
	});

	test("a draft can only be archived", () => {
		expect(dropVerdict(col({ role: "ready" }), { status: "draft" }).ok).toBe(
			false,
		);
		expect(dropVerdict(col({ role: "archived" }), { status: "draft" }).ok).toBe(
			true,
		);
	});

	test("bulk-move neighbours follow the same rules, with the reason as title", () => {
		const columns = boardColumns([
			status("draft", "draft", { order: 0 }),
			status("backlog", "backlog", { order: 1 }),
			status("doing", "in_progress", { order: 2 }),
		]);
		const [draft, backlog, doing] = columns as [
			BoardColumn,
			BoardColumn,
			BoardColumn,
		];
		expect(bulkMoveTarget(backlog, draft, "previous").ok).toBe(false);
		const intoDoing = bulkMoveTarget(backlog, doing, "next");
		expect(intoDoing.ok).toBe(false);
		if (!intoDoing.ok) expect(intoDoing.title).toContain("run starts");
		const fromDraft = bulkMoveTarget(draft, backlog, "next");
		expect(fromDraft.ok).toBe(false);
		if (!fromDraft.ok) expect(fromDraft.title).toContain("Expansion");
		expect(bulkMoveTarget(draft, undefined, "previous")).toEqual({
			ok: false,
			title: "First column",
		});
	});
});

describe("column header counts", () => {
	test("live runs and tasks needing a person come from the caches' answers", () => {
		const counts = columnCounts([{ id: "A" }, { id: "B" }, { id: "C" }], {
			liveRuns: (id) => (id === "A" ? 2 : id === "B" ? 1 : 0),
			needsHuman: (id) => id === "B",
		});
		expect(counts).toEqual({ total: 3, live: 3, needs: 1 });
	});
});

describe("columnView (the column menu)", () => {
	const t = (id: string, changed: number) => ({
		id,
		statusChangedAt: new Date(changed),
	});
	const tasks = [t("A", 1), t("B", 5), t("C", 3), t("D", 9)];
	const live: Record<string, number> = { A: 0, B: 1, C: 2, D: 0 };
	const needs = new Set(["D"]);
	const signals = {
		liveRuns: (x: { id: string }) => live[x.id] ?? 0,
		needsHuman: (x: { id: string }) => needs.has(x.id),
	};
	const ids = (list: { id: string }[]) => list.map((x) => x.id);

	test("with both switches off the order is untouched", () => {
		const off = { onlyAgents: false, byActivity: false };
		expect(ids(columnView(tasks, off, signals))).toEqual(["A", "B", "C", "D"]);
	});

	test("only with agents keeps tasks with a live run or a question", () => {
		const on = { onlyAgents: true, byActivity: false };
		expect(ids(columnView(tasks, on, signals))).toEqual(["B", "C", "D"]);
	});

	test("sort by activity: needs-you, then most live runs, then most recent", () => {
		const on = { onlyAgents: false, byActivity: true };
		expect(ids(columnView(tasks, on, signals))).toEqual(["D", "C", "B", "A"]);
	});

	test("both switches compose and never mutate the input", () => {
		const copy = [...tasks];
		const both = { onlyAgents: true, byActivity: true };
		expect(ids(columnView(tasks, both, signals))).toEqual(["D", "C", "B"]);
		expect(tasks).toEqual(copy);
	});
});
