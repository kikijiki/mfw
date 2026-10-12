import { describe, expect, test } from "bun:test";
import {
	addRow,
	type BoardView,
	buildPatch,
	draftFromTemplate,
	draftFromView,
	draftProblems,
	isEmptyPatch,
	moveRow,
	removedStatuses,
	removeRow,
	roleAdvice,
	setRowRole,
	setRowValue,
	setTypes,
	unresolvedRemovals,
} from "./boardDraft";

const view: BoardView = {
	statuses: [
		{ value: "planned", role: "ready", tasks: 2 },
		{ value: "doing", role: "in_progress", tasks: 1 },
		{ value: "done", role: "done", tasks: 0 },
		{ value: "deferred", role: "blocked", tasks: 3 },
	],
	taskTypes: ["implementation", "spike"],
	hierarchy: { maxDepth: 3 },
};

const keyOf = (d: ReturnType<typeof draftFromView>, value: string) =>
	d.rows.find((r) => r.value === value)?.key as string;

describe("board settings draft", () => {
	test("an untouched draft produces no patch", () => {
		expect(isEmptyPatch(buildPatch(draftFromView(view), view))).toBe(true);
	});

	test("reorder, role change and add make a statuses patch in the new order", () => {
		let d = draftFromView(view);
		d = moveRow(d, keyOf(d, "done"), -1);
		d = setRowRole(d, keyOf(d, "deferred"), "backlog");
		d = addRow(d, "qa", "review");
		const patch = buildPatch(d, view);
		expect(patch.statuses).toEqual([
			{ value: "planned", role: "ready" },
			{ value: "done", role: "done" },
			{ value: "doing", role: "in_progress" },
			{ value: "deferred", role: "backlog" },
			{ value: "qa", role: "review" },
		]);
		expect(patch.renames).toBeUndefined();
		// Moving the first row up is a no-op.
		const same = moveRow(
			draftFromView(view),
			keyOf(draftFromView(view), "x"),
			-1,
		);
		expect(same.rows.length).toBe(4);
	});

	test("renaming a status is a rename, not a removal", () => {
		let d = draftFromView(view);
		d = setRowValue(d, keyOf(d, "doing"), "active");
		const patch = buildPatch(d, view);
		expect(patch.renames).toEqual({ doing: "active" });
		expect(removedStatuses(d, view).map((g) => g.renamedTo)).toContain(
			"active",
		);
		// A rename needs no remap choice.
		expect(unresolvedRemovals(d, view)).toEqual([]);
	});

	test("removing a used status needs a target before it can be previewed", () => {
		let d = draftFromView(view);
		d = removeRow(d, keyOf(d, "deferred"));
		expect(unresolvedRemovals(d, view)).toEqual(["deferred"]);
		d = { ...d, remap: { deferred: "planned" } };
		expect(unresolvedRemovals(d, view)).toEqual([]);
		expect(buildPatch(d, view).remapTo).toEqual({ deferred: "planned" });
		// An unused removal needs nothing.
		let e = draftFromView(view);
		e = removeRow(e, keyOf(e, "done"));
		expect(unresolvedRemovals(e, view)).toEqual([]);
		expect(buildPatch(e, view).remapTo).toBeUndefined();
	});

	test("problems: empty, duplicate, bad characters, swaps, depth", () => {
		let d = draftFromView(view);
		d = addRow(d, "");
		d = addRow(d, "planned");
		d = addRow(d, "no spaces");
		d = setRowValue(d, keyOf(d, "doing"), "done");
		d = { ...d, maxDepth: "0" };
		const problems = draftProblems(d, view);
		expect(problems).toContain("A status has no name.");
		expect(problems).toContain("'planned' appears twice.");
		expect(problems.some((p) => p.includes("'no spaces'"))).toBe(true);
		expect(problems.some((p) => p.includes("rename in two steps"))).toBe(true);
		expect(problems.some((p) => p.includes("Maximum depth"))).toBe(true);
		expect(draftProblems(draftFromView(view), view)).toEqual([]);
	});

	test("task types and depth patch only when they differ", () => {
		let d = draftFromView(view);
		d = setTypes(d, ["implementation", "spike", "epic"]);
		d = { ...d, maxDepth: "" };
		const patch = buildPatch(d, view);
		expect(patch.types).toEqual(["implementation", "spike", "epic"]);
		expect(patch.maxDepth).toBeNull();
		expect(patch.statuses).toBeUndefined();
	});

	test("role advice names what the daemon cannot do", () => {
		let d = draftFromView(view);
		d = removeRow(d, keyOf(d, "planned"));
		expect(roleAdvice(d)).toEqual([
			"No status has the Ready role: nothing can be dispatched.",
		]);
	});

	test("a template keeps links to statuses the board already has", () => {
		const d = draftFromTemplate(draftFromView(view), view, {
			statuses: [
				{ value: "todo", role: "ready" },
				{ value: "doing", role: "in_progress" },
				{ value: "done", role: "done" },
			],
			types: ["implementation", "epic"],
		});
		expect(d.rows.map((r) => [r.value, r.original, r.tasks])).toEqual([
			["todo", null, 0],
			["doing", "doing", 1],
			["done", "done", 0],
		]);
		expect(d.types).toEqual(["implementation", "epic"]);
		// planned (2 tasks) and deferred (3 tasks) are now removals to resolve.
		expect(unresolvedRemovals(d, view)).toEqual(["planned", "deferred"]);
	});
});
