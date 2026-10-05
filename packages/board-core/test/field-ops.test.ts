import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coerceFieldValue } from "../src/cli-support.ts";
import { BoardConfigError, parseBoardConfig } from "../src/config.ts";
import { checklistProgress } from "../src/document.ts";
import {
	applyFieldOp,
	applyFieldOpDetailed,
	FieldOpError,
	resolveChecklistItem,
} from "../src/field-ops.ts";
import {
	BoardStore,
	DocumentConflictError,
	InvalidFieldsError,
} from "../src/store.ts";

const dirs: string[] = [];
async function freshRoot(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "board-core-ops-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true });
});

const config = parseBoardConfig({
	mfw: 1,
	types: {
		task: {
			layout: "flat",
			dir: "tasks",
			id: { strategy: "own-sequence", key: "TK" },
			fields: {
				title: {},
				status: { values: ["todo", "doing", "done"], default: "todo" },
				labels: { list: true, optional: true },
				tags: { values: ["a", "b", "c"], list: true, optional: true },
				deps: { ref: "task", list: true, optional: true },
				points: { type: "number", optional: true },
				urgent: { type: "boolean", optional: true },
				code: { pattern: "[A-Z]+", list: true, optional: true },
				log: { type: "json", list: true, rows: { required: ["id"] } },
				acceptance: { type: "checklist", optional: true },
				children: { ref: "task", list: true, optional: true },
				parent: { ref: "task", optional: true },
			},
		},
	},
	hierarchy: { parent: "parent", children: "children" },
});

async function setup() {
	const root = await freshRoot();
	const store = new BoardStore(root, config);
	const doc = await store.createDocument("task", { fields: { title: "t" } });
	return { root, store, id: doc.id };
}

const run = (
	s: Awaited<ReturnType<typeof setup>>,
	op: Parameters<typeof applyFieldOp>[4],
	opts?: Parameters<typeof applyFieldOp>[5],
) => applyFieldOp(s.store, config, "task", s.id, op, opts);

async function code(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		if (e instanceof FieldOpError) return e.code;
		throw e;
	}
	return "none";
}

