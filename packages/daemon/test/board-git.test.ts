import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { boot } from "../src/boot.ts";
import { git } from "../src/git.ts";
import { silentLogger } from "../src/log.ts";
import type { TaskService } from "../src/task-service.ts";
import { BoardRepo } from "../src/tasks/board-git.ts";
import { MFW_EXCLUDE, makeTasks } from "./fixtures/board.ts";

/** The board lands in the working branch's history, and the daemon refuses to
 *  commit whenever a commit would be misleading. */

interface Env {
	root: string;
	mfwDir: string;
	handle: ProjectDbHandle;
	tasks: TaskService;
	board: BoardRepo;
	warnings: string[];
}

const envs: Env[] = [];

async function repo(withCommit = true): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "mfw-boardgit-"));
	await git(["init", "-q", "-b", "main", "."], root);
	await git(["config", "user.email", "t@t"], root);
	await git(["config", "user.name", "t"], root);
	await writeFile(join(root, ".git/info/exclude"), MFW_EXCLUDE);
	if (withCommit) {
		await writeFile(join(root, "app.ts"), "export const x = 1;\n");
		await git(["add", "-A"], root);
		await git(["commit", "-qm", "init"], root);
	}
	return root;
}

async function env(root?: string, branch = "main"): Promise<Env> {
	const projectRoot = root ?? (await repo());
	const mfwDir = join(projectRoot, ".mfw");
	await mkdir(mfwDir, { recursive: true });
	const handle = await openProjectDb(mfwDir);
	const tasks = await makeTasks(handle, new EventBus(), mfwDir);
	const warnings: string[] = [];
	const board = new BoardRepo({
		projectRoot,
		mfwDir,
		integrationBranch: branch,
		log: {
			...silentLogger(),
			warn: (_o: unknown, m: string) => warnings.push(m),
			error: (_o: unknown, m: string) => warnings.push(m),
		} as unknown as ReturnType<typeof silentLogger>,
		minIntervalMs: 0,
	});
	tasks.onBoardChanged = () => board.touch();
	const e = { root: projectRoot, mfwDir, handle, tasks, board, warnings };
	envs.push(e);
	return e;
}

afterEach(async () => {
	for (const e of envs.splice(0)) {
		e.handle.close();
		await rm(e.root, { recursive: true, force: true });
	}
});

/** Commit subjects on the current branch, newest first. */
const log = (e: Env) =>
	git(["log", "--format=%s"], e.root).then((r) =>
		r.stdout.split("\n").filter(Boolean),
	);

const status = (e: Env) =>
	git(["status", "--porcelain"], e.root).then((r) =>
		r.stdout.split("\n").filter(Boolean),
	);

/** Paths touched by HEAD. */
const headFiles = (e: Env) =>
	git(["show", "--name-only", "--format=", "HEAD"], e.root).then((r) =>
		r.stdout.split("\n").filter(Boolean),
	);

