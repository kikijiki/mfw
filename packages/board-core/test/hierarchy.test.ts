import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BoardConfig, parseBoardConfig } from "../src/config.ts";
import { renderDocument } from "../src/document.ts";
import { BoardStore, HierarchyError } from "../src/store.ts";

const dirs: string[] = [];
async function freshRoot(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "board-core-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true });
});

function configWith(hierarchy: Record<string, unknown>): BoardConfig {
	const seq = { strategy: "own-sequence", sequence: "cards" };
	return parseBoardConfig({
		mfw: 1,
		types: {
			epic: {
				layout: "flat",
				dir: "epics",
				id: { ...seq, key: "EP" },
				fields: {
					title: { optional: true },
					parent: { ref: ["epic", "task"], optional: true },
					children: { ref: ["epic", "task"], list: true },
				},
			},
			task: {
				layout: "flat",
				dir: "tasks",
				id: { ...seq, key: "EP" },
				fields: {
					title: { optional: true },
					parent: { ref: ["epic", "task"], optional: true },
					children: { ref: ["task"], list: true },
				},
			},
			bug: {
				layout: "flat",
				dir: "bugs",
				id: { ...seq, key: "EP" },
				fields: {
					parent: { ref: ["epic"], optional: true },
					children: { ref: ["bug"], list: true },
				},
			},
			note: {
				layout: "flat",
				dir: "notes",
				id: { ...seq, key: "EP" },
				fields: { title: { optional: true } },
			},
		},
		hierarchy: { parent: "parent", children: "children", ...hierarchy },
	});
}

const RULES = {
	rules: [
		{ child: "task", parents: ["epic", "task"] },
		{ child: "epic", parents: ["epic"] },
	],
};

async function store(hierarchy: Record<string, unknown> = RULES) {
	const config = configWith(hierarchy);
	return { store: new BoardStore(await freshRoot(), config), config };
}

const kids = async (s: BoardStore, type: string, id: string) =>
	((await s.readDocument(type, id))?.fields.children as string[]) ?? [];

async function count(s: BoardStore, type: string) {
	return (await s.listDocuments(type)).length;
}

/** Bypass the store's guards to fabricate a hand-edited (desynced) board. */
async function force(
	s: BoardStore,
	config: BoardConfig,
	type: string,
	id: string,
	fields: Record<string, unknown>,
) {
	const doc = await s.readDocument(type, id);
	if (!doc) throw new Error("no doc");
	await writeFile(
		doc.path,
		renderDocument(config.types[type] as never, {
			...doc,
			fields: { ...doc.fields, ...fields },
		}),
	);
}

const messages = async (s: BoardStore) =>
	(await s.validate()).map((i) => `${i.id}: ${i.message}`);

describe("hierarchy: children are always refreshed from the parent fields", () => {
	test("any mutation touching a parent heals a hand-desynced children list", async () => {
		const { store: s, config } = await store();
		const e = await s.createDocument("epic", { fields: {} });
		const a = await s.createDocument("task", { fields: { parent: e.id } });
		// hand edit: a stale id in the list, and a missing child
		const b = await s.createDocument("task", { fields: {} });
		await force(s, config, "task", b.id, { parent: e.id });
		await force(s, config, "epic", e.id, { children: [a.id, "EP-99"] });
		expect((await messages(s)).length).toBeGreaterThan(0);
		// creating one more child under e rewrites the list from the truth
		const c = await s.createDocument("task", { fields: { parent: e.id } });
		expect(await kids(s, "epic", e.id)).toEqual([a.id, b.id, c.id]);
		expect(await s.validate()).toEqual([]);
	});

	test("repairHierarchy rebuilds every parent's list, keeps order, reports changes", async () => {
		const { store: s, config } = await store();
		const e1 = await s.createDocument("epic", { fields: {} });
		const e2 = await s.createDocument("epic", { fields: {} });
		const t1 = await s.createDocument("task", { fields: { parent: e1.id } });
		const t2 = await s.createDocument("task", { fields: {} });
		const t3 = await s.createDocument("task", { fields: {} });
		await force(s, config, "task", t2.id, { parent: e2.id });
		await force(s, config, "task", t3.id, { parent: e1.id });
		await force(s, config, "epic", e2.id, { children: ["GONE"] });
		const changed = await s.repairHierarchy();
		expect(changed.map((c) => c.id).sort()).toEqual([e1.id, e2.id].sort());
		expect(await kids(s, "epic", e1.id)).toEqual([t1.id, t3.id]);
		expect(await kids(s, "epic", e2.id)).toEqual([t2.id]);
		expect(await s.validate()).toEqual([]);
		expect(await s.repairHierarchy()).toEqual([]); // idempotent
	});

	test("repairHierarchy on a board without a hierarchy is refused", async () => {
		const s = new BoardStore(await freshRoot(), {
			...configWith({}),
			hierarchy: undefined,
		} as never);
		await expect(s.repairHierarchy()).rejects.toMatchObject({
			code: "no-hierarchy",
		});
	});
});

