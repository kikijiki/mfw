import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBoardConfig } from "../src/config.ts";
import {
	BoardStore,
	DocumentConflictError,
	DocumentExistsError,
	DocumentNotFoundError,
	InvalidFieldsError,
	InvalidIdError,
} from "../src/store.ts";

const CONFIG = parseBoardConfig({
	mfw: 1,
	types: {
		task: {
			layout: "flat",
			dir: "tasks",
			id: { strategy: "own-sequence", key: "TK" },
			slugFrom: "title",
			fields: {
				title: {},
				status: { values: ["planned", "doing", "done"], default: "planned" },
				assignee: { ref: "task", optional: true },
				dependencies: {
					ref: "task",
					list: true,
					acyclic: true,
					optional: true,
				},
			},
		},
		spec: {
			layout: "flat",
			dir: "specs",
			id: { strategy: "inherit", from: "task" },
			fields: {
				status: { values: ["active", "archived"], default: "active" },
			},
		},
		// mfw-shaped: directory layout with a sibling, for layout coverage.
		card: {
			layout: "directory",
			dir: "cards",
			primary: "card.md",
			siblings: ["notes.md"],
			id: { strategy: "own-sequence", key: "MFW" },
			slugFrom: "title",
			fields: {
				title: {},
				status: { values: ["backlog", "doing", "done"], default: "backlog" },
			},
		},
	},
});

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

describe("BoardStore: flat layout", () => {
	test("create allocates an own-sequence id and writes a flat file with a frozen slug", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const doc = await store.createDocument("task", {
			fields: { title: "Wire the thing up" },
		});
		expect(doc.id).toBe("TK-1");
		expect(doc.path).toBe(join(root, "tasks", "TK-1-wire-the-thing-up.md"));
		const raw = await readFile(doc.path, "utf8");
		expect(raw).toContain("mfw: 1");
		expect(raw).toContain("id: TK-1");
		expect(raw).not.toContain("status:"); // default value is quiet

		// Retitling does NOT move the file: the path is frozen at creation.
		const updated = await store.updateDocument("task", doc.id, {
			fields: { title: "Renamed" },
		});
		expect(updated.path).toBe(doc.path);
		expect(await readFile(doc.path, "utf8")).toContain("title: Renamed");
	});

	test("ids increment and are never reused, even after the counter file is lost", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		await store.createDocument("task", { fields: { title: "first" } });
		await rm(join(root, ".board", "state"), { recursive: true, force: true });
		const second = await store.createDocument("task", {
			fields: { title: "second" },
		});
		expect(second.id).toBe("TK-2");
	});

	test("eight concurrent creates get eight distinct ids", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const docs = await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				store.createDocument("task", { fields: { title: `t${i}` } }),
			),
		);
		expect(new Set(docs.map((d) => d.id)).size).toBe(8);
	});

	test("id.pad zero-pads generated ids, and overflow past the width just widens", async () => {
		const root = await freshRoot();
		const config = parseBoardConfig({
			mfw: 1,
			types: {
				task: {
					layout: "flat",
					dir: "tasks",
					id: { strategy: "own-sequence", key: "WH", pad: 4 },
					slugFrom: "title",
					fields: { title: {} },
				},
			},
		});
		const store = new BoardStore(root, config);
		const first = await store.createDocument("task", {
			fields: { title: "first" },
		});
		expect(first.id).toBe("WH-0001");
		// An id imported with an explicit, already-padded value reconciles the
		// sequence correctly (parsing never requires the configured pad).
		await store.createDocument("task", {
			id: "WH-0741",
			fields: { title: "imported" },
		});
		const next = await store.createDocument("task", {
			fields: { title: "next" },
		});
		expect(next.id).toBe("WH-0742");
	});

	test("a pre-existing zero-padded id reconciles the sequence even with no pad configured", async () => {
		// The id grammar always accepts leading zeros regardless of `pad` -
		// a project can carry already-padded ids without declaring `pad` at all.
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		await store.createDocument("task", {
			id: "TK-0007",
			fields: { title: "legacy padded id" },
		});
		const next = await store.createDocument("task", {
			fields: { title: "next" },
		});
		expect(next.id).toBe("TK-8");
	});

	test("update rejects a stale baseRev instead of overwriting", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const doc = await store.createDocument("task", {
			fields: { title: "guarded" },
		});
		await store.updateDocument("task", doc.id, { fields: { status: "doing" } });
		await expect(
			store.updateDocument(
				"task",
				doc.id,
				{ fields: { status: "done" } },
				{ baseRev: doc.rev },
			),
		).rejects.toBeInstanceOf(DocumentConflictError);
	});

	test("update on an unknown id fails clearly", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		await expect(
			store.updateDocument("task", "TK-99", {}),
		).rejects.toBeInstanceOf(DocumentNotFoundError);
	});

	test("create refuses an unknown field and a bad enum value", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		await expect(
			store.createDocument("task", { fields: { title: "x", bogus: "y" } }),
		).rejects.toBeInstanceOf(InvalidFieldsError);
		await expect(
			store.createDocument("task", {
				fields: { title: "x", status: "not-a-status" },
			}),
		).rejects.toBeInstanceOf(InvalidFieldsError);
	});

	test("create with an explicit id that already exists is refused", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		await store.createDocument("task", {
			id: "TK-5",
			fields: { title: "a" },
		});
		await expect(
			store.createDocument("task", { id: "TK-5", fields: { title: "b" } }),
		).rejects.toBeInstanceOf(DocumentExistsError);
	});

	test("a loose .md file with no mfw marker is never listed", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		await store.createDocument("task", { fields: { title: "real" } });
		const { mkdir, writeFile } = await import("node:fs/promises");
		await mkdir(join(root, "tasks"), { recursive: true });
		await writeFile(
			join(root, "tasks", "README.md"),
			"# Not a task\n\njust notes\n",
		);
		const list = await store.listDocuments("task");
		expect(list).toHaveLength(1);
	});

	test("inherit strategy: a spec borrows its task's id and must reference an existing one", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const task = await store.createDocument("task", {
			fields: { title: "needs a spec" },
		});
		const spec = await store.createDocument("spec", {
			id: task.id,
			fields: {},
		});
		expect(spec.id).toBe(task.id);
		await expect(
			store.createDocument("spec", { id: "TK-999", fields: {} }),
		).rejects.toThrow(/no 'task' document/);
	});

	test("list filters by field value", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const a = await store.createDocument("task", { fields: { title: "a" } });
		await store.updateDocument("task", a.id, { fields: { status: "done" } });
		await store.createDocument("task", { fields: { title: "b" } });
		expect(await store.listDocuments("task", { status: "done" })).toHaveLength(
			1,
		);
		expect(
			await store.listDocuments("task", { status: "planned" }),
		).toHaveLength(1);
	});
});

