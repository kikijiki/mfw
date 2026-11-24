import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import { mergeJobs, runs } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { git, gitOk } from "../src/git.ts";
import { silentLogger } from "../src/log.ts";
import { MergeQueue, type MergeQueueDeps } from "../src/merge-queue.ts";
import { MFW_EXCLUDE } from "./fixtures/board.ts";

type Reverify = MergeQueueDeps["reverify"];

interface Pin {
	root: string;
	handle: ProjectDbHandle;
	queue: MergeQueue;
	merged: string[];
	reverified: string[];
	reclaimed: string[];
	setReverify(fn: Reverify): void;
	setHasChecks(value: boolean): void;
	run(name: string, file: string, content: string): Promise<string>;
	verify(runId: string, name: string): Promise<string>;
	enqueue(runId: string, name: string): Promise<void>;
	commit(name: string, file: string, content: string): Promise<string>;
	job(runId: string): Promise<typeof mergeJobs.$inferSelect>;
	main(): Promise<string>;
	tip(name: string): Promise<string>;
}

const open: Pin[] = [];

async function pin(): Promise<Pin> {
	const root = await mkdtemp(join(tmpdir(), "mfw-pin-"));
	await git(["init", "-q", "-b", "main"], root);
	await git(["config", "user.email", "t@t"], root);
	await git(["config", "user.name", "t"], root);
	await writeFile(join(root, "base.txt"), "base\n");
	await git(["add", "-A"], root);
	await git(["commit", "-q", "-m", "init"], root);
	await writeFile(join(root, ".git/info/exclude"), MFW_EXCLUDE);
	const handle = await openProjectDb(join(root, ".mfw"));
	const merged: string[] = [];
	const reverified: string[] = [];
	let reverifyImpl: Reverify = async () => ({ passed: true });
	let hasChecks = true;
	const reclaimed: string[] = [];
	const queue = new MergeQueue({
		handle,
		bus: new EventBus(),
		projectRoot: root,
		log: silentLogger(),
		reverify: (job, base, tip) => {
			reverified.push(tip);
			return reverifyImpl(job, base, tip);
		},
		onMerged: async (_job, sha) => {
			merged.push(sha);
		},
		hasChecks: async () => hasChecks,
		reclaimTask: async (job) => {
			reclaimed.push(job.runId);
		},
		onParked: async () => {},
		landingRoot: join(root, ".git", "mfw-landing"),
	});
	const wt = (name: string) => join(root, "workspaces", name);
	const commit = async (name: string, file: string, content: string) => {
		await writeFile(join(wt(name), file), content);
		await git(["add", "-A"], wt(name));
		await git(["commit", "-q", "-m", `edit ${file}`], wt(name));
		return gitOk(["rev-parse", "HEAD"], wt(name));
	};
	const p: Pin = {
		root,
		handle,
		queue,
		merged,
		reverified,
		setReverify: (fn) => {
			reverifyImpl = fn;
		},
		setHasChecks: (value) => {
			hasChecks = value;
		},
		reclaimed,
		run: async (name, file, content) => {
			await git(["worktree", "add", "-q", "-b", name, wt(name), "main"], root);
			await commit(name, file, content);
			const runId = ulid();
			await handle.db.insert(runs).values({
				id: runId,
				kind: "task",
				label: name,
				model: "sonnet",
				cwd: wt(name),
				workspacePath: wt(name),
				branch: name,
				integrationBranch: "main",
				startedAt: new Date(),
			});
			return runId;
		},
		verify: async (runId, name) => {
			const sha = await gitOk(["rev-parse", name], root);
			await handle.db
				.update(runs)
				.set({ verifiedSha: sha })
				.where(eq(runs.id, runId));
			return sha;
		},
		enqueue: (runId, name) =>
			queue.enqueue({
				runId,
				taskId: "T-1",
				branch: name,
				targetBranch: "main",
				requireVerified: true,
			}),
		commit,
		job: async (runId) => {
			const [row] = await handle.db
				.select()
				.from(mergeJobs)
				.where(eq(mergeJobs.runId, runId));
			if (!row) throw new Error("no job");
			return row;
		},
		main: () => gitOk(["rev-parse", "refs/heads/main"], root),
		tip: (name) => gitOk(["rev-parse", `refs/heads/${name}`], root),
	};
	open.push(p);
	return p;
}

afterEach(async () => {
	for (const p of open.splice(0)) {
		p.handle.close();
		await rm(p.root, { recursive: true, force: true });
	}
});

