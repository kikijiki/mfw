import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardConfigError, parseBoardConfig } from "../src/config.ts";
import {
	BoardStore,
	DocumentExistsError,
	InvalidIdError,
} from "../src/store.ts";

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

const type = (dir: string, id: Record<string, unknown>) => ({
	layout: "flat",
	dir,
	id: { strategy: "own-sequence", key: "WH", ...id },
	fields: { title: { optional: true } },
});
const raw = (taskId: Record<string, unknown> = {}, epicId = {}) => ({
	mfw: 1,
	types: {
		task: type("tasks", { sequence: "s", pad: 4, ...taskId }),
		epic: type("epics", { sequence: "s", ...epicId }),
	},
});
const cfg = () => parseBoardConfig(raw());

describe("shared sequence config", () => {
	test("types sharing a sequence must share key and suffix", () => {
		expect(() => parseBoardConfig(raw({}, { key: "XX" }))).toThrow(
			BoardConfigError,
		);
		expect(() => parseBoardConfig(raw({}, { suffix: "A" }))).toThrow(
			/same id.key and id.suffix/,
		);
		parseBoardConfig(raw({ pad: 6 }));
	});
});

describe("cross-type id uniqueness", () => {
	test("a sibling type cannot take an existing id", async () => {
		const store = new BoardStore(await freshRoot(), cfg());
		await store.createDocument("task", { id: "WH-5", fields: {} });
		await expect(
			store.createDocument("epic", { id: "WH-5", fields: {} }),
		).rejects.toBeInstanceOf(DocumentExistsError);
	});

	test("same number, different spelling is refused (same and sibling type)", async () => {
		const store = new BoardStore(await freshRoot(), cfg());
		await store.createDocument("task", { id: "WH-0042", fields: {} });
		await expect(
			store.createDocument("task", { id: "WH-42", fields: {} }),
		).rejects.toBeInstanceOf(InvalidIdError);
		await expect(
			store.createDocument("epic", { id: "WH-42", fields: {} }),
		).rejects.toBeInstanceOf(InvalidIdError);
	});

	test("without a sequence, numbers are checked within the type", async () => {
		const store = new BoardStore(
			await freshRoot(),
			parseBoardConfig({ mfw: 1, types: { task: type("tasks", {}) } }),
		);
		await store.createDocument("task", { id: "WH-007", fields: {} });
		await expect(
			store.createDocument("task", { id: "WH-7", fields: {} }),
		).rejects.toBeInstanceOf(InvalidIdError);
	});

	test("validate reports cross-type duplicates and spelling collisions", async () => {
		const root = await freshRoot();
		const store = new BoardStore(root, cfg());
		await store.createDocument("task", { id: "WH-5", fields: {} });
		await store.createDocument("task", { id: "WH-0042", fields: {} });
		expect(await store.validate()).toEqual([]);
		// Plant what createDocument now refuses.
		const body = (id: string) => `---\nmfw: 1\nid: ${id}\nrev: 1\n---\n`;
		await Bun.write(join(root, "epics", "WH-5.md"), body("WH-5"));
		await Bun.write(join(root, "epics", "WH-42.md"), body("WH-42"));
		const issues = (await store.validate()).filter((i) => i.kind === "id");
		const msgs = issues.map((i) => i.message).join("\n");
		expect(issues.length).toBe(2);
		expect(msgs).toContain("duplicate id");
		expect(msgs).toContain("same number");
	});

	test("auto allocation sees explicit ids in sibling types", async () => {
		const store = new BoardStore(await freshRoot(), cfg());
		await store.createDocument("epic", { id: "WH-9", fields: {} });
		const t = await store.createDocument("task", { fields: {} });
		expect(t.id).toBe("WH-0010");
	});
});

describe("auto vs explicit race and huge ids", () => {
	test("concurrent explicit create of the next auto id never fails the auto create", async () => {
		for (let i = 0; i < 5; i++) {
			const store = new BoardStore(await freshRoot(), cfg());
			const results = await Promise.allSettled([
				store.createDocument("task", { id: "WH-0001", fields: {} }),
				store.createDocument("task", { fields: {} }),
				store.createDocument("epic", { fields: {} }),
			]);
			const autos = results.slice(1);
			expect(autos.every((r) => r.status === "fulfilled")).toBe(true);
			expect(await store.validate()).toEqual([]);
		}
	});

	test("an explicit id beyond MAX_SAFE_INTEGER is rejected", async () => {
		const store = new BoardStore(await freshRoot(), cfg());
		await expect(
			store.createDocument("task", {
				id: "WH-1000000000000000000000",
				fields: {},
			}),
		).rejects.toBeInstanceOf(InvalidIdError);
		const t = await store.createDocument("task", { fields: {} });
		expect(t.id).toBe("WH-0001");
	});
});