describe("BoardStore: YAML rendering style (R3)", () => {
	const STYLE_CONFIG = parseBoardConfig({
		mfw: 1,
		types: {
			task: {
				layout: "flat",
				dir: "tasks",
				id: { strategy: "own-sequence", key: "TK" },
				fields: {
					title: {},
					labels: { list: true, optional: true },
					sources: { list: true, optional: true },
					acceptance: { type: "json", optional: true },
				},
			},
		},
	});

	test("a short scalar list renders flow-style, on one line", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, STYLE_CONFIG);
		const doc = await store.createDocument("task", {
			fields: { title: "x", labels: ["hitl", "research"] },
		});
		const raw = await readFile(doc.path, "utf8");
		expect(raw).toContain("labels: [hitl, research]");
		expect(raw).not.toContain("[ ");
	});

	test("a long scalar list renders block-style, one item per line", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, STYLE_CONFIG);
		const many = Array.from(
			{ length: 10 },
			(_, i) => `crates/tk-serve/src/very/long/module/path/${i}.rs`,
		);
		const doc = await store.createDocument("task", {
			fields: { title: "x", sources: many },
		});
		const raw = await readFile(doc.path, "utf8");
		expect(raw).toContain("sources:\n  - crates/tk-serve");
		expect(raw).not.toContain("sources: [");
	});

	test("a type: json list of objects always renders block-style, never one giant line", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, STYLE_CONFIG);
		const doc = await store.createDocument("task", {
			fields: {
				title: "x",
				acceptance: [
					{ id: "SC-001", text: "a".repeat(80) },
					{ id: "SC-002", text: "short" },
				],
			},
		});
		const raw = await readFile(doc.path, "utf8");
		expect(raw).toContain("acceptance:\n  - id: SC-001");
		expect(raw).not.toContain("acceptance: [");
		// round-trips correctly regardless of rendering style
		const reread = await store.readDocument("task", doc.id);
		expect(reread?.fields.acceptance).toEqual([
			{ id: "SC-001", text: "a".repeat(80) },
			{ id: "SC-002", text: "short" },
		]);
	});
});

