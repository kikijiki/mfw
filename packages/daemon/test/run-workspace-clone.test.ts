import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
	appendFile,
	mkdir,
	mkdtemp,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/git.ts";
import { sandboxBundleArgv } from "../src/host-git/fetch.ts";
import { CloneRunWorkspace } from "../src/run-workspace/clone-impl.ts";
import {
	clearRunWorkspace,
	configureRunWorkspace,
	createRunWorkspace,
} from "../src/run-workspace/factory.ts";
import type { RunWorkspace } from "../src/run-workspace/run-workspace.ts";
import { WorktreeRunWorkspace } from "../src/run-workspace/worktree-impl.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
	const d = await mkdtemp(join(tmpdir(), "mfw-clone-"));
	dirs.push(d);
	return d;
}

async function primary(root: string): Promise<string> {
	const p = join(root, "primary");
	await mkdir(p);
	await git(["init", "-q", "-b", "main", "."], p);
	await git(["config", "user.email", "t@t"], p);
	await git(["config", "user.name", "t"], p);
	await writeFile(join(p, "a.txt"), "one\n");
	await git(["add", "-A"], p);
	await git(["commit", "-q", "-m", "init"], p);
	return p;
}

const ID = ["-c", "user.name=t", "-c", "user.email=t@t"];

/** What the in-sandbox side of a clone does: commit on the run branch, then write the outbox bundle. */
class FakeSandbox {
	constructor(
		private readonly dir: string,
		private readonly runId: string,
	) {}
	private run(args: string[]) {
		return git(
			[
				...ID,
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"core.fsmonitor=false",
				...args,
			],
			join(this.dir, "tree"),
			{
				env: {
					GIT_DIR: join(this.dir, "git"),
					GIT_WORK_TREE: join(this.dir, "tree"),
				},
			},
		);
	}
	async commit(file: string, body: string): Promise<string> {
		await writeFile(join(this.dir, "tree", file), body);
		await this.run(["add", "-A"]);
		await this.run(["commit", "-q", "-m", `work ${file}`]);
		return (await this.run(["rev-parse", "HEAD"])).stdout;
	}
	async checkoutRunBranch(): Promise<void> {
		await this.run(["checkout", "-q", `mfw/${this.runId}`]);
	}
	async bundle(): Promise<void> {
		const out = join(this.dir, "outbox", "result.bundle");
		const [, ...rest] = sandboxBundleArgv(this.runId, out);
		const r = await this.run(rest);
		if (r.exitCode !== 0) throw new Error(`bundle failed: ${r.stderr}`);
	}
}

type Impl = "worktree" | "clone";

async function make(impl: Impl) {
	const root = await tmp();
	const p = await primary(root);
	const home = join(root, "home");
	let ws: RunWorkspace;
	if (impl === "worktree") {
		ws = new WorktreeRunWorkspace(p);
	} else {
		ws = new CloneRunWorkspace(p, {
			workspaceRoot: join(home, "workspaces"),
			assertProcessesDead: () => {},
		});
	}
	/** The run does `file`, and leaves the result where the implementation expects it. */
	const work = async (
		runId: string,
		handle: { path: string },
		file: string,
	) => {
		if (impl === "worktree") {
			await writeFile(join(handle.path, file), "work\n");
			await git(["add", "-A"], handle.path);
			await git(
				[
					"-c",
					"user.name=t",
					"-c",
					"user.email=t@t",
					"commit",
					"-q",
					"-m",
					"w",
				],
				handle.path,
			);
			return;
		}
		const sb = new FakeSandbox(join(home, "workspaces", runId), runId);
		await sb.checkoutRunBranch();
		await sb.commit(file, "work\n");
		await sb.bundle();
	};
	return { root, p, home, ws, work };
}