describe("checklist field kind", () => {
	test("create assigns ids and defaults done", async () => {
		const { store } = await setup();
		const d = await store.createDocument("task", {
			fields: {
				title: "x",
				acceptance: [{ text: "a" }, { text: "b", done: true }],
			},
		});
		expect(d.fields.acceptance).toEqual([
			{ id: "c1", text: "a", done: false },
			{ id: "c2", text: "b", done: true },
		]);
	});

	test("new ids go above the max existing id, explicit ids are kept", async () => {
		const { store } = await setup();
		const d = await store.createDocument("task", {
			fields: {
				title: "x",
				acceptance: [{ id: "c7", text: "a" }, { text: "b" }],
			},
		});
		expect((d.fields.acceptance as { id: string }[]).map((i) => i.id)).toEqual([
			"c7",
			"c8",
		]);
	});

	test("update re-ids new items without disturbing existing ones", async () => {
		const s = await setup();
		await run(s, { op: "check-add", field: "acceptance", text: "a" });
		const d = await s.store.updateDocument("task", s.id, {
			fields: {
				acceptance: [{ id: "c1", text: "a", done: true }, { text: "new" }],
			},
		});
		expect(d.fields.acceptance).toEqual([
			{ id: "c1", text: "a", done: true },
			{ id: "c2", text: "new", done: false },
		]);
	});

	test("validation errors", async () => {
		const { store } = await setup();
		const bad = (acceptance: unknown) =>
			store.createDocument("task", { fields: { title: "x", acceptance } });
		await expect(bad("nope")).rejects.toBeInstanceOf(InvalidFieldsError);
		await expect(bad([{ text: "" }])).rejects.toThrow(
			/non-empty string 'text'/,
		);
		await expect(bad([{ text: "a", done: "yes" }])).rejects.toThrow(/'done'/);
		await expect(bad([{ text: "a", extra: 1 }])).rejects.toThrow(/unknown key/);
		await expect(
			bad([
				{ id: "c1", text: "a" },
				{ id: "c1", text: "b" },
			]),
		).rejects.toThrow(/duplicate item id/);
		await expect(bad(["a"])).rejects.toThrow(/must be an object/);
	});

	test("renders as a block list of mappings and round-trips", async () => {
		const s = await setup();
		await run(s, { op: "check-add", field: "acceptance", text: "first" });
		await run(s, { op: "check-add", field: "acceptance", text: "second" });
		const doc = await s.store.readDocument("task", s.id);
		const raw = await readFile(doc?.path as string, "utf8");
		expect(raw).toContain(
			"acceptance:\n  - id: c1\n    text: first\n    done: false\n  - id: c2",
		);
		expect(raw).not.toContain("[");
		expect(doc?.fields.acceptance).toHaveLength(2);
		expect(await s.store.validate()).toEqual([]);
	});

	test("empty checklist is quiet; optional and required_when behave like lists", async () => {
		const s = await setup();
		const raw = await readFile(
			(await s.store.readDocument("task", s.id))?.path as string,
			"utf8",
		);
		expect(raw).not.toContain("acceptance");
		const c = parseBoardConfig({
			mfw: 1,
			types: {
				t: {
					layout: "flat",
					dir: "t",
					id: { strategy: "own-sequence", key: "TT" },
					fields: {
						kind: { values: ["x", "y"], default: "x" },
						ac: {
							type: "checklist",
							required_when: { kind: "y" },
						},
					},
				},
			},
		});
		const st = new BoardStore(await freshRoot(), c);
		await st.createDocument("t", { fields: {} });
		await expect(
			st.createDocument("t", { fields: { kind: "y" } }),
		).rejects.toThrow(/required when/);
		await st.createDocument("t", {
			fields: { kind: "y", ac: [{ text: "ok" }] },
		});
	});

	test("config rejects list/default/pattern on a checklist", () => {
		expect(() =>
			parseBoardConfig({
				mfw: 1,
				types: {
					t: {
						layout: "flat",
						dir: "t",
						id: { strategy: "own-sequence", key: "TT" },
						fields: { ac: { type: "checklist", list: true } },
					},
				},
			}),
		).toThrow(BoardConfigError);
	});

	test("CLI coercion: JSON array or comma-separated texts", () => {
		const spec = config.types.task?.fields.acceptance as never;
		expect(coerceFieldValue(spec, "a, b,c")).toEqual([
			{ text: "a" },
			{ text: "b" },
			{ text: "c" },
		]);
		expect(coerceFieldValue(spec, '[{"text":"x","done":true}]')).toEqual([
			{ text: "x", done: true },
		]);
		expect(coerceFieldValue(spec, "")).toEqual([]);
	});

	test("checklistProgress", () => {
		expect(checklistProgress([{ done: true }, { done: false }])).toEqual({
			done: 1,
			total: 2,
		});
		expect(checklistProgress([])).toEqual({ done: 0, total: 0 });
	});
});