describe("hierarchy: create", () => {
	test("creating under a parent appends to its children, preserving order", async () => {
		const { store: s } = await store();
		const e = await s.createDocument("epic", { fields: {} });
		const a = await s.createDocument("task", { fields: { parent: e.id } });
		const b = await s.createDocument("task", { fields: { parent: e.id } });
		const sub = await s.createDocument("epic", { fields: { parent: e.id } });
		expect(await kids(s, "epic", e.id)).toEqual([a.id, b.id, sub.id]);
		expect(await s.validate()).toEqual([]);
	});

	test("a missing parent is refused and nothing is written", async () => {
		const { store: s } = await store();
		const err = await s
			.createDocument("task", { fields: { parent: "EP-99" } })
			.catch((e) => e);
		expect(err).toBeInstanceOf(HierarchyError);
		expect(err.code).toBe("parent-not-found");
		expect(await count(s, "task")).toBe(0);
	});

	test("rules: a disallowed parent type, or a type with no rule, is refused", async () => {
		const { store: s } = await store();
		const e = await s.createDocument("epic", { fields: {} });
		const t = await s.createDocument("task", { fields: { parent: e.id } });
		// epic's only allowed parent type is epic, not task
		await expect(
			s.createDocument("epic", { fields: { parent: t.id } }),
		).rejects.toMatchObject({ code: "parent-type-not-allowed" });
		// bug has a parent field but no rule entry: no parent at all
		await expect(
			s.createDocument("bug", { fields: { parent: e.id } }),
		).rejects.toMatchObject({
			code: "parent-type-not-allowed",
			message: expect.stringContaining("may not have a parent"),
		});
		expect(await count(s, "bug")).toBe(0);
		expect(await kids(s, "epic", e.id)).toEqual([t.id]);
		// ...but a parentless bug is fine
		await s.createDocument("bug", { fields: {} });
	});

	test("an explicit empty parents rule refuses any parent with the same message", async () => {
		const { store: s } = await store({
			rules: [
				{ child: "task", parents: ["epic"] },
				{ child: "epic", parents: [] },
			],
		});
		const e = await s.createDocument("epic", { fields: {} });
		await expect(
			s.createDocument("epic", { fields: { parent: e.id } }),
		).rejects.toMatchObject({
			code: "parent-type-not-allowed",
			message: expect.stringContaining("may not have a parent"),
		});
		await s.createDocument("task", { fields: { parent: e.id } });
	});

	test("without rules, any ref-allowed parent type works", async () => {
		const { store: s } = await store({});
		const e = await s.createDocument("epic", { fields: {} });
		const bug = await s.createDocument("bug", { fields: { parent: e.id } });
		expect(await kids(s, "epic", e.id)).toEqual([bug.id]);
	});

	test("maxDepth bounds the parent chain", async () => {
		const { store: s } = await store({ ...RULES, maxDepth: 2 });
		const e = await s.createDocument("epic", { fields: {} });
		const t1 = await s.createDocument("task", { fields: { parent: e.id } });
		const t2 = await s.createDocument("task", { fields: { parent: t1.id } });
		await expect(
			s.createDocument("task", { fields: { parent: t2.id } }),
		).rejects.toMatchObject({ code: "max-depth" });
		expect(await count(s, "task")).toBe(2);
		expect(await kids(s, "task", t2.id)).toEqual([]);
	});

	test("hand-written children must match reality", async () => {
		const { store: s } = await store();
		await expect(
			s.createDocument("epic", { fields: { children: ["EP-7"] } }),
		).rejects.toMatchObject({ code: "children-mismatch" });
		expect(await count(s, "epic")).toBe(0);
	});

	test("eight concurrent creates under one parent all land in its children", async () => {
		const { store: s } = await store();
		const e = await s.createDocument("epic", { fields: {} });
		const made = await Promise.all(
			Array.from({ length: 8 }, () =>
				s.createDocument("task", { fields: { parent: e.id } }),
			),
		);
		expect([...(await kids(s, "epic", e.id))].sort()).toEqual(
			made.map((d) => d.id).sort(),
		);
		expect(await s.validate()).toEqual([]);
	});
});