for (const impl of ["worktree", "clone"] as const) {
	describe(`RunWorkspace contract over ${impl}`, () => {
		test("seed, paths, ownership and list agree", async () => {
			const { ws, p } = await make(impl);
			expect(ws.kind).toBe(impl);
			const h = await ws.seed("r1", "main");
			expect(h.branch).toBe("mfw/r1");
			expect(h.path).toBe(ws.paths("r1").workPath);
			const head = (await git(["rev-parse", "main"], p)).stdout;
			expect(h.baseSha).toBe(head);
			expect(await ws.ownership(h.path)).toMatchObject({
				runId: "r1",
				branch: "mfw/r1",
				baseSha: head,
			});
			expect(await ws.list()).toContain(h.path);
			expect(await ws.ownership(p)).toBeNull();
			expect(await ws.ownership(join(h.path, ".."))).toBeNull();
		});

		test("fetchResult reports the tip once the run committed", async () => {
			const { ws, work } = await make(impl);
			const h = await ws.seed("r2", "main");
			const before = await ws.fetchResult(h);
			expect(before.sha === null || before.sha === h.baseSha).toBe(true);
			await work("r2", h, "b.txt");
			const after = await ws.fetchResult(h);
			expect(after.sha).not.toBeNull();
			expect(after.sha).not.toBe(h.baseSha);
		});

		test("remove refuses unproven paths, then removes the workspace", async () => {
			const { ws, root } = await make(impl);
			const h = await ws.seed("r3", "main");
			await expect(
				ws.remove({ ...h, path: join(root, "elsewhere") }, { force: true }),
			).rejects.toThrow();
			await ws.remove(h, { force: true });
			expect(await ws.list()).not.toContain(h.path);
			expect(await ws.ownership(h.path)).toBeNull();
		});

		test("archive and discard save the run's work on a wip branch", async () => {
			const { ws, p, work } = await make(impl);
			const h = await ws.seed("r4", "main");
			await work("r4", h, "b.txt");
			await ws.fetchResult(h);
			const { archive, removed } = await ws.discard(h, {
				runId: "r4",
				taskId: "T-1",
			});
			expect(removed).toBe(true);
			expect(archive?.ref).toBe("wip/T-1-r4");
			const tip = await git(["rev-parse", "refs/heads/wip/T-1-r4"], p);
			expect(tip.stdout).toBe(archive?.sha ?? "");
			const files = await git(["ls-tree", "-r", "--name-only", tip.stdout], p);
			expect(files.stdout).toContain("b.txt");
			expect(await ws.list()).not.toContain(h.path);
			// A run that did nothing archives nothing.
			const idle = await ws.seed("r5", "main");
			expect((await ws.discard(idle, { runId: "r5" })).archive).toBeNull();
		});
	});
}

describe("CloneRunWorkspace", () => {
	test("hasLocalChanges is true until the result is imported", async () => {
		const { ws, work } = await make("clone");
		const h = await ws.seed("c1", "main");
		expect(await ws.hasLocalChanges(h)).toBe(true);
		await expect(ws.remove(h, { force: false })).rejects.toThrow(/dirty/);
		await work("c1", h, "b.txt");
		await ws.fetchResult(h);
		expect(await ws.hasLocalChanges(h)).toBe(false);
		await ws.remove(h, { deleteBranch: true });
		expect(await ws.list()).toEqual([]);
	});

	test("without a liveness proof nothing is imported", async () => {
		const { p, home, work } = await make("clone");
		const ws = new CloneRunWorkspace(p, {
			workspaceRoot: join(home, "workspaces"),
		});
		const h = await ws.seed("c2", "main");
		await work("c2", h, "b.txt");
		expect((await ws.fetchResult(h)).sha).toBeNull();
	});

	test("a run that is not confirmed dead is not imported", async () => {
		const { p, home, work } = await make("clone");
		const ws = new CloneRunWorkspace(p, {
			workspaceRoot: join(home, "workspaces"),
			assertProcessesDead: () => {
				throw new Error("still running");
			},
		});
		const h = await ws.seed("c3", "main");
		await work("c3", h, "b.txt");
		await expect(ws.fetchResult(h)).rejects.toThrow(/not confirmed dead/);
		expect((await git(["for-each-ref", "refs/mfw/quarantine"], p)).stdout).toBe(
			"",
		);
	});

	test("the merge ref is the quarantine ref, and the run branch never reaches the primary", async () => {
		const { ws, p, work } = await make("clone");
		const h = await ws.seed("c4", "main");
		await work("c4", h, "b.txt");
		const res = await ws.fetchResult(h);
		expect(res.ref).toBe("refs/mfw/quarantine/c4");
		expect(
			(await git(["rev-parse", "--verify", "-q", "refs/heads/mfw/c4"], p))
				.exitCode,
		).not.toBe(0);
	});

	test("the default validator refuses results that change protected files, add gitlinks or escaping symlinks", async () => {
		const cases: [string, (tree: string) => Promise<void>, RegExp][] = [
			[
				"gitmodules",
				(t) => writeFile(join(t, ".gitmodules"), '[submodule "x"]\n'),
				/\.gitmodules/,
			],
			[
				"gitattributes",
				(t) => writeFile(join(t, ".gitattributes"), "* filter=lfs\n"),
				/\.gitattributes/,
			],
			[
				"symlink",
				(t) => symlink("../../etc/passwd", join(t, "link")),
				/symlink/,
			],
			["abs symlink", (t) => symlink("/etc/passwd", join(t, "abs")), /symlink/],
		];
		for (const [name, tamper, msg] of cases) {
			const { ws, p, home } = await make("clone");
			const id = `v-${name.replace(/\W/g, "")}`;
			const h = await ws.seed(id, "main");
			const dir = join(home, "workspaces", id);
			const sb = new FakeSandbox(dir, id);
			await sb.checkoutRunBranch();
			await tamper(join(dir, "tree"));
			await sb.commit("ok.txt", "x\n");
			await sb.bundle();
			await expect(ws.fetchResult(h)).rejects.toThrow(msg);
			expect(
				(await git(["for-each-ref", "refs/mfw/quarantine"], p)).stdout,
			).toBe("");
		}
	});

	test("an in-tree relative symlink is accepted", async () => {
		const { ws, home } = await make("clone");
		const h = await ws.seed("ok1", "main");
		const dir = join(home, "workspaces", "ok1");
		const sb = new FakeSandbox(dir, "ok1");
		await sb.checkoutRunBranch();
		await symlink("a.txt", join(dir, "tree", "alias"));
		await sb.commit("b.txt", "x\n");
		await sb.bundle();
		expect((await ws.fetchResult(h)).sha).not.toBeNull();
	});
});

