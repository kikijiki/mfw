import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitOk } from "../src/git.ts";
import { runProc } from "../src/proc.ts";
import { bwrapCore, pinnedTool } from "../src/sandbox.ts";

const bwrap = pinnedTool("bwrap");
const live = bwrap ? describe : describe.skip;
if (!bwrap && process.env.MFW_REQUIRE_LIVE_SANDBOX === "1") {
	throw new Error("MFW_REQUIRE_LIVE_SANDBOX=1 but bwrap is not available");
}

let base: string;
let repo: string;
let wt: string;

async function inSandbox(script: string) {
	const core = bwrapCore({
		bwrapPath: bwrap as string,
		cwd: wt,
		runDir: join(base, "rundir"),
		isolation: { mode: "bwrap", hidePaths: [] },
		journalDirs: [],
	});
	return runProc(
		[
			...core,
			"--setenv",
			"PATH",
			process.env.PATH ?? "",
			"--setenv",
			"HOME",
			"/tmp",
			"--chdir",
			wt,
			"--",
			"/bin/sh",
			"-c",
			script,
		],
		{ cwd: wt },
	);
}

beforeEach(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "mfw-gitdir-")));
	repo = join(base, "repo");
	wt = join(base, "wt");
	await runProc(["mkdir", "-p", join(base, "rundir")], { cwd: base });
	await gitOk(["init", "-q", "-b", "main", repo], base);
	await gitOk(["config", "user.email", "t@t"], repo);
	await gitOk(["config", "user.name", "t"], repo);
	await writeFile(join(repo, "a.txt"), "one\n");
	await gitOk(["add", "-A"], repo);
	await gitOk(["commit", "-q", "-m", "base"], repo);
	await gitOk(["worktree", "add", "-q", "-b", "mfw/run1", wt, "main"], repo);
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

live("a worktree sandbox and the primary gitdir", () => {
	test("the run can still commit on its own branch", async () => {
		const r = await inSandbox(
			"echo two > b.txt && git add b.txt && git commit -q -m work && git rev-parse HEAD",
		);
		expect(r.stderr).toBe("");
		expect(r.exitCode).toBe(0);
		expect(await gitOk(["rev-parse", "mfw/run1"], repo)).toBe(r.stdout.trim());
	});

	test("the reviewer's exploit cannot write the shared config", async () => {
		const before = readFileSync(join(repo, ".git/config"), "utf8");
		const r = await inSandbox("git config hook.x.command /tmp/payload");
		expect(r.exitCode).not.toBe(0);
		expect(readFileSync(join(repo, ".git/config"), "utf8")).toBe(before);
	});

	test("hooks, the target branch and refs/replace are read-only", async () => {
		const main = await gitOk(["rev-parse", "main"], repo);
		const r = await inSandbox(
			[
				`touch ${join(repo, ".git/hooks/pre-push")} 2>/dev/null && echo hook`,
				`git update-ref refs/heads/main HEAD~0 2>/dev/null; echo two > c; git add c; git commit -q -m c; git update-ref refs/heads/main HEAD 2>/dev/null && echo moved`,
				"git replace HEAD~1 HEAD 2>/dev/null && echo replaced",
				"true",
			].join("\n"),
		);
		expect(r.stdout).not.toContain("hook");
		expect(r.stdout).not.toContain("moved");
		expect(r.stdout).not.toContain("replaced");
		expect(existsSync(join(repo, ".git/hooks/pre-push"))).toBe(false);
		expect(await gitOk(["rev-parse", "main"], repo)).toBe(main);
	});
});
