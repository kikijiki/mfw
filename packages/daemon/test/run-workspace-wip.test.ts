import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { git } from "../src/git.ts";
import {
	HostGit,
	type HostGitResult,
	type HostGitRunOpts,
} from "../src/host-git/runner.ts";
import { CloneRunWorkspace } from "../src/run-workspace/clone-impl.ts";
import {
	parseWipControl,
	snapshotWip,
	type WipHelperEnv,
	watchWip,
	wipControlLine,
} from "../src/run-workspace/wip-helper.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setup() {
	const root = await mkdtemp(join(tmpdir(), "mfw-wip-"));
	dirs.push(root);
	const p = join(root, "primary");
	await mkdir(p);
	await git(["init", "-q", "-b", "main", "."], p);
	await git(["config", "user.email", "t@t"], p);
	await git(["config", "user.name", "t"], p);
	await writeFile(join(p, "a.txt"), "one\n");
	await writeFile(join(p, ".gitignore"), "ignored.txt\n");
	await git(["add", "-A"], p);
	await git(["commit", "-q", "-m", "init"], p);
	const wsRoot = join(root, "home", "workspaces");
	const runDir = join(root, "home", "runs", "r1");
	await mkdir(runDir, { recursive: true });
	const control = join(runDir, "control.jsonl");
	await writeFile(control, "");
	const calls: { args: string[]; cwd?: string; repo?: string }[] = [];
	class SpyHostGit extends HostGit {
		override async run(
			args: string[],
			opts: HostGitRunOpts,
		): Promise<HostGitResult> {
			calls.push({ args, cwd: opts.cwd, repo: opts.repo });
			return super.run(args, opts);
		}
	}
	const scratch = join(root, "home", "workspace-scratch");
	const host = new SpyHostGit({
		workspaceRoot: wsRoot,
		ownedRoots: [scratch],
	});
	const ws = new CloneRunWorkspace(p, {
		workspaceRoot: wsRoot,
		scratchRoot: scratch,
		host,
		controlPath: () => control,
		assertProcessesDead: () => {},
		assertQuiescent: () => {},
	});
	const handle = await ws.seed("r1");
	const dir = join(wsRoot, "r1");
	const env: WipHelperEnv = {
		runId: "r1",
		gitDir: join(dir, "git"),
		workTree: join(dir, "tree"),
		outbox: join(dir, "outbox"),
	};
	// What the sandbox does before the agent starts: be on the run branch.
	const sbGit = (args: string[]) =>
		git(["-c", "core.hooksPath=/dev/null", ...args], env.workTree, {
			env: { GIT_DIR: env.gitDir, GIT_WORK_TREE: env.workTree },
		});
	await sbGit(["checkout", "-q", "mfw/r1"]);
	return { root, p, wsRoot, ws, handle, env, sbGit, calls, control };
}

describe("wip control protocol", () => {
	test("parses only well-formed wip requests", () => {
		expect(parseWipControl(wipControlLine("ab12").trim())).toEqual({
			type: "wip",
			id: "ab12",
		});
		expect(parseWipControl('{"type":"steer","message":"x"}')).toBeNull();
		expect(parseWipControl('{"type":"wip","id":"../x"}')).toBeNull();
		expect(parseWipControl("not json")).toBeNull();
		expect(() => wipControlLine("a b")).toThrow();
	});
});

describe("snapshotWip (in the sandbox)", () => {
	test("commits edits and untracked files, not ignored ones, and leaves HEAD and the index alone", async () => {
		const s = await setup();
		await writeFile(join(s.env.workTree, "a.txt"), "edited\n");
		await writeFile(join(s.env.workTree, "new.txt"), "new\n");
		await writeFile(join(s.env.workTree, "ignored.txt"), "secret\n");
		const headBefore = (await s.sbGit(["rev-parse", "HEAD"])).stdout;
		const statusBefore = (await s.sbGit(["status", "--porcelain"])).stdout;

		const ack = await snapshotWip(s.env, "q1");
		expect(ack).toMatchObject({ id: "q1", ok: true, n: 1 });
		expect((await s.sbGit(["rev-parse", "HEAD"])).stdout).toBe(headBefore);
		expect((await s.sbGit(["status", "--porcelain"])).stdout).toBe(
			statusBefore,
		);
		const files = (
			await s.sbGit(["ls-tree", "-r", "--name-only", "mfw-wip/r1/1"])
		).stdout.split("\n");
		expect(files).toContain("new.txt");
		expect(files).not.toContain("ignored.txt");
		expect((await s.sbGit(["show", "mfw-wip/r1/1:a.txt"])).stdout.trim()).toBe(
			"edited",
		);
		expect(existsSync(join(s.env.outbox, "result.bundle"))).toBe(true);

		await writeFile(join(s.env.workTree, "new.txt"), "newer\n");
		expect(await snapshotWip(s.env, "q2")).toMatchObject({ ok: true, n: 2 });
	});

	test("a clean tree makes no ref and names HEAD", async () => {
		const s = await setup();
		const head = (await s.sbGit(["rev-parse", "HEAD"])).stdout;
		const ack = await snapshotWip(s.env, "q1");
		expect(ack).toMatchObject({ ok: true, sha: head });
		expect(ack.n).toBeUndefined();
		expect(
			(await s.sbGit(["for-each-ref", "refs/heads/mfw-wip/"])).stdout,
		).toBe("");
	});

	test("a missing run branch is an error ack, not a throw", async () => {
		const s = await setup();
		await s.sbGit(["branch", "-m", "mfw/r1", "other"]);
		const ack = await snapshotWip({ ...s.env }, "q1");
		expect(ack.ok).toBe(false);
	});
});

