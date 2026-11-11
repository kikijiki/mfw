import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fsp from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBoardConfig } from "../src/config.ts";
import { BoardStore } from "../src/store.ts";

/** `readDocument` finds a document by the entries named for its id and falls
 * back to the full scan for anything else. These tests pin that it answers like
 * the full scan, and that the hot paths no longer read the whole board. */

const CONFIG = parseBoardConfig({
	mfw: 1,
	hierarchy: { parent: "parent", children: "children" },
	types: {
		task: {
			layout: "flat",
			dir: "tasks",
			id: { strategy: "own-sequence", key: "TK" },
			slugFrom: "title",
			fields: {
				title: {},
				parent: { ref: "task", optional: true },
				children: { ref: "task", list: true, optional: true },
			},
		},
		card: {
			layout: "directory",
			dir: "cards",
			primary: "card.md",
			id: { strategy: "own-sequence", key: "MFW" },
			fields: { title: {} },
		},
	},
});

const dirs: string[] = [];
async function freshRoot(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "board-lookup-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true });
});

const doc = (id: string, extra = "") =>
	`---\nmfw: 1\nid: ${id}\nrev: 1\ntitle: ${id}\n${extra}---\n\nbody\n`;

/** Outcome of a lookup, thrown errors included, for comparing two paths. */
async function outcome(f: () => Promise<unknown>): Promise<unknown> {
	try {
		const d = (await f()) as { id: string; path: string } | null;
		return d ? { id: d.id, path: d.path } : null;
	} catch (e) {
		return { threw: (e as Error).constructor.name };
	}
}

describe("readDocument fast path", () => {
	test("answers like the full scan across odd directories (flat layout)", async () => {
		const root = await freshRoot();
		const dir = join(root, "tasks");
		await mkdir(dir, { recursive: true });
		const files: Record<string, string> = {
			"TK-1-first.md": doc("TK-1"),
			"TK-10-tenth.md": doc("TK-10"),
			"TK-100.md": doc("TK-100"),
			"TK-1-1.md": doc("TK-1-1"), // not TK-1's: id differs
			"zzz-misnamed.md": doc("TK-50"), // name says nothing about its id
			".hidden.md": doc("TK-60"),
			"TK-70.txt": doc("TK-70"),
			"TK-80-nofront.md": "just prose, no frontmatter\n",
			"TK-90-broken.md": "---\nmfw: 1\nid: TK-90\nrev: nope\n---\n",
			"TK-91-broken.md": "---\nmfw: 1\nid: TK-91\nrev: nope\n---\n",
			"a-valid-after-broken.md": doc("TK-91"), // a valid TK-91 sorts first
			"TK-95-a.md": doc("TK-95"),
			"TK-95-b.md": doc("TK-95"), // duplicate id, both name-matching
		};
		for (const [name, text] of Object.entries(files)) {
			await writeFile(join(dir, name), text);
		}
		const store = new BoardStore(root, CONFIG);
		const slow = (id: string) =>
			(
				store as unknown as {
					readDocumentByScan(
						t: string,
						ty: unknown,
						i: string,
					): Promise<unknown>;
				}
			).readDocumentByScan("task", CONFIG.types.task, id);
		for (const id of [
			"TK-1",
			"TK-10",
			"TK-100",
			"TK-1-1",
			"TK-50",
			"TK-60",
			"TK-70",
			"TK-80",
			"TK-90",
			"TK-91",
			"TK-95",
			"TK-2",
			"TK-",
			"tk-1",
			"TK-1.*",
		]) {
			expect({
				id,
				got: await outcome(() => store.readDocument("task", id)),
			}).toEqual({
				id,
				got: await outcome(() => slow(id)),
			});
		}
	});

	test("a name-matching entry wins over a misnamed duplicate", async () => {
		const root = await freshRoot();
		await mkdir(join(root, "tasks"), { recursive: true });
		await writeFile(
			join(root, "tasks", "a-misnamed.md"),
			doc("TK-1", "parent: TK-9\n"),
		);
		await writeFile(join(root, "tasks", "TK-1-real.md"), doc("TK-1"));
		const found = await new BoardStore(root, CONFIG).readDocument(
			"task",
			"TK-1",
		);
		expect(found?.path).toBe(join(root, "tasks", "TK-1-real.md"));
	});

	test("directory layout: matching directory, missing primary, misnamed directory", async () => {
		const root = await freshRoot();
		const put = async (name: string, text: string | null) => {
			await mkdir(join(root, "cards", name), { recursive: true });
			if (text !== null)
				await writeFile(join(root, "cards", name, "card.md"), text);
		};
		await put("MFW-1-alpha", doc("MFW-1"));
		await put("MFW-10", doc("MFW-10"));
		await put("MFW-2-no-primary", null);
		await put("renamed-by-hand", doc("MFW-3"));
		const store = new BoardStore(root, CONFIG);
		expect((await store.readDocument("card", "MFW-1"))?.id).toBe("MFW-1");
		expect((await store.readDocument("card", "MFW-10"))?.id).toBe("MFW-10");
		expect(await store.readDocument("card", "MFW-2")).toBeNull();
		expect((await store.readDocument("card", "MFW-3"))?.id).toBe("MFW-3");
	});
});

