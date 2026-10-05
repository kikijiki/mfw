import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commands } from "../src/commands/index.ts";

const CLI = join(import.meta.dir, "../src/cli.ts");

const BOARD = [
	"mfw: 1",
	"types:",
	"  task:",
	"    layout: flat",
	"    dir: tasks",
	"    id: { strategy: own-sequence, key: TK }",
	"    fields:",
	"      title: {}",
	"      labels: { list: true, optional: true }",
	"      points: { type: number, optional: true }",
	"      urgent: { type: boolean, optional: true }",
	"      log: { type: json, list: true, rows: { required: [id] } }",
	"      acceptance: { type: checklist, optional: true }",
	"      parent: { ref: task, optional: true }",
	"      children: { ref: task, list: true, optional: true }",
	"hierarchy: { parent: parent, children: children }",
].join("\n");

const dirs: string[] = [];
async function board(): Promise<string> {
	const d = await realpath(await mkdtemp(join(tmpdir(), "mfwb-ops-")));
	dirs.push(d);
	await mkdir(d, { recursive: true });
	await writeFile(join(d, "board.yaml"), BOARD);
	await mfwb(d, ["create", "title=a"]);
	return d;
}
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

async function fields(d: string): Promise<Record<string, unknown>> {
	const r = await mfwb(d, ["show", "--json", "TK-1"]);
	return JSON.parse(r.stdout).fields;
}

