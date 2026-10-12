import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { events as eventsTable } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { git } from "../src/git.ts";
import {
	LifecycleService,
	RunLiveError,
	TaskUnmergedError,
} from "../src/lifecycle.ts";
import { silentLogger } from "../src/log.ts";
import { RunRegistry } from "../src/run-registry.ts";
import type { TaskService } from "../src/task-service.ts";
import { WorktreeManager } from "../src/worktree.ts";
import { MFW_EXCLUDE, makeTasks } from "./fixtures/board.ts";

interface F {
	root: string;
	handle: ProjectDbHandle;
	tasks: TaskService;
	registry: RunRegistry;
	lifecycle: LifecycleService;
	cleanup: () => Promise<void>;
}

async function fixture(): Promise<F> {
	const root = await mkdtemp(join(tmpdir(), "mfw-lifecycle-"));
	await git(["init", "-q", "-b", "main"], root);
	await git(["config", "user.email", "t@t"], root);
	await git(["config", "user.name", "t"], root);
	await writeFile(join(root, "feature.txt"), "present\n");
	await git(["add", "-A"], root);
	await git(["commit", "-q", "-m", "init"], root);
	await writeFile(join(root, ".git/info/exclude"), MFW_EXCLUDE);
	const mfwDir = join(root, ".mfw");
	const handle = await openProjectDb(mfwDir);
	const bus = new EventBus();
	const tasks = await makeTasks(handle, bus, mfwDir, "MFW");
	const registry = new RunRegistry({
		handle,
		bus,
		runsDir: join(mfwDir, "runs"),
	});
	const lifecycle = new LifecycleService({
		handle,
		bus,
		registry,
		tasks,
		projectRoot: root,
		integrationBranch: "main",
		log: silentLogger(),
	});
	return {
		root,
		handle,
		tasks,
		registry,
		lifecycle,
		cleanup: async () => {
			handle.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

/** An owned worktree + run row for `taskId`, with one committed file. */
async function runWithWork(
	f: F,
	runId: string,
	taskId: string,
	opts: { commit?: boolean; state?: "completed" | "running" } = {},
) {
	const wt = await new WorktreeManager(f.root).create(runId, "main");
	await writeFile(join(wt.path, `${runId}.txt`), "work\n");
	if (opts.commit !== false) {
		await git(["add", "-A"], wt.path);
		await git(["commit", "-qm", "agent work"], wt.path);
	}
	const run = await f.registry.create({
		id: runId,
		kind: "task",
		taskId,
		label: taskId,
		model: "test",
		cwd: wt.path,
		worktreePath: wt.path,
		branch: wt.branch,
		integrationBranch: "main",
		baseSha: wt.baseSha,
	});
	if (opts.state !== "running") await f.registry.finish(run.id, "completed");
	else await f.registry.transition(run.id, "running");
	return wt;
}

describe("discard saves work to wip/ before removing it", () => {
	test("a finished run is archived, its worktree and mfw branch removed, and the discard audited", async () => {
		const f = await fixture();
		const t = await f.tasks.create({ title: "throw away" });
		const wt = await runWithWork(f, "run-a", t.id, { commit: false });

		const result = await f.lifecycle.discardRun("run-a");

		expect(result.archive?.ref).toBe(`wip/${t.id}-run-a`);
		expect(result.removed).toBe(true);
		expect(existsSync(wt.path)).toBe(false);
		expect(
			(await git(["rev-parse", "--verify", wt.branch], f.root)).exitCode,
		).not.toBe(0);
		expect(
			(await git(["show", `wip/${t.id}-run-a:run-a.txt`], f.root)).stdout,
		).toBe("work");
		const audit = await f.handle.db
			.select()
			.from(eventsTable)
			.where(eq(eventsTable.type, "run.wip_archived"));
		expect(audit).toHaveLength(1);
		expect(audit[0]?.payload).toMatchObject({
			ref: `wip/${t.id}-run-a`,
			actor: "human",
		});
		await f.cleanup();
	}, 30_000);

	test("a live run is refused with a fix, and nothing is touched", async () => {
		const f = await fixture();
		const t = await f.tasks.create({ title: "still running" });
		const wt = await runWithWork(f, "run-live", t.id, { state: "running" });

		const refused = await f.lifecycle.discardRun("run-live").catch((e) => e);

		expect(refused).toBeInstanceOf(RunLiveError);
		expect((refused as RunLiveError).fix.text).toContain("Stop run run-live");
		expect(existsSync(join(wt.path, "run-live.txt"))).toBe(true);
		expect(
			(await git(["for-each-ref", "refs/heads/wip/"], f.root)).stdout,
		).toBe("");
		// Task-level discard refuses before touching any run.
		await runWithWork(f, "run-old", t.id);
		await expect(f.lifecycle.discardTask(t.id)).rejects.toBeInstanceOf(
			RunLiveError,
		);
		expect(existsSync(join(f.root, "worktrees", "run-old"))).toBe(true);
		await f.cleanup();
	}, 30_000);

	test("discarding a task archives every finished run that still has a branch", async () => {
		const f = await fixture();
		const t = await f.tasks.create({ title: "two attempts" });
		await runWithWork(f, "run-1", t.id);
		await runWithWork(f, "run-2", t.id);

		const results = await f.lifecycle.discardTask(t.id);

		expect(results.map((r) => r.archive?.ref).sort()).toEqual([
			`wip/${t.id}-run-1`,
			`wip/${t.id}-run-2`,
		]);
		expect((await git(["worktree", "list"], f.root)).stdout).not.toContain(
			"run-1",
		);
		await f.cleanup();
	}, 30_000);
});

describe("a human close refuses while the task branch is unmerged", () => {
	test("done is refused with a fix; the merge tail (scheduler) passes", async () => {
		const f = await fixture();
		f.tasks.closeGuard = f.lifecycle;
		const t = await f.tasks.create({ title: "has work" });
		await runWithWork(f, "run-u", t.id);

		const refused = await f.tasks.move(t.id, "done", "human").catch((e) => e);

		expect(refused).toBeInstanceOf(TaskUnmergedError);
		expect((refused as TaskUnmergedError).unmerged).toMatchObject({
			runId: "run-u",
			branch: "mfw/run-u",
			ahead: 1,
		});
		expect((refused as TaskUnmergedError).fix.text).toContain(
			`wip/${t.id}-run-u`,
		);
		expect((await f.tasks.get(t.id))?.status).not.toBe("done");
		await expect(
			f.tasks.move(t.id, "archived", "human"),
		).rejects.toBeInstanceOf(TaskUnmergedError);
		// Bulk moves skip it rather than fail the batch.
		const status = (await f.tasks.get(t.id))?.status ?? "backlog";
		expect(await f.tasks.moveMany([t.id], status, "done", "human")).toEqual({
			moved: [],
			skipped: [{ id: t.id, reason: "unmerged" }],
		});

		expect((await f.tasks.move(t.id, "done", "scheduler")).status).toBe("done");
		await f.cleanup();
	}, 30_000);

	test("once the branch is merged a human may close", async () => {
		const f = await fixture();
		f.tasks.closeGuard = f.lifecycle;
		const t = await f.tasks.create({ title: "merged" });
		await runWithWork(f, "run-m", t.id);
		await git(["merge", "-q", "--no-ff", "-m", "merge", "mfw/run-m"], f.root);

		expect((await f.tasks.move(t.id, "done", "human")).status).toBe("done");
		await f.cleanup();
	}, 30_000);

	test("discard saves the work to wip/ and then closes", async () => {
		const f = await fixture();
		f.tasks.closeGuard = f.lifecycle;
		const t = await f.tasks.create({ title: "abandon" });
		const wt = await runWithWork(f, "run-d", t.id);

		const moved = await f.tasks.move(t.id, "archived", "human", undefined, {
			discard: true,
		});

		expect(moved.status).toBe("archived");
		expect(existsSync(wt.path)).toBe(false);
		expect(
			(await git(["show", `wip/${t.id}-run-d:run-d.txt`], f.root)).stdout,
		).toBe("work");
		await f.cleanup();
	}, 30_000);

	test("the branch is re-checked under the claim lock before writing", async () => {
		const f = await fixture();
		const t = await f.tasks.create({ title: "raced" });
		await runWithWork(f, "run-r", t.id);
		// First (unlocked) check sees nothing, as if the run committed just after.
		let calls = 0;
		f.tasks.closeGuard = {
			unmergedBranch: async (id) =>
				calls++ === 0 ? null : f.lifecycle.unmergedBranch(id),
			discardRun: (runId) => f.lifecycle.discardRun(runId),
		};

		await expect(f.tasks.move(t.id, "done", "human")).rejects.toBeInstanceOf(
			TaskUnmergedError,
		);
		expect(calls).toBe(2);
		expect((await f.tasks.get(t.id))?.status).not.toBe("done");
		await f.cleanup();
	}, 30_000);
});
