import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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

const CLI = join(import.meta.dir, "../src/cli.ts");

function board(extraTask = "", extraTypes = ""): string {
	return `mfw: 1
types:
  task:
    layout: flat
    dir: tasks
    id: { strategy: own-sequence, key: TK }
${extraTask}    statusClasses:
      terminal: [done]
      live: [planned, doing]
      parked: [deferred]
    transitions:
      start: { from: [planned], to: doing }
      done: { from: [planned, doing], to: done, arg: outcome, date: closed }
      defer: { from: [planned, doing], to: deferred, arg: reopen_gate }
      reopen: { from: [deferred], to: planned, clear: [reopen_gate] }
    fields:
      title: {}
      status: { values: [planned, doing, done, deferred], default: planned }
      outcome: { optional: true }
      closed: { type: date, optional: true }
      reopen_gate: { optional: true }
${extraTypes}`;
}

const dirs: string[] = [];
async function tmp(prefix = "mfwb-tr-"): Promise<string> {
	const d = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	dirs.push(d);
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

/** A board dir with one task (TK-001) in `status`. */
async function fixture(opts: { yaml?: string; status?: string } = {}) {
	const dir = await tmp();
	await writeFile(join(dir, "board.yaml"), opts.yaml ?? board());
	const r = await mfwb(dir, [
		"create",
		"--type",
		"task",
		"--id",
		"TK-001",
		"title=Hello",
		`status=${opts.status ?? "planned"}`,
	]);
	expect(r.code).toBe(0);
	const file = join(dir, "tasks", "TK-001.md");
	return { dir, file };
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function initRepo(dir: string): void {
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "t@example.com");
	git(dir, "config", "user.name", "T");
	git(dir, "config", "commit.gpgsign", "false");
}

describe("transition verbs", () => {
	test("start moves status", async () => {
		const { dir, file } = await fixture();
		const r = await mfwb(dir, ["start", "TK-001"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("doing");
		expect(await readFile(file, "utf8")).toContain("status: doing");
	});

	test("transition text after -- may start with -- and contain = and ~", async () => {
		const { dir, file } = await fixture();
		const r = await mfwb(dir, ["done", "TK-001", "--", "--odd a=b ~c"]);
		expect(r.code).toBe(0);
		expect(await readFile(file, "utf8")).toContain("--odd a=b ~c");
	});

	test("terminal and parked transitions release a CLI claim; others keep it", async () => {
		for (const [verb, text, released] of [
			["done", "ok", true],
			["defer", "later", true],
			["start", undefined, false],
		] as const) {
			const { dir } = await fixture();
			const c = await mfwb(dir, [
				"claim",
				"TK-001",
				"--run",
				"r1",
				"--from",
				"planned",
			]);
			expect(c.code).toBe(0);
			const args = [verb, "TK-001", ...(text ? [text] : [])];
			expect((await mfwb(dir, args)).code).toBe(0);
			const lease = JSON.parse(
				await readFile(join(dir, "state", "tasks", "TK-001.json"), "utf8"),
			);
			expect(lease.claimedByRunId).toBe(released ? null : "r1");
		}
	});

	test("done requires text, sets outcome and today's date", async () => {
		const { dir, file } = await fixture();
		const bad = await mfwb(dir, ["done", "TK-001"]);
		expect(bad.code).toBe(2);
		const r = await mfwb(dir, ["done", "TK-001", "shipped a=b it"]);
		expect(r.code).toBe(0);
		const raw = await readFile(file, "utf8");
		expect(raw).toContain("status: done");
		expect(raw).toContain("shipped a=b it");
		expect(raw).toContain(`closed: ${new Date().toISOString().slice(0, 10)}`);
	});

	test("text is forbidden when the verb takes none", async () => {
		const { dir, file } = await fixture();
		const before = await readFile(file, "utf8");
		const r = await mfwb(dir, ["start", "TK-001", "why"]);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("takes no argument");
		expect(await readFile(file, "utf8")).toBe(before);
	});

	test("defer then reopen clears the gate", async () => {
		const { dir, file } = await fixture();
		expect((await mfwb(dir, ["defer", "TK-001", "needs infra"])).code).toBe(0);
		expect(await readFile(file, "utf8")).toContain("needs infra");
		expect((await mfwb(dir, ["reopen", "TK-001"])).code).toBe(0);
		const raw = await readFile(file, "utf8");
		expect(raw).not.toContain("deferred"); // back to the default, elided
		expect(raw).not.toContain("needs infra");
	});

	test("precondition failure exits 1 and leaves the file byte-identical", async () => {
		const { dir, file } = await fixture();
		const before = await readFile(file, "utf8");
		const r = await mfwb(dir, ["reopen", "TK-001"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("expected status deferred, got planned");
		expect(await readFile(file, "utf8")).toBe(before);
	});

	test("missing document exits nonzero", async () => {
		const { dir } = await fixture();
		const r = await mfwb(dir, ["start", "TK-999"]);
		expect(r.code).not.toBe(0);
	});

	test("--json prints the document JSON", async () => {
		const { dir } = await fixture();
		const r = await mfwb(dir, ["--json", "start", "TK-001"]);
		expect(r.code).toBe(0);
		const j = JSON.parse(r.stdout);
		expect(j.id).toBe("TK-001");
		expect(JSON.stringify(j)).toContain("doing");
	});

	test("unknown verb prints usage listing the declared verbs, exit 2", async () => {
		const { dir } = await fixture();
		const r = await mfwb(dir, ["frobnicate", "TK-001"]);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("start <id>");
		expect(r.stderr).toContain("planned -> doing");
		expect(r.stderr).toContain("done <id> <outcome>");
		expect(r.stderr).toContain("(takes text)");
		expect(r.stderr).toContain("list");
	});

	test("the date is never scanned from the text; --date sets it explicitly", async () => {
		const { dir, file } = await fixture();
		const r = await mfwb(dir, ["done", "TK-001", "landed 2025-03-04"]);
		expect(r.code).toBe(0);
		expect(await readFile(file, "utf8")).toContain(
			`closed: ${new Date().toISOString().slice(0, 10)}`,
		);
		const f2 = await fixture();
		const ok = await mfwb(f2.dir, [
			"done",
			"TK-001",
			"backfilled",
			"--date",
			"2025-03-04",
		]);
		expect(ok.stderr).toBe("");
		expect(ok.code).toBe(0);
		expect(await readFile(f2.file, "utf8")).toContain("closed: 2025-03-04");
		const f3 = await fixture();
		const bad = await mfwb(f3.dir, [
			"done",
			"TK-001",
			"x",
			"--date",
			"2025-13-40",
		]);
		expect(bad.code).toBe(2);
		expect(bad.stderr).toContain("real calendar date");
		const none = await mfwb(f3.dir, [
			"start",
			"TK-001",
			"--date",
			"2025-03-04",
		]);
		expect(none.code).toBe(2);
		expect(none.stderr).toContain("takes no date");
	});

	test("a verb on a type that does not declare it is a one-line error, exit 2", async () => {
		const second = `  note:
    layout: flat
    dir: notes
    id: { strategy: own-sequence, key: NT }
    fields:
      title: {}
`;
		const { dir } = await fixture({ yaml: board("", second) });
		const r = await mfwb(dir, ["start", "NT-1", "--type", "note"]);
		expect(r.code).toBe(2);
		expect(r.stderr).toBe(
			"type 'note' does not declare the 'start' transition (declared by: task)",
		);
		const bad = await mfwb(dir, ["done", "TK-001", "a", "b"]);
		expect(bad.code).toBe(2);
		expect(bad.stderr.split("\n")).toHaveLength(1);
		expect(bad.stderr).toContain("usage: mfwb done <id> [<text>]");
	});

	test("usage without a board shows only static commands", async () => {
		const dir = await tmp();
		const r = await mfwb(dir, ["frobnicate"]);
		expect(r.code).toBe(3);
		const r2 = await mfwb(dir, []);
		expect(r2.code).toBe(2);
		expect(r2.stderr).toContain("list");
		expect(r2.stderr).not.toContain("transition verbs");
	});

	test("a verb declared by several types resolves the type from the id", async () => {
		const second = `  note:
    layout: flat
    dir: notes
    id: { strategy: own-sequence, key: NT }
    statusClasses: { live: [planned, doing] }
    transitions:
      start: { from: [planned], to: doing }
    fields:
      title: {}
      status: { values: [planned, doing], default: planned }
`;
		const { dir } = await fixture({ yaml: board("", second) });
		// the id says which document is meant: no --type needed
		const ok = await mfwb(dir, ["start", "TK-001"]);
		expect(ok.code).toBe(0);
		const none = await mfwb(dir, ["start", "NT-9"]);
		expect(none.code).toBe(1);
		expect(none.stderr).toContain("no document 'NT-9'");
		// a verb only one type declares needs no --type
		expect((await mfwb(dir, ["done", "TK-001", "x"])).code).toBe(0);
	});
});

describe("--commit / --push", () => {
	test("commits only that file, with the default prefix", async () => {
		const { dir, file } = await fixture();
		initRepo(dir);
		git(dir, "add", "-A");
		git(dir, "commit", "-qm", "init");
		await writeFile(join(dir, "other.txt"), "dirty\n");
		git(dir, "add", "other.txt"); // staged and unrelated
		await writeFile(join(dir, "untracked.txt"), "x\n");
		const r = await mfwb(dir, ["done", "TK-001", "all good", "--commit"]);
		expect(r.code).toBe(0);
		expect(git(dir, "log", "-1", "--format=%s")).toBe("task: TK-001: all good");
		expect(git(dir, "show", "--name-only", "--format=", "HEAD")).toBe(
			"tasks/TK-001.md",
		);
		expect(git(dir, "status", "--porcelain", "other.txt")).toBe("A  other.txt");
		expect(await readFile(file, "utf8")).toContain("status: done");
	});

	test("an untracked document is added and committed; verb used when no text; 60 char cap", async () => {
		const { dir } = await fixture();
		initRepo(dir);
		const r = await mfwb(dir, ["start", "TK-001", "--commit"]);
		expect(r.code).toBe(0);
		expect(git(dir, "log", "-1", "--format=%s")).toBe("task: TK-001: start");
		await mfwb(dir, ["done", "TK-001", "x".repeat(100), "--commit"]);
		expect(git(dir, "log", "-1", "--format=%s")).toBe(
			`task: TK-001: ${"x".repeat(60)}`,
		);
	});

	test("configured commit.prefix", async () => {
		const yaml = board("    commit: { prefix: tasks }\n");
		const { dir } = await fixture({ yaml });
		initRepo(dir);
		const r = await mfwb(dir, ["start", "TK-001", "--commit"]);
		expect(r.code).toBe(0);
		expect(git(dir, "log", "-1", "--format=%s")).toBe("tasks: TK-001: start");
	});

	test("--push pushes to a local bare repo", async () => {
		const { dir } = await fixture();
		const bare = await tmp("mfwb-bare-");
		git(bare, "init", "-q", "--bare", "-b", "main");
		initRepo(dir);
		git(dir, "add", "-A");
		git(dir, "commit", "-qm", "init");
		git(dir, "remote", "add", "origin", bare);
		git(dir, "push", "-q", "-u", "origin", "main");
		const r = await mfwb(dir, ["start", "TK-001", "--push"]);
		expect(r.code).toBe(0);
		expect(git(bare, "log", "-1", "--format=%s", "main")).toBe(
			"task: TK-001: start",
		);
	});

	test("a failing push is reported after the write, exit 1", async () => {
		const { dir, file } = await fixture();
		initRepo(dir); // no remote
		git(dir, "add", "-A");
		git(dir, "commit", "-qm", "init");
		const r = await mfwb(dir, ["start", "TK-001", "--push"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("git push failed");
		expect(r.stderr).toContain("was transitioned");
		expect(await readFile(file, "utf8")).toContain("status: doing");
	});

	test("--commit outside a git tree errors but the transition applied", async () => {
		// A bare tmp dir is outside any repo (os tmpdir is not in a work tree).
		const { dir, file } = await fixture();
		const r = await mfwb(dir, ["start", "TK-001", "--commit"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("not inside a git work tree");
		expect(r.stderr).toContain("was transitioned");
		expect(await readFile(file, "utf8")).toContain("status: doing");
	});
});

describe("concurrency", () => {
	test("two concurrent done calls: exactly one wins", async () => {
		const { dir, file } = await fixture();
		await mkdir(dir, { recursive: true });
		const [a, b] = await Promise.all([
			mfwb(dir, ["done", "TK-001", "first"]),
			mfwb(dir, ["done", "TK-001", "second"]),
		]);
		const codes = [a.code, b.code].sort();
		expect(codes).toEqual([0, 1]);
		const loser = a.code === 1 ? a : b;
		expect(loser.stderr).toContain(
			"expected status planned or doing, got done",
		);
		expect(await readFile(file, "utf8")).toContain(
			a.code === 0 ? "first" : "second",
		);
	});
});