describe("list commands", () => {
	test("append / prepend / insert / move / remove", async () => {
		const d = await board();
		expect((await mfwb(d, ["append", "TK-1", "labels", "b", "c"])).code).toBe(
			0,
		);
		await mfwb(d, ["prepend", "TK-1", "labels", "a"]);
		await mfwb(d, ["insert", "TK-1", "labels", "1", "x=y"]);
		expect((await fields(d)).labels).toEqual(["a", "x=y", "b", "c"]);
		await mfwb(d, ["move", "TK-1", "labels", "0", "3"]);
		await mfwb(d, ["remove", "TK-1", "labels", "x=y"]);
		expect((await fields(d)).labels).toEqual(["b", "c", "a"]);
		const r = await mfwb(d, ["remove", "TK-1", "labels", "zzz"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("not in 'labels'");
		expect(
			(await mfwb(d, ["remove", "TK-1", "labels", "zzz", "--if-present"])).code,
		).toBe(0);
	});

	test("--json output and --base-rev conflict", async () => {
		const d = await board();
		const r = await mfwb(d, ["append", "TK-1", "labels", "a", "--json"]);
		const j = JSON.parse(r.stdout);
		expect(j.fields.labels).toEqual(["a"]);
		expect(j.rev).toBe(2);
		const bad = await mfwb(d, [
			"append",
			"TK-1",
			"labels",
			"b",
			"--base-rev",
			"1",
		]);
		expect(bad.code).toBe(1);
		expect(bad.stderr).toContain("current rev is 2");
	});

	test("refuses hierarchy fields and unknown fields; usage on missing args", async () => {
		const d = await board();
		const r = await mfwb(d, ["append", "TK-1", "children", "TK-1"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("hierarchy");
		expect((await mfwb(d, ["append", "TK-1", "nope", "x"])).stderr).toContain(
			"no field 'nope'",
		);
		expect((await mfwb(d, ["append", "TK-1", "labels"])).code).toBe(2);
	});
});

describe("scalar commands", () => {
	test("inc / dec / toggle / unset", async () => {
		const d = await board();
		await mfwb(d, ["inc", "TK-1", "points"]);
		await mfwb(d, ["inc", "TK-1", "points", "5"]);
		await mfwb(d, ["dec", "TK-1", "points", "2"]);
		expect((await fields(d)).points).toBe(4);
		await mfwb(d, ["toggle", "TK-1", "urgent"]);
		expect((await fields(d)).urgent).toBe(true);
		await mfwb(d, ["unset", "TK-1", "points"]);
		expect((await fields(d)).points).toBeNull();
		expect((await mfwb(d, ["inc", "TK-1", "title"])).code).toBe(1);
	});
});

describe("check command", () => {
	test("add prints the item id; toggle/done/undone/edit/remove", async () => {
		const d = await board();
		const a = await mfwb(d, [
			"check",
			"TK-1",
			"acceptance",
			"add",
			"write",
			"tests",
		]);
		expect(a.code).toBe(0);
		expect(a.stdout).toContain("added c1");
		const j = await mfwb(d, [
			"check",
			"TK-1",
			"acceptance",
			"add",
			"ship it",
			"--json",
		]);
		expect(JSON.parse(j.stdout).itemId).toBe("c2");
		await mfwb(d, ["check", "TK-1", "acceptance", "toggle", "c1"]);
		await mfwb(d, ["check", "TK-1", "acceptance", "done", "ship"]);
		await mfwb(d, ["check", "TK-1", "acceptance", "undone", "ship"]);
		await mfwb(d, ["check", "TK-1", "acceptance", "edit", "c2", "release it"]);
		expect((await fields(d)).acceptance).toEqual([
			{ id: "c1", text: "write tests", done: true },
			{ id: "c2", text: "release it", done: false },
		]);
		await mfwb(d, ["check", "TK-1", "acceptance", "remove", "c1"]);
		expect(((await fields(d)).acceptance as unknown[]).length).toBe(1);
		const raw = await readFile(join(d, "tasks", "TK-1.md"), "utf8");
		expect(raw).toContain("  - id: c2\n    text: release it\n    done: false");
	});

	test("ambiguous and missing selectors list candidates", async () => {
		const d = await board();
		await mfwb(d, ["check", "TK-1", "acceptance", "add", "write a"]);
		await mfwb(d, ["check", "TK-1", "acceptance", "add", "write b"]);
		const amb = await mfwb(d, [
			"check",
			"TK-1",
			"acceptance",
			"toggle",
			"write",
		]);
		expect(amb.code).toBe(1);
		expect(amb.stderr).toContain('c1 "write a"');
		expect(amb.stderr).toContain('c2 "write b"');
		expect(
			(await mfwb(d, ["check", "TK-1", "acceptance", "toggle", "zzz"])).stderr,
		).toContain("no checklist item");
		expect(
			(await mfwb(d, ["check", "TK-1", "acceptance", "frobnicate", "x"])).code,
		).toBe(2);
	});

	test("create with checklist value syntax", async () => {
		const d = await board();
		await mfwb(d, ["create", "title=b", "acceptance=x,y"]);
		const r = await mfwb(d, ["show", "--json", "TK-2"]);
		expect(JSON.parse(r.stdout).fields.acceptance).toEqual([
			{ id: "c1", text: "x", done: false },
			{ id: "c2", text: "y", done: false },
		]);
		await mfwb(d, [
			"create",
			"title=c",
			'acceptance=[{"text":"q","done":true}]',
		]);
		const r3 = await mfwb(d, ["show", "--json", "TK-3"]);
		expect(JSON.parse(r3.stdout).fields.acceptance).toEqual([
			{ id: "c1", text: "q", done: true },
		]);
	});
});

describe("note and row commands", () => {
	test("note appends a timestamped entry under --section", async () => {
		const d = await board();
		await mfwb(d, ["note", "TK-1", "did", "a", "thing"]);
		await mfwb(d, ["note", "TK-1", "--section", "Decisions", "chose X"]);
		const body = JSON.parse(
			(await mfwb(d, ["show", "--json", "TK-1"])).stdout,
		).body;
		expect(body).toMatch(
			/^## Progress\n\n### \d{4}-\d\d-\d\dT[\d:]+Z - did a thing\n\n## Decisions\n\n### [\d\-T:Z]+ - chose X$/,
		);
	});

	test("row add / set / remove", async () => {
		const d = await board();
		await mfwb(d, ["row", "TK-1", "log", "add", '{"id":"r1","n":1}']);
		await mfwb(d, ["row", "TK-1", "log", "set", "r1", '{"n":2}']);
		expect((await fields(d)).log).toEqual([{ id: "r1", n: 2 }]);
		const bad = await mfwb(d, ["row", "TK-1", "log", "add", '{"n":1}']);
		expect(bad.code).toBe(1);
		expect(bad.stderr).toContain("missing required");
		expect(
			(await mfwb(d, ["row", "TK-1", "log", "add", "{nope"])).stderr,
		).toContain("valid JSON");
		await mfwb(d, ["row", "TK-1", "log", "remove", "r1"]);
		expect((await fields(d)).log).toEqual([]);
		expect((await mfwb(d, ["row", "TK-1", "labels", "add", "{}"])).code).toBe(
			1,
		);
	});
});

describe("verbs", () => {
	test("usage lists the new commands; a transition cannot reuse their names", async () => {
		const d = await board();
		const u = await mfwb(d, ["bogus"]);
		for (const v of [
			"append",
			"prepend",
			"insert",
			"remove",
			"move",
			"inc",
			"dec",
			"toggle",
			"unset",
			"check",
			"note",
			"row",
		]) {
			expect(u.stderr).toContain(`  ${v} `);
		}
		const { RESERVED_VERBS } = await import("@mfw/board-core");
		for (const verb of commands.map((c) => c.name)) {
			expect(RESERVED_VERBS.has(verb)).toBe(true);
		}
	});
});

describe("argument parsing", () => {
	async function bodyOf(d: string): Promise<string> {
		return JSON.parse((await mfwb(d, ["show", "--json", "TK-1"])).stdout).body;
	}

	test("-- makes the rest positional text (note, check add)", async () => {
		const d = await board();
		const n = await mfwb(d, ["note", "TK-1", "--", "--weird text a=b ~c"]);
		expect(n.code).toBe(0);
		expect(await bodyOf(d)).toContain("--weird text a=b ~c");
		const c = await mfwb(d, [
			"check",
			"TK-1",
			"acceptance",
			"add",
			"--",
			"--x=y",
		]);
		expect(c.code).toBe(0);
		expect((await fields(d)).acceptance).toBeDefined();
		expect(JSON.stringify(await fields(d))).toContain("--x=y");
	});

	test("an unknown flag without -- is a usage error that hints at --", async () => {
		const d = await board();
		const r = await mfwb(d, ["note", "TK-1", "--weird"]);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("--weird");
		expect(r.stderr).toContain("bare --");
	});

	test("= and ~ operands reach note text intact", async () => {
		const d = await board();
		expect((await mfwb(d, ["note", "TK-1", "x=1", "y~2"])).code).toBe(0);
		expect(await bodyOf(d)).toContain("x=1 y~2");
	});

	test("numeric flags must be non-negative integers", async () => {
		const d = await board();
		for (const [flag, v] of [
			["--base-rev", "abc"],
			["--base-rev", ""],
			["--base-rev", "-1"],
			["--base-rev", "1.5"],
			["--lease-ms", "abc"],
		] as const) {
			const r = await mfwb(d, ["note", "TK-1", flag, v, "t"]);
			expect(r.code).toBe(2);
			expect(r.stderr).toContain(`${flag} needs a non-negative integer`);
		}
	});
});
