import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBoardConfig } from "../src/config.ts";
import { type BoardDocument, BoardStore } from "../src/store.ts";
import {
	applyTransition,
	blockedAfterCompletion,
	ChildrenOpenError,
	computeLevels,
	effectiveDependencies,
	isLive,
	isParked,
	isQueued,
	isTerminal,
	readyDocuments,
	statusClassOf,
	TransitionArgError,
	TransitionPreconditionError,
	todayUtc,
	UnknownTransitionError,
	workflowIssues,
} from "../src/workflow.ts";

const STATUSES = ["planned", "doing", "done", "retired", "deferred", "dropped"];

const BASE = {
	mfw: 1,
	types: {
		task: {
			layout: "flat",
			dir: "tasks",
			id: { strategy: "own-sequence", key: "WF" },
			statusClasses: {
				terminal: ["done", "retired"],
				live: ["planned", "doing"],
				parked: ["deferred", "dropped"],
				queued: ["planned"],
			},
			ready: { columns: ["agent"] },
			transitions: {
				start: { from: ["planned"], to: "doing" },
				done: {
					from: ["planned", "doing"],
					to: "done",
					arg: "outcome",
					date: "closed",
				},
				defer: {
					from: ["planned", "doing"],
					to: "deferred",
					arg: "reopen_gate",
				},
				reopen: { from: ["deferred"], to: "planned", clear: ["reopen_gate"] },
			},
			fields: {
				status: { values: STATUSES, default: "planned" },
				agent: { optional: true },
				outcome: { optional: true },
				closed: { type: "date", optional: true },
				reopen_gate: { optional: true },
				depends_on: { ref: "task", list: true, optional: true },
				children: { ref: "task", list: true, optional: true },
			},
		},
	},
};

const CONFIG = parseBoardConfig(BASE);
/** Same board with a real `hierarchy:` section (and its `parent` ref field). */
const HCONFIG = parseBoardConfig({
	...BASE,
	hierarchy: { parent: "parent", children: "children" },
	types: {
		task: {
			...BASE.types.task,
			fields: {
				...BASE.types.task.fields,
				parent: { ref: "task", optional: true },
			},
		},
	},
});

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true });
});

interface Seed {
	id: string;
	status?: string;
	deps?: string[];
	children?: string[];
}

async function board(seeds: Seed[]) {
	const dir = await mkdtemp(join(tmpdir(), "board-core-wf-"));
	dirs.push(dir);
	const store = new BoardStore(dir, CONFIG);
	for (const s of seeds) {
		await store.createDocument("task", {
			id: s.id,
			fields: {
				status: s.status ?? "planned",
				depends_on: s.deps ?? [],
				children: s.children ?? [],
			},
		});
	}
	return { store, docs: await store.listDocuments("task") };
}

const ids = (docs: BoardDocument[]) => docs.map((d) => d.id);

describe("status classes", () => {
	test("classify and helpers", () => {
		expect(statusClassOf(CONFIG, "task", "done")).toBe("terminal");
		expect(statusClassOf(CONFIG, "task", "doing")).toBe("live");
		expect(statusClassOf(CONFIG, "task", "dropped")).toBe("parked");
		expect(statusClassOf(CONFIG, "nope", "done")).toBe("other");
		expect(isTerminal(CONFIG, "task", "retired")).toBe(true);
		expect(isLive(CONFIG, "task", "planned")).toBe(true);
		expect(isParked(CONFIG, "task", "deferred")).toBe(true);
		expect(isQueued(CONFIG, "task", "planned")).toBe(true);
		expect(isQueued(CONFIG, "task", "doing")).toBe(false);
	});
});

