import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { git, gitOk } from "../src/git.ts";
import { registerRunWorkspaceRoot } from "../src/host-git/legacy-guard.ts";
import { runProc } from "../src/proc.ts";
import { CloneRunWorkspace } from "../src/run-workspace/clone-impl.ts";
import {
	clearRunWorkspace,
	configureRunWorkspace,
	createCheckClones,
	createRunWorkspace,
} from "../src/run-workspace/factory.ts";

/**
 * Security review P5b, B1: a clone's tree is agent-writable, so a planted
 * `.git` with `core.fsmonitor` runs on the host the moment plain git is pointed
 * at it. Every legacy helper must refuse any path under the workspace root.
 */

let base: string;
let workspaces: string;
let tree: string;
let canary: string;

/** The tree an agent leaves behind: its own `.git`, with a hook to the host. */
async function plant(dir: string, marker: string): Promise<string> {
	mkdirSync(dir, { recursive: true });
	const raw = (args: string[]) =>
		Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe" });
	raw(["init", "-q", "-b", "main"]);
	writeFileSync(join(dir, "f"), "x\n");
	raw(["add", "f"]);
	raw([
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@localhost",
		"commit",
		"-q",
		"-m",
		"c",
	]);
	const sha = raw(["rev-parse", "HEAD"]).stdout.toString().trim();
	writeFileSync(
		join(dir, ".pwn.sh"),
		`#!/bin/sh\necho HOST_EXEC > '${marker}'\n`,
	);
	chmodSync(join(dir, ".pwn.sh"), 0o755);
	raw(["config", "core.fsmonitor", "./.pwn.sh"]);
	return sha;
}

beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "mfw-b1-")));
	workspaces = join(base, "mfw/workspaces");
	tree = join(workspaces, "r1/tree");
	canary = join(base, "HOST_EXEC");
	registerRunWorkspaceRoot(workspaces);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("every run workspace is a clone", () => {
	const project = () => join(base, "project");

	test("an attached project's runs get private clones and check clones", () => {
		mkdirSync(project());
		configureRunWorkspace(project(), { workspaceRoot: workspaces });
		try {
			expect(createRunWorkspace(project())).toBeInstanceOf(CloneRunWorkspace);
			expect(createRunWorkspace(project()).paths("r1").workPath).toBe(tree);
			expect(createCheckClones(project())).not.toBeNull();
		} finally {
			clearRunWorkspace(project());
		}
	});

	test("a project that never attached has no workspace, rather than a fallback", () => {
		expect(() => createRunWorkspace(join(base, "unconfigured"))).toThrow(
			"no run workspace settings",
		);
		expect(createCheckClones(join(base, "unconfigured"))).toBeNull();
	});
});

describe("B1: legacy host git refuses a run workspace", () => {
	test("positive control: plain git fires the planted fsmonitor outside the root", async () => {
		const outside = join(base, "outside");
		await plant(outside, canary);
		Bun.spawnSync(["git", "status"], { cwd: outside, stdout: "pipe" });
		expect(existsSync(canary)).toBe(true);
	});

	test("the hardened runner does not fire it, even outside the root", async () => {
		const outside = join(base, "outside");
		await plant(outside, canary);
		await git(["status"], outside);
		expect(existsSync(canary)).toBe(false);
	});

	test.each([
		["git()", () => git(["status"], tree)],
		["gitOk()", () => gitOk(["status"], tree)],
		["a subdirectory", () => git(["status"], join(tree, "sub"))],
		["runProc", () => runProc(["git", "status"], { cwd: tree })],
		["-C", () => runProc(["git", "-C", tree, "status"], { cwd: base })],
		[
			"--git-dir=",
			() => runProc(["git", `--git-dir=${tree}/.git`, "status"], { cwd: base }),
		],
		[
			"--work-tree",
			() =>
				runProc(["git", "--work-tree", tree, "status"], {
					cwd: base,
				}),
		],
		[
			"GIT_DIR",
			() =>
				runProc(["git", "status"], {
					cwd: base,
					env: { ...process.env, GIT_DIR: join(tree, ".git") },
				}),
		],
		[
			"GIT_WORK_TREE",
			() => git(["status"], base, { env: { GIT_WORK_TREE: tree } }),
		],
	])("%s is refused", async (_name, call) => {
		await plant(tree, canary);
		mkdirSync(join(tree, "sub"), { recursive: true });
		await expect(call()).rejects.toThrow("run workspace");
		expect(existsSync(canary)).toBe(false);
	});

	test("a symlink into the root is resolved and refused", async () => {
		await plant(tree, canary);
		const link = join(base, "innocent");
		symlinkSync(tree, link);
		await expect(git(["status"], link)).rejects.toThrow("run workspace");
		expect(existsSync(canary)).toBe(false);
	});

	test("a sibling path that only shares the prefix still works", async () => {
		const sibling = join(base, "mfw/workspaces-other");
		await plant(sibling, join(base, "unused"));
		expect((await git(["rev-parse", "HEAD"], sibling)).exitCode).toBe(0);
	});

	test("only the HostGit-owned callers may skip the guard", () => {
		const src = resolve(import.meta.dir, "../src");
		const users: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const p = join(dir, entry.name);
				if (entry.isDirectory()) walk(p);
				else if (
					p.endsWith(".ts") &&
					readFileSync(p, "utf8").includes("hostGitChecked: true")
				) {
					users.push(p.slice(src.length + 1));
				}
			}
		};
		walk(src);
		expect(users.sort()).toEqual([
			"host-git/runner.ts",
			"run-workspace/rebase-clone.ts",
			"run-workspace/seed.ts",
		]);
	});
});
