import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBoardConfig } from "../src/config.ts";
import { BoardStore, InvalidFieldsError } from "../src/store.ts";

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

const type = (dir: string, fields: Record<string, unknown>, key: string) => ({
	layout: "flat",
	dir,
	id: { strategy: "own-sequence", key },
	fields,
});

describe("ref unions", () => {
	const config = parseBoardConfig({
		mfw: 1,
		types: {
			epic: type("epics", { title: {} }, "EP"),
			task: type("tasks", { title: {} }, "TK"),
			note: type(
				"notes",
				{
					about: { ref: ["epic", "task"], optional: true },
					abouts: { ref: ["epic", "task"], list: true },
					only: { ref: "epic", optional: true },
				},
				"NT",
			),
		},
	});

	test("a ref resolves if the id exists in ANY listed type; otherwise it dangles", async () => {
		const store = new BoardStore(await freshRoot(), config);
		await store.createDocument("epic", { fields: { title: "e" } });
		await store.createDocument("task", { fields: { title: "t" } });
		await store.createDocument("note", {
			fields: { about: "TK-1", abouts: ["EP-1", "TK-1"] },
		});
		expect(await store.validate()).toEqual([]);
		await store.createDocument("note", {
			fields: { about: "NT-1", abouts: ["EP-9"], only: "TK-1" },
		});
		const messages = (await store.validate()).map((i) => i.message);
		expect(messages).toContain(
			"field 'about' references unknown epic/task 'NT-1'",
		);
		expect(messages).toContain(
			"field 'abouts' references unknown epic/task 'EP-9'",
		);
		// a single-type ref still names just that type
		expect(messages).toContain("field 'only' references unknown epic 'TK-1'");
	});
});

describe("missing required field message", () => {
	test("says which field is required and that it has no default", async () => {
		const config = parseBoardConfig({
			mfw: 1,
			types: { t: type("t", { priority: { values: ["P0", "P1"] } }, "TT") },
		});
		const store = new BoardStore(await freshRoot(), config);
		await expect(store.createDocument("t", { fields: {} })).rejects.toThrow(
			"missing required field 'priority' (no default; pass priority=...)",
		);
	});
});

describe("required_when", () => {
	const config = parseBoardConfig({
		mfw: 1,
		types: {
			t: type(
				"t",
				{
					status: { values: ["open", "blocked", "dropped"], default: "open" },
					reason: {
						required_when: { status: ["blocked", "dropped"] },
						optional: true,
					},
					steps: { required_when: { status: "blocked" }, list: true },
				},
				"TT",
			),
		},
	});

	test("optional while the condition is false, required once it holds", async () => {
		const store = new BoardStore(await freshRoot(), config);
		const doc = await store.createDocument("t", { fields: {} });
		expect(doc.fields.reason).toBeNull();
		await expect(
			store.updateDocument("t", doc.id, { fields: { status: "blocked" } }),
		).rejects.toThrow(InvalidFieldsError);
		await expect(
			store.updateDocument("t", doc.id, { fields: { status: "dropped" } }),
		).rejects.toThrow(
			"missing required field 'reason': required when 'status' is blocked or dropped (no default; pass reason=...)",
		);
		const ok = await store.updateDocument("t", doc.id, {
			fields: { status: "dropped", reason: "obsolete" },
		});
		expect(ok.fields.reason).toBe("obsolete");
	});

	test("a list field counts as missing when empty, and validate() enforces it", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, config);
		await expect(
			store.createDocument("t", {
				fields: { status: "blocked", reason: "x", steps: [] },
			}),
		).rejects.toThrow(/missing required field 'steps'/);
		await store.createDocument("t", {
			fields: { status: "blocked", reason: "x", steps: ["a"] },
		});
		expect(await store.validate()).toEqual([]);
		// hand-edit the file so the condition holds without the field
		const { writeFile, readFile } = await import("node:fs/promises");
		const doc = (await store.listDocuments("t"))[0];
		const raw = await readFile(doc?.path as string, "utf8");
		await writeFile(doc?.path as string, raw.replace(/reason: x\n/, ""));
		const issues = await store.validate();
		expect(issues.map((i) => i.message).join()).toContain(
			"missing required field 'reason'",
		);
	});
});

describe("rows.required", () => {
	const config = parseBoardConfig({
		mfw: 1,
		types: {
			t: type(
				"t",
				{
					checklist: {
						type: "json",
						list: true,
						rows: { required: ["id", "text"] },
					},
				},
				"TT",
			),
		},
	});

	test("every row must be an object carrying the required keys", async () => {
		const store = new BoardStore(await freshRoot(), config);
		const ok = await store.createDocument("t", {
			fields: { checklist: [{ id: "a", text: "x", done: true }] },
		});
		expect(ok.fields.checklist).toHaveLength(1);
		await expect(
			store.createDocument("t", {
				fields: { checklist: [{ id: "a", text: "x" }, { id: "b" }] },
			}),
		).rejects.toThrow("row 2 is missing required key(s) 'text'");
		await expect(
			store.createDocument("t", { fields: { checklist: ["nope"] } }),
		).rejects.toThrow("row 1 must be an object");
		await store.createDocument("t", { fields: {} }); // an empty list is fine
	});
});

describe("pattern anchoring", () => {
	const config = parseBoardConfig({
		mfw: 1,
		types: {
			t: type(
				"ts",
				{
					loose: { pattern: "[a-z]+", optional: true },
					anch: { pattern: "^R\\d{3}-\\d{3}$", optional: true },
				},
				"TT",
			),
		},
	});

	test("an unanchored pattern must match the whole value", async () => {
		const store = new BoardStore(await freshRoot(), config);
		await expect(
			store.createDocument("t", { fields: { loose: "abc123!!" } }),
		).rejects.toBeInstanceOf(InvalidFieldsError);
		await store.createDocument("t", { fields: { loose: "abc" } });
	});

	test("an already-anchored pattern keeps working", async () => {
		const store = new BoardStore(await freshRoot(), config);
		await store.createDocument("t", { fields: { anch: "R001-002" } });
		await expect(
			store.createDocument("t", { fields: { anch: "xR001-002" } }),
		).rejects.toBeInstanceOf(InvalidFieldsError);
	});

	test("an alternation is anchored as a whole", async () => {
		const c = parseBoardConfig({
			mfw: 1,
			types: { t: type("ts", { f: { pattern: "a|b", optional: true } }, "TT") },
		});
		const store = new BoardStore(await freshRoot(), c);
		await expect(
			store.createDocument("t", { fields: { f: "ab" } }),
		).rejects.toBeInstanceOf(InvalidFieldsError);
		await store.createDocument("t", { fields: { f: "b" } });
	});
});