describe("BoardStore: keyed ids, padding, shared sequences (R1/R2)", () => {
	test("pad zero-pads the number after the key", async () => {
		const root = await freshRoot();
		const config = parseBoardConfig({
			mfw: 1,
			types: {
				task: {
					layout: "flat",
					dir: "tasks",
					id: { strategy: "own-sequence", key: "CARD", pad: 3 },
					fields: { title: {} },
				},
			},
		});
		const store = new BoardStore(root, config);
		const doc = await store.createDocument("task", { fields: { title: "x" } });
		expect(doc.id).toBe("CARD-001");
	});

	test("an explicit id outside the grammar is rejected", async () => {
		const root = await freshRoot();
		const config = parseBoardConfig({
			mfw: 1,
			types: {
				task: {
					layout: "flat",
					dir: "tasks",
					id: { strategy: "own-sequence", key: "CARD", pad: 3 },
					fields: { title: {} },
				},
			},
		});
		const store = new BoardStore(root, config);
		await expect(
			store.createDocument("task", { id: "not-a-number", fields: {} }),
		).rejects.toThrow(InvalidIdError);
		// a trailing letter (the removed "split" form) is not part of the grammar
		await expect(
			store.createDocument("task", { id: "CARD-001a", fields: {} }),
		).rejects.toThrow(InvalidIdError);
		// ...and neither is a bare number: every id carries its key
		await expect(
			store.createDocument("task", { id: "001", fields: {} }),
		).rejects.toThrow(InvalidIdError);
	});

	test("two types sharing a sequence allocate from one counter", async () => {
		const root = await freshRoot();
		const config = parseBoardConfig({
			mfw: 1,
			types: {
				task: {
					layout: "flat",
					dir: "tasks",
					id: { strategy: "own-sequence", key: "CARD", sequence: "cards" },
					fields: { title: {} },
				},
				spec: {
					layout: "flat",
					dir: "specs",
					id: { strategy: "own-sequence", key: "CARD", sequence: "cards" },
					fields: { title: {} },
				},
			},
		});
		const store = new BoardStore(root, config);
		const t1 = await store.createDocument("task", { fields: { title: "a" } });
		const s1 = await store.createDocument("spec", { fields: { title: "b" } });
		const t2 = await store.createDocument("task", { fields: { title: "c" } });
		expect([t1.id, s1.id, t2.id]).toEqual(["CARD-1", "CARD-2", "CARD-3"]);
	});

	test("validate() flags an on-disk id that predates a key change", async () => {
		const root = await freshRoot();
		// A document written under an old key...
		const bare = parseBoardConfig({
			mfw: 1,
			types: {
				task: {
					layout: "flat",
					dir: "tasks",
					id: { strategy: "own-sequence", key: "OLDK" },
					fields: { title: {} },
				},
			},
		});
		await new BoardStore(root, bare).createDocument("task", {
			id: "OLDK-7",
			fields: { title: "x" },
		});
		// ...is flagged once the project moves to another key without
		// migrating what's already on disk.
		const keyed = parseBoardConfig({
			mfw: 1,
			types: {
				task: {
					layout: "flat",
					dir: "tasks",
					id: { strategy: "own-sequence", key: "TK" },
					fields: { title: {} },
				},
			},
		});
		const issues = await new BoardStore(root, keyed).validate();
		expect(issues).toContainEqual(
			expect.objectContaining({
				id: "OLDK-7",
				message: expect.stringContaining(
					"does not match its own-sequence grammar",
				),
			}),
		);
	});
});