/** Everything in the primary's gitdir that could make a later host git run a program. */
function fingerprint(primaryRoot: string): string {
	const h = createHash("sha256");
	const gd = join(primaryRoot, ".git");
	h.update(readFileSync(join(gd, "config")));
	h.update(readFileSync(join(gd, "HEAD")));
	for (const sub of ["hooks", "info"]) {
		const d = join(gd, sub);
		if (!existsSync(d)) continue;
		for (const f of readdirSync(d).sort()) {
			h.update(f);
			h.update(readFileSync(join(d, f)));
		}
	}
	return h.digest("hex");
}

describe("E3b: a tampered clone cannot reach the primary", () => {
	test("hostile clone config and hooks run nothing, and the primary gitdir fingerprint is unchanged", async () => {
		const { ws, p, home, work } = await make("clone");
		const h = await ws.seed("e3b", "main");
		await work("e3b", h, "b.txt");
		const dir = join(home, "workspaces", "e3b");
		const canary = join(dir, "..", "CANARY");
		const script = join(dir, "..", "pwn.sh");
		await writeFile(script, `#!/bin/sh\ntouch ${canary}\n`, { mode: 0o755 });
		// Tamper after the bundle: the clone is hostile when the host reads the result.
		await appendFile(
			join(dir, "git", "config"),
			[
				"[core]",
				`\tfsmonitor = ${script}`,
				`\thooksPath = ${dir}/git/hooks`,
				`\tsshCommand = ${script}`,
				`[filter "x"]`,
				`\tclean = ${script}`,
				`[credential]`,
				`\thelper = ${script}`,
				`[include]`,
				`\tpath = ${script}`,
				`[uploadpack]`,
				`\tpackObjectsHook = ${script}`,
				"",
			].join("\n"),
		);
		await mkdir(join(dir, "git", "hooks"), { recursive: true });
		for (const hook of [
			"post-checkout",
			"reference-transaction",
			"pre-auto-gc",
		]) {
			await writeFile(
				join(dir, "git", "hooks", hook),
				`#!/bin/sh\ntouch ${canary}\n`,
				{
					mode: 0o755,
				},
			);
		}
		const before = fingerprint(p);
		const res = await ws.fetchResult(h);
		expect(res.sha).not.toBeNull();
		await ws.discard(h, { runId: "e3b", taskId: null });
		expect(existsSync(canary)).toBe(false);
		expect(fingerprint(p)).toBe(before);
	});
});

describe("the factory", () => {
	test("worktree by default, clone once the project is configured", async () => {
		const root = await tmp();
		const p = await primary(root);
		expect(createRunWorkspace(p).kind).toBe("worktree");
		configureRunWorkspace(p, {
			kind: "clone",
			clone: { workspaceRoot: join(root, "ws") },
		});
		try {
			expect(createRunWorkspace(p).kind).toBe("clone");
		} finally {
			clearRunWorkspace(p);
		}
		expect(createRunWorkspace(p).kind).toBe("worktree");
		expect(() => configureRunWorkspace(p, { kind: "clone" })).toThrow();
	});
});