describe("checklist ops", () => {
	test("add / toggle / set / edit / remove with id and prefix selectors", async () => {
		const s = await setup();
		const a = await applyFieldOpDetailed(s.store, config, "task", s.id, {
			op: "check-add",
			field: "acceptance",
			text: "write tests",
		});
		expect(a.itemId).toBe("c1");
		await run(s, { op: "check-add", field: "acceptance", text: "ship it" });
		let d = await run(s, {
			op: "check-toggle",
			field: "acceptance",
			selector: "c1",
		});
		expect((d.fields.acceptance as { done: boolean }[])[0]?.done).toBe(true);
		d = await run(s, {
			op: "check-set",
			field: "acceptance",
			selector: "ship",
			done: true,
		});
		d = await run(s, {
			op: "check-set",
			field: "acceptance",
			selector: "c1",
			done: true,
		}); // explicit set is idempotent
		expect(d.fields.acceptance).toEqual([
			{ id: "c1", text: "write tests", done: true },
			{ id: "c2", text: "ship it", done: true },
		]);
		d = await run(s, {
			op: "check-edit",
			field: "acceptance",
			selector: "c2",
			text: "release",
		});
		d = await run(s, {
			op: "check-remove",
			field: "acceptance",
			selector: "write",
		});
		expect(d.fields.acceptance).toEqual([
			{ id: "c2", text: "release", done: true },
		]);
		const added = await applyFieldOpDetailed(s.store, config, "task", s.id, {
			op: "check-add",
			field: "acceptance",
			text: "again",
		});
		expect(added.itemId).toBe("c3"); // never collides with an existing id
	});

	test("selector resolution", () => {
		const items = [
			{ id: "c1", text: "write docs", done: false },
			{ id: "c2", text: "write tests", done: false },
			{ id: "c3", text: "write", done: false },
		];
		expect(resolveChecklistItem(items, "c2").id).toBe("c2");
		expect(resolveChecklistItem(items, "write t").id).toBe("c2");
		expect(resolveChecklistItem(items, "WRITE D").id).toBe("c1");
		expect(resolveChecklistItem(items, "write").id).toBe("c3"); // exact text wins
		const err = (sel: string) => {
			try {
				resolveChecklistItem(items, sel);
			} catch (e) {
				return e as FieldOpError;
			}
			throw new Error("expected error");
		};
		expect(err("wri").code).toBe("ambiguous-selector");
		expect(err("wri").message).toContain('c1 "write docs"');
		expect(err("zzz").code).toBe("not-found");
		expect(err("zzz").message).toContain("c2");
		expect(err("  ").code).toBe("bad-selector");
	});

	test("kind checks", async () => {
		const s = await setup();
		expect(
			await code(run(s, { op: "check-add", field: "labels", text: "x" })),
		).toBe("wrong-kind");
		expect(
			await code(run(s, { op: "append", field: "acceptance", values: ["x"] })),
		).toBe("wrong-kind");
		expect(
			await code(run(s, { op: "check-add", field: "acceptance", text: " " })),
		).toBe("bad-value");
	});

	test("concurrent toggles of one item cancel out; concurrent adds both land", async () => {
		const s = await setup();
		await run(s, { op: "check-add", field: "acceptance", text: "x" });
		await Promise.all([
			run(s, { op: "check-toggle", field: "acceptance", selector: "c1" }),
			run(s, { op: "check-toggle", field: "acceptance", selector: "c1" }),
		]);
		let d = await s.store.readDocument("task", s.id);
		expect((d?.fields.acceptance as { done: boolean }[])[0]?.done).toBe(false);
		await Promise.all([
			run(s, { op: "check-add", field: "acceptance", text: "p" }),
			run(s, { op: "check-add", field: "acceptance", text: "q" }),
		]);
		d = await s.store.readDocument("task", s.id);
		const ids = (d?.fields.acceptance as { id: string }[]).map((i) => i.id);
		expect(ids.sort()).toEqual(["c1", "c2", "c3"]);
	});
});