describe("the board lands on the branch you work on", () => {
	test("a transition is one commit, on this branch, touching only board paths", async () => {
		const e = await env();
		await e.board.ensureTracked();
		await e.tasks.load();
		const t = await e.tasks.create({ title: "trace me" });
		// The first flush also adds board.yaml, written by `ensureBoardConfig`.
		expect(await e.board.flush()).toBe(
			`mfw: board.yaml added ((root)), ${t.id} added (task)`,
		);
		await e.tasks.move(t.id, "ready", "human");
		// Status lives in frontmatter now (MFW-ADR-22); the path is frozen at
		// creation, so a status change is a content edit, not a rename.
		expect(await e.board.flush()).toBe(`mfw: ${t.id} edited`);

		expect(await log(e)).toEqual([
			`mfw: ${t.id} edited`,
			`mfw: board.yaml added ((root)), ${t.id} added (task)`,
			"init",
		]);
		// The path never changes, so the whole history is visible without `--follow`.
		const history = await git(
			["log", "--format=%s", "--", `.mfw/tasks/${t.id}-trace-me/task.md`],
			e.root,
		);
		expect(history.stdout.split("\n").filter(Boolean)).toHaveLength(2);
		expect((await headFiles(e)).every((f) => f.startsWith(".mfw/"))).toBe(true);
		expect(await status(e)).toEqual([]);
	});

	test("the human's staged and unstaged work survives untouched", async () => {
		const e = await env();
		await e.board.ensureTracked();
		await e.tasks.load();

		await writeFile(join(e.root, "staged.txt"), "staged\n");
		await git(["add", "staged.txt"], e.root);
		await writeFile(join(e.root, "app.ts"), "export const x = 2;\n");

		await e.tasks.create({ title: "meanwhile" });
		await e.board.flush();

		// `git()` trims, so the first line loses its leading status column.
		const after = await status(e);
		expect(after.some((l) => /^A\s+staged\.txt$/.test(l.trim()))).toBe(true);
		expect(after.some((l) => /^M\s+app\.ts$/.test(l.trim()))).toBe(true);
		expect(await headFiles(e)).not.toContain("staged.txt");
		expect(await readFile(join(e.root, "app.ts"), "utf8")).toBe(
			"export const x = 2;\n",
		);
	});

	test("a task's spec and attachments ride along with it", async () => {
		const e = await env();
		await e.board.ensureTracked();
		await e.tasks.load();
		const task = await e.tasks.create({ title: "Auth design" });
		await e.tasks.setSpec(task.id, "notes");
		await e.tasks.addAttachment(task.id, "shot.png", new Uint8Array([1, 2, 3]));

		const summary = await e.board.flush();
		expect(summary).toContain(`${task.id} added`);
		const tracked = (await git(["ls-files", "--", ".mfw"], e.root)).stdout;
		expect(tracked).toContain(`.mfw/tasks/${task.id}-auth-design/task.md`);
		expect(tracked).toContain(`.mfw/tasks/${task.id}-auth-design/spec.md`);
		expect(tracked).toContain(
			`.mfw/tasks/${task.id}-auth-design/files/shot.png`,
		);

		// A status change is a frontmatter edit now; the path stays put.
		await e.tasks.move(task.id, "ready", "human");
		expect(await e.board.flush()).toBe(`mfw: ${task.id} edited`);
		const after = (await git(["ls-files", "--", ".mfw"], e.root)).stdout;
		expect(after).toContain(`.mfw/tasks/${task.id}-auth-design/spec.md`);
	});

	test("a burst coalesces into one commit, and a no-op commits nothing", async () => {
		const e = await env();
		await e.board.ensureTracked();
		await e.tasks.load();
		const a = await e.tasks.create({ title: "alpha" });
		await e.tasks.create({ title: "beta" });
		await e.tasks.create({ title: "gamma" });
		await e.tasks.create({ title: "delta" });
		await e.tasks.move(a.id, "ready", "human");
		await e.board.flush();
		const entries = await log(e);
		expect(entries).toHaveLength(2); // "init" plus one commit

		expect(await e.board.flush()).toBeNull();
		expect(await e.board.flush()).toBeNull();
		expect(await log(e)).toEqual(entries);
	});

	test("the board survives a full load → transition → commit → reload cycle", async () => {
		const e = await env();
		await e.board.ensureTracked();
		await e.tasks.load();
		const ids: string[] = [];
		for (let i = 0; i < 6; i++) {
			ids.push((await e.tasks.create({ title: `task ${i}` })).id);
		}
		await e.tasks.move(ids[0] as string, "ready", "human");
		await e.tasks.move(ids[1] as string, "done", "human");
		await e.board.flush();

		expect(await status(e)).toEqual([]);
		const tracked = (
			await git(["ls-files", "--", ".mfw/tasks"], e.root)
		).stdout.split("\n");
		expect(tracked).toContain(`.mfw/tasks/${ids[0]}-task-0/task.md`);
		expect(tracked).toContain(`.mfw/tasks/${ids[1]}-task-1/task.md`);
		expect(tracked.filter((f) => f.endsWith(".md"))).toHaveLength(6);

		// A fresh index over the same directory finds the same board.
		const reread = await makeTasks(e.handle, new EventBus(), e.mfwDir);
		expect((await reread.list()).map((t) => t.id).sort()).toEqual(
			[...ids].sort(),
		);
	});
});