describe("hierarchy: re-parenting", () => {
	test("setParent moves a document between parents and detaches with null", async () => {
		const { store: s } = await store();
		const e1 = await s.createDocument("epic", { fields: {} });
		const e2 = await s.createDocument("epic", { fields: {} });
		const t = await s.createDocument("task", { fields: { parent: e1.id } });
		await s.setParent("task", t.id, e2.id);
		expect(await kids(s, "epic", e1.id)).toEqual([]);
		expect(await kids(s, "epic", e2.id)).toEqual([t.id]);
		expect((await s.readDocument("task", t.id))?.fields.parent).toBe(e2.id);
		await s.setParent("task", t.id, null);
		expect(await kids(s, "epic", e2.id)).toEqual([]);
		expect((await s.readDocument("task", t.id))?.fields.parent).toBeNull();
		expect(await s.validate()).toEqual([]);
	});

	test("updateDocument changing parent re-parents, alongside other field edits", async () => {
		const { store: s } = await store();
		const e1 = await s.createDocument("epic", { fields: {} });
		const e2 = await s.createDocument("epic", { fields: {} });
		const t = await s.createDocument("task", { fields: { parent: e1.id } });
		const next = await s.updateDocument("task", t.id, {
			fields: { parent: e2.id, title: "moved" },
		});
		expect(next.fields.title).toBe("moved");
		expect(await kids(s, "epic", e1.id)).toEqual([]);
		expect(await kids(s, "epic", e2.id)).toEqual([t.id]);
		expect(await s.validate()).toEqual([]);
	});

	test("refuses a cycle, a bad type, an unknown parent, and a deep subtree", async () => {
		const { store: s } = await store({ ...RULES, maxDepth: 2 });
		const e1 = await s.createDocument("epic", { fields: {} });
		const e2 = await s.createDocument("epic", { fields: { parent: e1.id } });
		const t = await s.createDocument("task", { fields: { parent: e2.id } });
		await expect(s.setParent("epic", e1.id, e2.id)).rejects.toMatchObject({
			code: "cycle",
		});
		await expect(s.setParent("epic", e1.id, e1.id)).rejects.toMatchObject({
			code: "cycle",
		});
		await expect(s.setParent("epic", e2.id, t.id)).rejects.toMatchObject({
			code: "parent-type-not-allowed",
		});
		await expect(s.setParent("task", t.id, "EP-99")).rejects.toMatchObject({
			code: "parent-not-found",
		});
		// a new root epic, moving e1 (which carries a 2-deep subtree) under it
		// would make a 3-long chain
		const root = await s.createDocument("epic", { fields: {} });
		await expect(s.setParent("epic", e1.id, root.id)).rejects.toMatchObject({
			code: "max-depth",
		});
		expect(await kids(s, "epic", root.id)).toEqual([]);
		expect((await s.readDocument("epic", e1.id))?.fields.parent).toBeNull();
		expect(await s.validate()).toEqual([]);
	});

	test("setParent on a type outside the hierarchy is a typed error", async () => {
		const { store: s } = await store();
		const n = await s.createDocument("note", { fields: {} });
		await expect(s.setParent("note", n.id, null)).rejects.toMatchObject({
			code: "no-hierarchy",
		});
	});

	test("children may be reordered but not hand-edited out of sync", async () => {
		const { store: s } = await store();
		const e = await s.createDocument("epic", { fields: {} });
		const a = await s.createDocument("task", { fields: { parent: e.id } });
		const b = await s.createDocument("task", { fields: { parent: e.id } });
		await s.updateDocument("epic", e.id, {
			fields: { children: [b.id, a.id] },
		});
		expect(await kids(s, "epic", e.id)).toEqual([b.id, a.id]);
		await expect(
			s.updateDocument("epic", e.id, { fields: { children: [a.id] } }),
		).rejects.toMatchObject({ code: "children-mismatch" });
		await expect(
			s.updateDocument("epic", e.id, {
				fields: { children: [a.id, b.id, "EP-40"] },
			}),
		).rejects.toMatchObject({ code: "children-mismatch" });
		expect(await kids(s, "epic", e.id)).toEqual([b.id, a.id]);
	});

	test("transact cannot change parent/children behind the relation's back", async () => {
		const { store: s } = await store();
		const e = await s.createDocument("epic", { fields: {} });
		const t = await s.createDocument("task", { fields: {} });
		await expect(
			s.transact("task", t.id, async () => ({ fields: { parent: e.id } })),
		).rejects.toMatchObject({ code: "direct-write" });
		// unrelated patches (and re-stating the same value) still work
		const ok = await s.transact("task", t.id, async () => ({
			fields: { title: "x", parent: null },
		}));
		expect(ok?.fields.title).toBe("x");
	});

	test("concurrent opposing re-parents settle without deadlock or desync", async () => {
		const { store: s } = await store();
		const a = await s.createDocument("epic", { fields: {} });
		const b = await s.createDocument("epic", { fields: {} });
		const t = await s.createDocument("task", { fields: { parent: a.id } });
		const results = await Promise.allSettled([
			s.setParent("epic", a.id, b.id),
			s.setParent("epic", b.id, a.id),
			s.setParent("task", t.id, b.id),
			s.setParent("task", t.id, a.id),
			s.createDocument("task", { fields: { parent: a.id } }),
			s.createDocument("task", { fields: { parent: b.id } }),
		]);
		for (const r of results) {
			if (r.status === "rejected")
				expect(r.reason).toBeInstanceOf(HierarchyError);
		}
		expect(await s.validate()).toEqual([]);
	});
});