describe("list ops", () => {
	test("append / prepend / insert / move / remove on a plain list", async () => {
		const s = await setup();
		await run(s, { op: "append", field: "labels", values: ["b", "c"] });
		await run(s, { op: "prepend", field: "labels", values: ["a"] });
		await run(s, { op: "insert", field: "labels", index: 2, values: ["x"] });
		let d = await run(s, { op: "move", field: "labels", from: 0, to: 3 });
		expect(d.fields.labels).toEqual(["b", "x", "c", "a"]);
		d = await run(s, { op: "remove", field: "labels", value: "x" });
		expect(d.fields.labels).toEqual(["b", "c", "a"]);
	});

	test("duplicates: allowed on plain lists, refused on enum and ref lists", async () => {
		const s = await setup();
		await run(s, { op: "append", field: "labels", values: ["a"] });
		const d = await run(s, { op: "append", field: "labels", values: ["a"] });
		expect(d.fields.labels).toEqual(["a", "a"]);
		await run(s, { op: "append", field: "tags", values: ["a"] });
		expect(
			await code(run(s, { op: "append", field: "tags", values: ["a"] })),
		).toBe("duplicate");
		expect(
			await code(run(s, { op: "append", field: "tags", values: ["b", "b"] })),
		).toBe("duplicate");
		const other = await s.store.createDocument("task", {
			fields: { title: "o" },
		});
		await run(s, { op: "append", field: "deps", values: [other.id] });
		expect(
			await code(run(s, { op: "append", field: "deps", values: [other.id] })),
		).toBe("duplicate");
	});

	test("validation goes through the field spec", async () => {
		const s = await setup();
		await expect(
			run(s, { op: "append", field: "tags", values: ["zzz"] }),
		).rejects.toBeInstanceOf(InvalidFieldsError);
		await expect(
			run(s, { op: "append", field: "code", values: ["lower"] }),
		).rejects.toBeInstanceOf(InvalidFieldsError);
		expect(
			await code(run(s, { op: "append", field: "deps", values: ["TK-99"] })),
		).toBe("not-found");
		expect(
			await code(run(s, { op: "append", field: "points", values: [1] })),
		).toBe("wrong-kind");
		expect(
			await code(run(s, { op: "append", field: "nope", values: [1] })),
		).toBe("unknown-field");
		expect(
			await code(run(s, { op: "append", field: "labels", values: [] })),
		).toBe("bad-value");
	});

	test("remove errors unless ifPresent; index errors", async () => {
		const s = await setup();
		await run(s, { op: "append", field: "labels", values: ["a"] });
		expect(
			await code(run(s, { op: "remove", field: "labels", value: "z" })),
		).toBe("not-found");
		const r = await applyFieldOpDetailed(s.store, config, "task", s.id, {
			op: "remove",
			field: "labels",
			value: "z",
			ifPresent: true,
		});
		expect(r.changed).toBe(false);
		const rev = r.doc.rev;
		expect((await s.store.readDocument("task", s.id))?.rev).toBe(rev);
		expect(
			await code(
				run(s, { op: "insert", field: "labels", index: 5, values: ["q"] }),
			),
		).toBe("bad-index");
		expect(
			await code(run(s, { op: "move", field: "labels", from: 0, to: 1 })),
		).toBe("bad-index");
	});

	test("two concurrent appends to one list both land", async () => {
		const s = await setup();
		await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				run(s, { op: "append", field: "labels", values: [`l${i}`] }),
			),
		);
		const d = await s.store.readDocument("task", s.id);
		expect((d?.fields.labels as string[]).sort()).toEqual(
			Array.from({ length: 8 }, (_, i) => `l${i}`),
		);
	});
});

describe("scalar ops", () => {
	test("inc / dec / toggle / unset / set", async () => {
		const s = await setup();
		let d = await run(s, { op: "inc", field: "points" });
		expect(d.fields.points).toBe(1);
		d = await run(s, { op: "inc", field: "points", by: 4 });
		d = await run(s, { op: "dec", field: "points", by: 2 });
		expect(d.fields.points).toBe(3);
		d = await run(s, { op: "toggle", field: "urgent" });
		expect(d.fields.urgent).toBe(true);
		d = await run(s, { op: "toggle", field: "urgent" });
		expect(d.fields.urgent).toBe(false);
		d = await run(s, { op: "unset", field: "points" });
		expect(d.fields.points).toBeNull();
		d = await run(s, { op: "set", field: "labels", value: ["z"] });
		expect(d.fields.labels).toEqual(["z"]);
		d = await run(s, { op: "unset", field: "labels" });
		expect(d.fields.labels).toEqual([]);
		expect(await code(run(s, { op: "unset", field: "title" }))).toBe(
			"required",
		);
		expect(await code(run(s, { op: "inc", field: "title" }))).toBe(
			"wrong-kind",
		);
		expect(await code(run(s, { op: "toggle", field: "points" }))).toBe(
			"wrong-kind",
		);
	});

	test("concurrent incs all land", async () => {
		const s = await setup();
		await Promise.all(
			Array.from({ length: 6 }, () => run(s, { op: "inc", field: "points" })),
		);
		expect((await s.store.readDocument("task", s.id))?.fields.points).toBe(6);
	});
});

describe("json rows", () => {
	test("append / set-row / remove-row, rows.required honored", async () => {
		const s = await setup();
		await run(s, { op: "append", field: "log", values: [{ id: "r1", n: 1 }] });
		await expect(
			run(s, { op: "append", field: "log", values: [{ n: 2 }] }),
		).rejects.toBeInstanceOf(InvalidFieldsError);
		expect(
			await code(
				run(s, { op: "append", field: "log", values: [{ id: "r1" }] }),
			),
		).toBe("duplicate");
		let d = await run(s, {
			op: "set-row",
			field: "log",
			id: "r1",
			patch: { n: 5, extra: "x" },
		});
		expect(d.fields.log).toEqual([{ id: "r1", n: 5, extra: "x" }]);
		expect(
			await code(run(s, { op: "set-row", field: "log", id: "zz", patch: {} })),
		).toBe("not-found");
		await expect(
			run(s, { op: "set-row", field: "log", id: "r1", patch: { id: null } }),
		).rejects.toBeInstanceOf(InvalidFieldsError);
		d = await run(s, { op: "remove-row", field: "log", id: "r1" });
		expect(d.fields.log).toEqual([]);
		expect(
			await code(
				run(s, { op: "set-row", field: "labels", id: "a", patch: {} }),
			),
		).toBe("wrong-kind");
	});
});

