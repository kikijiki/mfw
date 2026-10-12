import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../src/cli.ts");

const BOARD = [
	"mfw: 1",
	"types:",
	"  task:",
	"    layout: flat",
	"    dir: tasks",
	"    id: { strategy: own-sequence, key: TK }",
	"    statusClasses:",
	"      terminal: [done]",
	"      live: [todo, doing]",
	"      queued: [todo]",
	"    transitions:",
	"      done: { from: [todo, doing], to: done, arg: outcome }",
	"    rules:",
	"      - id: done-resolved",
	"        field: acceptance",
	"        when: { status: done }",
	"        forbid: { result: pending }",
	"      - id: no-red",
	"        field: acceptance",
	"        key: text",
	"        must_match: 'red|mutation'",
	"        flags: i",
	"        severity: advisory",
	"    fields:",
	"      title: {}",
	"      outcome: { optional: true }",
	"      status: { values: [todo, doing, done], default: todo }",
	"      acceptance: { type: json, list: true, optional: true, rows: { required: [id, text] } }",
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

async function board(rows: unknown[] = []) {
	const d = await realpath(await mkdtemp(join(tmpdir(), "mfwb-rul-")));
	dirs.push(d);
	await writeFile(join(d, "board.yaml"), BOARD);
	const args = ["create", "title=t"];
	if (rows.length > 0) args.push(`acceptance=${JSON.stringify(rows)}`);
	expect((await mfwb(d, args)).code).toBe(0);
	return d;
}

const PENDING = [
	{ id: "SC-1", text: "turns red when reverted", result: "pending" },
];

describe("field rules at the command line", () => {
	test("the done verb refuses and lists the offending row ids", async () => {
		const d = await board(PENDING);
		const r = await mfwb(d, ["done", "TK-1", "shipped"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("done-resolved");
		expect(r.stderr).toContain("SC-1");
		expect(r.stderr).toContain("--override done-resolved");
		const shown = JSON.parse(
			(await mfwb(d, ["show", "TK-1", "--json"])).stdout,
		);
		expect(shown.fields.status).toBe("todo");
	});

	test("so does `update status=done`", async () => {
		const d = await board(PENDING);
		const r = await mfwb(d, ["update", "TK-1", "status=done"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("SC-1");
	});

	test("resolving the row first lets it through", async () => {
		const d = await board(PENDING);
		const set = await mfwb(d, [
			"row",
			"TK-1",
			"acceptance",
			"set",
			"SC-1",
			'{"id":"SC-1","text":"turns red when reverted","result":"pass"}',
		]);
		expect(set.code).toBe(0);
		expect((await mfwb(d, ["done", "TK-1", "shipped"])).code).toBe(0);
	});

	test("--override passes the write and says so on stderr", async () => {
		const d = await board(PENDING);
		const r = await mfwb(d, [
			"done",
			"TK-1",
			"shipped",
			"--override",
			"done-resolved",
		]);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("override: done-resolved on task TK-1");
		// check still reports it
		const c = await mfwb(d, ["check"]);
		expect(c.code).toBe(1);
		expect(c.stdout).toContain("error done-resolved task TK-1");
	});

	test("--override of an unknown or advisory rule is a usage error", async () => {
		const d = await board(PENDING);
		expect(
			(await mfwb(d, ["done", "TK-1", "x", "--override", "nope"])).code,
		).toBe(2);
		const adv = await mfwb(d, ["done", "TK-1", "x", "--override", "no-red"]);
		expect(adv.code).toBe(2);
		expect(adv.stderr).toContain("advisory");
	});

	test("check rejects --override: it always reports every violation", async () => {
		const d = await board();
		expect((await mfwb(d, ["check", "--override", "done-resolved"])).code).toBe(
			2,
		);
	});

	test("advisory rules print, pass, and fail under --strict", async () => {
		const d = await board([
			{ id: "SC-1", text: "plain assertion", result: "pass" },
		]);
		const r = await mfwb(d, ["check"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("advisory no-red task TK-1: acceptance SC-1");
		expect((await mfwb(d, ["check", "--strict"])).code).toBe(1);
		expect(
			(await mfwb(d, ["check", "--rule", "no-red", "TK-1"])).stdout,
		).toContain("no-red");
	});

	test("check --list includes the configured rules", async () => {
		const d = await board();
		const r = JSON.parse(
			(await mfwb(d, ["check", "--list", "--json"])).stdout,
		) as {
			id: string;
			kind: string;
			severity: string;
			type?: string;
		}[];
		const rule = r.find((x) => x.id === "done-resolved");
		expect(rule).toMatchObject({
			kind: "field",
			severity: "error",
			type: "task",
		});
	});
});
