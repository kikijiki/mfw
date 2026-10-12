import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectIssues } from "../src/checks.ts";
import { BoardConfigError, parseBoardConfig } from "../src/config.ts";
import { evaluateRules, newViolations } from "../src/rules.ts";
import { BoardStore, RuleViolationError } from "../src/store.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const RULES = [
	{
		id: "done-resolved",
		field: "acceptance",
		when: { status: "done" },
		forbid: { result: "pending" },
	},
	{
		id: "no-red",
		field: "acceptance",
		key: "text",
		must_match: "red|mutation|reproduc",
		flags: "i",
		severity: "advisory",
	},
	{
		id: "local-big",
		field: "acceptance",
		key: "text",
		must_not_match: "\\b(2\\d|3\\d)B\\b",
		strip: "POOT-\\d+",
		unless: "pod",
		severity: "advisory",
	},
	{
		id: "owns-prose",
		field: "owns",
		must_not_match: "[`:]|\\s",
		severity: "advisory",
	},
	{
		id: "all-checked",
		field: "steps",
		when: { status: "done" },
		forbid: { done: false },
	},
];

function raw(rules: unknown[] = RULES) {
	return {
		mfw: 1,
		types: {
			task: {
				layout: "flat",
				dir: "tasks",
				id: { strategy: "own-sequence", key: "TK" },
				rules,
				fields: {
					title: {},
					status: { values: ["todo", "done"], default: "todo" },
					acceptance: {
						type: "json",
						list: true,
						optional: true,
						rows: { required: ["id", "text"] },
					},
					owns: { list: true, optional: true },
					steps: { type: "checklist", optional: true },
				},
			},
		},
	};
}

const config = parseBoardConfig(raw());
const task = config.types.task;
if (!task) throw new Error("fixture");

async function store(opts = {}) {
	const root = await mkdtemp(join(tmpdir(), "board-core-rules-"));
	dirs.push(root);
	return new BoardStore(root, config, opts);
}

const row = (id: string, text: string, result?: string) => ({
	id,
	text,
	...(result ? { result } : {}),
});

describe("rule evaluation", () => {
	test("forbid fires only while `when` holds, naming the row", () => {
		const fields = {
			status: "todo",
			acceptance: [row("SC-1", "x red", "pending")],
		};
		expect(evaluateRules(task, fields).map((v) => v.rule)).not.toContain(
			"done-resolved",
		);
		const done = { ...fields, status: "done" };
		const v = evaluateRules(task, done).filter(
			(x) => x.rule === "done-resolved",
		);
		expect(v).toHaveLength(1);
		expect(v[0]?.item).toBe("SC-1");
		expect(v[0]?.severity).toBe("error");
	});

	test("must_match is inverted: fires when the pattern is absent", () => {
		const v = evaluateRules(task, {
			status: "todo",
			acceptance: [
				row("SC-1", "a plain assertion"),
				row("SC-2", "turns RED on revert"),
			],
		}).filter((x) => x.rule === "no-red");
		expect(v.map((x) => x.item)).toEqual(["SC-1"]);
	});

	test("strip removes text before matching; unless tests the original", () => {
		const v = (text: string) =>
			evaluateRules(task, {
				status: "todo",
				acceptance: [row("SC-1", `${text} red`)],
			}).filter((x) => x.rule === "local-big");
		expect(v("runs 27B locally")).toHaveLength(1);
		expect(v("runs 27B on a pod")).toHaveLength(0); // unless: pod
		expect(v("see POOT-2300 for the plan")).toHaveLength(0); // stripped before matching
	});

	test("string list items and checklist items are items too", () => {
		const v = evaluateRules(task, {
			status: "done",
			owns: ["src/a/**", "`src/b`: note"],
			steps: [
				{ id: "c1", text: "one", done: true },
				{ id: "c2", text: "two", done: false },
			],
		});
		expect(v.filter((x) => x.rule === "owns-prose").map((x) => x.item)).toEqual(
			["`src/b`: note"],
		);
		expect(
			v.filter((x) => x.rule === "all-checked").map((x) => x.item),
		).toEqual(["c2"]);
	});

	test("newViolations: a violation present before is not new", () => {
		const before = {
			status: "done",
			acceptance: [row("SC-1", "red", "pending")],
		};
		const after = {
			status: "done",
			acceptance: [
				row("SC-1", "red, edited", "pending"),
				row("SC-2", "red", "pending"),
			],
		};
		const fresh = newViolations(task, before, after).filter(
			(v) => v.rule === "done-resolved",
		);
		expect(fresh.map((v) => v.item)).toEqual(["SC-2"]);
	});
});