describe("readyDocuments", () => {
	test("planned with terminal deps is ready; doing is never listed", async () => {
		const { docs } = await board([
			{ id: "WF-1", status: "done" },
			{ id: "WF-2", status: "retired" },
			{ id: "WF-3", deps: ["WF-1", "WF-2"] },
			{ id: "WF-4", status: "doing" },
			{ id: "WF-5", deps: ["WF-3"] },
		]);
		expect(ids(readyDocuments(CONFIG, docs))).toEqual(["WF-3"]);
	});

	test("missing and parked dependencies are not ready", async () => {
		const { docs } = await board([
			{ id: "WF-1", status: "deferred" },
			{ id: "WF-2", deps: ["WF-1"] },
			{ id: "WF-3", deps: ["WF-99"] },
		]);
		expect(ids(readyDocuments(CONFIG, docs))).toEqual([]);
	});

	test("results are sorted by id", async () => {
		const { docs } = await board([
			{ id: "WF-3" },
			{ id: "WF-1" },
			{ id: "WF-2" },
		]);
		expect(ids(readyDocuments(CONFIG, docs))).toEqual(["WF-1", "WF-2", "WF-3"]);
	});

	test("a parent is ready only once all children are terminal", async () => {
		const open = await board([
			{ id: "WF-1", children: ["WF-2", "WF-3"] },
			{ id: "WF-2", status: "done" },
			{ id: "WF-3", status: "doing" },
		]);
		expect(ids(readyDocuments(HCONFIG, open.docs))).toEqual([]);
		// without hierarchy the children field means nothing
		expect(ids(readyDocuments(CONFIG, open.docs))).toEqual(["WF-1"]);

		const closed = await board([
			{ id: "WF-1", children: ["WF-2", "WF-3"], deps: ["WF-4"] },
			{ id: "WF-2", status: "done" },
			{ id: "WF-3", status: "retired" },
			{ id: "WF-4", status: "done" },
		]);
		expect(ids(readyDocuments(HCONFIG, closed.docs))).toEqual(["WF-1"]);
	});

	test("under restricts candidates to descendants, deps resolve board-wide", async () => {
		const { docs } = await board([
			{ id: "WF-1", children: ["WF-2", "WF-3"] },
			{ id: "WF-2", children: ["WF-4"] },
			{ id: "WF-3", deps: ["WF-9"] },
			{ id: "WF-4", deps: ["WF-8"] },
			{ id: "WF-5" },
			{ id: "WF-8", status: "done" },
			{ id: "WF-9", status: "planned" },
		]);
		expect(ids(readyDocuments(HCONFIG, docs, { under: "WF-1" }))).toEqual([
			"WF-4",
		]);
		expect(ids(readyDocuments(HCONFIG, docs, { under: "WF-2" }))).toEqual([
			"WF-4",
		]);
		expect(ids(readyDocuments(HCONFIG, docs))).toEqual([
			"WF-4",
			"WF-5",
			"WF-9",
		]);
	});
});

describe("effectiveDependencies", () => {
	test("unions depends_on with children, deduped", async () => {
		const { docs } = await board([
			{ id: "WF-1", deps: ["WF-2"], children: ["WF-2", "WF-3"] },
			{ id: "WF-2" },
			{ id: "WF-3" },
		]);
		expect(effectiveDependencies(HCONFIG, docs).get("WF-1")).toEqual([
			"WF-2",
			"WF-3",
		]);
		expect(effectiveDependencies(CONFIG, docs).get("WF-1")).toEqual(["WF-2"]);
	});
});

