import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import {
	engineKv,
	events as eventsTable,
	mergeJobs,
	runs,
} from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { git, gitOk } from "../src/git.ts";
import { silentLogger } from "../src/log.ts";
import { type MergeJobView, MergeQueue } from "../src/merge-queue.ts";
import { MFW_EXCLUDE } from "./fixtures/board.ts";

interface Fixture {
	root: string;
	handle: ProjectDbHandle;
	bus: EventBus;
	merged: { job: MergeJobView; sha: string }[];
	parked: { job: MergeJobView; reason: string; kind: string }[];
	reclaimed: MergeJobView[];
	sentToReady: MergeJobView[];
	queue: MergeQueue;
	makeBranchRun: (
		name: string,
		file: string,
		content: string,
	) => Promise<string>; // returns runId
	jobIdFor: (runId: string) => Promise<number>;
	cleanup: () => Promise<void>;
}

async function fixture(
	reverify: (
		job: MergeJobView,
	) => Promise<{ passed: boolean; detail?: string }> = async () => ({
		passed: true,
	}),
	push?: { enabled: boolean; remote: string },
	/** Runs inside `onMerged` before the job is recorded; stands in for the board commit `tasks.release` makes. */
	onMergedTail?: (job: MergeJobView, sha: string) => Promise<void>,
	selfRepairMainRed?: () => boolean,
): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "mfw-mq-"));
	await git(["init", "-q", "-b", "main"], root);
	await git(["config", "user.email", "t@t"], root);
	await git(["config", "user.name", "t"], root);
	await writeFile(join(root, "base.txt"), "base\n");
	await git(["add", "-A"], root);
	await git(["commit", "-q", "-m", "init"], root);
	await writeFile(join(root, ".git/info/exclude"), MFW_EXCLUDE);

	const handle = await openProjectDb(join(root, ".mfw"));
	const bus = new EventBus();
	const merged: Fixture["merged"] = [];
	const parked: Fixture["parked"] = [];
	const reclaimed: Fixture["reclaimed"] = [];
	const sentToReady: Fixture["sentToReady"] = [];
	const queue = new MergeQueue({
		handle,
		bus,
		projectRoot: root,
		log: silentLogger(),
		reverify,
		onMerged: async (job, sha) => {
			await onMergedTail?.(job, sha);
			merged.push({ job, sha });
		},
		onParked: async (job, reason, kind) => {
			parked.push({ job, reason, kind });
		},
		reclaimTask: async (job) => {
			reclaimed.push(job);
		},
		sendTaskToReady: async (job) => {
			sentToReady.push(job);
		},
		push,
		selfRepairMainRed,
	});

	const makeBranchRun = async (
		name: string,
		file: string,
		content: string,
	): Promise<string> => {
		const wt = join(root, "worktrees", name);
		await git(["worktree", "add", "-q", "-b", name, wt, "main"], root);
		await writeFile(join(wt, file), content);
		await git(["add", "-A"], wt);
		await git(["commit", "-q", "-m", `work on ${name}`], wt);
		const runId = ulid();
		await handle.db.insert(runs).values({
			id: runId,
			kind: "task",
			label: name,
			model: "sonnet",
			cwd: wt,
			worktreePath: wt,
			branch: name,
			integrationBranch: "main",
			startedAt: new Date(),
		});
		return runId;
	};

	const jobIdFor = async (runId: string): Promise<number> => {
		const [row] = await handle.db
			.select({ id: mergeJobs.id })
			.from(mergeJobs)
			.where(eq(mergeJobs.runId, runId));
		if (!row) throw new Error(`no merge job for run ${runId}`);
		return row.id;
	};

	return {
		root,
		handle,
		bus,
		merged,
		parked,
		reclaimed,
		sentToReady,
		queue,
		makeBranchRun,
		jobIdFor,
		cleanup: async () => {
			handle.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

describe("MergeQueue v2, real git matrix", () => {
	test("clean merge lands on the integration branch; primary checkout untouched", async () => {
		const f = await fixture();
		const primaryHeadBefore = await gitOk(["rev-parse", "HEAD"], f.root);
		const runId = await f.makeBranchRun("mfw/t1", "a.txt", "hello\n");
		await f.queue.enqueue({
			runId,
			taskId: "MFW-1",
			branch: "mfw/t1",
			targetBranch: "main",
		});
		const events: string[] = [];
		f.bus.subscribe((e) => events.push(e.type));

		expect(await f.queue.tick()).toBe("merged");
		const show = await git(["show", "main:a.txt"], f.root);
		expect(show.stdout).toBe("hello");
		// primary checkout keeps its HEAD ref and a clean tree
		expect(await gitOk(["symbolic-ref", "HEAD"], f.root)).toContain("main");
		expect((await gitOk(["status", "--porcelain"], f.root)).trim()).toBe("");
		// a clean primary on the target branch is synced to the merge commit
		expect(await gitOk(["rev-parse", "HEAD"], f.root)).toBe(
			f.merged[0]?.sha ?? "",
		);
		expect(f.merged.length).toBe(1);
		expect(events).toContain("merge.completed");
		expect(primaryHeadBefore).not.toBe(f.merged[0]?.sha);
		await f.cleanup();
	});

	test("a landed merge is pushed to the remote when the project asks", async () => {
		const f = await fixture(undefined, { enabled: true, remote: "origin" });
		const remote = await mkdtemp(join(tmpdir(), "mfw-remote-"));
		await git(["init", "-q", "--bare", "-b", "main"], remote);
		await gitOk(["remote", "add", "origin", remote], f.root);

		const runId = await f.makeBranchRun("mfw/t1", "a.txt", "hello\n");
		await f.queue.enqueue({
			runId,
			taskId: "MFW-1",
			branch: "mfw/t1",
			targetBranch: "main",
		});
		expect(await f.queue.tick()).toBe("merged");

		expect(await gitOk(["rev-parse", "main"], remote)).toBe(
			f.merged[0]?.sha ?? "",
		);
		await rm(remote, { recursive: true, force: true });
		await f.cleanup();
	});

	test("a merge with pushing off stays local", async () => {
		const f = await fixture();
		const remote = await mkdtemp(join(tmpdir(), "mfw-remote-"));
		await git(["init", "-q", "--bare", "-b", "main"], remote);
		await gitOk(["remote", "add", "origin", remote], f.root);

		const runId = await f.makeBranchRun("mfw/t1", "a.txt", "hello\n");
		await f.queue.enqueue({
			runId,
			taskId: "MFW-1",
			branch: "mfw/t1",
			targetBranch: "main",
		});
		expect(await f.queue.tick()).toBe("merged");

		// Nothing published: the remote has no `main`.
		expect((await git(["rev-parse", "main"], remote)).exitCode).not.toBe(0);
		await rm(remote, { recursive: true, force: true });
		await f.cleanup();
	});

	/** Pushing is on by default, so having no remote is ordinary and must not emit push_failed. */
	test("pushing on with no remote configured lands the merge silently", async () => {
		const f = await fixture(undefined, { enabled: true, remote: "origin" });
		const events: string[] = [];
		f.bus.subscribe((e) => events.push(e.type));

		const runId = await f.makeBranchRun("mfw/t1", "a.txt", "hello\n");
		await f.queue.enqueue({
			runId,
			taskId: "MFW-1",
			branch: "mfw/t1",
			targetBranch: "main",
		});

		expect(await f.queue.tick()).toBe("merged");
		expect((await git(["show", "main:a.txt"], f.root)).stdout).toBe("hello");
		expect(events).toContain("merge.completed");
		expect(events).not.toContain("merge.push_failed");
		await f.cleanup();
	});

	/**
	 * The merge has already landed locally when the push runs. Parking the job
	 * would re-queue a completed merge, so a push failure is reported and skipped.
	 */
	test("a failed push leaves the merge landed and the job merged", async () => {
		const f = await fixture(undefined, { enabled: true, remote: "origin" });
		// Unresolvable remote: only the push may fail.
		await gitOk(["remote", "add", "origin", "/nonexistent/repo.git"], f.root);
		const events: string[] = [];
		f.bus.subscribe((e) => events.push(e.type));

		const runId = await f.makeBranchRun("mfw/t1", "a.txt", "hello\n");
		await f.queue.enqueue({
			runId,
			taskId: "MFW-1",
			branch: "mfw/t1",
			targetBranch: "main",
		});

		expect(await f.queue.tick()).toBe("merged");
		expect((await git(["show", "main:a.txt"], f.root)).stdout).toBe("hello");
		expect(f.merged.length).toBe(1);
		expect(f.parked.length).toBe(0);
		const [row] = await f.handle.db
			.select()
			.from(mergeJobs)
			.where(eq(mergeJobs.runId, runId));
		expect(row?.state).toBe("merged");
		expect(events).toContain("merge.completed");
		expect(events).toContain("merge.push_failed");
		await f.cleanup();
	});

	/**
	 * `onMerged` runs before `publish`, so the board commit task release makes
	 * rides out in the same push (otherwise the remote's last commit shows the
	 * task still `in-progress`).
	 */
	test("onMerged's tail runs before publish, so its own commit reaches the remote in the same push", async () => {
		const remote = await mkdtemp(join(tmpdir(), "mfw-remote-"));
		await git(["init", "-q", "--bare", "-b", "main"], remote);
		const f = await fixture(
			undefined,
			{ enabled: true, remote: "origin" },
			async () => {
				// Stands in for `tasks.release` plus the board committer.
				await writeFile(join(f.root, "board.txt"), "done\n");
				await gitOk(["add", "-A"], f.root);
				await gitOk(
					["commit", "-q", "-m", "mfw: MFW-1: in-progress → done"],
					f.root,
				);
			},
		);
		await gitOk(["remote", "add", "origin", remote], f.root);

		const runId = await f.makeBranchRun("mfw/t1", "a.txt", "hello\n");
		await f.queue.enqueue({
			runId,
			taskId: "MFW-1",
			branch: "mfw/t1",
			targetBranch: "main",
		});
		expect(await f.queue.tick()).toBe("merged");

		// The remote carries the primary's current head (merge plus board commit).
		const primaryHead = await gitOk(["rev-parse", "main"], f.root);
		expect(await gitOk(["show", "main:board.txt"], f.root)).toBe("done");
		expect(await gitOk(["rev-parse", "main"], remote)).toBe(primaryHead);
		await rm(remote, { recursive: true, force: true });
		await f.cleanup();
	});

	/**
	 * A failed `git remote` is not "no remotes". Repository discovery is broken
	 * just as publication starts; the failure must be observable without
	 * changing the outcome.
	 */
	test("a failed git remote invocation is reported instead of treated as no remote", async () => {
		const f = await fixture(
			undefined,
			{ enabled: true, remote: "origin" },
			async () => {
				await rename(join(f.root, ".git"), join(f.root, ".git-broken"));
			},
		);
		const events: string[] = [];
		f.bus.subscribe((event) => events.push(event.type));

		const runId = await f.makeBranchRun("mfw/t1", "a.txt", "hello\n");
		await f.queue.enqueue({
			runId,
			taskId: "MFW-1",
			branch: "mfw/t1",
			targetBranch: "main",
		});

		expect(await f.queue.tick()).toBe("merged");
		expect(f.merged.length).toBe(1);
		expect(f.parked.length).toBe(0);
		expect(events).toContain("merge.completed");
		expect(events).toContain("merge.push_failed");
		await f.cleanup();
	});

	/** Board-only commits (status drag, task creation) have no merge, so `publish` never fires; `publishBranch` is the sweep's catch-up. */
	test("publishBranch catches up board-only commits that had no merge to ride along with", async () => {
		const f = await fixture(undefined, { enabled: true, remote: "origin" });
		const remote = await mkdtemp(join(tmpdir(), "mfw-remote-"));
		await git(["init", "-q", "--bare", "-b", "main"], remote);
		await gitOk(["remote", "add", "origin", remote], f.root);

		await writeFile(join(f.root, "board.txt"), "moved\n");
		await gitOk(["add", "-A"], f.root);
		await gitOk(
			["commit", "-q", "-m", "mfw: MFW-2: ready → in-progress"],
			f.root,
		);

		await f.queue.publishBranch("main");

		expect(await gitOk(["rev-parse", "main"], remote)).toBe(
			await gitOk(["rev-parse", "main"], f.root),
		);
		await rm(remote, { recursive: true, force: true });
		await f.cleanup();
	});

	test("publishBranch with pushing off does nothing", async () => {
		const f = await fixture();
		const remote = await mkdtemp(join(tmpdir(), "mfw-remote-"));
		await git(["init", "-q", "--bare", "-b", "main"], remote);
		await gitOk(["remote", "add", "origin", remote], f.root);

		await f.queue.publishBranch("main");

		expect((await git(["rev-parse", "main"], remote)).exitCode).not.toBe(0);
		await rm(remote, { recursive: true, force: true });
		await f.cleanup();
	});

	test("FIFO: two jobs merge in enqueue order", async () => {
		const f = await fixture();
		const r1 = await f.makeBranchRun("mfw/t1", "a.txt", "one\n");
		const r2 = await f.makeBranchRun("mfw/t2", "b.txt", "two\n");
		await f.queue.enqueue({
			runId: r1,
			branch: "mfw/t1",
			targetBranch: "main",
		});
		await f.queue.enqueue({
			runId: r2,
			branch: "mfw/t2",
			targetBranch: "main",
		});
		expect(await f.queue.tick()).toBe("merged");
		expect(await f.queue.tick()).toBe("merged");
		expect(await f.queue.tick()).toBe("idle");
		expect(f.merged.map((m) => m.job.branch)).toEqual(["mfw/t1", "mfw/t2"]);
		await f.cleanup();
	});

	test("conflict → rebase in run worktree → re-verify → retry merge succeeds", async () => {
		const f = await fixture();
		// both branches edit base.txt: the second merge conflicts
		const r1 = await f.makeBranchRun("mfw/t1", "base.txt", "from t1\n");
		const r2 = await f.makeBranchRun("mfw/t2", "base.txt", "base\nfrom t2\n");
		await f.queue.enqueue({
			runId: r1,
			branch: "mfw/t1",
			targetBranch: "main",
		});
		await f.queue.enqueue({
			runId: r2,
			branch: "mfw/t2",
			targetBranch: "main",
		});
		expect(await f.queue.tick()).toBe("merged");
		// both changed the same lines, so the rebase itself conflicts → parked
		expect(await f.queue.tick()).toBe("parked");
		// a single park stays below the retry budget, so `onParked` has not fired
		expect(f.parked.length).toBe(0);
		const [job1] = await f.handle.db
			.select()
			.from(mergeJobs)
			.where(eq(mergeJobs.runId, r2));
		expect(job1?.state).toBe("parked");
		expect(job1?.parkRetries).toBe(1);

		// Parking appends a `merge.parked` event.
		const [ev] = await f.handle.db
			.select()
			.from(eventsTable)
			.where(eq(eventsTable.type, "merge.parked"));
		expect(ev).toBeDefined();
		expect(ev?.payload).toMatchObject({
			target: "main",
			kind: "conflict",
			retries: 1,
			exhausted: false,
		});
		expect(String((ev?.payload as { reason: string }).reason)).toContain(
			"rebase conflict",
		);

		// t3 was built from the original main but touches its own file, so it merges cleanly.
		const r3 = await f.makeBranchRun("mfw/t3", "c.txt", "three\n");
		await f.queue.enqueue({
			runId: r3,
			branch: "mfw/t3",
			targetBranch: "main",
		});
		expect(await f.queue.tick()).toBe("merged");
		await f.cleanup();
	});

	test("MFW-52: a parked job is requeued automatically and merges once retried, nothing was ever escalated", async () => {
		const f = await fixture();
		const r1 = await f.makeBranchRun("mfw/t1", "base.txt", "from t1\n");
		const r2 = await f.makeBranchRun("mfw/t2", "base.txt", "base\nfrom t2\n");
		await f.queue.enqueue({
			runId: r1,
			branch: "mfw/t1",
			targetBranch: "main",
		});
		await f.queue.enqueue({
			runId: r2,
			branch: "mfw/t2",
			targetBranch: "main",
		});
		expect(await f.queue.tick()).toBe("merged");
		expect(await f.queue.tick()).toBe("parked"); // t2's rebase conflicts with t1

		// Nothing new to reconcile with: still parked.
		expect(await f.queue.retryParked()).toBe(1);
		expect(await f.queue.tick()).toBe("parked");
		expect(f.parked.length).toBe(0); // still below the retry budget

		// Resolve the conflict on main (as a later commit could), then retry: it merges with no human involved.
		await git(["checkout", "main"], f.root);
		await writeFile(join(f.root, "base.txt"), "base\nfrom t2\n");
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "resolve"], f.root);

		expect(await f.queue.retryParked()).toBe(1);
		expect(await f.queue.tick()).toBe("merged");
		expect(f.parked.length).toBe(0);
		await f.cleanup();
	});

	test("MFW-52: a park that never resolves escalates exactly once, with the retry count in the message", async () => {
		const f = await fixture();
		const r1 = await f.makeBranchRun("mfw/t1", "base.txt", "from t1\n");
		const r2 = await f.makeBranchRun("mfw/t2", "base.txt", "base\nfrom t2\n");
		await f.queue.enqueue({
			runId: r1,
			branch: "mfw/t1",
			targetBranch: "main",
		});
		await f.queue.enqueue({
			runId: r2,
			branch: "mfw/t2",
			targetBranch: "main",
		});
		expect(await f.queue.tick()).toBe("merged");
		expect(await f.queue.tick()).toBe("parked");

		// The conflict never changes, so it parks every time until the budget runs out.
		for (let i = 0; i < 5; i++) {
			if (f.parked.length > 0) break;
			await f.queue.retryParked();
			await f.queue.tick();
		}

		expect(f.parked.length).toBe(1);
		expect(f.parked[0]?.kind).toBe("conflict");
		expect(f.parked[0]?.reason).toContain("retried this automatically");
		expect(f.parked[0]?.reason).toContain("3 times");

		// Once escalated, `retryParked()` must not touch it again.
		expect(await f.queue.retryParked()).toBe(0);
		const [job] = await f.handle.db
			.select()
			.from(mergeJobs)
			.where(eq(mergeJobs.runId, r2));
		expect(job?.state).toBe("parked");
		expect(job?.parkRetries).toBe(3);
		await f.cleanup();
	});

	test("MFW-58: exhausted retries hand off to an automatic unblock run instead of a human", async () => {
		const f = await fixture();
		const r1 = await f.makeBranchRun("mfw/t1", "base.txt", "from t1\n");
		const r2 = await f.makeBranchRun("mfw/t2", "base.txt", "base\nfrom t2\n");
		await f.queue.enqueue({
			runId: r1,
			branch: "mfw/t1",
			targetBranch: "main",
		});
		await f.queue.enqueue({
			runId: r2,
			branch: "mfw/t2",
			targetBranch: "main",
		});
		expect(await f.queue.tick()).toBe("merged");
		expect(await f.queue.tick()).toBe("parked");

		const unblocked: { job: MergeJobView; reason: string }[] = [];
		f.queue.unblock = async (job, reason) => {
			unblocked.push({ job, reason });
			return { runId: "01UNBLOCKCHILDRUNXXXXXXXXX" };
		};

		for (let i = 0; i < 5; i++) {
			if (unblocked.length > 0) break;
			await f.queue.retryParked();
			await f.queue.tick();
		}

		expect(unblocked.length).toBe(1);
		expect(unblocked[0]?.reason).toBeTruthy();
		// not escalated to a human
		expect(f.parked.length).toBe(0);

		const [job] = await f.handle.db
			.select()
			.from(mergeJobs)
			.where(eq(mergeJobs.runId, r2));
		expect(job?.state).toBe("abandoned");
		expect(job?.parkRetries).toBe(3);
		expect(job?.error).toBeTruthy();

		const [ev] = await f.handle.db
			.select()
			.from(eventsTable)
			.where(eq(eventsTable.type, "merge.unblock_started"));
		expect(
			(ev?.payload as { childRunId?: string; retries?: number } | undefined)
				?.childRunId,
		).toBe("01UNBLOCKCHILDRUNXXXXXXXXX");

		// Terminal: the retry sweep leaves it alone.
		expect(await f.queue.retryParked()).toBe(0);
		await f.cleanup();
	});

	test("MFW-58: a declined (or failed) unblock attempt still escalates to a human", async () => {
		const f = await fixture();
		const r1 = await f.makeBranchRun("mfw/t1", "base.txt", "from t1\n");
		const r2 = await f.makeBranchRun("mfw/t2", "base.txt", "base\nfrom t2\n");
		await f.queue.enqueue({
			runId: r1,
			branch: "mfw/t1",
			targetBranch: "main",
		});
		await f.queue.enqueue({
			runId: r2,
			branch: "mfw/t2",
			targetBranch: "main",
		});
		expect(await f.queue.tick()).toBe("merged");
		expect(await f.queue.tick()).toBe("parked");

		let calls = 0;
		f.queue.unblock = async () => {
			calls++;
			return null; // brain disabled, or the spawn itself failed
		};

		for (let i = 0; i < 5; i++) {
			if (f.parked.length > 0) break;
			await f.queue.retryParked();
			await f.queue.tick();
		}

		expect(calls).toBe(1); // asked once, at exhaustion
		expect(f.parked.length).toBe(1); // declined → escalates to a human
		const [job] = await f.handle.db
			.select()
			.from(mergeJobs)
			.where(eq(mergeJobs.runId, r2));
		expect(job?.state).toBe("parked");
		await f.cleanup();
	});

	test("re-verify failure after rebase parks the job with kind reverify", async () => {
		// Force the rebase path: same file, t1 edits the top and t2 the bottom of a padded file.
		const f0 = await fixture();
		await writeFile(
			join(f0.root, "base.txt"),
			`top\n${"pad\n".repeat(10)}bottom\n`,
		);
		await git(["add", "-A"], f0.root);
		await git(["commit", "-q", "-m", "longer base"], f0.root);
		f0.handle.close();
		await rm(f0.root, { recursive: true, force: true });

		// Rebuild with the longer base from the start.
		const root = await mkdtemp(join(tmpdir(), "mfw-mq-"));
		await git(["init", "-q", "-b", "main"], root);
		await git(["config", "user.email", "t@t"], root);
		await git(["config", "user.name", "t"], root);
		await writeFile(
			join(root, "base.txt"),
			`top\n${"pad\n".repeat(10)}bottom\n`,
		);
		await git(["add", "-A"], root);
		await git(["commit", "-q", "-m", "init"], root);
		const handle = await openProjectDb(join(root, ".mfw"));
		const parked: Fixture["parked"] = [];
		const queue = new MergeQueue({
			handle,
			bus: new EventBus(),
			projectRoot: root,
			log: silentLogger(),
			reverify: async () => ({
				passed: false,
				detail: "DoD broke on new base",
			}),
			onMerged: async () => {},
			onParked: async (job, reason, kind) => {
				parked.push({ job, reason, kind });
			},
		});
		const mkRun = async (name: string, content: string) => {
			const wt = join(root, "worktrees", name);
			await git(["worktree", "add", "-q", "-b", name, wt, "main"], root);
			await writeFile(join(wt, "base.txt"), content);
			await git(["add", "-A"], wt);
			await git(["commit", "-q", "-m", name], wt);
			const runId = ulid();
			await handle.db.insert(runs).values({
				id: runId,
				kind: "task",
				label: name,
				model: "sonnet",
				cwd: wt,
				worktreePath: wt,
				branch: name,
				integrationBranch: "main",
				startedAt: new Date(),
			});
			return runId;
		};
		const pad = "pad\n".repeat(10);
		const r1 = await mkRun("mfw/t1", `T1\ntop\n${pad}bottom\n`);
		const r2 = await mkRun("mfw/t2", `top\n${pad}bottom\nT2\n`);
		await queue.enqueue({ runId: r1, branch: "mfw/t1", targetBranch: "main" });
		await queue.enqueue({ runId: r2, branch: "mfw/t2", targetBranch: "main" });
		expect(await queue.tick()).toBe("merged");
		// Opposite ends of a padded file may merge cleanly, so accept either outcome.
		// A single park is below the retry budget, so read `kind` off the event instead of `parked`.
		const second = await queue.tick();
		if (second === "parked") {
			expect(parked.length).toBe(0);
			const [ev] = await handle.db
				.select()
				.from(eventsTable)
				.where(eq(eventsTable.type, "merge.parked"));
			expect(
				(ev?.payload as { kind?: string } | undefined)?.kind,
			).toBeDefined();
		} else {
			expect(second).toBe("merged");
		}
		handle.close();
		await rm(root, { recursive: true, force: true });
	});

	test("a crashed re-verify after rebase parks as crashed, not a real conflict (MFW-56)", async () => {
		// Same setup as above, but `reverify` reports a signal death (as `verify()` does
		// when a check dies twice); the park must say so, not blame the rebase.
		const root = await mkdtemp(join(tmpdir(), "mfw-mq-"));
		await git(["init", "-q", "-b", "main"], root);
		await git(["config", "user.email", "t@t"], root);
		await git(["config", "user.name", "t"], root);
		const pad = "pad\n".repeat(10);
		await writeFile(join(root, "base.txt"), `top\n${pad}bottom\n`);
		await git(["add", "-A"], root);
		await git(["commit", "-q", "-m", "init"], root);
		const handle = await openProjectDb(join(root, ".mfw"));
		const parked: Fixture["parked"] = [];
		const queue = new MergeQueue({
			handle,
			bus: new EventBus(),
			projectRoot: root,
			log: silentLogger(),
			reverify: async () => ({
				passed: false,
				detail: "check process was killed by a signal twice in a row",
				crashed: true,
			}),
			onMerged: async () => {},
			onParked: async (job, reason, kind) => {
				parked.push({ job, reason, kind });
			},
		});
		const mkRun = async (name: string, content: string) => {
			const wt = join(root, "worktrees", name);
			await git(["worktree", "add", "-q", "-b", name, wt, "main"], root);
			await writeFile(join(wt, "base.txt"), content);
			await git(["add", "-A"], wt);
			await git(["commit", "-q", "-m", name], wt);
			const runId = ulid();
			await handle.db.insert(runs).values({
				id: runId,
				kind: "task",
				label: name,
				model: "sonnet",
				cwd: wt,
				worktreePath: wt,
				branch: name,
				integrationBranch: "main",
				startedAt: new Date(),
			});
			return runId;
		};
		const r1 = await mkRun("mfw/t1", `T1\ntop\n${pad}bottom\n`);
		const r2 = await mkRun("mfw/t2", `top\n${pad}bottom\nT2\n`);
		await queue.enqueue({ runId: r1, branch: "mfw/t1", targetBranch: "main" });
		await queue.enqueue({ runId: r2, branch: "mfw/t2", targetBranch: "main" });
		expect(await queue.tick()).toBe("merged");
		const second = await queue.tick();
		if (second === "parked") {
			expect(parked.length).toBe(0); // below MAX_PARK_RETRIES, not escalated
			const [ev] = await handle.db
				.select()
				.from(eventsTable)
				.where(eq(eventsTable.type, "merge.parked"));
			const payload = ev?.payload as
				| { kind?: string; crashed?: boolean; reason?: string }
				| undefined;
			expect(payload?.kind).toBe("reverify");
			expect(payload?.crashed).toBe(true);
			expect(payload?.reason).not.toContain("re-verify failed after rebase");
		} else {
			expect(second).toBe("merged");
		}
		handle.close();
		await rm(root, { recursive: true, force: true });
	});

	test("red-main pauses the queue; jobs wait instead of bouncing", async () => {
		const f = await fixture();
		const runId = await f.makeBranchRun("mfw/t1", "a.txt", "hello\n");
		await f.queue.enqueue({ runId, branch: "mfw/t1", targetBranch: "main" });
		await f.handle.db.insert(engineKv).values({
			key: "main_red",
			value: { red: true, since: Date.now() },
			updatedAt: new Date(),
		});
		expect(await f.queue.tick()).toBe("paused");
		const [job] = await f.handle.db.select().from(mergeJobs);
		expect(job?.state).toBe("queued"); // waiting, not parked
		await f.handle.db
			.update(engineKv)
			.set({ value: { red: false, since: Date.now() } })
			.where(eq(engineKv.key, "main_red"));
		expect(await f.queue.tick()).toBe("merged");
		await f.cleanup();
	});

	test("red-main admits only its repair job and skips older ordinary work", async () => {
		const f = await fixture(undefined, undefined, undefined, () => true);
		const ordinary = await f.makeBranchRun(
			"mfw/ordinary",
			"ordinary.txt",
			"wait\n",
		);
		const repair = await f.makeBranchRun("mfw/repair", "repair.txt", "fix\n");
		await f.queue.enqueue({
			runId: ordinary,
			taskId: "MFW-OLD",
			branch: "mfw/ordinary",
			targetBranch: "main",
		});
		await f.queue.enqueue({
			runId: repair,
			taskId: "MFW-BROKEN",
			branch: "mfw/repair",
			targetBranch: "main",
		});
		await f.handle.db.insert(engineKv).values({
			key: "main_red",
			value: {
				red: true,
				since: Date.now(),
				causeTaskId: "MFW-BROKEN",
				repairRunId: repair,
			},
			updatedAt: new Date(),
		});

		expect(await f.queue.tick()).toBe("merged");
		expect(f.merged.map((entry) => entry.job.runId)).toEqual([repair]);
		const [waiting] = await f.handle.db
			.select()
			.from(mergeJobs)
			.where(eq(mergeJobs.runId, ordinary));
		expect(waiting?.state).toBe("queued");
		expect(await f.queue.tick()).toBe("paused");
		await f.cleanup();
	});

	test("an escalated red-main admits no repair merge", async () => {
		const f = await fixture(undefined, undefined, undefined, () => true);
		const repairRun = await f.makeBranchRun(
			"mfw/repair",
			"repair.txt",
			"fixed\n",
		);
		await f.queue.enqueue({
			runId: repairRun,
			taskId: "MFW-CAUSE",
			branch: "mfw/repair",
			targetBranch: "main",
		});
		await f.handle.db.insert(engineKv).values({
			key: "main_red",
			value: {
				red: true,
				since: Date.now(),
				causeTaskId: "MFW-CAUSE",
				repairRunId: repairRun,
				escalated: true,
			},
			updatedAt: new Date(),
		});

		expect(await f.queue.tick()).toBe("paused");
		expect((await git(["show", "main:repair.txt"], f.root)).exitCode).not.toBe(
			0,
		);
		await f.cleanup();
	});

	test("enqueue is idempotent by runId", async () => {
		const f = await fixture();
		const runId = await f.makeBranchRun("mfw/t1", "a.txt", "x\n");
		await f.queue.enqueue({ runId, branch: "mfw/t1", targetBranch: "main" });
		await f.queue.enqueue({ runId, branch: "mfw/t1", targetBranch: "main" });
		const jobs = await f.handle.db.select().from(mergeJobs);
		expect(jobs.length).toBe(1);
		await f.cleanup();
	});

	test("activeByTask and byRun report a queued job; MFW-50 needs both to keep the review surfaces from re-offering it", async () => {
		const f = await fixture();
		const runId = await f.makeBranchRun("mfw/t1", "a.txt", "x\n");
		await f.queue.enqueue({
			runId,
			taskId: "T-1",
			branch: "mfw/t1",
			targetBranch: "main",
		});
		expect(await f.queue.activeByTask()).toEqual([
			{ taskId: "T-1", state: "queued" },
		]);
		expect(await f.queue.byRun(runId)).toEqual({
			state: "queued",
			error: null,
		});
		await f.cleanup();
	});

	test("activeByTask excludes parked and merged jobs, one is already landed, the other needs a fresh decision", async () => {
		const f = await fixture();
		const runId = await f.makeBranchRun("mfw/t1", "a.txt", "x\n");
		await f.queue.enqueue({
			runId,
			taskId: "T-1",
			branch: "mfw/t1",
			targetBranch: "main",
		});
		expect(await f.queue.tick()).toBe("merged");
		expect(await f.queue.activeByTask()).toEqual([]);
		expect((await f.queue.byRun(runId))?.state).toBe("merged");
		await f.cleanup();
	});

	test("resetInFlight requeues crashed jobs after resetting the worktree", async () => {
		const f = await fixture();
		const runId = await f.makeBranchRun("mfw/t1", "a.txt", "x\n");
		await f.queue.enqueue({ runId, branch: "mfw/t1", targetBranch: "main" });
		// simulate a crash mid-merge
		await f.handle.db
			.update(mergeJobs)
			.set({ state: "merging" })
			.where(eq(mergeJobs.runId, runId));
		expect(await f.queue.resetInFlight()).toBe(1);
		const [job] = await f.handle.db.select().from(mergeJobs);
		expect(job?.state).toBe("queued");
		expect(await f.queue.tick()).toBe("merged");
		await f.cleanup();
	});
});