describe("BoardStore: scalar type checks and pattern (R4)", () => {
	const SCALAR_CONFIG = parseBoardConfig({
		mfw: 1,
		types: {
			task: {
				layout: "flat",
				dir: "tasks",
				id: { strategy: "own-sequence", key: "TK" },
				fields: {
					title: {},
					age: { type: "number", optional: true },
					urgent: { type: "boolean", optional: true },
					due: { type: "date", optional: true },
					notes: { type: "json", optional: true },
					ledger_ids: {
						type: "string",
						list: true,
						optional: true,
						pattern: "^R\\d{3}-\\d{3}$",
					},
				},
			},
		},
	});

	test("number/boolean/date reject a value of the wrong shape", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, SCALAR_CONFIG);
		await expect(
			store.createDocument("task", {
				fields: { title: "x", age: "not a number" },
			}),
		).rejects.toThrow(/must be a number/);
		await expect(
			store.createDocument("task", {
				fields: { title: "x", urgent: "yes" },
			}),
		).rejects.toThrow(/must be a boolean/);
		await expect(
			store.createDocument("task", {
				fields: { title: "x", due: "not a date" },
			}),
		).rejects.toThrow(/must be a YYYY-MM-DD date string/);
	});

	test("date rejects a YAML timestamp, accepts a plain YYYY-MM-DD string", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, SCALAR_CONFIG);
		// A bare, unquoted date in YAML parses as a JS Date, not a string -
		// exactly the ambiguity `type: date` requiring a string grammar rejects.
		await expect(
			store.createDocument("task", {
				fields: { title: "x", due: new Date("2026-01-01") },
			}),
		).rejects.toThrow(/must be a YYYY-MM-DD date string/);
		const doc = await store.createDocument("task", {
			fields: { title: "x", due: "2026-01-01" },
		});
		expect(doc.fields.due).toBe("2026-01-01");
	});

	test("type: json accepts any already-parsed shape with no further check", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, SCALAR_CONFIG);
		const doc = await store.createDocument("task", {
			fields: { title: "x", notes: { anything: ["goes", 1, true] } },
		});
		expect(doc.fields.notes).toEqual({ anything: ["goes", 1, true] });
	});

	test("pattern rejects a non-matching string, applied per element on a list", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, SCALAR_CONFIG);
		const doc = await store.createDocument("task", {
			fields: { title: "x", ledger_ids: ["R472-007", "R001-002"] },
		});
		expect(doc.fields.ledger_ids).toEqual(["R472-007", "R001-002"]);
		await expect(
			store.createDocument("task", {
				fields: { title: "y", ledger_ids: ["R472-007", "not-a-ledger-id"] },
			}),
		).rejects.toThrow(/must match/);
	});

	test("config rejects pattern on a non-string scalar type", () => {
		expect(() =>
			parseBoardConfig({
				mfw: 1,
				types: {
					task: {
						layout: "flat",
						dir: "tasks",
						id: { strategy: "own-sequence", key: "TK" },
						fields: {
							count: { type: "number", pattern: "^[0-9]+$" },
						},
					},
				},
			}),
		).toThrow(/'pattern' only applies to type: string/);
	});
});

describe("BoardStore: directory layout", () => {
	test("a directory-layout document lives at <dir>/<id>-<slug>/<primary>", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const doc = await store.createDocument("card", {
			fields: { title: "Design the thing" },
		});
		expect(doc.path).toBe(
			join(root, "cards", `${doc.id}-design-the-thing`, "card.md"),
		);
	});

	test("a directory with no primary file is not a document", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const { mkdir, writeFile } = await import("node:fs/promises");
		await mkdir(join(root, "cards", "stray"), { recursive: true });
		await writeFile(
			join(root, "cards", "stray", "notes.md"),
			"orphaned notes\n",
		);
		expect(await store.listDocuments("card")).toEqual([]);
	});
});

describe("BoardStore: optional fields round-trip through update", () => {
	test("updating one field does not choke on another optional ref field's null sentinel", async () => {
		// Regression: materializeFields validated a round-tripped `null` (this
		// engine's own "optional and absent" sentinel) against the field's
		// declared kind instead of treating it as absent, so ANY update on a
		// document with an untouched optional single-value field (ref or enum)
		// failed with "must be an id" / "must be one of ...".
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const doc = await store.createDocument("task", {
			fields: { title: "no assignee yet" },
		});
		expect(doc.fields.assignee).toBeNull();
		const updated = await store.updateDocument("task", doc.id, {
			fields: { status: "doing" },
		});
		expect(updated.fields.status).toBe("doing");
		expect(updated.fields.assignee).toBeNull();
	});
});