describe("hierarchy: delete", () => {
	test("delete removes the document from its parent's children", async () => {
		const { store: s } = await store();
		const e = await s.createDocument("epic", { fields: {} });
		const a = await s.createDocument("task", { fields: { parent: e.id } });
		const b = await s.createDocument("task", { fields: { parent: e.id } });
		expect(await s.deleteDocument("task", a.id)).toBe(true);
		expect(await kids(s, "epic", e.id)).toEqual([b.id]);
		expect(await s.validate()).toEqual([]);
	});

	test("a document that still has children cannot be deleted", async () => {
		const { store: s } = await store();
		const e = await s.createDocument("epic", { fields: {} });
		const a = await s.createDocument("task", { fields: { parent: e.id } });
		await expect(s.deleteDocument("epic", e.id)).rejects.toMatchObject({
			code: "has-children",
		});
		expect(await count(s, "epic")).toBe(1);
		await s.deleteDocument("task", a.id);
		expect(await s.deleteDocument("epic", e.id)).toBe(true);
	});

	test("wipeType deletes a hierarchy leaf-first", async () => {
		const { store: s } = await store();
		const e = await s.createDocument("epic", { fields: {} });
		const sub = await s.createDocument("epic", { fields: { parent: e.id } });
		await s.createDocument("epic", { fields: { parent: sub.id } });
		expect((await s.wipeType("epic")).length).toBe(3);
		expect(
			await readdir(join((s as never as { root: string }).root, "epics")),
		).toEqual([]);
	});
});