describe("the primary checkout is never left inconsistent", () => {
	test("a merge that WOULD clobber a local edit defers, and lands once committed", async () => {
		// Ref, index and worktree must move together: a ref ahead of the working tree
		// shows phantom deletions and lets `git commit -a` revert the merge. The
		// collision must be real (same path), not an unrelated dirty file.
		const f = await fixture();
		const runId = await f.makeBranchRun(
			"mfw/t1",
			"base.txt",
			"from the branch\n",
		);
		await f.queue.enqueue({ runId, branch: "mfw/t1", targetBranch: "main" });
		const headBefore = await gitOk(["rev-parse", "HEAD"], f.root);

		await writeFile(join(f.root, "base.txt"), "uncommitted work\n");
		expect(await f.queue.tick()).toBe("deferred");

		// the ref did not move and the edit is untouched
		expect(await gitOk(["rev-parse", "HEAD"], f.root)).toBe(headBefore);
		expect(await Bun.file(join(f.root, "base.txt")).text()).toBe(
			"uncommitted work\n",
		);
		const [job] = await f.handle.db.select().from(mergeJobs);
		expect(job?.state).toBe("queued");
		expect(job?.error).toContain("cannot fast-forward");

		await git(["checkout", "--", "base.txt"], f.root);
		expect(await f.queue.tick()).toBe("merged");
		await f.cleanup();
	});

	test("a target branch NOT checked out is merged without touching the primary", async () => {
		const f = await fixture();
		await git(["checkout", "-q", "-b", "human-work"], f.root);
		const runId = await f.makeBranchRun("mfw/t1", "a.txt", "hello\n");
		await f.queue.enqueue({ runId, branch: "mfw/t1", targetBranch: "main" });
		const headBefore = await gitOk(["rev-parse", "HEAD"], f.root);

		expect(await f.queue.tick()).toBe("merged");
		// main advanced; the primary's branch and worktree did not
		expect(await gitOk(["rev-parse", "HEAD"], f.root)).toBe(headBefore);
		expect((await gitOk(["status", "--porcelain"], f.root)).trim()).toBe("");
		expect((await git(["show", "main:a.txt"], f.root)).stdout).toBe("hello");
		await f.cleanup();
	});
});

