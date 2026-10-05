import { describe, expect, test } from "bun:test";
import {
	type BoardDocument,
	dependencyGraph,
	impactOf,
	parseBoardConfig,
	parseOwnershipExemptions,
	planParallel,
	renderDot,
	renderMermaid,
} from "../src/index.ts";

const CONFIG = parseBoardConfig({
	mfw: 1,
	hierarchy: { parent: "parent", children: "children" },
	types: {
		task: {
			layout: "flat",
			dir: "tasks",
			id: { strategy: "own-sequence", key: "TK" },
			ownership: { field: "owns" },
			statusClasses: {
				terminal: ["done"],
				live: ["todo", "doing"],
				parked: ["parked"],
				queued: ["todo"],
			},
			fields: {
				title: { optional: true },
				status: {
					values: ["todo", "doing", "done", "parked"],
					default: "todo",
				},
				depends_on: { ref: "task", list: true, optional: true },
				owns: { type: "string", list: true, optional: true },
				parent: { ref: "task", optional: true },
				children: { ref: "task", list: true, optional: true },
			},
		},
	},
});

function doc(n: number, fields: Record<string, unknown> = {}): BoardDocument {
	const id = `TK-${n}`;
	return {
		type: "task",
		id,
		rev: 1,
		fields: { title: `t${n}`, status: "todo", ...fields },
		body: "",
		path: `/tasks/${id}.md`,
		hash: "x",
	};
}

// 1 done; 2 (dep 1) ready; 3 (dep 2); 4 (dep 2); 5 (dep 3,4); 6 doing; 7 ready alone
const DOCS = [
	doc(1, { status: "done" }),
	doc(2, { depends_on: ["TK-1"] }),
	doc(3, { depends_on: ["TK-2"] }),
	doc(4, { depends_on: ["TK-2"] }),
	doc(5, { depends_on: ["TK-3", "TK-4"] }),
	doc(6, { status: "doing" }),
	doc(7),
];

describe("dependencyGraph", () => {
	test("keeps open documents, marks ready ones, points dependency -> dependent", () => {
		const g = dependencyGraph(CONFIG, DOCS);
		expect(g.nodes.map((n) => n.id)).toEqual([
			"TK-2",
			"TK-3",
			"TK-4",
			"TK-5",
			"TK-6",
			"TK-7",
		]);
		expect(g.nodes.filter((n) => n.ready).map((n) => n.id)).toEqual([
			"TK-2",
			"TK-7",
		]);
		expect(g.edges).toContainEqual({
			dependent: "TK-3",
			dependency: "TK-2",
			kind: "depends_on",
		});
		// the finished TK-1 and its edge are gone unless asked for
		expect(g.edges.some((e) => e.dependency === "TK-1")).toBe(false);
		expect(dependencyGraph(CONFIG, DOCS, { all: true }).nodes).toHaveLength(7);
	});

	test("hierarchy children are edges and --under scopes the graph", () => {
		const docs = [
			doc(1, { children: ["TK-2", "TK-3"] }),
			doc(2, { parent: "TK-1" }),
			doc(3, { parent: "TK-1" }),
			doc(4),
		];
		const g = dependencyGraph(CONFIG, docs, { under: "TK-1" });
		expect(g.nodes.map((n) => n.id)).toEqual(["TK-1", "TK-2", "TK-3"]);
		expect(g.edges.filter((e) => e.kind === "child")).toHaveLength(2);
	});

	test("mermaid and dot render every node and edge", () => {
		const g = dependencyGraph(CONFIG, DOCS);
		const m = renderMermaid(g);
		expect(m.startsWith("graph LR")).toBe(true);
		expect(m).toContain('TK_2["TK-2<br/>t2"]:::ready');
		expect(m).toContain("TK_2 --> TK_3");
		const d = renderDot(g);
		expect(d).toContain("digraph board {");
		expect(d).toContain('"TK-2" -> "TK-3"');
	});
});

describe("impactOf", () => {
	test("counts what each open document transitively unblocks and the chain behind it", () => {
		const impact = impactOf(CONFIG, DOCS);
		expect(impact.get("TK-2")).toEqual({ unblocks: 3, height: 2 });
		expect(impact.get("TK-3")).toEqual({ unblocks: 1, height: 1 });
		expect(impact.get("TK-5")).toEqual({ unblocks: 0, height: 0 });
		expect(impact.has("TK-1")).toBe(false); // finished
	});
});