describe("blockedAfterCompletion", () => {
	test("a healthy chain drains", async () => {
		const { docs } = await board([
			{ id: "WF-1", status: "done" },
			{ id: "WF-2", deps: ["WF-1"] },
			{ id: "WF-3", status: "doing", deps: ["WF-2"] },
		]);
		expect([...blockedAfterCompletion(CONFIG, docs)]).toEqual([]);
	});

	test("dangling, parked-dependency and cycle are reported; parked docs are not", async () => {
		const { docs } = await board([
			{ id: "WF-1", status: "deferred" },
			{ id: "WF-2", deps: ["WF-1"] },
			{ id: "WF-3", deps: ["WF-2"] },
			{ id: "WF-4", deps: ["WF-99"] },
			{ id: "WF-5", deps: ["WF-6"] },
			{ id: "WF-6", deps: ["WF-5"] },
			{ id: "WF-7", status: "dropped", deps: ["WF-99"] },
		]);
		expect(Object.fromEntries(blockedAfterCompletion(CONFIG, docs))).toEqual({
			"WF-2": ["WF-1"],
			"WF-3": ["WF-2"],
			"WF-4": ["WF-99"],
			"WF-5": ["WF-6"],
			"WF-6": ["WF-5"],
		});
	});

	test("under limits the report, not the simulation", async () => {
		const { docs } = await board([
			{ id: "WF-1", children: ["WF-2"] },
			{ id: "WF-2", deps: ["WF-3"] },
			{ id: "WF-3", status: "done" },
			{ id: "WF-4", deps: ["WF-99"] },
		]);
		expect([
			...blockedAfterCompletion(HCONFIG, docs, { under: "WF-1" }),
		]).toEqual([]);
		expect([...blockedAfterCompletion(HCONFIG, docs).keys()]).toEqual(["WF-4"]);
	});

	test("a child depending on its parent deadlocks both", async () => {
		const { docs } = await board([
			{ id: "WF-1", children: ["WF-2"] },
			{ id: "WF-2", deps: ["WF-1"] },
		]);
		expect([...blockedAfterCompletion(HCONFIG, docs).keys()].sort()).toEqual([
			"WF-1",
			"WF-2",
		]);
	});
});

describe("computeLevels", () => {
	test("longest chain, children count, cycles terminate", async () => {
		const { docs } = await board([
			{ id: "WF-1" },
			{ id: "WF-2", deps: ["WF-1"] },
			{ id: "WF-3", deps: ["WF-1", "WF-2"] },
			{ id: "WF-4", children: ["WF-3"] },
			{ id: "WF-5", deps: ["WF-6"] },
			{ id: "WF-6", deps: ["WF-5"] },
		]);
		const levels = computeLevels(HCONFIG, docs);
		expect(levels.get("WF-1")).toBe(0);
		expect(levels.get("WF-3")).toBe(2);
		expect(levels.get("WF-4")).toBe(3);
		expect(levels.has("WF-5")).toBe(true);
		expect(computeLevels(CONFIG, docs).get("WF-4")).toBe(0);
	});
});

describe("workflowIssues", () => {
	test("reports a depends_on cycle once, naming it", async () => {
		const { docs } = await board([
			{ id: "WF-1", deps: ["WF-2"] },
			{ id: "WF-2", deps: ["WF-3"] },
			{ id: "WF-3", deps: ["WF-1"] },
		]);
		const issues = workflowIssues(CONFIG, docs);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.message).toContain("WF-1 -> WF-2 -> WF-3 -> WF-1");
	});

	test("a child that depends_on its ancestor is a cycle only with hierarchy", async () => {
		const { docs } = await board([
			{ id: "WF-1", children: ["WF-2"] },
			{ id: "WF-2", children: ["WF-3"] },
			{ id: "WF-3", deps: ["WF-1"] },
		]);
		expect(workflowIssues(CONFIG, docs)).toEqual([]);
		const issues = workflowIssues(HCONFIG, docs);
		expect(issues).toHaveLength(1);
		expect(issues[0]?.message).toContain("WF-1 -> WF-2 -> WF-3 -> WF-1");
	});

	test("clean board and self-dependency", async () => {
		const clean = await board([{ id: "WF-1" }, { id: "WF-2", deps: ["WF-1"] }]);
		expect(workflowIssues(CONFIG, clean.docs)).toEqual([]);
		const self = await board([{ id: "WF-1", deps: ["WF-1"] }]);
		expect(workflowIssues(CONFIG, self.docs)).toHaveLength(1);
	});
});