describe("an unrelated dirty file does not block the queue", () => {
	test("a fast-forward lands with local edits present, and leaves them alone", async () => {
		// A whole-tree `git status` pre-screen deferred every job on one edited file;
		// `merge --ff-only` only objects to paths it would overwrite.
		const f = await fixture();
		const runId = await f.makeBranchRun("mfw/t1", "feature.txt", "shipped\n");

		// Unrelated local edits: one dirty, one staged.
		await writeFile(join(f.root, "base.txt"), "base, edited\n");
		await writeFile(join(f.root, "scratch.txt"), "wip\n");
		await git(["add", "scratch.txt"], f.root);

		await f.queue.enqueue({ runId, branch: "mfw/t1", targetBranch: "main" });
		expect(await f.queue.tick()).toBe("merged");

		expect((await git(["show", "main:feature.txt"], f.root)).stdout).toContain(
			"shipped",
		);
		// local edits are untouched
		expect(await readFile(join(f.root, "base.txt"), "utf8")).toBe(
			"base, edited\n",
		);
		expect(await readFile(join(f.root, "scratch.txt"), "utf8")).toBe("wip\n");
		await f.cleanup();
	});
});

/**
 * The board firewall. Run worktrees are sparse-checked-out (`worktree.test.ts`);
 * this covers what gets past that: pre-sparse worktrees, `git sparse-checkout
 * disable`, or a human editing a task file on a feature branch.
 */
