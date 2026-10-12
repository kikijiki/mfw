import { describe, expect, test } from "bun:test";

import {
	buildFlow,
	type FlowNodeIn,
	followTarget,
	formatFlowFilter,
	lineageOf,
	parseFlowFilter,
	rowIndexFor,
	stepTree,
	treeKeyFor,
} from "./flowModel";

const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);

function task(
	id: string,
	over: Partial<FlowNodeIn> & { parent?: string | null } = {},
): FlowNodeIn {
	return {
		ref: `task:${id}`,
		parent: null,
		kind: "task",
		title: id,
		status: { value: "in_progress", role: "in_progress" },
		needsMe: null,
		lastAt: new Date(T0),
		...over,
	} as FlowNodeIn;
}

function run(
	id: string,
	parent: string | null,
	over: {
		state?: string;
		activity?: string | null;
		relation?: string;
		at?: number;
		harness?: string;
		model?: string;
		host?: string | null;
		needsMe?: FlowNodeIn["needsMe"];
		kind?: "run" | "judge";
	} = {},
): FlowNodeIn {
	const at = over.at ?? 0;
	return {
		ref: `run:${id}`,
		parent,
		kind: over.kind ?? "run",
		title: id,
		needsMe: over.needsMe ?? null,
		lastAt: new Date(T0 + at),
		run: {
			role: "worker",
			relation: over.relation ?? "fresh",
			state: over.state ?? "completed",
			activity: over.activity ?? null,
			harness: over.harness ?? "claude-cli",
			model: over.model ?? "sonnet",
			effort: null,
			host: over.host ?? null,
			label: id,
			startedAt: new Date(T0 + at),
			finishedAt: null,
			costUsd: null,
			liveCostUsd: null,
		},
	} as FlowNodeIn;
}

const keys = (nodes: FlowNodeIn[], opts?: Parameters<typeof buildFlow>[1]) =>
	buildFlow(nodes, opts).rows.map((r) => r.key);

describe("flatten", () => {
	const epic = task("E", { kind: "epic" });
	const nodes = [
		epic,
		task("A", { parent: "task:E" }),
		task("B", { parent: "task:E" }),
		run("a1", "task:A", { at: 1 }),
	];

	test("depth, parent keys and set positions", () => {
		const view = buildFlow(nodes, { overrides: { "task:E": true } });
		const [e, a, b] = view.rows;
		expect(e?.depth).toBe(0);
		expect(a?.depth).toBe(1);
		expect(a?.parentKey).toBe("task:E");
		expect([a?.posInSet, a?.setSize]).toEqual([1, 2]);
		expect([b?.posInSet, b?.setSize]).toEqual([2, 2]);
		expect(view.indexByKey.get("task:B")).toBe(2);
	});

	test("a closed row hides its subtree; an explicit override opens it", () => {
		expect(keys(nodes)).toEqual(["task:E"]);
		expect(keys(nodes, { overrides: new Map([["task:E", true]]) })).toEqual([
			"task:E",
			"task:A",
			"task:B",
		]);
	});

	test("epics report done of total over leaf tasks", () => {
		const view = buildFlow([
			epic,
			task("A", { parent: "task:E", status: { value: "done", role: "done" } }),
			task("B", { parent: "task:E" }),
			task("C", { parent: "task:E" }),
		]);
		expect(view.rows[0]?.progress).toEqual({ done: 1, total: 3 });
	});

	test("orphans and cycles do not hang or drop rows", () => {
		const view = buildFlow([
			task("X", { parent: "task:missing" }),
			task("P", { parent: "task:Q" }),
			task("Q", { parent: "task:P" }),
		]);
		expect(view.rows.map((r) => r.key)).toEqual(["task:X"]);
	});
});