describe("hierarchy: validate()", () => {
	test("reports a child naming a parent that does not list it, and the reverse", async () => {
		const { store: s, config } = await store();
		const e = await s.createDocument("epic", { fields: {} });
		const t = await s.createDocument("task", { fields: { parent: e.id } });
		const t2 = await s.createDocument("task", { fields: {} });
		await force(s, config, "epic", e.id, { children: [] });
		await force(s, config, "epic", e.id, { children: [t2.id] });
		const msgs = await messages(s);
		expect(msgs).toContainEqual(
			`${t.id}: names '${e.id}' as its parent, but '${e.id}' does not list it in 'children'`,
		);
		expect(msgs).toContainEqual(
			`${e.id}: lists '${t2.id}' in 'children', but its parent is unset`,
		);
	});

	test("reports a rules violation and an exceeded maxDepth", async () => {
		const { store: s, config } = await store({ ...RULES, maxDepth: 1 });
		const e = await s.createDocument("epic", { fields: {} });
		const t = await s.createDocument("task", { fields: { parent: e.id } });
		const bug = await s.createDocument("bug", { fields: {} });
		await force(s, config, "bug", bug.id, { parent: e.id });
		await force(s, config, "epic", e.id, { children: [t.id, bug.id] });
		const t2 = await s.createDocument("task", { fields: {} });
		await force(s, config, "task", t2.id, { parent: t.id });
		await force(s, config, "task", t.id, { children: [t2.id] });
		const msgs = await messages(s);
		expect(msgs).toContainEqual(`${bug.id}: a 'bug' may not have a parent`);
		expect(msgs).toContainEqual(
			`${t2.id}: parent chain is 2 deep, over maxDepth 1`,
		);
	});

	test("reports a cycle in the parent chain", async () => {
		const { store: s, config } = await store();
		const a = await s.createDocument("epic", { fields: {} });
		const b = await s.createDocument("epic", { fields: {} });
		await force(s, config, "epic", a.id, { parent: b.id, children: [b.id] });
		await force(s, config, "epic", b.id, { parent: a.id, children: [a.id] });
		const msgs = await messages(s);
		expect(msgs.some((m) => m.includes("parent chain has a cycle"))).toBe(true);
	});

	test("a clean hierarchy validates with no issues", async () => {
		const { store: s } = await store({ ...RULES, maxDepth: 3 });
		const e = await s.createDocument("epic", { fields: {} });
		await s.createDocument("task", { fields: { parent: e.id } });
		expect(await s.validate()).toEqual([]);
	});
});

// One `task` document type whose KIND is a frontmatter field: the rules match on
// the field's value, not on separate document types in separate directories.
function kindConfig(rules: unknown[]): BoardConfig {
	return parseBoardConfig({
		mfw: 1,
		types: {
			task: {
				layout: "flat",
				dir: "tasks",
				id: { strategy: "own-sequence", key: "KT", pad: 3 },
				fields: {
					title: { optional: true },
					kind: { values: ["epic", "task", "subtask", "bug"], default: "task" },
					parent: { ref: "task", optional: true },
					children: { ref: "task", list: true, optional: true },
				},
			},
		},
		hierarchy: { parent: "parent", children: "children", rules },
	});
}

const KIND_RULES = [
	{ child: { type: "task", where: { kind: "epic" } }, parents: [] },
	{
		child: { type: "task", where: { kind: ["task", "bug"] } },
		parents: [{ type: "task", where: { kind: "epic" } }],
	},
	{
		child: { type: "task", where: { kind: "subtask" } },
		parents: [{ type: "task", where: { kind: ["task", "bug"] } }],
	},
];