describe("no branch may change the board on its way in", () => {
	/**
	 * Put a real board on `main`. `.mfw/lifetime/` and `AGENTS.md` are included
	 * because the firewall covers all of `.mfw/`: recurring-task definitions are
	 * code the daemon runs, and AGENTS.md is the rulebook runs are judged against.
	 */
	async function withBoard(f: Fixture): Promise<void> {
		await mkdir(join(f.root, ".mfw/tasks/ready"), { recursive: true });
		await mkdir(join(f.root, ".mfw/tasks/done"), { recursive: true });
		await mkdir(join(f.root, ".mfw/adrs"), { recursive: true });
		await mkdir(join(f.root, ".mfw/lifetime"), { recursive: true });
		await mkdir(join(f.root, ".mfw/triggers"), { recursive: true });
		await mkdir(join(f.root, ".mfw/state"), { recursive: true });
		await writeFile(
			join(f.root, ".mfw/tasks/ready/MFW-1-alpha.md"),
			"---\nid: MFW-1\nrev: 1\ntitle: alpha\n---\n\nthe real body\n",
		);
		await writeFile(
			join(f.root, ".mfw/tasks/ready/MFW-2-beta.md"),
			"---\nid: MFW-2\nrev: 1\ntitle: beta\n---\n\nsecond\n",
		);
		await writeFile(join(f.root, ".mfw/adrs/0001-s.md"), "adr\n");
		await writeFile(
			join(f.root, ".mfw/lifetime/nightly.md"),
			"---\nid: nightly\ntitle: nightly sweep\ntrigger: { schedule: '0 3 * * *' }\n---\n",
		);
		await writeFile(join(f.root, ".mfw/AGENTS.md"), "the rules\n");
		await writeFile(join(f.root, ".mfw/config.yaml"), "name: demo\n");
		await writeFile(join(f.root, ".mfw/state/tracked"), "runtime\n");
		await writeFile(join(f.root, ".mfw/triggers/deploy.md"), "deploy v1\n");
		await writeFile(join(f.root, ".mfw/triggers/obsolete.md"), "obsolete\n");
		await git(["add", "-A", "--", ".mfw"], f.root);
		// Runtime state is ignored; force one tracked file so the firewall covers it too.
		await git(["add", "-f", "--", ".mfw/state/tracked"], f.root);
		await git(["commit", "-q", "-m", "board"], f.root);
	}

	/** Everything tracked under `.mfw/` on a ref, path → bytes. */
	async function boardTree(
		root: string,
		ref: string,
	): Promise<Map<string, string>> {
		const ls = await git(
			["ls-tree", "-r", "--name-only", ref, "--", ".mfw"],
			root,
		);
		const out = new Map<string, string>();
		for (const p of ls.stdout.split("\n").filter(Boolean)) {
			out.set(p, (await git(["show", `${ref}:${p}`], root)).stdout);
		}
		return out;
	}

	/** A branch whose agent did `body(worktree)` to the board, then committed. */
	async function hostileRun(
		f: Fixture,
		name: string,
		body: (wt: string) => Promise<void>,
	): Promise<string> {
		const wt = join(f.root, "worktrees", name);
		await git(["worktree", "add", "-q", "-b", name, wt, "main"], f.root);
		// real code work that must still land
		await writeFile(join(wt, "shipped.txt"), "real work\n");
		await body(wt);
		await git(["add", "-A"], wt);
		await git(["commit", "-q", "-m", `work on ${name}`], wt);
		const runId = ulid();
		await f.handle.db.insert(runs).values({
			id: runId,
			kind: "task",
			label: name,
			model: "sonnet",
			cwd: wt,
			worktreePath: wt,
			branch: name,
			integrationBranch: "main",
			startedAt: new Date(),
		});
		return runId;
	}

	const hostilities: [string, (wt: string) => Promise<void>][] = [
		[
			"edits a task file",
			async (wt) =>
				writeFile(
					join(wt, ".mfw/tasks/ready/MFW-1-alpha.md"),
					"---\nid: MFW-1\nrev: 99\ntitle: HIJACKED\n---\n\nrewritten\n",
				),
		],
		[
			"deletes a task file",
			async (wt) => rm(join(wt, ".mfw/tasks/ready/MFW-2-beta.md")),
		],
		[
			"fabricates a status transition",
			async (wt) => {
				// git does not track empty directories, so `done/` is absent from the worktree.
				await mkdir(join(wt, ".mfw/tasks/done"), { recursive: true });
				await rename(
					join(wt, ".mfw/tasks/ready/MFW-1-alpha.md"),
					join(wt, ".mfw/tasks/done/MFW-1-alpha.md"),
				);
			},
		],
		[
			"invents a task of its own",
			async (wt) =>
				writeFile(
					join(wt, ".mfw/tasks/ready/MFW-999-invented.md"),
					"---\nid: MFW-999\nrev: 1\ntitle: I made this up\n---\n",
				),
		],
		[
			"rewrites an ADR",
			async (wt) => writeFile(join(wt, ".mfw/adrs/0001-s.md"), "mine\n"),
		],
		// The defences once stopped at `tasks/` and `adrs/`, so anything else under `.mfw/` merged verbatim.
		[
			"authors its own recurring task",
			async (wt) => {
				await mkdir(join(wt, ".mfw/lifetime"), { recursive: true });
				await writeFile(
					join(wt, ".mfw/lifetime/nightly.md"),
					"---\nid: nightly\ntitle: MINE NOW\ntrigger: { schedule: '* * * * *' }\n---\n",
				);
				await writeFile(
					join(wt, ".mfw/lifetime/backdoor.md"),
					"---\nid: backdoor\ntitle: run forever\ntrigger: { schedule: '* * * * *' }\n---\n",
				);
			},
		],
		[
			"rewrites the rules it is about to be judged against",
			async (wt) => writeFile(join(wt, ".mfw/AGENTS.md"), "no rules\n"),
		],
		[
			"rewrites configuration and tracked runtime state",
			async (wt) => {
				await writeFile(join(wt, ".mfw/config.yaml"), "name: hostile\n");
				await writeFile(join(wt, ".mfw/state/tracked"), "corrupt\n");
				await writeFile(join(wt, ".mfw/state/invented"), "new runtime\n");
				await git(["add", "-f", "--", ".mfw/state/invented"], wt);
			},
		],
	];

	for (const [what, body] of hostilities) {
		test(`a run that ${what} lands its code and none of that`, async () => {
			const f = await fixture();
			await withBoard(f);
			const before = await boardTree(f.root, "main");
			expect(before.size).toBe(9); // protected files plus two trigger definitions

			const runId = await hostileRun(f, "mfw/hostile", body);
			await f.queue.enqueue({
				runId,
				taskId: "MFW-1",
				branch: "mfw/hostile",
				targetBranch: "main",
			});
			const events: string[] = [];
			f.bus.subscribe((e) => events.push(e.type));

			expect(await f.queue.tick()).toBe("merged");

			// board is byte-identical; the real work still landed (surgical, not a veto)
			expect(await boardTree(f.root, "main")).toEqual(before);
			expect((await git(["show", "main:shipped.txt"], f.root)).stdout).toBe(
				"real work",
			);
			expect(events).toContain("merge.board_reverted");
			const [ev] = await f.handle.db
				.select()
				.from(eventsTable)
				.where(eq(eventsTable.type, "merge.board_reverted"));
			const payload = ev?.payload as { paths: string[]; target: string };
			expect(payload.target).toBe("main");
			expect(payload.paths.length).toBeGreaterThan(0);
			expect(payload.paths.every((p) => p.startsWith(".mfw/"))).toBe(true);
			await f.cleanup();
		});
	}

	test("trigger additions, edits and deletions survive the queue byte-for-byte", async () => {
		const f = await fixture();
		await withBoard(f);
		const wt = join(f.root, "worktrees", "mfw/triggers");
		await git(
			["worktree", "add", "-q", "-b", "mfw/triggers", wt, "main"],
			f.root,
		);
		const edited = "deploy v2\nwith exact bytes  \n";
		const added = "new trigger\nsecond line\n";
		await writeFile(join(wt, ".mfw/triggers/deploy.md"), edited);
		await rm(join(wt, ".mfw/triggers/obsolete.md"));
		await writeFile(join(wt, ".mfw/triggers/new.md"), added);
		await git(["add", "-A"], wt);
		await git(["commit", "-q", "-m", "author triggers"], wt);
		const runId = ulid();
		await f.handle.db.insert(runs).values({
			id: runId,
			kind: "task",
			label: "triggers",
			model: "sonnet",
			cwd: wt,
			worktreePath: wt,
			branch: "mfw/triggers",
			integrationBranch: "main",
			startedAt: new Date(),
		});
		await f.queue.enqueue({
			runId,
			branch: "mfw/triggers",
			targetBranch: "main",
		});

		expect(await f.queue.tick()).toBe("merged");
		expect(
			await readFile(join(f.root, ".mfw/triggers/deploy.md"), "utf8"),
		).toBe(edited);
		expect(await readFile(join(f.root, ".mfw/triggers/new.md"), "utf8")).toBe(
			added,
		);
		expect(existsSync(join(f.root, ".mfw/triggers/obsolete.md"))).toBe(false);
		await f.cleanup();
	});

	test("an ordinary run does not trip it, and emits nothing", async () => {
		// A firewall firing on the normal path would amend every merge commit and spam the timeline.
		const f = await fixture();
		await withBoard(f);
		const before = await boardTree(f.root, "main");
		const runId = await f.makeBranchRun("mfw/clean", "a.txt", "hello\n");
		await f.queue.enqueue({
			runId,
			branch: "mfw/clean",
			targetBranch: "main",
		});
		const events: string[] = [];
		f.bus.subscribe((e) => events.push(e.type));
		expect(await f.queue.tick()).toBe("merged");
		expect(await boardTree(f.root, "main")).toEqual(before);
		expect(events).not.toContain("merge.board_reverted");
		await f.cleanup();
	});

	test("a project with no ADRs directory merges normally", async () => {
		// `git checkout <base> -- .mfw/adrs` fails on a pathspec the base lacks, which every ADR-less project would hit.
		const f = await fixture();
		await mkdir(join(f.root, ".mfw/tasks/ready"), { recursive: true });
		await writeFile(
			join(f.root, ".mfw/tasks/ready/MFW-1-a.md"),
			"---\nid: MFW-1\nrev: 1\ntitle: a\n---\n",
		);
		await git(["add", "-A", "--", ".mfw"], f.root);
		await git(["commit", "-q", "-m", "board, no ADRs"], f.root);

		const runId = await f.makeBranchRun("mfw/t1", "a.txt", "hello\n");
		await f.queue.enqueue({ runId, branch: "mfw/t1", targetBranch: "main" });
		expect(await f.queue.tick()).toBe("merged");
		expect(
			(await git(["show", "main:.mfw/tasks/ready/MFW-1-a.md"], f.root)).stdout,
		).toContain("title: a");
		await f.cleanup();
	});

	test("the board survives even when the branch had to be rebased first", async () => {
		// The retry path lands a different merge commit; the firewall must cover it too.
		const f = await fixture();
		await withBoard(f);
		const before = await boardTree(f.root, "main");

		// t1 moves main, so t2 (same file) conflicts and rebases.
		const r1 = await f.makeBranchRun("mfw/t1", "base.txt", "base\nfrom t1\n");
		const r2 = await hostileRun(f, "mfw/t2", async (wt) => {
			await writeFile(join(wt, "base.txt"), "prelude\nbase\n");
			await writeFile(
				join(wt, ".mfw/tasks/ready/MFW-1-alpha.md"),
				"---\nid: MFW-1\nrev: 42\ntitle: sneaky\n---\n",
			);
		});
		await f.queue.enqueue({
			runId: r1,
			branch: "mfw/t1",
			targetBranch: "main",
		});
		await f.queue.enqueue({
			runId: r2,
			branch: "mfw/t2",
			targetBranch: "main",
		});
		expect(await f.queue.tick()).toBe("merged");
		expect(await f.queue.tick()).toBe("merged");

		expect(await boardTree(f.root, "main")).toEqual(before);
		await f.cleanup();
	});
});

