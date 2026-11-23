import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRunDirLayout } from "../src/containment/run-dir.ts";
import { git } from "../src/git.ts";
import { quarantineRef } from "../src/host-git/fetch.ts";
import {
	CloneRunWorkspace,
	type CloneWorkspaceOptions,
} from "../src/run-workspace/clone-impl.ts";
import {
	snapshotWip,
	type WipHelperEnv,
	watchWip,
} from "../src/run-workspace/wip-helper.ts";

/**
 * The host side of the clone result path. The helper runs in-process here; the
 * real sandbox is covered by `clone-wip-e2e.test.ts`.
 */

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setup(over: Partial<CloneWorkspaceOptions> = {}) {
	const root = realpathSync(await mkdtemp(join(tmpdir(), "mfw-wip-import-")));
	dirs.push(root);
	const p = join(root, "primary");
	await mkdir(p);
	await git(["init", "-q", "-b", "main", "."], p);
	await git(["config", "user.email", "t@t"], p);
	await git(["config", "user.name", "t"], p);
	await writeFile(join(p, "a.txt"), "one\n");
	await git(["add", "-A"], p);
	await git(["commit", "-q", "-m", "init"], p);
	const wsRoot = join(root, "home", "workspaces");
	const runDir = join(root, "state", "runs", "r1");
	const layout = ensureRunDirLayout(runDir);
	const control = join(layout.control, "control.jsonl");
	await writeFile(control, "");
	const state = {
		alive: false,
		snapshots: 0,
		snapshot: "real" as "real" | "fail" | "throw",
	};
	const env: WipHelperEnv = {
		runId: "r1",
		gitDir: join(wsRoot, "r1", "git"),
		workTree: join(wsRoot, "r1", "tree"),
		outbox: layout.outbox,
	};
	const ws = new CloneRunWorkspace(p, {
		workspaceRoot: wsRoot,
		scratchRoot: join(root, "home", "workspace-scratch"),
		runDirOf: () => runDir,
		controlPath: () => control,
		assertProcessesDead: () => {
			if (state.alive) throw new Error("still running");
		},
		finalSnapshot: {
			available: () => true,
			run: async () => {
				state.snapshots++;
				if (state.snapshot === "throw") throw new Error("probe refused");
				if (state.snapshot === "fail") return "failed";
				return (await snapshotWip(env, "final")).ok ? "ok" : "failed";
			},
		},
		...over,
	});
	const handle = await ws.seed("r1");
	const sbGit = (args: string[]) =>
		git(["-c", "user.name=a", "-c", "user.email=a@a", ...args], env.workTree, {
			env: { GIT_DIR: env.gitDir, GIT_WORK_TREE: env.workTree },
		});
	const refs = async () =>
		(await git(["for-each-ref", "--format=%(refname)", "refs/mfw/"], p)).stdout
			.split("\n")
			.filter(Boolean);
	return { root, p, ws, handle, env, sbGit, state, layout, control, refs };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function withHelper<T>(s: Setup, fn: () => Promise<T>): Promise<T> {
	const ac = new AbortController();
	const loop = watchWip(s.env, s.control, { pollMs: 10, signal: ac.signal });
	try {
		return await fn();
	} finally {
		ac.abort();
		await loop;
	}
}

describe("a live snapshot", () => {
	test("lands in the live namespace and is never the run's result", async () => {
		const s = await setup();
		s.state.alive = true;
		await writeFile(join(s.env.workTree, "live.txt"), "x\n");
		const out = await withHelper(s, () =>
			s.ws.requestWip(s.handle, { pollMs: 10 }),
		);
		expect(out.imported?.live).toBe(true);
		const refs = await s.refs();
		expect(refs).toContain("refs/mfw/quarantine-live/r1/head");
		expect(refs).toContain("refs/mfw/quarantine-live/r1/wip/1");
		expect(refs).not.toContain(quarantineRef("r1"));
	});

	test("concurrent requests are served one at a time", async () => {
		const s = await setup();
		s.state.alive = true;
		await writeFile(join(s.env.workTree, "c.txt"), "x\n");
		const all = await withHelper(s, () =>
			Promise.all([
				s.ws.requestWip(s.handle, { pollMs: 10 }),
				s.ws.requestWip(s.handle, { pollMs: 10 }),
				s.ws.requestWip(s.handle, { pollMs: 10 }),
			]),
		);
		expect(new Set(all.map((a) => a.ack.id)).size).toBe(3);
		for (const a of all) expect(a.ack.ok).toBe(true);
	});
});

describe("the end-of-run import", () => {
	test("takes a final snapshot once the run is dead and imports it", async () => {
		const s = await setup();
		await writeFile(join(s.env.workTree, "a.txt"), "committed\n");
		await s.sbGit(["add", "-A"]);
		await s.sbGit(["commit", "-q", "-m", "work"]);
		await writeFile(join(s.env.workTree, "pending.txt"), "uncommitted\n");
		const tip = (await s.sbGit(["rev-parse", "HEAD"])).stdout.trim();

		const res = await s.ws.fetchResult(s.handle);
		expect(res.sha).toBe(tip);
		expect(res.failure).toBeUndefined();
		expect(await s.refs()).toContain("refs/mfw/quarantine-wip/r1/1");
		await s.ws.fetchResult(s.handle);
		expect(s.state.snapshots).toBe(1);
	});

	test("does not snapshot or import while the run is alive", async () => {
		const s = await setup();
		s.state.alive = true;
		await expect(s.ws.fetchResult(s.handle)).rejects.toThrow(/not confirmed/);
		expect(s.state.snapshots).toBe(0);
		expect(await s.refs()).not.toContain(quarantineRef("r1"));
	});

	test("a bundle the agent left behind is never imported", async () => {
		const s = await setup();
		await writeFile(join(s.layout.outbox, "result.bundle"), "forged");
		s.state.snapshot = "fail";
		const res = await s.ws.fetchResult(s.handle);
		expect(res.sha).toBeNull();
		expect(res.failure).toBe("snapshot_failed");
		expect(existsSync(join(s.layout.outbox, "result.bundle"))).toBe(false);
	});

	test("a deleted gitdir fails closed, keeps the quarantine empty and is not retried", async () => {
		const s = await setup();
		await rm(s.env.gitDir, { recursive: true, force: true });
		const res = await s.ws.fetchResult(s.handle);
		expect(res).toMatchObject({ sha: null, failure: "snapshot_failed" });
		expect(await s.refs()).toEqual([]);
		await s.ws.fetchResult(s.handle);
		expect(s.state.snapshots).toBe(1);
		expect(await s.ws.hasLocalChanges(s.handle)).toBe(true);
	});

	test("corrupt objects fail closed", async () => {
		const s = await setup();
		await writeFile(join(s.env.workTree, "b.txt"), "b\n");
		await s.sbGit(["add", "-A"]);
		await s.sbGit(["commit", "-q", "-m", "b"]);
		const sha = (await s.sbGit(["rev-parse", "HEAD"])).stdout.trim();
		const obj = join(s.env.gitDir, "objects", sha.slice(0, 2), sha.slice(2));
		await rm(obj, { force: true });
		await writeFile(obj, "garbage");
		const res = await s.ws.fetchResult(s.handle);
		expect(res.sha).toBeNull();
		expect(res.failure).toBeDefined();
		expect(await s.refs()).not.toContain(quarantineRef("r1"));
	});

	test("a symlinked bundle is refused", async () => {
		const s = await setup();
		const secret = join(s.root, "host-secret");
		await writeFile(secret, "# v2 git bundle\nsecret\n\n");
		s.state.snapshot = "real";
		const ws = new CloneRunWorkspace(s.p, {
			workspaceRoot: join(s.root, "home", "workspaces"),
			scratchRoot: join(s.root, "home", "workspace-scratch"),
			runDirOf: () => join(s.root, "state", "runs", "r1"),
			assertProcessesDead: () => {},
			finalSnapshot: {
				available: () => true,
				run: async () => {
					await symlink(secret, join(s.layout.outbox, "result.bundle"));
					return "ok";
				},
			},
		});
		const res = await ws.fetchResult(s.handle);
		expect(res).toMatchObject({ sha: null, failure: "bad_bundle" });
	});

	test("an oversized bundle is refused by the budget", async () => {
		const s = await setup({ maxBundleBytes: 16 });
		const res = await s.ws.fetchResult(s.handle);
		expect(res).toMatchObject({ sha: null, failure: "bad_bundle" });
	});

	test("a launch that could not run is retried, not recorded as a bad result", async () => {
		const s = await setup();
		s.state.snapshot = "throw";
		await expect(s.ws.fetchResult(s.handle)).rejects.toThrow("probe refused");
		s.state.snapshot = "real";
		const res = await s.ws.fetchResult(s.handle);
		expect(res.sha).toBe(s.handle.baseSha);
		expect(res.failure).toBeUndefined();
	});

	test("after a failed import the last live sample can still be archived", async () => {
		const s = await setup();
		s.state.alive = true;
		await writeFile(join(s.env.workTree, "saved.txt"), "keep me\n");
		await withHelper(s, () => s.ws.requestWip(s.handle, { pollMs: 10 }));
		s.state.alive = false;
		s.state.snapshot = "fail";
		expect((await s.ws.fetchResult(s.handle)).sha).toBeNull();
		const archive = await s.ws.archive(s.handle, { runId: "r1", taskId: "T" });
		expect(archive?.ref).toBe("wip/T-r1");
		expect((await git(["show", "wip/T-r1:saved.txt"], s.p)).stdout.trim()).toBe(
			"keep me",
		);
	});
});