describe("corrupt boards and scan order", () => {
	test("a valid name-matching entry wins over a malformed one", async () => {
		const root = await freshRoot();
		await mkdir(join(root, "tasks"), { recursive: true });
		await writeFile(
			join(root, "tasks", "TK-7-a-broken.md"),
			"---\nmfw: 1\nid: TK-7\nrev: x\n---\n",
		);
		await writeFile(join(root, "tasks", "TK-7-b.md"), doc("TK-7"));
		const found = await new BoardStore(root, CONFIG).readDocument(
			"task",
			"TK-7",
		);
		expect(found?.path).toBe(join(root, "tasks", "TK-7-b.md"));
	});

	test("listDocuments over several scan batches keeps directory order", async () => {
		const root = await freshRoot();
		await mkdir(join(root, "tasks"), { recursive: true });
		await Promise.all(
			Array.from({ length: 150 }, (_, i) =>
				writeFile(join(root, "tasks", `TK-${i + 1}.md`), doc(`TK-${i + 1}`)),
			),
		);
		const { readdir } = await import("node:fs/promises");
		const onDisk = (await readdir(join(root, "tasks"))).map((n) =>
			n.slice(0, -3),
		);
		const listed = (
			await new BoardStore(root, CONFIG).listDocuments("task")
		).map((d) => d.id);
		expect(listed).toEqual(onDisk);
	});

	test("repair fixes stale, missing and foreign children and is then a no-op", async () => {
		const root = await freshRoot();
		await mkdir(join(root, "tasks"), { recursive: true });
		const put = (id: string, extra: string) =>
			writeFile(join(root, "tasks", `${id}.md`), doc(id, extra));
		await put("TK-1", "children: [TK-9, TK-3]\n"); // TK-9 is not a child; TK-2 missing; TK-3 not a child
		await put("TK-2", "parent: TK-1\n");
		await put("TK-3", "");
		await put("TK-4", "parent: TK-4\n"); // self-parent is not its own child
		await put("TK-5", "parent: TK-1\n");
		const store = new BoardStore(root, CONFIG);
		const changed = await store.repairHierarchy();
		expect(changed.map((c) => [c.id, c.after])).toEqual([
			["TK-1", ["TK-2", "TK-5"]],
		]);
		expect(await store.repairHierarchy()).toEqual([]);
		expect(
			(await store.readDocument("task", "TK-4"))?.fields.children ?? [],
		).toEqual([]);
	});
});

describe("create against an explicit id", () => {
	test("an explicit create racing auto creates never overwrites or duplicates", async () => {
		for (let round = 0; round < 15; round++) {
			const root = await freshRoot();
			const a = new BoardStore(root, CONFIG);
			const b = new BoardStore(root, CONFIG);
			const results = await Promise.allSettled([
				a.createDocument("task", { id: "TK-1", fields: { title: "explicit" } }),
				b.createDocument("task", { fields: { title: "auto one" } }),
				b.createDocument("task", { fields: { title: "auto two" } }),
			]);
			const made = results.flatMap((r) =>
				r.status === "fulfilled" ? [r.value] : [],
			);
			const listed = await a.listDocuments("task");
			expect(listed.map((d) => d.id).sort()).toEqual(
				made.map((d) => d.id).sort(),
			);
			expect(new Set(listed.map((d) => d.id)).size).toBe(listed.length);
			for (const d of made) {
				expect((await a.readDocument("task", d.id))?.fields.title).toBe(
					d.fields.title,
				);
			}
		}
	}, 60_000);

	test("creating next to a malformed file never overwrites it", async () => {
		// Unchanged behaviour, pinned: the malformed file is invisible to the id
		// scan, so its number can be allocated again; `validate()` reports the pair.
		const root = await freshRoot();
		await mkdir(join(root, "tasks"), { recursive: true });
		await writeFile(
			join(root, "tasks", "TK-1-broken.md"),
			"---\nid: TK-1\nrev: x\n---\n",
		);
		await new BoardStore(root, CONFIG).createDocument("task", {
			fields: { title: "n" },
		});
		expect(
			await Bun.file(join(root, "tasks", "TK-1-broken.md")).text(),
		).toContain("rev: x");
	});
});

describe("hot paths no longer read the whole board", () => {
	const N = 300;
	async function seeded(): Promise<{ store: BoardStore; root: string }> {
		const root = await freshRoot();
		await mkdir(join(root, "tasks"), { recursive: true });
		await Promise.all(
			Array.from({ length: N }, (_, i) =>
				writeFile(
					join(root, "tasks", `TK-${i + 1}-t.md`),
					doc(`TK-${i + 1}`, i === 0 ? "" : "parent: TK-1\n").replace(
						"body",
						"body",
					),
				),
			),
		);
		const store = new BoardStore(root, CONFIG);
		await store.repairHierarchy();
		return { store, root };
	}

	async function reads<T>(f: () => Promise<T>): Promise<number> {
		const spy = spyOn(fsp, "readFile");
		try {
			await f();
			return spy.mock.calls.length;
		} finally {
			spy.mockRestore();
		}
	}

	test("the spy sees the store's reads (guards against a vacuous test)", async () => {
		const { store } = await seeded();
		expect(
			await reads(() => store.listDocuments("task")),
		).toBeGreaterThanOrEqual(N);
	});

	test("readDocument and update read O(1) files", async () => {
		const { store } = await seeded();
		expect(
			await reads(() => store.readDocument("task", "TK-200")),
		).toBeLessThanOrEqual(2);
		expect(
			await reads(() =>
				store.updateDocument("task", "TK-200", { fields: { title: "x" } }),
			),
		).toBeLessThanOrEqual(12);
	});

	test("create under a parent reads the board a handful of times, not nine", async () => {
		const { store } = await seeded();
		const n = await reads(() =>
			store.createDocument("task", {
				fields: { title: "new", parent: "TK-5" },
			}),
		);
		// counter max-scan + existence check + the parent's children listing
		expect(n).toBeLessThan(3.5 * N);
	});
});