describe("body ops", () => {
	const now = new Date("2026-01-02T03:04:05.678Z");

	test("note creates the section, then appends under it", async () => {
		const s = await setup();
		let d = await run(s, { op: "note", text: "started" }, { now });
		expect(d.body).toBe("## Progress\n\n### 2026-01-02T03:04:05Z - started");
		d = await run(s, { op: "note", text: "second" }, { now });
		expect(d.body).toBe(
			"## Progress\n\n### 2026-01-02T03:04:05Z - started\n\n### 2026-01-02T03:04:05Z - second",
		);
	});

	test("note goes into the right section and keeps others intact", async () => {
		const s = await setup();
		await s.store.updateDocument("task", s.id, {
			body: "intro\n\n## Progress\n\nold\n\n## Other\n\nkeep\n",
		});
		const d = await run(s, { op: "note", text: "hi" }, { now });
		expect(d.body).toBe(
			"intro\n\n## Progress\n\nold\n\n### 2026-01-02T03:04:05Z - hi\n\n## Other\n\nkeep",
		);
		const e = await run(
			s,
			{ op: "note", text: "n", section: "Other" },
			{ now },
		);
		expect(e.body).toEndWith("keep\n\n### 2026-01-02T03:04:05Z - n");
		const f = await run(
			s,
			{ op: "note", text: "z", section: "Decisions" },
			{ now },
		);
		expect(f.body).toEndWith("## Decisions\n\n### 2026-01-02T03:04:05Z - z");
	});

	test("section-set replaces content, ignores fenced headings", async () => {
		const s = await setup();
		await s.store.updateDocument("task", s.id, {
			body: "## Plan\n\n```\n## Plan\n```\n\n## Done\n\nx\n",
		});
		let d = await run(s, {
			op: "section-set",
			section: "Plan",
			content: "new",
		});
		expect(d.body).toBe("## Plan\n\nnew\n\n## Done\n\nx");
		d = await run(s, { op: "section-set", section: "Fresh", content: "c" });
		expect(d.body).toEndWith("x\n\n## Fresh\n\nc");
		expect(await code(run(s, { op: "note", text: " " }))).toBe("bad-value");
		expect(await code(run(s, { op: "note", text: "a", section: "a\nb" }))).toBe(
			"bad-value",
		);
	});

	test("concurrent notes both land", async () => {
		const s = await setup();
		await Promise.all([
			run(s, { op: "note", text: "one" }),
			run(s, { op: "note", text: "two" }),
		]);
		const d = await s.store.readDocument("task", s.id);
		expect(d?.body).toContain("one");
		expect(d?.body).toContain("two");
	});
});

describe("guards", () => {
	test("hierarchy-managed fields are refused", async () => {
		const s = await setup();
		for (const field of ["children", "parent"]) {
			expect(
				await code(run(s, { op: "append", field, values: ["TK-1"] })),
			).toBe("managed-field");
		}
		expect(
			await code(run(s, { op: "set", field: "parent", value: null })),
		).toBe("managed-field");
	});

	test("baseRev precondition", async () => {
		const s = await setup();
		await run(s, { op: "inc", field: "points" });
		await expect(
			run(s, { op: "inc", field: "points" }, { baseRev: 1 }),
		).rejects.toBeInstanceOf(DocumentConflictError);
		const d = await run(s, { op: "inc", field: "points" }, { baseRev: 2 });
		expect(d.rev).toBe(3);
	});

	test("unknown type and document", async () => {
		const s = await setup();
		await expect(
			applyFieldOp(s.store, config, "nope", "x", { op: "toggle", field: "a" }),
		).rejects.toThrow();
		await expect(
			applyFieldOp(s.store, config, "task", "TK-404", {
				op: "inc",
				field: "points",
			}),
		).rejects.toThrow(/not found/);
	});
});
