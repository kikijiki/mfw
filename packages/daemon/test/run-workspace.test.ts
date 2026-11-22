import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/git.ts";
import { createRunWorkspace } from "../src/run-workspace/factory.ts";

const roots: string[] = [];

async function repo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "mfw-rw-"));
	roots.push(root);
	await git(["init", "-q", "-b", "main", "."], root);
	await git(["config", "user.email", "t@t"], root);
	await git(["config", "user.name", "t"], root);
	await writeFile(join(root, "a.txt"), "one\n");
	await git(["add", "-A"], root);
	await git(["commit", "-q", "-m", "init"], root);
	return root;
}

afterEach(async () => {
	for (const r of roots.splice(0)) {
		await rm(r, { recursive: true, force: true });
	}
});

describe("RunWorkspace over worktrees", () => {
	test("seed, paths, ownership and list agree", async () => {
		const root = await repo();
		const ws = createRunWorkspace(root);
		expect(ws.kind).toBe("worktree");
		const handle = await ws.seed("r1", "main");
		expect(handle.branch).toBe("mfw/r1");
		expect(handle.path).toBe(ws.paths("r1").workPath);
		expect(ws.paths("r1").root).toBe(join(root, "worktrees"));
		const owned = await ws.ownership(handle.path);
		expect(owned).toMatchObject({ runId: "r1", branch: "mfw/r1" });
		expect(owned?.baseSha).toBe(handle.baseSha);
		expect((await ws.list()).map((p) => p)).toContain(handle.path);
		expect(await ws.ownership(root)).toBeNull();
	});

	test("fetchResult reads the branch tip, null once the branch is gone", async () => {
		const root = await repo();
		const ws = createRunWorkspace(root);
		const handle = await ws.seed("r2", "main");
		expect(await ws.fetchResult(handle)).toEqual({
			ref: "mfw/r2",
			sha: handle.baseSha,
		});
		await writeFile(join(handle.path, "b.txt"), "two\n");
		await git(["add", "-A"], handle.path);
		await git(["commit", "-q", "-m", "work"], handle.path);
		const result = await ws.fetchResult(handle);
		expect(result.sha).not.toBeNull();
		expect(result.sha).not.toBe(handle.baseSha);
		await ws.remove(handle, { force: true, deleteBranch: true });
		expect((await ws.fetchResult(handle)).sha).toBeNull();
	});

	test("hasLocalChanges, remove refusal and removal", async () => {
		const root = await repo();
		const ws = createRunWorkspace(root);
		const handle = await ws.seed("r3", "main");
		expect(await ws.hasLocalChanges(handle)).toBe(false);
		await writeFile(join(handle.path, "scratch.txt"), "x\n");
		expect(await ws.hasLocalChanges(handle)).toBe(true);
		await expect(ws.remove(handle, { force: false })).rejects.toThrow(/dirty/);
		await ws.remove(handle, { force: true });
		expect(await ws.list()).not.toContain(handle.path);
	});

	test("archive and discard save work on a wip branch", async () => {
		const root = await repo();
		const ws = createRunWorkspace(root);
		const handle = await ws.seed("r4", "main");
		await writeFile(join(handle.path, "b.txt"), "two\n");
		const { archive, removed } = await ws.discard(handle, {
			runId: "r4",
			taskId: "T-1",
		});
		expect(removed).toBe(true);
		expect(archive?.ref).toStartWith("wip/");
		const tip = await git(["rev-parse", `refs/heads/${archive?.ref}`], root);
		expect(tip.stdout.trim()).toBe(archive?.sha ?? "");
		expect(await ws.ownership(handle.path)).toBeNull();
		expect((await ws.fetchResult(handle)).sha).toBeNull();
	});

	test("an unproven workspace is refused", async () => {
		const root = await repo();
		const ws = createRunWorkspace(root);
		await expect(
			ws.remove({
				path: join(root, "worktrees", "nope"),
				branch: "mfw/nope",
				baseSha: "0",
			}),
		).rejects.toThrow(/unproven/);
	});
});

describe("workspace seam", () => {
	test("only run-workspace/worktree-impl.ts imports WorktreeManager", () => {
		const srcRoot = join(import.meta.dir, "..", "src");
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const full = join(dir, name);
				if (statSync(full).isDirectory()) walk(full);
				else if (name.endsWith(".ts")) {
					const rel = full.slice(srcRoot.length + 1);
					if (rel === "worktree.ts") continue;
					if (rel === join("run-workspace", "worktree-impl.ts")) continue;
					if (/\bWorktreeManager\b/.test(readFileSync(full, "utf8"))) {
						offenders.push(rel);
					}
				}
			}
		};
		walk(srcRoot);
		// Comments may mention the class; code must not import it.
		const importing = offenders.filter((rel) =>
			/import[^;]*\bWorktreeManager\b[^;]*from/s.test(
				readFileSync(join(srcRoot, rel), "utf8"),
			),
		);
		expect(importing).toEqual([]);
	});
});
