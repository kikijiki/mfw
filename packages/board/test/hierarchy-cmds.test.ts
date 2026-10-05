import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../src/cli.ts");

const BOARD = [
	"mfw: 1",
	"hierarchy: { parent: parent, children: children, maxDepth: 2 }",
	"types:",
	"  task:",
	"    layout: flat",
	"    dir: tasks",
	"    id: { strategy: own-sequence, key: TK }",
	"    statusClasses:",
	"      terminal: [done]",
	"      live: [todo]",
	"      queued: [todo]",
	"    fields:",
	"      title: {}",
	"      status: { values: [todo, done], default: todo }",
	"      depends_on: { ref: task, list: true, optional: true }",
	"      parent: { ref: task, optional: true }",
	"      children: { ref: task, list: true, optional: true }",
].join("\n");

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function mfwb(cwd: string, args: string[]) {
	const e: Record<string, string | undefined> = { ...process.env };
	delete e.MFW_BOARD;
	const p = Bun.spawn(["bun", "run", CLI, ...args], {
		cwd,
		env: e,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}

async function board(titles = 0): Promise<string> {
	const d = await realpath(await mkdtemp(join(tmpdir(), "mfwb-h-")));
	dirs.push(d);
	await writeFile(join(d, "board.yaml"), BOARD);
	for (let i = 1; i <= titles; i++) {
		expect((await mfwb(d, ["create", `title=t${i}`])).code).toBe(0);
	}
	return d;
}

async function put(d: string, id: string, extra = "", status = "todo") {
	await mkdir(join(d, "tasks"), { recursive: true });
	await writeFile(
		join(d, "tasks", `${id}.md`),
		`---\nmfw: 1\nid: ${id}\nrev: 1\ntitle: x\nstatus: ${status}\n${extra}---\n`,
	);
}

const getFields = async (d: string, id: string) =>
	JSON.parse((await mfwb(d, ["show", id, "--json"])).stdout).fields;

describe("validate exit codes and --json", () => {
	test("ok", async () => {
		const d = await board(2);
		expect((await mfwb(d, ["validate"])).stdout).toBe("ok");
		const j = await mfwb(d, ["validate", "--json"]);
		expect(j.code).toBe(0);
		expect(JSON.parse(j.stdout)).toEqual({ ok: true, issues: [] });
	});

	const classes: [string, number, (d: string) => Promise<void>][] = [
		["document", 10, (d) => put(d, "TK-1", "", "bogus")],
		[
			"id",
			11,
			async (d) => {
				await put(d, "TK-1");
				await writeFile(
					join(d, "tasks", "TK-1-copy.md"),
					await Bun.file(join(d, "tasks", "TK-1.md")).text(),
				);
			},
		],
		["reference", 12, (d) => put(d, "TK-1", "depends_on: [TK-99]\n")],
		[
			"hierarchy",
			13,
			(d) => put(d, "TK-1", "parent: TK-2\n").then(() => put(d, "TK-2")),
		],
		[
			"cycle",
			14,
			(d) =>
				put(d, "TK-1", "depends_on: [TK-2]\n").then(() =>
					put(d, "TK-2", "depends_on: [TK-1]\n"),
				),
		],
	];
	for (const [kind, code, setup] of classes) {
		test(`${kind} exits ${code}`, async () => {
			const d = await board();
			await setup(d);
			const r = await mfwb(d, ["validate"]);
			expect(r.code).toBe(code);
			const j = await mfwb(d, ["validate", "--json"]);
			expect(j.code).toBe(code);
			const out = JSON.parse(j.stdout);
			expect(out.ok).toBe(false);
			expect(out.issues.map((i: { kind: string }) => i.kind)).toContain(kind);
			expect(Object.keys(out.issues[0]).sort()).toEqual([
				"id",
				"kind",
				"message",
				"path",
				"type",
			]);
		});
	}

	test("several classes: lowest code wins, --json lists all", async () => {
		const d = await board();
		await put(d, "TK-1", "depends_on: [TK-2, TK-99]\n");
		await put(d, "TK-2", "depends_on: [TK-1]\n");
		const j = await mfwb(d, ["validate", "--json"]);
		expect(j.code).toBe(12);
		const kinds = new Set(
			JSON.parse(j.stdout).issues.map((i: { kind: string }) => i.kind),
		);
		expect(kinds.has("reference")).toBe(true);
		expect(kinds.has("cycle")).toBe(true);
	});

	test("no board and bad board.yaml exit 3", async () => {
		const d = await realpath(await mkdtemp(join(tmpdir(), "mfwb-h-")));
		dirs.push(d);
		expect((await mfwb(d, ["validate"])).code).toBe(3);
		await writeFile(join(d, "board.yaml"), "types: [not, a, map\n");
		expect((await mfwb(d, ["validate"])).code).toBe(3);
	});
});

describe("hierarchy through create / update / reparent", () => {
	test("create parent=<id> and update parent=<id> sync the children list", async () => {
		const d = await board(2);
		expect((await mfwb(d, ["create", "title=kid", "parent=TK-1"])).code).toBe(
			0,
		);
		expect((await getFields(d, "TK-1")).children).toEqual(["TK-3"]);
		expect((await mfwb(d, ["update", "TK-3", "parent=TK-2"])).code).toBe(0);
		expect((await getFields(d, "TK-1")).children ?? []).toEqual([]);
		expect((await getFields(d, "TK-2")).children).toEqual(["TK-3"]);
		expect((await mfwb(d, ["validate"])).code).toBe(0);
	});

	test("reparent moves, clears with '-', and supports --json", async () => {
		const d = await board(3);
		expect((await mfwb(d, ["reparent", "TK-3", "TK-1"])).code).toBe(0);
		const j = await mfwb(d, ["reparent", "TK-3", "TK-2", "--json"]);
		expect(j.code).toBe(0);
		expect(JSON.parse(j.stdout).fields.parent).toBe("TK-2");
		expect((await getFields(d, "TK-2")).children).toEqual(["TK-3"]);
		expect((await mfwb(d, ["reparent", "TK-3", "-"])).code).toBe(0);
		expect((await getFields(d, "TK-3")).parent ?? "").toBe("");
		expect((await getFields(d, "TK-2")).children ?? []).toEqual([]);
		expect((await mfwb(d, ["validate"])).code).toBe(0);
	});

	test("reparent errors carry the HierarchyError code and exit 1", async () => {
		const d = await board(3);
		await mfwb(d, ["reparent", "TK-2", "TK-1"]);
		const cyc = await mfwb(d, ["reparent", "TK-1", "TK-2"]);
		expect(cyc.code).toBe(1);
		expect(cyc.stderr).toContain("(cycle)");
		const nf = await mfwb(d, ["reparent", "TK-3", "TK-99"]);
		expect(nf.code).toBe(1);
		expect(nf.stderr).toContain("parent-not-found");
		await mfwb(d, ["reparent", "TK-3", "TK-2"]);
		await mfwb(d, ["create", "title=deep", "parent=TK-3"]);
		const deep = await mfwb(d, ["create", "title=deeper", "parent=TK-4"]);
		expect(deep.code).not.toBe(0);
		expect((await mfwb(d, ["reparent", "TK-3"])).code).toBe(2);
	});
});

describe("repair", () => {
	test("rebuilds children from hand-set parents, then validate is clean", async () => {
		const d = await board();
		await put(d, "TK-1");
		await put(d, "TK-2", "parent: TK-1\n");
		await put(d, "TK-3", "parent: TK-1\n");
		expect((await mfwb(d, ["validate"])).code).toBe(13);
		const r = await mfwb(d, ["repair"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain(
			"repaired task TK-1: children [] -> [TK-2, TK-3]",
		);
		expect((await getFields(d, "TK-1")).children).toEqual(["TK-2", "TK-3"]);
		expect((await mfwb(d, ["validate"])).code).toBe(0);
		expect((await mfwb(d, ["repair"])).stdout).toBe("nothing to repair");
		const j = await mfwb(d, ["repair", "--json"]);
		expect(JSON.parse(j.stdout)).toEqual({ repaired: [] });
	});

	test("a board without a hierarchy section exits 2", async () => {
		const d = await realpath(await mkdtemp(join(tmpdir(), "mfwb-h-")));
		dirs.push(d);
		await writeFile(
			join(d, "board.yaml"),
			"mfw: 1\ntypes:\n  task:\n    layout: flat\n    dir: tasks\n    id: { strategy: own-sequence, key: TK }\n    fields:\n      title: {}\n",
		);
		const r = await mfwb(d, ["repair"]);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("no hierarchy");
	});
});