describe("the daemon refuses to commit when a commit would lie", () => {
	test("on a detached HEAD: and leaves no orphan commit behind", async () => {
		const e = await env();
		await e.board.ensureTracked();
		await e.tasks.load();
		await e.board.flush();
		const before = (await git(["rev-parse", "HEAD"], e.root)).stdout;

		await git(["checkout", "-q", "--detach"], e.root);
		await e.tasks.create({ title: "written while detached" });
		expect(await e.board.flush()).toBeNull();
		// `git commit` on a detached HEAD succeeds and orphans the commit, so it
		// must be refused.
		expect((await git(["rev-parse", "HEAD"], e.root)).stdout).toBe(before);
		expect(e.warnings.join("\n")).toContain(
			"HEAD is not the integration branch",
		);
	});

	test("on another branch: and resumes, with the pending change, on return", async () => {
		const e = await env();
		await e.board.ensureTracked();
		await e.tasks.load();
		await e.board.flush();
		const mainLog = await log(e);

		await git(["checkout", "-q", "-b", "feature"], e.root);
		const t = await e.tasks.create({ title: "made on a feature branch" });
		expect(await e.board.flush()).toBeNull();
		expect((await log(e)).length).toBe(mainLog.length);

		// The refusal must not drop the change.
		await git(["checkout", "-q", "main"], e.root);
		expect(await e.board.tick()).toBe(`mfw: ${t.id} added (task)`);
	});

	test("mid-merge, and again after `merge --abort`", async () => {
		const e = await env();
		await e.board.ensureTracked();
		await e.tasks.load();

		await writeFile(join(e.root, "conflict.txt"), "base\n");
		await git(["add", "-A"], e.root);
		await git(["commit", "-qm", "base"], e.root);
		await git(["checkout", "-q", "-b", "other"], e.root);
		await writeFile(join(e.root, "conflict.txt"), "theirs\n");
		await git(["commit", "-qam", "theirs"], e.root);
		await git(["checkout", "-q", "main"], e.root);
		await writeFile(join(e.root, "conflict.txt"), "ours\n");
		await git(["commit", "-qam", "ours"], e.root);
		const merge = await git(["merge", "other"], e.root);
		expect(merge.exitCode).not.toBe(0);
		expect(existsSync(join(e.root, ".git", "MERGE_HEAD"))).toBe(true);

		const t = await e.tasks.create({ title: "made mid-merge" });
		expect(await e.board.flush()).toBeNull();
		expect(e.warnings.join("\n")).toContain("a merge is in progress");

		await git(["merge", "--abort"], e.root);
		expect(await e.board.tick()).toBe(`mfw: ${t.id} added (task)`);
	});

	test("mid-rebase", async () => {
		const e = await env();
		await e.board.ensureTracked();
		await e.tasks.load();
		await writeFile(join(e.root, "c.txt"), "base\n");
		await git(["add", "-A"], e.root);
		await git(["commit", "-qm", "base"], e.root);
		await git(["checkout", "-q", "-b", "topic"], e.root);
		await writeFile(join(e.root, "c.txt"), "topic\n");
		await git(["commit", "-qam", "topic"], e.root);
		await git(["checkout", "-q", "main"], e.root);
		await writeFile(join(e.root, "c.txt"), "main\n");
		await git(["commit", "-qam", "main change"], e.root);
		await git(["checkout", "-q", "topic"], e.root);
		const rb = await git(["rebase", "main"], e.root);
		expect(rb.exitCode).not.toBe(0); // stopped on a conflict

		const branchEnv = await env(e.root, "topic");
		await branchEnv.board.ensureTracked();
		await branchEnv.tasks.create({ title: "made mid-rebase" });
		expect(await branchEnv.board.flush()).toBeNull();
		expect(branchEnv.warnings.join("\n")).toContain("a rebase is in progress");
		await git(["rebase", "--abort"], e.root);
	});

	test("a refusal is logged once, not once per tick", async () => {
		const e = await env();
		await e.board.ensureTracked();
		await e.tasks.load();
		await git(["checkout", "-q", "-b", "elsewhere"], e.root);
		await e.tasks.create({ title: "x" });
		for (let i = 0; i < 5; i++) await e.board.flush();
		const branchWarnings = e.warnings.filter((w) =>
			w.includes("HEAD is not the integration branch"),
		);
		expect(branchWarnings).toHaveLength(1);
	});

	test("while the board is suspended", async () => {
		const e = await env();
		await e.board.ensureTracked();
		await e.tasks.load();
		await e.tasks.create({ title: "real" });
		await e.board.flush();

		e.board.setSuspended(true);
		await e.tasks.create({ title: "written while suspect" });
		expect(await e.board.flush()).toBeNull();

		e.board.setSuspended(false);
		expect(await e.board.flush()).not.toBeNull();
	});
});