describe("planParallel", () => {
	test("ranks ready documents by what they unblock", () => {
		const plan = planParallel(CONFIG, DOCS);
		expect(plan.picked.map((p) => p.id)).toEqual(["TK-2", "TK-7"]);
		expect(plan.inProgress).toEqual(["TK-6"]);
		expect(plan.skipped).toEqual([]);
	});

	test("in-progress work that gates others is reported, biggest first, with what it frees", () => {
		// 1 doing; 2 and 3 wait only on it; 4 waits on 2 as well as 1; 5 doing, frees nobody
		const docs = [
			doc(1, { status: "doing" }),
			doc(2, { depends_on: ["TK-1"] }),
			doc(3, { depends_on: ["TK-1"] }),
			doc(4, { depends_on: ["TK-1", "TK-2"] }),
			doc(5, { status: "doing" }),
		];
		const plan = planParallel(CONFIG, docs);
		expect(plan.picked).toEqual([]);
		expect(plan.blockers).toEqual([
			{ id: "TK-1", unblocks: 3, next: ["TK-2", "TK-3"] },
		]);
	});

	test("--max caps the batch and says why the rest were left", () => {
		const plan = planParallel(CONFIG, DOCS, { max: 1 });
		expect(plan.picked.map((p) => p.id)).toEqual(["TK-2"]);
		expect(plan.skipped).toEqual([{ id: "TK-7", reason: "over --max 1" }]);
	});

	test("file scopes: overlapping with work in progress or an earlier pick is skipped", () => {
		const docs = [
			doc(1, { owns: ["src/a/**"], status: "doing" }),
			doc(2, { owns: ["src/a/x.ts"] }), // overlaps the one in progress
			doc(3, { owns: ["src/b/**"] }),
			doc(4, { owns: ["src/b/y.ts"] }), // overlaps TK-3, picked first
			doc(5), // no scope: never conflicts
		];
		const plan = planParallel(CONFIG, docs);
		expect(plan.picked.map((p) => p.id)).toEqual(["TK-3", "TK-5"]);
		expect(plan.skipped.map((s) => s.reason)).toEqual([
			"overlaps TK-1 (in progress) on src/a/x.ts ~ src/a/**",
			"overlaps TK-3 (picked) on src/b/y.ts ~ src/b/**",
		]);
	});

	test("an exemption lets the pair run together", () => {
		const docs = [
			doc(1, { owns: ["src/reg.ts"] }),
			doc(2, { owns: ["src/reg.ts"] }),
		];
		const ex = parseOwnershipExemptions(
			{ append_only: ["src/reg.ts"] },
			new Set(["TK-1", "TK-2"]),
		);
		expect(planParallel(CONFIG, docs).picked).toHaveLength(1);
		expect(
			planParallel(CONFIG, docs, { exemptions: () => ex }).picked,
		).toHaveLength(2);
	});

	test("a ready parent only waits to be closed and is never scheduled", () => {
		const docs = [
			doc(1, { children: ["TK-2"] }),
			doc(2, { parent: "TK-1", status: "done" }),
			doc(3),
		];
		const plan = planParallel(CONFIG, docs);
		expect(plan.toClose).toEqual(["TK-1"]);
		expect(plan.picked.map((p) => p.id)).toEqual(["TK-3"]);
	});
});

describe("ownership exemptions and config", () => {
	test("parseOwnershipExemptions validates ids, paths and shape", () => {
		const known = new Set(["TK-1", "TK-2"]);
		const ok = parseOwnershipExemptions(
			{ pairs: [{ cards: ["TK-1", "TK-2"], paths: ["a/**"], note: "n" }] },
			known,
		);
		expect(ok.pairs[0]?.cards).toEqual(["TK-1", "TK-2"]);
		expect(() =>
			parseOwnershipExemptions(
				{ pairs: [{ cards: ["TK-1", "TK-9"], paths: ["a"] }] },
				known,
			),
		).toThrow(/unknown id 'TK-9'/);
		expect(() =>
			parseOwnershipExemptions({ append_only: ["/abs"] }, known),
		).toThrow(/relative/);
		expect(() =>
			parseOwnershipExemptions(
				{ pairs: [{ cards: ["TK-1"], paths: ["a"] }] },
				known,
			),
		).toThrow(/exactly two/);
	});

	test("config: ownership.field must be a list of strings", () => {
		const base = (fields: Record<string, unknown>) => () =>
			parseBoardConfig({
				mfw: 1,
				types: {
					task: {
						layout: "flat",
						dir: "t",
						id: { strategy: "own-sequence", key: "TK" },
						ownership: { field: "owns" },
						fields: { title: {}, ...fields },
					},
				},
			});
		expect(
			base({ owns: { type: "string", list: true, optional: true } }),
		).not.toThrow();
		expect(base({})).toThrow(/ownership\.field 'owns'/);
		expect(base({ owns: {} })).toThrow(/ownership\.field 'owns'/);
	});
});