describe("wip-helper.ts as a process", () => {
	test("snapshot runs from GIT_DIR and the MFW_WIP_* settings alone", async () => {
		const s = await setup();
		await writeFile(join(s.env.workTree, "proc.txt"), "x\n");
		const p = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, "../src/run-workspace/wip-helper.ts"),
				"snapshot",
				"cli1",
			],
			{
				cwd: s.env.workTree,
				env: {
					PATH: process.env.PATH ?? "",
					GIT_DIR: s.env.gitDir,
					GIT_WORK_TREE: s.env.workTree,
					MFW_WIP_RUN_ID: "r1",
					MFW_WIP_OUTBOX: s.env.outbox,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const out = await new Response(p.stdout).text();
		expect(await p.exited).toBe(0);
		expect(JSON.parse(out)).toMatchObject({ id: "cli1", ok: true, n: 1 });
	});
});

describe("CloneRunWorkspace.requestWip (host side)", () => {
	async function withHelper<T>(
		s: Awaited<ReturnType<typeof setup>>,
		fn: () => Promise<T>,
	): Promise<T> {
		const ac = new AbortController();
		const loop = watchWip(s.env, s.control, { pollMs: 20, signal: ac.signal });
		try {
			return await fn();
		} finally {
			ac.abort();
			await loop;
		}
	}

	test("asks through control.jsonl, fetches the snapshot and archives uncommitted work, with no host git in the clone", async () => {
		const s = await setup();
		await writeFile(join(s.env.workTree, "a.txt"), "uncommitted\n");
		const out = await withHelper(s, () =>
			s.ws.requestWip(s.handle, { pollMs: 20 }),
		);
		expect(out.ack.ok).toBe(true);
		expect(out.imported?.wip).toEqual(["refs/mfw/quarantine-wip/r1/1"]);

		const res = await s.ws.fetchResult(s.handle);
		expect(res.sha).toBe(s.handle.baseSha);
		const archive = await s.ws.archive(s.handle, { runId: "r1", taskId: "T" });
		expect(archive?.ref).toBe("wip/T-r1");
		expect((await git(["show", "wip/T-r1:a.txt"], s.p)).stdout.trim()).toBe(
			"uncommitted",
		);

		// The HostGit spy: nothing ran with a cwd or repo inside the workspace root.
		expect(s.calls.length).toBeGreaterThan(0);
		for (const c of s.calls) {
			for (const where of [c.cwd, c.repo]) {
				if (where)
					expect(resolve(where).startsWith(`${s.wsRoot}/`)).toBe(false);
			}
		}
	});

	test("without assertQuiescent the ack comes back and nothing is imported", async () => {
		const s = await setup();
		const ws = new CloneRunWorkspace(s.p, {
			workspaceRoot: s.wsRoot,
			controlPath: () => s.control,
			assertProcessesDead: () => {},
		});
		await writeFile(join(s.env.workTree, "b.txt"), "b\n");
		const out = await withHelper(s, () =>
			ws.requestWip(s.handle, { pollMs: 20 }),
		);
		expect(out.ack.ok).toBe(true);
		expect(out.imported).toBeNull();
		expect(
			(await git(["for-each-ref", "refs/mfw/"], s.p)).stdout,
		).not.toContain("quarantine-wip");
	});

	test("times out when no helper answers, and ignores an ack for another request", async () => {
		const s = await setup();
		await writeFile(
			join(s.env.outbox, "wip-ack.json"),
			JSON.stringify({ id: "stale", ok: true }),
		);
		await expect(
			s.ws.requestWip(s.handle, { timeoutMs: 150, pollMs: 20 }),
		).rejects.toThrow(/did not answer/);
	});
});