describe("default expansion follows what matters", () => {
	const nodes = [
		task("E", { kind: "epic" }),
		task("A", { parent: "task:E" }),
		task("B", { parent: "task:E" }),
		run("done1", "task:A", { at: 1 }),
		run("live1", "task:B", { state: "running", activity: "working", at: 2 }),
	];

	test("ancestors of a live node are open, ended subtrees are closed", () => {
		expect(keys(nodes)).toEqual(["task:E", "task:A", "task:B", "run:live1"]);
	});

	test("a needs-me node opens its ancestors too", () => {
		const asking = nodes.map((n) =>
			n.ref === "task:A" ? { ...n, needsMe: "inbox" as const } : n,
		);
		// task:A itself needs me: its parent opens, its (ended) runs stay closed
		expect(keys(asking)).toContain("task:A");
		expect(keys(asking)).not.toContain("run:done1");
	});

	test("a closed lineage reads as an aggregate: count and outcome glyphs", () => {
		const chain = [
			task("A"),
			run("r1", "task:A", { state: "failed", at: 1 }),
			run("r2", "run:r1", { state: "failed", relation: "repair", at: 2 }),
			run("r3", "run:r2", { state: "completed", relation: "repair", at: 3 }),
		];
		const view = buildFlow(chain);
		expect(view.rows).toHaveLength(1);
		expect(view.rows[0]?.chain).toEqual({
			count: 3,
			glyphs: ["cross", "cross", "check"],
			labels: ["failed", "failed", "merged"],
		});
		// expanded, it shows each run and no aggregate
		const open = buildFlow(chain, {
			overrides: { "task:A": true, "run:r1": true, "run:r2": true },
		});
		expect(open.rows.map((r) => r.key)).toEqual([
			"task:A",
			"run:r1",
			"run:r2",
			"run:r3",
		]);
		expect(open.rows.every((r) => r.chain === undefined)).toBe(true);
	});
});

describe("done siblings fold", () => {
	const done = { value: "done", role: "done" };
	const nodes = [
		task("E", { kind: "epic" }),
		task("D1", { parent: "task:E", status: done }),
		task("D2", { parent: "task:E", status: done }),
		task("D3", { parent: "task:E", status: done }),
		task("W", { parent: "task:E" }),
		task("DL", { parent: "task:E", status: done }),
		run("liveInDone", "task:DL", { state: "running", activity: "working" }),
	];
	const open = { "task:E": true };

	test("three done tasks become one row; a done task with live work stays", () => {
		const view = buildFlow(nodes, { overrides: open });
		expect(view.rows.map((r) => r.key)).toEqual([
			"task:E",
			"task:W",
			"task:DL",
			"run:liveInDone",
			"fold:task:E",
		]);
		const fold = view.rows.find((r) => r.kind === "fold");
		expect(fold?.fold?.count).toBe(3);
		expect(fold?.expandable).toBe(true);
		expect(fold?.expanded).toBe(false);
	});

	test("opening the fold row lists them again", () => {
		const view = buildFlow(nodes, {
			overrides: { ...open, "fold:task:E": true },
		});
		expect(view.rows.map((r) => r.key)).toContain("task:D1");
		expect(view.rows.map((r) => r.key)).toContain("fold:task:E");
	});

	test("one done sibling is not worth a fold row", () => {
		const view = buildFlow(
			[
				task("E", { kind: "epic" }),
				task("D", { parent: "task:E", status: done }),
			],
			{ overrides: open },
		);
		expect(view.rows.map((r) => r.key)).toEqual(["task:E", "task:D"]);
	});

	test("a filter turns folding off so matches are not hidden", () => {
		const view = buildFlow(nodes, { filter: { q: "D1" } });
		expect(view.rows.map((r) => r.key)).toEqual(["task:E", "task:D1"]);
	});
});