describe("the merge queue lands only the verified commit", () => {
	test("the verified commit lands", async () => {
		const p = await pin();
		const runId = await p.run("mfw/a", "a.txt", "a\n");
		const sha = await p.verify(runId, "mfw/a");
		await p.enqueue(runId, "mfw/a");
		expect((await p.job(runId)).verifiedSha).toBe(sha);
		expect(await p.queue.tick()).toBe("merged");
		expect(
			(await git(["merge-base", "--is-ancestor", sha, "main"], p.root))
				.exitCode,
		).toBe(0);
	});

	test("a commit added after verification is refused", async () => {
		const p = await pin();
		const before = await p.main();
		const runId = await p.run("mfw/a", "a.txt", "a\n");
		await p.verify(runId, "mfw/a");
		await p.enqueue(runId, "mfw/a");
		await p.commit("mfw/a", "evil.txt", "unverified\n");

		expect(await p.queue.tick()).toBe("parked");
		expect(await p.main()).toBe(before);
		expect(p.merged).toEqual([]);
		expect((await p.job(runId)).error).toContain("not the commit");
	});

	test("a commit added before the enqueue is refused too", async () => {
		const p = await pin();
		const before = await p.main();
		const runId = await p.run("mfw/a", "a.txt", "a\n");
		await p.verify(runId, "mfw/a");
		await p.commit("mfw/a", "evil.txt", "unverified\n");
		await p.enqueue(runId, "mfw/a");

		expect(await p.queue.tick()).toBe("parked");
		expect(await p.main()).toBe(before);
	});

	test("a rebase after verification is refused until it is verified again", async () => {
		const p = await pin();
		const runId = await p.run("mfw/a", "a.txt", "a\n");
		await p.verify(runId, "mfw/a");
		await p.enqueue(runId, "mfw/a");
		await writeFile(join(p.root, "other.txt"), "other\n");
		await git(["add", "other.txt"], p.root);
		await git(["commit", "-q", "-m", "target moves"], p.root);
		const target = await p.main();
		await gitOk(["rebase", "main"], join(p.root, "workspaces", "mfw/a"));

		expect(await p.queue.tick()).toBe("parked");
		expect(await p.main()).toBe(target);
		expect(p.reverified).toEqual([]);
	});

	test("the queue's own rebase re-verifies that exact tip and re-pins it", async () => {
		const p = await pin();
		const runId = await p.run("mfw/r", "base.txt", "target\n");
		await p.commit("mfw/r", "base.txt", "branch\n");
		await p.verify(runId, "mfw/r");
		await p.enqueue(runId, "mfw/r");
		await writeFile(join(p.root, "base.txt"), "target\n");
		await git(["add", "-A"], p.root);
		await git(["commit", "-q", "-m", "target moves"], p.root);

		expect(await p.queue.tick()).toBe("merged");
		const rebased = await p.tip("mfw/r");
		expect(p.reverified).toEqual([rebased]);
		expect((await p.job(runId)).verifiedSha).toBe(rebased);
	});

	test("a commit slipped in during the re-verification is refused", async () => {
		const p = await pin();
		const runId = await p.run("mfw/r", "base.txt", "target\n");
		await p.commit("mfw/r", "base.txt", "branch\n");
		await p.verify(runId, "mfw/r");
		await p.enqueue(runId, "mfw/r");
		await writeFile(join(p.root, "base.txt"), "target\n");
		await git(["add", "-A"], p.root);
		await git(["commit", "-q", "-m", "target moves"], p.root);
		const target = await p.main();
		p.setReverify(async () => {
			await p.commit("mfw/r", "evil.txt", "unverified\n");
			return { passed: true };
		});

		expect(await p.queue.tick()).toBe("parked");
		expect(await p.main()).toBe(target);
		expect(p.merged).toEqual([]);
	});

	test("a rebased tip whose re-verification crashed is verified again, never landed as is", async () => {
		const p = await pin();
		const runId = await p.run("mfw/r", "base.txt", "target\n");
		await p.commit("mfw/r", "base.txt", "branch\n");
		await p.verify(runId, "mfw/r");
		await p.enqueue(runId, "mfw/r");
		await writeFile(join(p.root, "base.txt"), "target\n");
		await git(["add", "-A"], p.root);
		await git(["commit", "-q", "-m", "target moves"], p.root);
		p.setReverify(async () => ({ passed: false, crashed: true }));
		expect(await p.queue.tick()).toBe("parked");
		const rebased = await p.tip("mfw/r");
		expect(p.merged).toEqual([]);

		p.setReverify(async () => ({ passed: true }));
		await p.queue.retryParked();
		expect(await p.queue.tick()).toBe("merged");
		expect(p.reverified).toEqual([rebased, rebased]);
	});

	test("concurrent runs: one run's verification never covers another's tip", async () => {
		const p = await pin();
		const a = await p.run("mfw/a", "a.txt", "a\n");
		const b = await p.run("mfw/b", "b.txt", "b\n");
		const shaA = await p.verify(a, "mfw/a");
		await p.verify(b, "mfw/b");
		await p.enqueue(a, "mfw/a");
		await p.enqueue(b, "mfw/b");
		await p.commit("mfw/b", "evil.txt", "unverified\n");

		const outcomes = [await p.queue.tick(), await p.queue.tick()];
		expect(outcomes.sort()).toEqual(["merged", "parked"]);
		expect((await p.job(a)).state).toBe("merged");
		expect((await p.job(b)).state).toBe("parked");
		expect((await p.job(a)).verifiedSha).toBe(shaA);
		const landed = await gitOk(
			["ls-tree", "-r", "--name-only", "main"],
			p.root,
		);
		expect(landed).toContain("a.txt");
		expect(landed).not.toContain("evil.txt");
		expect(landed).not.toContain("b.txt");
	});

	test("a job with no pin is refused", async () => {
		const p = await pin();
		const before = await p.main();
		const runId = await p.run("mfw/a", "a.txt", "a\n");
		await p.handle.db.insert(mergeJobs).values({
			runId,
			branch: "mfw/a",
			targetBranch: "main",
			enqueuedAt: new Date(),
			updatedAt: new Date(),
		});

		expect(await p.queue.tick()).toBe("parked");
		expect(await p.main()).toBe(before);
		expect((await p.job(runId)).error).toContain("no verified commit");
	});

	test("a run that must be verified cannot be queued without a recorded commit", async () => {
		const p = await pin();
		const runId = await p.run("mfw/a", "a.txt", "a\n");
		await expect(p.enqueue(runId, "mfw/a")).rejects.toThrow(/verified commit/);
		expect(await p.queue.tick()).toBe("idle");
	});

	test("a run with no checks is pinned to its tip when queued", async () => {
		const p = await pin();
		const before = await p.main();
		const runId = await p.run("mfw/a", "a.txt", "a\n");
		const tip = await p.tip("mfw/a");
		await p.queue.enqueue({
			runId,
			taskId: "T-1",
			branch: "mfw/a",
			targetBranch: "main",
		});
		expect((await p.job(runId)).verifiedSha).toBe(tip);
		await p.commit("mfw/a", "evil.txt", "later\n");
		expect(await p.queue.tick()).toBe("parked");
		expect(await p.main()).toBe(before);
	});
	const MOVED =
		"the tip moved since it was verified; re-run the task so it is verified again";

	test("an operator's retry of a moved tip with no checks is refused and stays parked", async () => {
		const p = await pin();
		const before = await p.main();
		const runId = await p.run("mfw/a", "a.txt", "a\n");
		await p.queue.enqueue({
			runId,
			taskId: "T-1",
			branch: "mfw/a",
			targetBranch: "main",
		});
		await p.commit("mfw/a", "evil.txt", "unverified\n");
		p.setHasChecks(false);
		expect(await p.queue.tick()).toBe("parked");
		expect((await p.job(runId)).error).toContain(MOVED);
		const { id } = await p.job(runId);

		await expect(p.queue.retry(id)).rejects.toThrow(MOVED);

		const job = await p.job(runId);
		expect(job.state).toBe("parked");
		expect(job.error).toContain(MOVED);
		expect(job.rebasedSha).toBeNull();
		expect(p.reclaimed).toEqual([]);
		expect(await p.queue.tick()).toBe("idle");
		// The automatic sweep cannot land it either.
		await p.queue.retryParked();
		expect(await p.queue.tick()).toBe("parked");
		expect((await p.job(runId)).error).toContain(MOVED);
		expect(p.reverified).toEqual([]);
		expect(p.merged).toEqual([]);
		expect(await p.main()).toBe(before);
	});

	test("if the checks cannot be read, the retry of a moved tip is refused", async () => {
		const p = await pin();
		const runId = await p.run("mfw/a", "a.txt", "a\n");
		await p.verify(runId, "mfw/a");
		await p.enqueue(runId, "mfw/a");
		await p.commit("mfw/a", "evil.txt", "unverified\n");
		expect(await p.queue.tick()).toBe("parked");
		p.setHasChecks(false);
		const { id } = await p.job(runId);
		await expect(p.queue.retry(id)).rejects.toThrow(MOVED);
		expect((await p.job(runId)).state).toBe("parked");
	});

	test("an operator's retry of a moved tip with checks re-verifies that tip, then lands", async () => {
		const p = await pin();
		const runId = await p.run("mfw/a", "a.txt", "a\n");
		await p.verify(runId, "mfw/a");
		await p.enqueue(runId, "mfw/a");
		const moved = await p.commit("mfw/a", "fix.txt", "fixed by hand\n");
		expect(await p.queue.tick()).toBe("parked");
		const { id } = await p.job(runId);

		await p.queue.retry(id);

		expect(p.reclaimed).toEqual([runId]);
		expect(await p.queue.tick()).toBe("merged");
		expect(p.reverified).toEqual([moved]);
		expect((await p.job(runId)).verifiedSha).toBe(moved);
	});

	test("a moved tip whose re-verification fails on retry does not land", async () => {
		const p = await pin();
		const before = await p.main();
		const runId = await p.run("mfw/a", "a.txt", "a\n");
		await p.verify(runId, "mfw/a");
		await p.enqueue(runId, "mfw/a");
		await p.commit("mfw/a", "bad.txt", "bad\n");
		expect(await p.queue.tick()).toBe("parked");
		p.setReverify(async () => ({ passed: false, detail: "tests" }));
		await p.queue.retry((await p.job(runId)).id);

		expect(await p.queue.tick()).toBe("parked");
		expect(p.merged).toEqual([]);
		expect(await p.main()).toBe(before);
	});
});