describe("applyTransition", () => {
	test("plain transition bumps rev and sets status", async () => {
		const { store } = await board([{ id: "WF-1" }]);
		const doc = await applyTransition(store, CONFIG, "task", "WF-1", "start");
		expect(doc.fields.status).toBe("doing");
		expect(doc.rev).toBe(2);
	});

	test("wrong source status throws and leaves the doc untouched", async () => {
		const { store } = await board([{ id: "WF-1", status: "done" }]);
		const err = await applyTransition(
			store,
			CONFIG,
			"task",
			"WF-1",
			"start",
		).catch((e) => e);
		expect(err).toBeInstanceOf(TransitionPreconditionError);
		expect(err.actual).toBe("done");
		expect(err.from).toEqual(["planned"]);
		const after = await store.readDocument("task", "WF-1");
		expect(after?.rev).toBe(1);
	});

	test("arg is required, stored, and date defaults to today", async () => {
		const { store } = await board([{ id: "WF-1" }]);
		await expect(
			applyTransition(store, CONFIG, "task", "WF-1", "done"),
		).rejects.toBeInstanceOf(TransitionArgError);
		await expect(
			applyTransition(store, CONFIG, "task", "WF-1", "start", "x"),
		).rejects.toBeInstanceOf(TransitionArgError);
		const doc = await applyTransition(
			store,
			CONFIG,
			"task",
			"WF-1",
			"done",
			"shipped it",
		);
		expect(doc.fields.outcome).toBe("shipped it");
		expect(doc.fields.closed).toBe(todayUtc());
		expect(doc.fields.status).toBe("done");
	});

	test("date is taken from the arg text when it contains one", async () => {
		const { store } = await board([{ id: "WF-1" }]);
		const doc = await applyTransition(
			store,
			CONFIG,
			"task",
			"WF-1",
			"done",
			"landed 2025-03-04, again 2025-05-06",
		);
		// dates in the text are just text: the date field is today's, never scanned
		expect(doc.fields.outcome).toBe("landed 2025-03-04, again 2025-05-06");
		expect(doc.fields.closed).toBe(todayUtc());
	});

	test("clear empties fields", async () => {
		const { store } = await board([{ id: "WF-1" }]);
		const d = await applyTransition(
			store,
			CONFIG,
			"task",
			"WF-1",
			"defer",
			"wait for X",
		);
		expect(d.fields.reopen_gate).toBe("wait for X");
		const r = await applyTransition(store, CONFIG, "task", "WF-1", "reopen");
		expect(r.fields.status).toBe("planned");
		expect(r.fields.reopen_gate).toBeNull();
	});

	test("unknown verb lists the available ones", async () => {
		const { store } = await board([{ id: "WF-1" }]);
		const err = await applyTransition(
			store,
			CONFIG,
			"task",
			"WF-1",
			"nope",
		).catch((e) => e);
		expect(err).toBeInstanceOf(UnknownTransitionError);
		expect(err.message).toContain("start");
	});

	test("terminal transition is refused while children are open", async () => {
		const { store } = await board([
			{ id: "WF-1", children: ["WF-2", "WF-3", "WF-4"] },
			{ id: "WF-2", status: "done" },
			{ id: "WF-3", status: "doing" },
		]);
		const err = await applyTransition(
			store,
			HCONFIG,
			"task",
			"WF-1",
			"done",
			"all done",
		).catch((e) => e);
		expect(err).toBeInstanceOf(ChildrenOpenError);
		expect(err.openChildIds).toEqual(["WF-3", "WF-4"]); // WF-4 is dangling
		expect((await store.readDocument("task", "WF-1"))?.rev).toBe(1);
		// non-terminal transitions are unaffected
		const started = await applyTransition(
			store,
			HCONFIG,
			"task",
			"WF-1",
			"start",
		);
		expect(started.fields.status).toBe("doing");
	});

	test("terminal transition succeeds when all children are terminal", async () => {
		const { store } = await board([
			{ id: "WF-1", children: ["WF-2", "WF-3"] },
			{ id: "WF-2", status: "done" },
			{ id: "WF-3", status: "retired" },
		]);
		const doc = await applyTransition(
			store,
			HCONFIG,
			"task",
			"WF-1",
			"done",
			"ok",
		);
		expect(doc.fields.status).toBe("done");
	});

	test("concurrent double start (same race as a double done) has exactly one winner", async () => {
		const { store } = await board([{ id: "WF-1" }]);
		const results = await Promise.allSettled([
			applyTransition(store, CONFIG, "task", "WF-1", "start"),
			applyTransition(store, CONFIG, "task", "WF-1", "start"),
			applyTransition(store, CONFIG, "task", "WF-1", "start"),
		]);
		const ok = results.filter((r) => r.status === "fulfilled");
		const bad = results.filter(
			(r) =>
				r.status === "rejected" &&
				r.reason instanceof TransitionPreconditionError,
		);
		expect(ok).toHaveLength(1);
		expect(bad).toHaveLength(2);
		expect((await store.readDocument("task", "WF-1"))?.rev).toBe(2);
	});
});