describe("filter keeps ancestors of matches", () => {
	const nodes = [
		task("E", { kind: "epic" }),
		task("A", { parent: "task:E" }),
		task("B", { parent: "task:E" }),
		run("a1", "task:A", {
			state: "running",
			activity: "needs_answer",
			needsMe: "question",
			host: "ssh:box",
			harness: "codex-cli",
		}),
		run("b1", "task:B", { state: "completed", host: "local" }),
	];

	test("matches show, their ancestors stay dimmed and open", () => {
		const view = buildFlow(nodes, { filter: { needsMe: true } });
		expect(view.rows.map((r) => [r.key, r.dim])).toEqual([
			["task:E", true],
			["task:A", true],
			["run:a1", false],
		]);
		expect(view.matchCount).toBe(1);
	});

	test("predicates compose", () => {
		expect(
			keys(nodes, { filter: { harness: "codex", host: "ssh:box" } }),
		).toContain("run:a1");
		expect(
			keys(nodes, { filter: { harness: "codex", host: "local" } }),
		).toEqual([]);
		expect(keys(nodes, { filter: { live: true } })).toEqual([
			"task:E",
			"task:A",
			"run:a1",
		]);
		expect(keys(nodes, { filter: { q: "b1" } })).toEqual([
			"task:E",
			"task:B",
			"run:b1",
		]);
	});

	test("since keeps what was touched inside the window", () => {
		const old = [
			task("O", { lastAt: new Date(T0 - 5 * 3600_000) }),
			task("N", { lastAt: new Date(T0 - 10 * 60_000) }),
		];
		expect(keys(old, { filter: { since: "1h" }, now: T0 })).toEqual(["task:N"]);
	});

	test("the URL form round-trips and is canonical", () => {
		const f = parseFlowFilter(
			"host:local needs:me live status:doing refactor config",
		);
		expect(f).toEqual({
			needsMe: true,
			live: true,
			status: "doing",
			host: "local",
			q: "refactor config",
		});
		const text = formatFlowFilter(f);
		expect(text).toBe("needs:me live status:doing host:local refactor config");
		expect(parseFlowFilter(text)).toEqual(f);
		expect(formatFlowFilter({})).toBeUndefined();
		expect(parseFlowFilter(undefined)).toEqual({});
		// an unknown key:value is text, not silently dropped
		expect(parseFlowFilter("foo:bar").q).toBe("foo:bar");
	});
});

describe("follow target", () => {
	test("the newest live run, else the freshest needs-me node, else nothing", () => {
		const nodes = [
			task("A"),
			run("old", "task:A", { state: "running", activity: "working", at: 1 }),
			run("new", "task:A", { state: "running", activity: "working", at: 9 }),
			run("end", "task:A", { state: "completed", at: 20 }),
		];
		expect(followTarget(nodes)).toBe("run:new");
		expect(
			followTarget([
				task("A", { needsMe: "inbox", lastAt: new Date(T0 + 5) }),
				task("B", { needsMe: "inbox", lastAt: new Date(T0 + 9) }),
			]),
		).toBe("task:B");
		expect(followTarget([task("A")])).toBeNull();
	});

	test("its row is its own, or the nearest visible ancestor when hidden", () => {
		const nodes = [
			task("A"),
			run("r1", "task:A", { at: 1 }),
			run("r2", "run:r1", { relation: "repair", at: 2 }),
		];
		const view = buildFlow(nodes);
		expect(rowIndexFor(view, nodes, "task:A")).toBe(0);
		// r2 is hidden under the closed task: the task row stands in for it
		expect(rowIndexFor(view, nodes, "run:r2")).toBe(0);
		expect(rowIndexFor(view, nodes, "run:nope")).toBe(-1);
	});
});

describe("treegrid keys", () => {
	const nodes = [
		task("E", { kind: "epic" }),
		task("A", { parent: "task:E" }),
		run("a1", "task:A", { at: 1 }),
		task("B", { parent: "task:E" }),
	];
	const rows = (o: Record<string, boolean>) =>
		buildFlow(nodes, { overrides: o }).rows;

	test("physical keys map to verbs", () => {
		expect(treeKeyFor("j")).toBe("next");
		expect(treeKeyFor("k")).toBe("prev");
		expect(treeKeyFor("h")).toBe("close");
		expect(treeKeyFor("l")).toBe("open");
		expect(treeKeyFor("Enter")).toBe("select");
		expect(treeKeyFor(".")).toBe("actions");
		expect(treeKeyFor("ArrowDown")).toBe("next");
		expect(treeKeyFor("x")).toBeNull();
	});

	test("j and k clamp at the ends", () => {
		const r = rows({ "task:E": true });
		expect(stepTree(r, 0, "prev").focus).toBe(0);
		expect(stepTree(r, 0, "next").focus).toBe(1);
		expect(stepTree(r, r.length - 1, "next").focus).toBe(r.length - 1);
	});

	test("l opens a closed row, then steps into it; h closes, then steps out", () => {
		const closed = rows({});
		expect(stepTree(closed, 0, "open")).toEqual({
			focus: 0,
			toggle: { key: "task:E", open: true },
		});
		const open = rows({ "task:E": true });
		expect(stepTree(open, 0, "open")).toEqual({ focus: 1 });
		expect(stepTree(open, 0, "close")).toEqual({
			focus: 0,
			toggle: { key: "task:E", open: false },
		});
		// a leaf (or a closed row) goes to its parent
		expect(stepTree(open, 2, "close").focus).toBe(0);
		// a leaf has nothing to open
		expect(stepTree(open, 2, "open")).toEqual({ focus: 2 });
	});

	test("Enter selects the node; . asks for its actions", () => {
		const r = rows({ "task:E": true });
		expect(stepTree(r, 1, "select").select).toBe("task:A");
		expect(stepTree(r, 1, "actions").actions).toBe("task:A");
	});
});