describe("BoardStore: transact (the exclusive-transition primitive)", () => {
	test("eight concurrent transacts against one precondition produce exactly one winner", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const doc = await store.createDocument("task", {
			fields: { title: "contested" },
		});

		const results = await Promise.all(
			Array.from({ length: 8 }, () =>
				store.transact("task", doc.id, async (current) => {
					// A claim-shaped precondition: only fire from the expected source status.
					if (current.fields.status !== "planned") return null;
					return { fields: { status: "doing" } };
				}),
			),
		);
		expect(results.filter(Boolean)).toHaveLength(1);
		const after = await store.readDocument("task", doc.id);
		expect(after?.fields.status).toBe("doing");
	});

	test("fn returning null aborts with no write and no rev bump", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const doc = await store.createDocument("task", {
			fields: { title: "untouched" },
		});
		const result = await store.transact("task", doc.id, async () => null);
		expect(result).toBeNull();
		const after = await store.readDocument("task", doc.id);
		expect(after?.rev).toBe(doc.rev);
	});

	test("fn can read OTHER documents to decide (a dependency-style precondition)", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const dep = await store.createDocument("task", {
			fields: { title: "dependency" },
		});
		const doc = await store.createDocument("task", {
			fields: { title: "dependent", dependencies: [dep.id] },
		});

		const blocked = await store.transact("task", doc.id, async (current) => {
			const deps = current.fields.dependencies as string[];
			for (const depId of deps) {
				const depDoc = await store.readDocument("task", depId);
				if (depDoc?.fields.status !== "done") return null;
			}
			return { fields: { status: "doing" } };
		});
		expect(blocked).toBeNull();

		await store.updateDocument("task", dep.id, { fields: { status: "done" } });
		const unblocked = await store.transact("task", doc.id, async (current) => {
			const deps = current.fields.dependencies as string[];
			for (const depId of deps) {
				const depDoc = await store.readDocument("task", depId);
				if (depDoc?.fields.status !== "done") return null;
			}
			return { fields: { status: "doing" } };
		});
		expect(unblocked?.fields.status).toBe("doing");
	});
});

describe("BoardStore: deleteDocument / wipeType", () => {
	test("deleteDocument removes a directory-layout document's whole directory", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const doc = await store.createDocument("card", {
			fields: { title: "throwaway" },
		});
		expect(await store.deleteDocument("card", doc.id)).toBe(true);
		expect(await store.readDocument("card", doc.id)).toBeNull();
	});

	test("deleteDocument removes a flat-layout document's file", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const doc = await store.createDocument("task", {
			fields: { title: "throwaway" },
		});
		expect(await store.deleteDocument("task", doc.id)).toBe(true);
		expect(await store.readDocument("task", doc.id)).toBeNull();
	});

	test("deleteDocument on an unknown id returns false", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		expect(await store.deleteDocument("task", "TK-999")).toBe(false);
	});

	test("wipeType removes every document of that type and leaves the counter non-reusable", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		await store.createDocument("task", { fields: { title: "a" } });
		await store.createDocument("task", { fields: { title: "b" } });
		const removed = await store.wipeType("task");
		expect(removed.sort()).toEqual(["TK-1", "TK-2"]);
		expect(await store.listDocuments("task")).toEqual([]);
		const next = await store.createDocument("task", { fields: { title: "c" } });
		expect(next.id).toBe("TK-3");
	});
});

