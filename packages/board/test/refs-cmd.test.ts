import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CLI = join(import.meta.dir, "../src/cli.ts");

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

const BOARD = (extra = "") =>
	[
		"mfw: 1",
		"roots:",
		"  code: code",
		"refs:",
		"  - id: held-markers",
		"    root: code",
		"    paths: ['src/**/*.rs']",
		"    pattern: 'held for (?<id>TK-\\d+)'",
		"    to: task",
		"    status: [todo, doing]",
		extra,
		"types:",
		"  task:",
		"    layout: flat",
		"    dir: tasks",
		"    id: { strategy: own-sequence, key: TK }",
		"    fields:",
		"      title: {}",
		"      status: { values: [todo, doing, done], default: todo }",
	].join("\n");

async function setup(files: Record<string, string>, yaml = BOARD()) {
	const d = await realpath(await mkdtemp(join(tmpdir(), "mfwb-ref-")));
	dirs.push(d);
	await writeFile(join(d, "board.yaml"), yaml);
	for (const [title, status] of [
		["live", "todo"],
		["finished", "done"],
	] as const) {
		expect(
			(await mfwb(d, ["create", `title=${title}`, `status=${status}`])).code,
		).toBe(0);
	}
	for (const [p, text] of Object.entries(files)) {
		await mkdir(dirname(join(d, "code", p)), { recursive: true });
		await writeFile(join(d, "code", p), text);
	}
	return d;
}

describe("refs", () => {
	test("a marker naming a live card passes; done and unknown ids fail with file:line", async () => {
		const d = await setup({
			"src/a.rs": "// ok\nfn a() {} // held for TK-1\n",
			"src/b.rs": "x\n// held for TK-2 and held for TK-9\n",
		});
		const r = await mfwb(d, ["check"]);
		expect(r.code).toBe(1);
		expect(r.stdout).toContain(
			"error held-markers code/src/b.rs:2: refers to TK-2, which is done (allowed: todo, doing)",
		);
		expect(r.stdout).toContain(
			"code/src/b.rs:2: refers to unknown task 'TK-9'",
		);
		expect(r.stdout).not.toContain("a.rs");
	});

	test("an id is never read out of a longer one; a foreign id is reported", async () => {
		const yaml = BOARD().replace("TK-\\d+", "[A-Z]+-\\d{1,2}");
		const d = await setup(
			{ "src/a.rs": "held for TK-1x\nheld for TK-123\nheld for FOO-7\n" },
			yaml,
		);
		const r = await mfwb(d, ["check", "--json"]);
		const msgs = JSON.parse(r.stdout).issues.map(
			(i: { message: string }) => i.message,
		);
		// TK-1x: capture TK-1 is followed by a word character, so it is skipped;
		// TK-123 captures TK-12 then '3' follows: skipped too; FOO-7 is not a task id.
		expect(msgs).toEqual(["'FOO-7' is not a task id"]);
	});

	test("--board-only skips it; --rule selects it", async () => {
		const d = await setup({ "src/a.rs": "held for TK-2\n" });
		expect((await mfwb(d, ["check", "--board-only"])).code).toBe(0);
		expect((await mfwb(d, ["check", "--rule", "held-markers"])).code).toBe(1);
	});

	test("a missing root is exit 3 (not an issue); --root and MFWB_ROOT_CODE repoint it", async () => {
		const d = await setup({ "src/a.rs": "held for TK-1\n" });
		await rm(join(d, "code"), { recursive: true });
		const gone = await mfwb(d, ["check"]);
		expect(gone.code).toBe(3);
		expect(gone.stderr).toContain("--root code=<path>");
		expect((await mfwb(d, ["check", "--board-only"])).code).toBe(0);
		await mkdir(join(d, "elsewhere", "src"), { recursive: true });
		await writeFile(join(d, "elsewhere", "src", "a.rs"), "held for TK-2\n");
		const flag = await mfwb(d, ["check", "--root", "code=elsewhere"]);
		expect(flag.code).toBe(1);
		expect(flag.stdout).toContain("TK-2");
	});

	test("honours .gitignore in a git work tree and skips binary files", async () => {
		const d = await setup({
			"src/keep.rs": "held for TK-1\n",
			"src/ignored.rs": "held for TK-2\n",
			"src/blob.rs": "held for TK-2\0\n",
			".gitignore": "src/ignored.rs\n",
		});
		const g = Bun.spawnSync(["git", "init", "-q"], { cwd: join(d, "code") });
		expect(g.exitCode).toBe(0);
		const r = await mfwb(d, ["check"]);
		expect(r.stdout).not.toContain("ignored.rs");
		expect(r.stdout).toContain(
			"advisory held-markers code/src/blob.rs: not scanned (binary)",
		);
		expect(r.code).toBe(0); // only advisory notes remain
	});

	test("config errors: undeclared root, no (?<id>) group, status not a value", async () => {
		const bad = async (from: string, to: string) => {
			const d = await realpath(await mkdtemp(join(tmpdir(), "mfwb-ref-")));
			dirs.push(d);
			await writeFile(join(d, "board.yaml"), BOARD().replace(from, to));
			return mfwb(d, ["check"]);
		};
		expect((await bad("root: code", "root: nowhere")).code).toBe(3);
		expect((await bad("(?<id>TK-\\d+)", "TK-\\d+")).code).toBe(3);
		expect((await bad("[todo, doing]", "[todo, nonsense]")).code).toBe(3);
	});
});