describe("workflow config validation", () => {
	const mutate = (patch: (t: Record<string, unknown>) => void) => {
		const copy = structuredClone(BASE) as typeof BASE;
		patch(copy.types.task as unknown as Record<string, unknown>);
		return () => parseBoardConfig(copy);
	};

	test("the base config parses with defaults", () => {
		const wf = CONFIG.types.task?.workflow;
		expect(wf?.statusField).toBe("status");
		expect(wf?.ready.dependsOn).toBe("depends_on");
		expect(wf?.ready.columns).toEqual(["agent"]);
	});

	test("a type without workflow keys has none", () => {
		const cfg = parseBoardConfig({
			mfw: 1,
			types: {
				a: {
					layout: "flat",
					dir: "a",
					id: { strategy: "own-sequence", key: "AA" },
					fields: {},
				},
			},
		});
		expect(cfg.types.a?.workflow).toBeUndefined();
	});

	test("commit.prefix defaults to the type name and can be configured", () => {
		expect(CONFIG.types.task?.workflow?.commit.prefix).toBe("task");
		const copy = structuredClone(BASE) as unknown as {
			types: { task: Record<string, unknown> };
		};
		copy.types.task.commit = { prefix: "tasks" };
		expect(parseBoardConfig(copy).types.task?.workflow?.commit.prefix).toBe(
			"tasks",
		);
		copy.types.task.commit = { prefix: "" };
		expect(() => parseBoardConfig(copy)).toThrow();
	});

	test("statusField must be an enum field", () => {
		expect(
			mutate((t) => {
				t.statusField = "agent";
			}),
		).toThrow(/statusField/);
		expect(
			mutate((t) => {
				t.statusField = "nope";
			}),
		).toThrow(/statusField/);
	});

	test("classes must name enum values, queued within live, groups disjoint", () => {
		expect(
			mutate((t) => {
				t.statusClasses = { terminal: ["bogus"] };
			}),
		).toThrow(/bogus/);
		expect(
			mutate((t) => {
				t.statusClasses = { live: ["planned"], queued: ["doing"] };
			}),
		).toThrow(/queued/);
		expect(
			mutate((t) => {
				t.statusClasses = { terminal: ["done"], parked: ["done"] };
			}),
		).toThrow(/disjoint/);
	});

	test("transition from/to/arg/date/clear are checked", () => {
		const tr = (x: Record<string, unknown>) =>
			mutate((t) => {
				t.transitions = { go: { from: ["planned"], to: "doing", ...x } };
			});
		expect(tr({ from: ["bogus"] })).toThrow(/from/);
		expect(tr({ to: "bogus" })).toThrow(/\.to/);
		expect(tr({ arg: "ghost" })).toThrow(/arg/);
		expect(tr({ date: "ghost" })).toThrow(/date/);
		expect(tr({ clear: ["ghost"] })).toThrow(/clear/);
		expect(tr({})).not.toThrow();
	});

	test("verb names are validated and reserved verbs rejected", () => {
		const verb = (name: string) =>
			mutate((t) => {
				t.transitions = { [name]: { from: ["planned"], to: "doing" } };
			});
		expect(verb("list")).toThrow(/reserved/);
		expect(verb("Bad")).toThrow();
		expect(verb("kick-off_2")).not.toThrow();
	});

	test("ready.columns and ready.dependsOn must name fields", () => {
		expect(
			mutate((t) => {
				t.ready = { columns: ["ghost"] };
			}),
		).toThrow(/columns/);
		expect(
			mutate((t) => {
				t.ready = { dependsOn: "agent" };
			}),
		).toThrow(/dependsOn/);
	});
});