describe("hierarchy: rules matched on a field's value", () => {
	async function kstore(rules: unknown[] = KIND_RULES) {
		const config = kindConfig(rules);
		return { store: new BoardStore(await freshRoot(), config), config };
	}
	const mk = (s: BoardStore, kind: string, parent?: string) =>
		s.createDocument("task", {
			fields: { kind, ...(parent ? { parent } : {}) },
		});

	test("one document type, kinds nest as the rules say", async () => {
		const { store: s } = await kstore();
		const epic = await mk(s, "epic");
		const task = await mk(s, "task", epic.id);
		const bug = await mk(s, "bug", epic.id);
		const sub = await mk(s, "subtask", task.id);
		expect(await kids(s, "task", epic.id)).toEqual([task.id, bug.id]);
		expect(await kids(s, "task", task.id)).toEqual([sub.id]);
		expect(await s.validate()).toEqual([]);
	});

	test("a parent of the wrong kind is refused with the rule in the message", async () => {
		const { store: s } = await kstore();
		const epic = await mk(s, "epic");
		const task = await mk(s, "task", epic.id);
		// subtask directly under an epic, task under a task, epic under anything
		await expect(mk(s, "subtask", epic.id)).rejects.toMatchObject({
			code: "parent-type-not-allowed",
			message: expect.stringContaining("subtask"),
		});
		await expect(mk(s, "task", task.id)).rejects.toMatchObject({
			code: "parent-type-not-allowed",
		});
		await expect(mk(s, "epic", epic.id)).rejects.toMatchObject({
			code: "parent-type-not-allowed",
			message: expect.stringContaining("may not have a parent"),
		});
		// nothing was written for the refused ones
		expect((await s.listDocuments("task")).length).toBe(2);
	});

	test("reparenting and kind changes are checked against the rules", async () => {
		const { store: s } = await kstore();
		const epic = await mk(s, "epic");
		const task = await mk(s, "task", epic.id);
		const sub = await mk(s, "subtask", task.id);
		await expect(s.setParent("task", sub.id, epic.id)).rejects.toMatchObject({
			code: "parent-type-not-allowed",
		});
		// the task cannot become a subtask while it has a subtask child, nor an
		// epic while it has a parent
		await expect(
			s.updateDocument("task", task.id, { fields: { kind: "subtask" } }),
		).rejects.toMatchObject({ code: "parent-type-not-allowed" });
		await expect(
			s.updateDocument("task", task.id, { fields: { kind: "epic" } }),
		).rejects.toMatchObject({ code: "parent-type-not-allowed" });
		expect((await s.readDocument("task", task.id))?.fields.kind).toBe("task");
		// a kind change that still fits is fine (task -> bug keeps the subtask valid)
		await s.updateDocument("task", task.id, { fields: { kind: "bug" } });
		expect(await s.validate()).toEqual([]);
	});

	test("validate() reports hand-edited kind/parent combinations that break a rule", async () => {
		const { store: s, config } = await kstore();
		const epic = await mk(s, "epic");
		const task = await mk(s, "task", epic.id);
		await force(s, config, "task", task.id, { kind: "epic" });
		expect((await messages(s)).join("\n")).toContain("may not have a parent");
	});

	test("config: where fields must be single-valued enum/string fields with valid values", () => {
		const bad = (rules: unknown[]) => () => kindConfig(rules);
		expect(
			bad([{ child: { type: "task", where: { nope: "x" } }, parents: [] }]),
		).toThrow(/'where' field 'nope'/);
		expect(
			bad([{ child: { type: "task", where: { kind: "saga" } }, parents: [] }]),
		).toThrow(/'saga' is not a value of 'kind'/);
		expect(
			bad([
				{ child: { type: "task", where: { kind: "epic" } }, parents: [] },
				{ child: { type: "task", where: { kind: "epic" } }, parents: [] },
			]),
		).toThrow(/more than one rule/);
	});
});