describe("BoardStore: a malformed document never hides the others", () => {
	test("listDocuments skips a malformed file instead of throwing for the whole type", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const good = await store.createDocument("task", {
			fields: { title: "fine" },
		});
		const { mkdir, writeFile } = await import("node:fs/promises");
		await mkdir(join(root, "tasks"), { recursive: true });
		await writeFile(
			join(root, "tasks", "TK-99-broken.md"),
			"---\nmfw: 1\nid: TK-99\n---\nno title\n",
		);
		const list = await store.listDocuments("task");
		expect(list.map((d) => d.id)).toEqual([good.id]);
	});

	test("readDocument still finds a valid document past a malformed one", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const good = await store.createDocument("task", {
			fields: { title: "fine" },
		});
		const { mkdir, writeFile } = await import("node:fs/promises");
		await mkdir(join(root, "tasks"), { recursive: true });
		await writeFile(
			join(root, "tasks", "TK-99-broken.md"),
			"---\nmfw: 1\nid: TK-99\n---\nno title\n",
		);
		expect((await store.readDocument("task", good.id))?.id).toBe(good.id);
	});

	test("validate() still reports the malformed document that list/read made invisible", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const { mkdir, writeFile } = await import("node:fs/promises");
		await mkdir(join(root, "tasks"), { recursive: true });
		await writeFile(
			join(root, "tasks", "TK-99-broken.md"),
			"---\nmfw: 1\nid: TK-99\n---\nno title\n",
		);
		const issues = await store.validate();
		expect(
			issues.some((i) => i.message.includes("missing required field 'title'")),
		).toBe(true);
	});

	test("readDocument throws the real error when the KNOWN id itself is the broken one", async () => {
		// Every document's name starts with its id by construction (`pathFor`),
		// so a broken entry whose name matches the id being asked for is almost
		// certainly the one wanted - that must surface as the real parse
		// failure, not a misleading "not found" (readDocument returning null).
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const doc = await store.createDocument("task", {
			fields: { title: "repair me" },
		});
		const { writeFile } = await import("node:fs/promises");
		await writeFile(
			doc.path,
			"---\nmfw: 1\nid: not-even-the-same-id\n---\nbroken\n",
		);
		await expect(store.readDocument("task", doc.id)).rejects.toThrow(
			/missing required field/,
		);
	});

	test("readDocument still returns null for a genuinely unknown id beside an unrelated broken file", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const { mkdir, writeFile } = await import("node:fs/promises");
		await mkdir(join(root, "tasks"), { recursive: true });
		await writeFile(
			join(root, "tasks", "TK-99-broken.md"),
			"---\nmfw: 1\nid: TK-99\n---\nno title\n",
		);
		expect(await store.readDocument("task", "TK-1")).toBeNull();
	});
});

describe("BoardStore: validate", () => {
	test("catches a dangling ref, a duplicate id, and a dependency cycle", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const a = await store.createDocument("task", { fields: { title: "a" } });
		const b = await store.createDocument("task", { fields: { title: "b" } });
		await store.updateDocument("task", a.id, {
			fields: { dependencies: [b.id] },
		});
		const { writeFile, readFile: rf } = await import("node:fs/promises");
		// The store refuses to close the cycle, so fabricate a hand-edited one.
		await writeFile(
			b.path,
			(await rf(b.path, "utf8")).replace(
				/^rev: .*$/m,
				(m) => `${m}\ndependencies: [${a.id}]`,
			),
		);
		await store.createDocument("task", {
			fields: { title: "c", dependencies: ["TK-999"] },
		});

		const dupPath = join(root, "tasks", "TK-1-duplicate.md");
		await writeFile(dupPath, await rf(a.path, "utf8"));

		const issues = await store.validate();
		expect(
			issues.some((i) => i.message.includes("unknown task 'TK-999'")),
		).toBe(true);
		expect(issues.some((i) => i.message.includes("duplicate id"))).toBe(true);
		expect(issues.some((i) => i.message.includes("cycle"))).toBe(true);
	});

	test("a write that would close a dependency cycle is refused, nothing written", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		const a = await store.createDocument("task", { fields: { title: "a" } });
		const b = await store.createDocument("task", {
			fields: { title: "b", dependencies: [a.id] },
		});
		const c = await store.createDocument("task", {
			fields: { title: "c", dependencies: [b.id] },
		});
		// a -> c would close c -> b -> a -> c
		await expect(
			store.updateDocument("task", a.id, { fields: { dependencies: [c.id] } }),
		).rejects.toThrow(/would create a cycle: .*→/);
		// ...so does a self-reference, via transact as well
		await expect(
			store.updateDocument("task", a.id, { fields: { dependencies: [a.id] } }),
		).rejects.toThrow(/would create a cycle/);
		await expect(
			store.transact("task", a.id, async () => ({
				fields: { dependencies: [b.id] },
			})),
		).rejects.toThrow(/would create a cycle/);
		expect((await store.readDocument("task", a.id))?.rev).toBe(1);
		// an unrelated, acyclic edge is fine
		await store.updateDocument("task", a.id, { fields: { title: "a2" } });
		expect(await store.validate()).toEqual([]);
	});

	test("creating a document that depends on itself is refused", async () => {
		const store = new BoardStore(await freshRoot(), CONFIG);
		await store.createDocument("task", { fields: { title: "x" } });
		await expect(
			store.createDocument("task", {
				fields: { title: "y", dependencies: ["TK-2"] },
				id: "TK-2",
			}),
		).rejects.toThrow(/would create a cycle/);
	});

	test("a clean board validates with no issues", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, CONFIG);
		await store.createDocument("task", { fields: { title: "fine" } });
		expect(await store.validate()).toEqual([]);
	});
});