describe("setup", () => {
	test("a project that is not a git repo still works, just unversioned", async () => {
		const root = await mkdtemp(join(tmpdir(), "mfw-nogit-"));
		const e = await env(root);
		expect(await e.board.ensureTracked()).toEqual({
			enabled: false,
		});
		expect(e.board.isEnabled).toBe(false);
		const t = await e.tasks.create({ title: "works anyway" });
		expect((await e.tasks.get(t.id))?.title).toBe("works anyway");
		expect(await e.board.flush()).toBeNull();
	});

	test("a board the project itself gitignores disables committing, loudly", async () => {
		const root = await repo();
		await writeFile(join(root, ".gitignore"), ".mfw/\n");
		await git(["add", ".gitignore"], root);
		await git(["commit", "-qm", "ignore mfw"], root);
		const e = await env(root);
		expect(await e.board.ensureTracked()).toEqual({
			enabled: false,
		});
		expect(e.warnings.join("\n")).toContain("git-ignored");
		const t = await e.tasks.create({ title: "still a board" });
		expect((await e.tasks.get(t.id))?.title).toBe("still a board");
	});

	test("a repo with no commits yet commits the board onto the unborn branch", async () => {
		const e = await env(await repo(false));
		expect(await e.board.ensureTracked()).toEqual({
			enabled: true,
		});
		await e.tasks.load();
		await e.tasks.create({ title: "first thing ever" });
		expect(await e.board.flush()).not.toBeNull();
		expect(await log(e)).toHaveLength(1);
	});

	test("ensureTracked is idempotent", async () => {
		const e = await env();
		await e.board.ensureTracked();
		await e.tasks.load();
		await e.tasks.create({ title: "x" });
		await e.board.flush();
		const before = await log(e);
		expect(await e.board.ensureTracked()).toEqual({
			enabled: true,
		});
		expect(await log(e)).toEqual(before);
	});
});

describe("an existing board is tracked immediately", () => {
	test("attach commits the board without waiting for a transition", async () => {
		const root = await repo();
		const taskDir = join(root, ".mfw", "tasks", "MFW-1-carried-over");
		await mkdir(taskDir, { recursive: true });
		await writeFile(
			join(taskDir, "task.md"),
			"---\nmfw: 1\nid: MFW-1\nrev: 1\ntitle: carried over\ntype: implementation\nstatus: done\npriority: medium\n---\n",
		);

		const orch = await boot({
			projects: [{ name: "demo", root, integrationBranch: "main" }],
			log: silentLogger(),
			autostart: false,
		});
		const svc = orch.get("demo");
		// `tick()`, not `flush()`: tick respects the dirty flag, so this only
		// passes if attach marked the board dirty.
		await svc.board.tick();

		const tracked = await git(["ls-files", "--", ".mfw/tasks"], root);
		expect(tracked.stdout).toContain("MFW-1-carried-over/task.md");
		const status = await git(["status", "--porcelain", "--", ".mfw"], root);
		expect(status.stdout.trim()).toBe("");

		await orch.shutdown();
		await rm(root, { recursive: true, force: true });
	}, 30_000);
});