describe("lineage", () => {
	const nodes = [
		task("E", { kind: "epic" }),
		task("A", { parent: "task:E" }),
		run("r1", "task:A", { state: "failed", at: 1 }),
		run("r2", "run:r1", { relation: "repair", state: "failed", at: 2 }),
		run("r3", "run:r2", { relation: "resume", state: "running", at: 3 }),
		run("j1", "run:r1", { relation: "judge", kind: "judge", at: 2 }),
		run("solo", "task:A", { at: 9 }),
	];

	test("breadcrumb is the tree parents, root first", () => {
		const l = lineageOf(nodes, "run:r3");
		expect(l?.crumbs.map((n) => n.ref)).toEqual([
			"task:E",
			"task:A",
			"run:r1",
			"run:r2",
			"run:r3",
		]);
	});

	test("siblings are the worktree chain, from any member, oldest first; judges are not in it", () => {
		for (const ref of ["run:r1", "run:r2", "run:r3"]) {
			expect(lineageOf(nodes, ref)?.family.map((n) => n.ref)).toEqual([
				"run:r1",
				"run:r2",
				"run:r3",
			]);
		}
		expect(lineageOf(nodes, "run:j1")?.family).toEqual([]);
		expect(lineageOf(nodes, "run:solo")?.family).toEqual([]);
	});

	test("a chain link names the run it continues", () => {
		expect(lineageOf(nodes, "run:r3")?.continues?.ref).toBe("run:r2");
		expect(lineageOf(nodes, "run:r1")?.continues).toBeNull();
		expect(lineageOf(nodes, "run:gone")).toBeNull();
	});
});

describe("bench", () => {
	test("5,010 nodes flatten in under 20 ms", () => {
		const nodes: FlowNodeIn[] = [];
		// 10 epics x (1 + 50 tasks x (1 + 9 runs)) = 5,010 nodes
		for (let e = 0; e < 10; e++) {
			nodes.push(task(`E${e}`, { kind: "epic" }));
			for (let t = 0; t < 50; t++) {
				const id = `T${e}-${t}`;
				nodes.push(
					task(id, {
						parent: `task:E${e}`,
						status:
							t % 3 === 0
								? { value: "done", role: "done" }
								: { value: "in_progress", role: "in_progress" },
					}),
				);
				let parent = `task:${id}`;
				for (let r = 0; r < 9; r++) {
					const rid = `${id}r${r}`;
					nodes.push(
						run(rid, parent, {
							relation: r === 0 ? "fresh" : "repair",
							state: r === 8 && t % 7 === 0 ? "running" : "completed",
							activity: r === 8 && t % 7 === 0 ? "working" : null,
							at: r,
						}),
					);
					parent = `run:${rid}`;
				}
			}
		}
		expect(nodes.length).toBe(5010);
		// warm the JIT, then measure the best of a few: a loaded CI box is noisy
		buildFlow(nodes);
		const open = Object.fromEntries(nodes.map((n) => [n.ref, true]));
		let best = Number.POSITIVE_INFINITY;
		for (let i = 0; i < 5; i++) {
			const t = performance.now();
			const view = buildFlow(nodes, { overrides: open });
			best = Math.min(best, performance.now() - t);
			expect(view.rows.length).toBeGreaterThan(3000);
		}
		expect(best).toBeLessThan(20);
	});
});
