import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/git.ts";
import { HostGit } from "../src/host-git/runner.ts";
import { runProc } from "../src/proc.ts";
import {
	clearRunWorkspace,
	configureRunWorkspace,
} from "../src/run-workspace/factory.ts";
import { createRoleClone } from "../src/run-workspace/role-clone.ts";
import { seedWorkspace } from "../src/run-workspace/seed.ts";
import { VerifierClones } from "../src/run-workspace/verifier-clone.ts";

/**
 * Security review P7, H2 (X6): a "one commit" clone held the project's whole
 * object store, so any role could read other branches, quarantined work and
 * secrets deleted from history with `git cat-file`.
 */

let base: string;
let primary: string;
let workspaces: string;
let tip: string;
let otherBranchBlob: string;
let deletedBlob: string;
let tipBlob: string;

const blobOf = async (content: string) => {
	const r = await runProc(["git", "hash-object", "--stdin"], {
		input: content,
		timeoutMs: 5000,
	});
	return r.stdout.trim();
};

/** Whether a gitdir can produce this object. */
const has = async (gitDir: string, oid: string) =>
	(
		await runProc(["git", `--git-dir=${gitDir}`, "cat-file", "-e", oid], {
			timeoutMs: 5000,
			hostGitChecked: true,
		})
	).exitCode === 0;

beforeEach(async () => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "mfw-seed-objects-")));
	primary = join(base, "primary");
	workspaces = join(base, "home", "workspaces");
	mkdirSync(primary);
	await git(["init", "-q", "-b", "main"], primary);
	await git(["config", "user.email", "t@t"], primary);
	await git(["config", "user.name", "t"], primary);
	writeFileSync(join(primary, "secret.txt"), "deleted-from-history\n");
	await git(["add", "-A"], primary);
	await git(["commit", "-q", "-m", "with secret"], primary);
	await git(["checkout", "-q", "-b", "other"], primary);
	writeFileSync(join(primary, "other.txt"), "only-on-another-branch\n");
	await git(["add", "-A"], primary);
	await git(["commit", "-q", "-m", "other"], primary);
	await git(["checkout", "-q", "main"], primary);
	await git(["rm", "-q", "secret.txt"], primary);
	writeFileSync(join(primary, "a.txt"), "at-the-tip\n");
	await git(["add", "-A"], primary);
	await git(["commit", "-q", "-m", "remove secret"], primary);
	tip = (await git(["rev-parse", "HEAD"], primary)).stdout.trim();
	otherBranchBlob = await blobOf("only-on-another-branch\n");
	deletedBlob = await blobOf("deleted-from-history\n");
	tipBlob = await blobOf("at-the-tip\n");
	// Positive control: the primary really holds all three.
	const primaryGit = join(primary, ".git");
	expect(await has(primaryGit, otherBranchBlob)).toBe(true);
	expect(await has(primaryGit, deletedBlob)).toBe(true);
	expect(await has(primaryGit, tipBlob)).toBe(true);
	configureRunWorkspace(primary, {
		kind: "worktree",
		clone: { workspaceRoot: workspaces },
	});
});

afterEach(async () => {
	clearRunWorkspace(primary);
	await rm(base, { recursive: true, force: true });
});

const host = () =>
	new HostGit({ workspaceRoot: workspaces, ownedRoots: [primary] });

describe("what a seeded clone holds", () => {
	test("a task clone has its history but no other branch", async () => {
		const r = await seedWorkspace({
			runId: "task-run",
			workspaceRoot: workspaces,
			primaryRoot: primary,
			baseSha: tip,
			host: host(),
		});
		expect(await has(r.gitDir, tipBlob)).toBe(true);
		expect(await has(r.gitDir, deletedBlob)).toBe(true);
		expect(await has(r.gitDir, otherBranchBlob)).toBe(false);
	});

	test("a verifier clone holds the commit alone", async () => {
		const clones = new VerifierClones({
			workspaceRoot: workspaces,
			primaryRoot: primary,
		});
		const clone = await clones.create(tip, "h2");
		const gitDir = join(clone.path, "..", "git");
		expect(await has(gitDir, tipBlob)).toBe(true);
		expect(await has(gitDir, deletedBlob)).toBe(false);
		expect(await has(gitDir, otherBranchBlob)).toBe(false);
		const log = await runProc(
			["git", `--git-dir=${gitDir}`, "log", "--format=%H"],
			{ timeoutMs: 5000, hostGitChecked: true },
		);
		expect(log.exitCode).toBe(0);
		expect(log.stdout.trim()).toBe(tip);
		await clone.dispose();
	});

	test("a read-only role's clone holds the commit alone", async () => {
		const clone = await createRoleClone(primary, "role-h2", tip);
		const gitDir = join(clone.root, "git");
		expect(await has(gitDir, tipBlob)).toBe(true);
		expect(await has(gitDir, deletedBlob)).toBe(false);
		expect(await has(gitDir, otherBranchBlob)).toBe(false);
	});
});