describe("config validation", () => {
	const bad = (rule: Record<string, unknown>) => () =>
		parseBoardConfig(raw([{ id: "r", field: "acceptance", ...rule }]));

	test("rejects: unknown field, built-in id, no assertion, two assertions", () => {
		expect(bad({ field: "nope", must_match: "x", key: "text" })).toThrow(
			BoardConfigError,
		);
		expect(() =>
			parseBoardConfig(raw([{ id: "cycle", field: "owns", must_match: "x" }])),
		).toThrow(/built-in rule id/);
		expect(bad({})).toThrow(/exactly one/);
		expect(bad({ forbid: { a: 1 }, must_match: "x", key: "text" })).toThrow(
			/exactly one/,
		);
	});

	test("rejects: rows need a key, forbid on a plain list, bad regex, bad when field", () => {
		expect(bad({ must_match: "x" })).toThrow(/need a 'key'/);
		expect(() =>
			parseBoardConfig(raw([{ id: "r", field: "owns", forbid: { a: 1 } }])),
		).toThrow(/neither/);
		expect(bad({ must_match: "(", key: "text" })).toThrow(/regular expression/);
		expect(bad({ forbid: { a: 1 }, when: { nope: "x" } })).toThrow(
			/not a declared field/,
		);
	});

	test("rejects: strip/unless without a match, unless with must_match, duplicate ids across and within types", () => {
		expect(bad({ forbid: { a: 1 }, strip: "x" })).toThrow(/only apply/);
		expect(bad({ must_match: "x", key: "text", unless: "y" })).toThrow(
			/unless only/,
		);
		expect(() =>
			parseBoardConfig(
				raw([
					{ id: "r", field: "owns", must_match: "x" },
					{ id: "r", field: "owns", must_match: "y" },
				]),
			),
		).toThrow(/declared twice/);
		expect(() =>
			parseBoardConfig({
				...raw(),
				types: {
					...raw().types,
					spec: {
						layout: "flat",
						dir: "specs",
						id: { strategy: "own-sequence", key: "SP" },
						fields: { title: {}, owns: { list: true, optional: true } },
						rules: [{ id: "no-red", field: "owns", must_match: "x" }],
					},
				},
			}),
		).toThrow(/board-wide/);
	});
});

describe("the write gate", () => {
	async function seeded(opts = {}) {
		const s = await store(opts);
		const doc = await s.createDocument("task", {
			fields: {
				title: "t",
				acceptance: [row("SC-1", "reproduce it", "pending")],
			},
		});
		return { s, id: doc.id };
	}

	test("refuses a status change that creates a violation, naming the rows", async () => {
		const { s, id } = await seeded();
		const err = await s
			.updateDocument("task", id, { fields: { status: "done" } })
			.catch((e) => e);
		expect(err).toBeInstanceOf(RuleViolationError);
		expect(err.violations.map((v: { item: string }) => v.item)).toEqual([
			"SC-1",
		]);
		expect(err.message).toContain("done-resolved");
		expect((await s.readDocument("task", id))?.fields.status).toBe("todo");
	});

	test("allows it once the row is resolved", async () => {
		const { s, id } = await seeded();
		await s.updateDocument("task", id, {
			fields: { acceptance: [row("SC-1", "reproduce it", "passes")] },
		});
		const done = await s.updateDocument("task", id, {
			fields: { status: "done" },
		});
		expect(done.fields.status).toBe("done");
	});

	test("refuses a new pending row on a done document, but not edits to old violations", async () => {
		const { s, id } = await seeded();
		await s.updateDocument("task", id, {
			fields: {
				acceptance: [row("SC-1", "reproduce it", "ok")],
				status: "done",
			},
		});
		const err = await s
			.updateDocument("task", id, {
				fields: {
					acceptance: [
						row("SC-1", "reproduce it", "ok"),
						row("SC-2", "red", "pending"),
					],
				},
			})
			.catch((e) => e);
		expect(err).toBeInstanceOf(RuleViolationError);
	});

	test("a document that already violates stays editable", async () => {
		const root = await mkdtemp(join(tmpdir(), "board-core-rules-"));
		dirs.push(root);
		const loose = new BoardStore(root, config, {
			overrideRules: ["done-resolved"],
		});
		const doc = await loose.createDocument("task", {
			fields: {
				title: "t",
				status: "done",
				acceptance: [row("SC-1", "red", "pending")],
			},
		});
		const strict = new BoardStore(root, config);
		const next = await strict.updateDocument("task", doc.id, {
			fields: { title: "renamed" },
		});
		expect(next.fields.title).toBe("renamed");
	});

	test("create is gated too", async () => {
		const s = await store();
		await expect(
			s.createDocument("task", {
				fields: {
					title: "t",
					status: "done",
					acceptance: [row("SC-1", "red", "pending")],
				},
			}),
		).rejects.toBeInstanceOf(RuleViolationError);
	});

	test("override lets the write through and reports it", async () => {
		const seen: string[] = [];
		const { s, id } = await seeded({
			overrideRules: ["done-resolved"],
			onOverride: (i: { id: string; violation: { rule: string } }) =>
				seen.push(`${i.violation.rule}@${i.id}`),
		});
		const done = await s.updateDocument("task", id, {
			fields: { status: "done" },
		});
		expect(done.fields.status).toBe("done");
		expect(seen).toEqual([`done-resolved@${id}`]);
	});

	test("advisory rules never block a write", async () => {
		const s = await store();
		const doc = await s.createDocument("task", {
			fields: { title: "t", acceptance: [row("SC-1", "no marker at all")] },
		});
		expect(doc.id).toBeDefined();
	});

	test("check reports the violation of a hand-edited document", async () => {
		const { s, id } = await seeded({ overrideRules: ["done-resolved"] });
		await s.updateDocument("task", id, { fields: { status: "done" } });
		const issues = await collectIssues(s, config, "");
		const mine = issues.filter((i) => i.rule === "done-resolved");
		expect(mine).toHaveLength(1);
		expect(mine[0]).toMatchObject({ severity: "error", id });
	});
});