describe("transition field validation", () => {
	const withTransition = (
		t: Record<string, unknown>,
		extraFields: Record<string, unknown> = {},
		hierarchy = false,
	) => {
		const copy = structuredClone(BASE) as unknown as {
			types: { task: { transitions: Record<string, unknown>; fields: object } };
			hierarchy?: unknown;
		};
		copy.types.task.transitions.x = { from: ["planned"], to: "doing", ...t };
		Object.assign(copy.types.task.fields, extraFields);
		if (hierarchy) copy.hierarchy = { parent: "parent", children: "children" };
		return () => parseBoardConfig(copy);
	};
	const withParent = { parent: { ref: "task", optional: true } };

	test("arg/date/clear may not name hierarchy-managed fields", () => {
		for (const key of ["arg", "date"]) {
			expect(withTransition({ [key]: "parent" }, withParent, true)).toThrow(
				/transitions\.x\.\w+: 'parent' is managed by the hierarchy/,
			);
		}
		expect(withTransition({ clear: ["children"] }, withParent, true)).toThrow(
			/transitions\.x\.clear: 'children' is managed by the hierarchy/,
		);
	});

	test("arg must be a single string or enum field", () => {
		expect(withTransition({ arg: "closed" })).toThrow(/transitions\.x\.arg/);
		expect(
			withTransition({ arg: "n" }, { n: { type: "number", optional: true } }),
		).toThrow(/transitions\.x\.arg/);
		expect(
			withTransition({ arg: "l" }, { l: { list: true, optional: true } }),
		).toThrow(/transitions\.x\.arg/);
		withTransition({ arg: "outcome" })();
	});

	test("date must be a date or string field", () => {
		expect(
			withTransition({ date: "n" }, { n: { type: "number", optional: true } }),
		).toThrow(/transitions\.x\.date/);
		withTransition({ date: "closed" })();
		withTransition({ date: "outcome" })();
	});

	test("clear may not name a required field", () => {
		expect(
			withTransition({ clear: ["req"] }, { req: { type: "string" } }),
		).toThrow(/transitions\.x\.clear: 'req' is required/);
		withTransition({ clear: ["d"] }, { d: { type: "string", default: "z" } })();
		withTransition({ clear: ["reopen_gate"] })();
	});

	test("an explicit date is used as given, and must be a real calendar date", async () => {
		const { store } = await board([{ id: "WF-1" }]);
		await expect(
			applyTransition(store, CONFIG, "task", "WF-1", "done", "x", {
				date: "2026-99-99",
			}),
		).rejects.toThrow(/real calendar date/);
		expect((await store.readDocument("task", "WF-1"))?.rev).toBe(1);
		const ok = await applyTransition(
			store,
			CONFIG,
			"task",
			"WF-1",
			"done",
			"x",
			{
				date: "2026-02-03",
			},
		);
		expect(ok.fields.closed).toBe("2026-02-03");
	});

	test("an explicit date on a verb that declares no date field is refused", async () => {
		const { store } = await board([{ id: "WF-1" }]);
		await expect(
			applyTransition(store, CONFIG, "task", "WF-1", "start", undefined, {
				date: "2026-02-03",
			}),
		).rejects.toThrow(/takes no date/);
	});
});