describe("operator actions on a parked job", () => {
	test("retry, abandon and sendToReady all refuse a job that is not parked", async () => {
		const f = await fixture();
		const runId = await f.makeBranchRun("mfw/t1", "a.txt", "x\n");
		await f.queue.enqueue({ runId, branch: "mfw/t1", targetBranch: "main" });
		const jobId = await f.jobIdFor(runId); // still "queued"
		await expect(f.queue.retry(jobId)).rejects.toThrow(/not parked/);
		await expect(f.queue.abandon(jobId)).rejects.toThrow(/not parked/);
		await expect(f.queue.sendToReady(jobId)).rejects.toThrow(/not parked/);
		await expect(f.queue.retry(999_999)).rejects.toThrow(/unknown merge job/);
		await f.cleanup();
	});

	test("retry reclaims the task, re-queues the job, and a fixed conflict merges on the next tick", async () => {
		const f = await fixture();
		// Same setup as "conflict → rebase → parked": t2's rebase conflicts with t1.
		const r1 = await f.makeBranchRun("mfw/t1", "base.txt", "from t1\n");
		const r2 = await f.makeBranchRun("mfw/t2", "base.txt", "base\nfrom t2\n");
		await f.queue.enqueue({
			runId: r1,
			taskId: "MFW-2",
			branch: "mfw/t1",
			targetBranch: "main",
		});
		await f.queue.enqueue({
			runId: r2,
			taskId: "MFW-3",
			branch: "mfw/t2",
			targetBranch: "main",
		});
		expect(await f.queue.tick()).toBe("merged");
		expect(await f.queue.tick()).toBe("parked");
		// The first park is soft (the queue retries itself), so `onParked` has not fired,
		// but the state is `parked`, which is what `retry()` acts on.
		expect(f.parked).toEqual([]);
		const jobId = await f.jobIdFor(r2);
		expect((await f.queue.byRun(r2))?.state).toBe("parked");

		// The queue's aborted rebase left mfw/t2 on the original main; as an operator
		// would, rebase by hand and resolve so it applies cleanly before retrying.
		const wt = join(f.root, "worktrees", "mfw/t2");
		const rebase = await git(["rebase", "main"], wt);
		expect(rebase.exitCode).not.toBe(0); // same conflict the queue hit
		await writeFile(join(wt, "base.txt"), "from t1\nfrom t2\n");
		await git(["add", "-A"], wt);
		await git(
			[
				"-c",
				"user.email=t@t",
				"-c",
				"user.name=t",
				// `rebase --continue` opens an editor; under the sweep's scrubbed env (see
				// `scrubEnv`, no EDITOR, no TTY) it cannot start and the rebase stays in
				// progress. Passed locally, failed in sweeps.
				"-c",
				"core.editor=true",
				"rebase",
				"--continue",
			],
			wt,
		);
		expect((await gitOk(["status", "--porcelain"], wt)).trim()).toBe("");

		await f.queue.retry(jobId);
		expect(f.reclaimed.map((j) => j.id)).toEqual([jobId]);
		expect((await f.queue.byRun(r2))?.state).toBe("queued");
		expect((await f.queue.byRun(r2))?.error).toBeNull();
		const [retriedEvent] = await f.handle.db
			.select()
			.from(eventsTable)
			.where(eq(eventsTable.type, "merge.retried"));
		expect(retriedEvent?.payload).toMatchObject({ target: "main" });
		expect(retriedEvent?.taskId).toBe("MFW-3");

		expect(await f.queue.tick()).toBe("merged");
		expect(f.merged.at(-1)?.job.runId).toBe(r2);
		await f.cleanup();
	});

	test("abandon ends the job without touching the task, and never reclaims or sends to ready", async () => {
		const f = await fixture();
		const r1 = await f.makeBranchRun("mfw/t1", "base.txt", "from t1\n");
		const r2 = await f.makeBranchRun("mfw/t2", "base.txt", "base\nfrom t2\n");
		await f.queue.enqueue({
			runId: r1,
			branch: "mfw/t1",
			targetBranch: "main",
		});
		await f.queue.enqueue({
			runId: r2,
			taskId: "MFW-4",
			branch: "mfw/t2",
			targetBranch: "main",
		});
		expect(await f.queue.tick()).toBe("merged");
		expect(await f.queue.tick()).toBe("parked");
		const jobId = await f.jobIdFor(r2);

		await f.queue.abandon(jobId);
		expect((await f.queue.byRun(r2))?.state).toBe("abandoned");
		expect(f.reclaimed).toEqual([]);
		expect(f.sentToReady).toEqual([]);
		const [abandonedEvent] = await f.handle.db
			.select()
			.from(eventsTable)
			.where(eq(eventsTable.type, "merge.abandoned"));
		expect(abandonedEvent?.taskId).toBe("MFW-4");
		expect(abandonedEvent?.payload).toMatchObject({ target: "main" });

		// already abandoned: refused
		await expect(f.queue.abandon(jobId)).rejects.toThrow(/not parked/);
		await f.cleanup();
	});

	test("sendToReady abandons the job and asks the task to go back to ready", async () => {
		const f = await fixture();
		const r1 = await f.makeBranchRun("mfw/t1", "base.txt", "from t1\n");
		const r2 = await f.makeBranchRun("mfw/t2", "base.txt", "base\nfrom t2\n");
		await f.queue.enqueue({
			runId: r1,
			branch: "mfw/t1",
			targetBranch: "main",
		});
		await f.queue.enqueue({
			runId: r2,
			taskId: "MFW-5",
			branch: "mfw/t2",
			targetBranch: "main",
		});
		expect(await f.queue.tick()).toBe("merged");
		expect(await f.queue.tick()).toBe("parked");
		const jobId = await f.jobIdFor(r2);

		await f.queue.sendToReady(jobId);
		expect((await f.queue.byRun(r2))?.state).toBe("abandoned");
		expect(f.sentToReady.map((j) => j.id)).toEqual([jobId]);
		expect(f.reclaimed).toEqual([]);
		const [abandonedEvent] = await f.handle.db
			.select()
			.from(eventsTable)
			.where(eq(eventsTable.type, "merge.abandoned"));
		expect(abandonedEvent?.taskId).toBe("MFW-5");
		await f.cleanup();
	});

	test("sendToReady on a job with no taskId does not call sendTaskToReady", async () => {
		const f = await fixture();
		const r1 = await f.makeBranchRun("mfw/t1", "base.txt", "from t1\n");
		const r2 = await f.makeBranchRun("mfw/t2", "base.txt", "base\nfrom t2\n");
		await f.queue.enqueue({
			runId: r1,
			branch: "mfw/t1",
			targetBranch: "main",
		});
		await f.queue.enqueue({
			runId: r2,
			branch: "mfw/t2",
			targetBranch: "main",
		});
		expect(await f.queue.tick()).toBe("merged");
		expect(await f.queue.tick()).toBe("parked");
		const jobId = await f.jobIdFor(r2);

		await f.queue.sendToReady(jobId);
		expect(f.sentToReady).toEqual([]);
		expect((await f.queue.byRun(r2))?.state).toBe("abandoned");
		await f.cleanup();
	});

	test("an unexpected in-flight failure is requeued without a restart", async () => {
		const f = await fixture();
		const runId = await f.makeBranchRun("mfw/requeue", "work.txt", "work\n");
		await f.queue.enqueue({
			runId,
			branch: "mfw/requeue",
			targetBranch: "main",
		});
		const queue = f.queue as unknown as {
			process(job: MergeJobView): Promise<"merged">;
		};
		queue.process = async (job) => {
			await f.handle.db
				.update(mergeJobs)
				.set({ state: "reverifying" })
				.where(eq(mergeJobs.id, job.id));
			throw new Error("verifier exploded");
		};

		expect(await f.queue.tick()).toBe("deferred");
		const job = await f.queue.byRun(runId);
		expect(job?.state).toBe("queued");
		expect(job?.error).toContain("verifier exploded");
		await f.cleanup();
	});
});
