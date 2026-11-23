import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitComplete, gitOk } from "../src/git.ts";
import { repoConfigRefusal } from "../src/host-git/repo-config.ts";

let base: string;
let repo: string;
let canary: string;
let payload: string;

/** Every hook event a queue merge, a ref move or a push can reach. */
const EVENTS = [
	"pre-merge-commit",
	"prepare-commit-msg",
	"commit-msg",
	"post-commit",
	"post-merge",
	"post-checkout",
	"post-rewrite",
	"pre-rebase",
	"reference-transaction",
	"pre-push",
];

beforeEach(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "mfw-allow-")));
	repo = join(base, "repo");
	canary = join(base, "canary");
	payload = join(base, "payload.sh");
	await writeFile(payload, `#!/bin/sh\ntouch "${canary}"\n`, { mode: 0o755 });
	await gitOk(["init", "-q", "-b", "main", repo], base);
	await gitOk(["config", "user.email", "t@t"], repo);
	await gitOk(["config", "user.name", "t"], repo);
	await writeFile(join(repo, "a.txt"), "one\n");
	await gitOk(["add", "-A"], repo);
	await gitOk(["commit", "-q", "-m", "base"], repo);
	await gitOk(["checkout", "-q", "-b", "side"], repo);
	await writeFile(join(repo, "b.txt"), "two\n");
	await gitOk(["add", "-A"], repo);
	await gitOk(["commit", "-q", "-m", "side"], repo);
	await gitOk(["checkout", "-q", "main"], repo);
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

describe("repository config allowlist", () => {
	for (const event of EVENTS) {
		test(`hook.* for ${event} is refused and never runs`, async () => {
			await gitOk(["config", "hook.x.event", event], repo);
			await gitOk(["config", "hook.x.command", payload], repo);
			const merged = await git(["merge", "--no-ff", "--no-edit", "side"], repo);
			expect(merged.exitCode).not.toBe(0);
			expect(merged.stderr).toContain("hook.x.event");
			expect(merged.stderr).toContain("Fix:");
			await git(["update-ref", "refs/heads/moved", "HEAD"], repo);
			expect(existsSync(canary)).toBe(false);
		});
	}

	test("a clean repository is allowed", async () => {
		expect(await repoConfigRefusal(repo)).toBeNull();
		expect((await git(["status", "--short"], repo)).exitCode).toBe(0);
	});

	for (const key of [
		"filter.evil.smudge",
		"merge.evil.driver",
		"diff.evil.textconv",
		"core.sshCommand",
		"core.gitProxy",
		"core.worktree",
		"core.attributesFile",
		"credential.helper",
		"include.path",
		"gpg.program",
		"remote.origin.pushurl",
		"remote.origin.receivepack",
		"url./tmp/evil.insteadOf",
		"url./tmp/evil.pushInsteadOf",
		"alias.st",
		"some.unknown.key",
	]) {
		test(`${key} is outside the allowlist`, async () => {
			await gitOk(["config", key, "x"], repo);
			const refusal = await repoConfigRefusal(repo);
			expect(refusal?.keys.join(" ").toLowerCase()).toContain(
				key.split(".").at(-1)?.toLowerCase() as string,
			);
			await expect(gitComplete(["log", "-1"], repo)).rejects.toThrow("Fix:");
		});
	}

	test("a key in config.worktree of a linked worktree is refused", async () => {
		const wt = join(base, "wt");
		await gitOk(["config", "extensions.worktreeConfig", "true"], repo);
		await gitOk(["worktree", "add", "-q", wt, "side"], repo);
		await gitOk(["config", "--worktree", "hook.x.command", payload], wt);
		expect((await repoConfigRefusal(wt))?.keys).toContain("hook.x.command");
	});

	test("changing the config invalidates an earlier clean answer", async () => {
		expect(await repoConfigRefusal(repo)).toBeNull();
		await gitOk(["config", "hook.x.command", payload], repo);
		expect((await repoConfigRefusal(repo))?.keys).toContain("hook.x.command");
	});

	test("the config can still be repaired after a refusal", async () => {
		await gitOk(["config", "hook.x.command", payload], repo);
		await gitOk(["config", "--unset", "hook.x.command"], repo);
		expect((await git(["status", "--short"], repo)).exitCode).toBe(0);
	});
});
