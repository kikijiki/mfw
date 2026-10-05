import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitMessage, GitError, git, isInsideWorkTree } from "../src/git.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
	const d = await realpath(await mkdtemp(join(tmpdir(), "mfwb-git-")));
	dirs.push(d);
	return d;
}

test("commitMessage formats, collapses whitespace and caps at 60", () => {
	expect(commitMessage("task", "TK-1", "start")).toBe("task: TK-1: start");
	expect(commitMessage("t", "A", "done", "a\n  b")).toBe("t: A: a b");
	expect(commitMessage("t", "A", "done", "y".repeat(80))).toBe(
		`t: A: ${"y".repeat(60)}`,
	);
});

test("git surfaces stderr in a GitError", async () => {
	const d = await tmp();
	const e = await git(["status"], d).catch((x) => x);
	expect(e).toBeInstanceOf(GitError);
	expect((e as GitError).stderr).toContain("not a git repository");
});

test("isInsideWorkTree", async () => {
	const d = await tmp();
	expect(await isInsideWorkTree(d)).toBe(false);
	await git(["init", "-q"], d);
	expect(await isInsideWorkTree(d)).toBe(true);
});

test("a held index.lock is retried until it clears", async () => {
	const d = await tmp();
	await git(["init", "-q"], d);
	await git(["config", "user.email", "t@example.com"], d);
	await git(["config", "user.name", "T"], d);
	await writeFile(join(d, "f.txt"), "x");
	const lock = join(d, ".git", "index.lock");
	await writeFile(lock, "");
	const release = setTimeout(() => void unlink(lock), 300);
	await git(["add", "--", "f.txt"], d); // blocked by the lock, then succeeds
	clearTimeout(release);
	expect(await git(["status", "--porcelain"], d)).toContain("A  f.txt");
});

test("a lock that never clears still fails with git's own message", async () => {
	const d = await tmp();
	await git(["init", "-q"], d);
	await writeFile(join(d, "f.txt"), "x");
	await writeFile(join(d, ".git", "index.lock"), "");
	const e = await git(["add", "--", "f.txt"], d).catch((x) => x);
	expect(e).toBeInstanceOf(GitError);
	expect((e as GitError).stderr).toContain("index.lock");
}, 15000);
