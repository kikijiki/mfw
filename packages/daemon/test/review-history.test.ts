import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus, type StoredEvent } from "@mfw/db/eventlog";
import { decisions, runSteps } from "@mfw/db/schema";
import { GitDiffSource } from "../src/brain.ts";
import { git } from "../src/git.ts";
import { buildDigest } from "../src/history.ts";
import { ReviewService } from "../src/review.ts";
import { RunRegistry } from "../src/run-registry.ts";
import type { TaskService } from "../src/task-service.ts";
import { makeTasks } from "./fixtures/board.ts";

interface F {
	root: string;
	handle: ProjectDbHandle;
	registry: RunRegistry;
	tasks: TaskService;
	review: ReviewService;
	cleanup: () => Promise<void>;
}

async function fixture(): Promise<F> {
	const root = await mkdtemp(join(tmpdir(), "mfw-review-"));
	await git(["init", "-q", "-b", "main"], root);
	await git(["config", "user.email", "t@t"], root);
	await git(["config", "user.name", "t"], root);
	await writeFile(join(root, "keep.txt"), "unchanged\n");
	await writeFile(join(root, "edit.txt"), "before\n");
	await writeFile(join(root, "gone.txt"), "delete me\n");
	await git(["add", "-A"], root);
	await git(["commit", "-q", "-m", "init"], root);
	// Production writes these into .git/info/exclude at attach; without them a
	// test's `git add -A` commits the live database into the branch.
	await writeFile(join(root, ".git/info/exclude"), ".mfw/\nworktrees/\n");

	const mfwDir = join(root, ".mfw");
	const handle = await openProjectDb(mfwDir);
	const bus = new EventBus();
	const registry = new RunRegistry({
		handle,
		bus,
		runsDir: join(mfwDir, "runs"),
	});
	const tasks = await makeTasks(handle, bus, mfwDir);
	const review = new ReviewService({
		handle,
		registry,
		tasks,
		projectRoot: root,
	});
	return {
		root,
		handle,
		registry,
		tasks,
		review,
		cleanup: async () => {
			handle.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

describe("ReviewService bundle", () => {
	test("scope includes rename sources and raw paths beyond the displayed file limit", async () => {
		const f = await fixture();
		try {
			const task = await f.tasks.create({ title: "scope", owns: ["owned/**"] });
			const baseSha = (await git(["rev-parse", "HEAD"], f.root)).stdout;
			await git(["checkout", "-q", "-b", "mfw/paths"], f.root);
			await Bun.write(join(f.root, "owned/new.txt"), "new\n");
			await git(["mv", "keep.txt", "owned/moved.txt"], f.root);
			const rawNames = [
				"owned/é.ts",
				"owned/tab\tname.ts",
				"owned/line\nname.ts",
			];
			for (const name of rawNames)
				await Bun.write(join(f.root, name), "raw name\n");
			for (let i = 0; i < 201; i++)
				await Bun.write(join(f.root, `owned/file-${i}.txt`), `file ${i}\n`);
			await Bun.write(
				join(f.root, "z-outside.txt"),
				"outside after display cap\n",
			);
			await git(["add", "-A"], f.root);
			await git(["commit", "-q", "-m", "scope paths"], f.root);
			const facts = await new GitDiffSource().collect(
				{ worktreePath: f.root, baseSha } as Parameters<
					GitDiffSource["collect"]
				>[0],
				"critic",
			);
			expect(facts.files).toContain("keep.txt");
			expect(facts.files).toContain("owned/moved.txt");
			for (const name of rawNames) expect(facts.files).toContain(name);
			await git(["checkout", "-q", "main"], f.root);
			await f.registry.create({
				kind: "task",
				taskId: task.id,
				label: task.id,
				model: "sonnet",
				cwd: f.root,
				branch: "mfw/paths",
				baseSha,
			});
			const bundle = await f.review.bundle(task.id);
			expect(bundle.truncated).toBe(true);
			expect(bundle.files).toHaveLength(200);
			expect(bundle.scope?.outside.sort()).toEqual([
				"keep.txt",
				"z-outside.txt",
			]);
		} finally {
			await f.cleanup();
		}
	});

	test("collects the diff, DoD results, critic verdict and cost in one payload", async () => {
		const f = await fixture();
		const t = await f.tasks.create({ title: "reviewable" });
		const baseSha = (await git(["rev-parse", "HEAD"], f.root)).stdout.trim();

		// an agent branch: one add, one edit, one delete
		await git(["checkout", "-q", "-b", "mfw/work"], f.root);
		await writeFile(join(f.root, "added.txt"), "new file\n");
		await writeFile(join(f.root, "edit.txt"), "after\n");
		await rm(join(f.root, "gone.txt"));
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "work"], f.root);
		await git(["checkout", "-q", "main"], f.root);

		const run = await f.registry.create({
			kind: "task",
			taskId: t.id,
			label: t.id,
			model: "sonnet",
			cwd: f.root,
			branch: "mfw/work",
			baseSha,
		});
		await f.handle.db.insert(runSteps).values({
			runId: run.id,
			step: "verify",
			seq: 1,
			status: "done",
			result: {
				passed: false,
				checks: [
					{ check: "bun test", ok: false, detail: "1 failing" },
					{ check: "files_exist", ok: true },
				],
			},
			startedAt: new Date(),
		});
		await f.handle.db.insert(decisions).values({
			ts: new Date(),
			role: "critic",
			taskId: t.id,
			subjectRunId: run.id,
			model: "sonnet",
			status: "ok",
			action: "flagged",
			reason: "the diff touches unrelated files",
			input: {},
			output: {},
		});
		await f.tasks.release(
			t.id,
			null,
			"review",
			"scheduler",
			"critic gate → review",
		);

		const b = await f.review.bundle(t.id);
		expect(b.branch).toBe("mfw/work");
		const byPath = Object.fromEntries(b.files.map((x) => [x.path, x]));
		expect(Object.keys(byPath).sort()).toEqual([
			"added.txt",
			"edit.txt",
			"gone.txt",
		]);
		expect(byPath["added.txt"]?.status).toBe("added");
		expect(byPath["added.txt"]?.oldText).toBe("");
		expect(byPath["edit.txt"]?.oldText.trim()).toBe("before");
		expect(byPath["edit.txt"]?.newText.trim()).toBe("after");
		expect(byPath["gone.txt"]?.status).toBe("deleted");
		// unchanged files are absent, the human reads only what changed
		expect(byPath["keep.txt"]).toBeUndefined();

		expect(b.checks).toEqual([
			{ name: "bun test", ok: false, detail: "1 failing" },
			{ name: "files_exist", ok: true, detail: undefined },
		]);
		expect(b.critic).toEqual({
			outcome: "flagged",
			detail: "the diff touches unrelated files",
		});
		expect(b.reviewCause).toBe("critic_flagged");
		expect(b.run?.runId).toBe(run.id);

		await f.tasks.release(t.id, null, "ready", "scheduler", "retry");
		await f.tasks.release(t.id, null, "review", "scheduler", "review gate");
		expect((await f.review.bundle(t.id)).reviewCause).toBe("human_required");
		await f.cleanup();
	});

	test("a task with no branch yields an empty bundle rather than throwing", async () => {
		const f = await fixture();
		const t = await f.tasks.create({ title: "nothing yet" });
		const b = await f.review.bundle(t.id);
		expect(b.files).toEqual([]);
		expect(b.run).toBeNull();
		await f.cleanup();
	});

	test("carries evidence classes, the declared scope and the reviewer model", async () => {
		const f = await fixture();
		const t = await f.tasks.create({
			title: "scoped",
			owns: ["src/**"],
			criteria: [{ text: "api works" }, { text: "old verdict" }],
		});
		const baseSha = (await git(["rev-parse", "HEAD"], f.root)).stdout.trim();

		await git(["checkout", "-q", "-b", "mfw/scoped"], f.root);
		await Bun.write(join(f.root, "src/api.ts"), "export {};\n");
		await writeFile(join(f.root, "edit.txt"), "sprawl\n");
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "work"], f.root);
		await git(["checkout", "-q", "main"], f.root);

		const run = await f.registry.create({
			kind: "task",
			taskId: t.id,
			label: t.id,
			model: "sonnet",
			cwd: f.root,
			branch: "mfw/scoped",
			baseSha,
		});
		await f.handle.db.insert(decisions).values({
			ts: new Date(),
			role: "critic",
			taskId: t.id,
			subjectRunId: run.id,
			model: "opus",
			status: "ok",
			action: "flagged",
			reason: "criterion 1 is met only on the agent's word",
			input: {},
			output: {
				criteria: [
					{
						criterion: "api works",
						verdict: "met",
						evidenceClass: "claimed",
						evidence: "the report says so",
					},
					{ criterion: "old verdict", verdict: "met", evidence: "diff" },
				],
				implementerModel: "sonnet",
				reviewerModel: "opus",
				sameModel: false,
			},
		});

		const b = await f.review.bundle(t.id);
		expect(b.acceptance?.criteria.map((c) => c.evidenceClass)).toEqual([
			"claimed",
			null,
		]);
		expect(b.scope).toEqual({ owns: ["src/**"], outside: ["edit.txt"] });
		expect(b.review).toEqual({
			implementerModel: "sonnet",
			reviewerModel: "opus",
			sameModel: false,
		});
		await f.cleanup();
	});

	test("no owns means no scope; a critic without model fields means no review line", async () => {
		const f = await fixture();
		const t = await f.tasks.create({ title: "unscoped" });
		const baseSha = (await git(["rev-parse", "HEAD"], f.root)).stdout.trim();
		await git(["checkout", "-q", "-b", "mfw/unscoped"], f.root);
		await writeFile(join(f.root, "edit.txt"), "anything\n");
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "work"], f.root);
		await git(["checkout", "-q", "main"], f.root);
		const run = await f.registry.create({
			kind: "task",
			taskId: t.id,
			label: t.id,
			model: "sonnet",
			cwd: f.root,
			branch: "mfw/unscoped",
			baseSha,
		});
		await f.handle.db.insert(decisions).values({
			ts: new Date(),
			role: "critic",
			taskId: t.id,
			subjectRunId: run.id,
			model: "sonnet",
			status: "ok",
			action: "accepted",
			input: {},
			output: { criteria: [] },
		});
		const b = await f.review.bundle(t.id);
		expect(b.scope).toBeNull();
		expect(b.review).toBeNull();
		await f.cleanup();
	});

	/** A task that skipped review (or was approved) and is now `done` stays reviewable: the bundle reads diffs from git keyed off the run's branch/baseSha, never task status. */
	test("the bundle survives a task moving to done, review after merge", async () => {
		const f = await fixture();
		const t = await f.tasks.create({ title: "no review, merged already" });
		const baseSha = (await git(["rev-parse", "HEAD"], f.root)).stdout.trim();

		await git(["checkout", "-q", "-b", "mfw/no-review-work"], f.root);
		await writeFile(join(f.root, "added.txt"), "shipped without review\n");
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "work"], f.root);
		await git(["checkout", "-q", "main"], f.root);

		const run = await f.registry.create({
			kind: "task",
			taskId: t.id,
			label: t.id,
			model: "sonnet",
			cwd: f.root,
			branch: "mfw/no-review-work",
			baseSha,
		});

		// Mirrors `onMerged`: release straight to `done`, never stopping in `review`. Never claimed here, so claim is null.
		await f.tasks.release(t.id, null, "done", "scheduler", "merged");

		const b = await f.review.bundle(t.id);
		expect(b.branch).toBe("mfw/no-review-work");
		expect(b.run?.runId).toBe(run.id);
		expect(b.files.map((x) => x.path)).toEqual(["added.txt"]);
		await f.cleanup();
	});
});

/** Approving only enqueues a merge job; the task stays in `review` until it lands. The bundle's `mergeJob` tells "decided, in motion" from "awaiting a human" and must track the queue's live state. */
describe("ReviewService bundle, mergeJob (MFW-50)", () => {
	test("a queued or in-flight job is surfaced; queued is paused only while main is red", async () => {
		const f = await fixture();
		const t = await f.tasks.create({ title: "reviewable" });
		const baseSha = (await git(["rev-parse", "HEAD"], f.root)).stdout.trim();

		await git(["checkout", "-q", "-b", "mfw/work"], f.root);
		await writeFile(join(f.root, "added.txt"), "new file\n");
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "work"], f.root);
		await git(["checkout", "-q", "main"], f.root);

		await f.registry.create({
			kind: "task",
			taskId: t.id,
			label: t.id,
			model: "sonnet",
			cwd: f.root,
			branch: "mfw/work",
			baseSha,
		});

		let state: "queued" | "merging" = "queued";
		let paused = true;
		const review = new ReviewService({
			handle: f.handle,
			registry: f.registry,
			tasks: f.tasks,
			projectRoot: f.root,
			mergeQueue: {
				byRun: async () => ({ state, error: null }),
				paused: async () => paused,
			},
		});

		expect(await review.bundle(t.id)).toMatchObject({
			mergeJob: { state: "queued", paused: true, error: null },
		});

		// In flight: the breaker no longer applies (it already cleared the queue).
		state = "merging";
		paused = false;
		expect(await review.bundle(t.id)).toMatchObject({
			mergeJob: { state: "merging", paused: false, error: null },
		});
		await f.cleanup();
	});

	test("a parked job is not reported as active, parking hands the task a fresh decision", async () => {
		const f = await fixture();
		const t = await f.tasks.create({ title: "reviewable" });
		const baseSha = (await git(["rev-parse", "HEAD"], f.root)).stdout.trim();

		await git(["checkout", "-q", "-b", "mfw/work"], f.root);
		await writeFile(join(f.root, "added.txt"), "new file\n");
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "work"], f.root);
		await git(["checkout", "-q", "main"], f.root);

		await f.registry.create({
			kind: "task",
			taskId: t.id,
			label: t.id,
			model: "sonnet",
			cwd: f.root,
			branch: "mfw/work",
			baseSha,
		});

		const review = new ReviewService({
			handle: f.handle,
			registry: f.registry,
			tasks: f.tasks,
			projectRoot: f.root,
			mergeQueue: {
				byRun: async () => ({ state: "parked", error: "merge conflict" }),
				paused: async () => false,
			},
		});

		expect((await review.bundle(t.id)).mergeJob).toBeNull();
		await f.cleanup();
	});

	test("no mergeQueue dependency (older callers) yields mergeJob: null", async () => {
		const f = await fixture();
		const t = await f.tasks.create({ title: "reviewable" });
		const baseSha = (await git(["rev-parse", "HEAD"], f.root)).stdout.trim();

		await git(["checkout", "-q", "-b", "mfw/work"], f.root);
		await writeFile(join(f.root, "added.txt"), "new file\n");
		await git(["add", "-A"], f.root);
		await git(["commit", "-q", "-m", "work"], f.root);
		await git(["checkout", "-q", "main"], f.root);

		await f.registry.create({
			kind: "task",
			taskId: t.id,
			label: t.id,
			model: "sonnet",
			cwd: f.root,
			branch: "mfw/work",
			baseSha,
		});

		expect((await f.review.bundle(t.id)).mergeJob).toBeNull();
		await f.cleanup();
	});
});

describe("ReviewService comments", () => {
	test("structured comments replace the [file:line] text hack", async () => {
		const f = await fixture();
		const t = await f.tasks.create({ title: "commented" });
		const c = await f.review.addComment({
			taskId: t.id,
			file: "src/auth.ts",
			line: 42,
			side: "new",
			body: "this swallows the error",
		});
		expect(c?.file).toBe("src/auth.ts");
		expect(c?.line).toBe(42);
		expect(c?.resolved).toBe(false);

		await f.review.addComment({
			taskId: t.id,
			file: "src/db.ts",
			line: 7,
			side: "new",
			body: "n+1 query",
		});
		await f.review.resolveComment(c?.id as number, true);
		const all = await f.review.listComments(t.id);
		expect(all.length).toBe(2);
		expect(all.filter((x) => !x.resolved).length).toBe(1);
		await f.cleanup();
	});

	test("rejection feedback reaches the repair run, reason AND open comments", async () => {
		// v1 discarded the human's reasoning entirely and re-ran the agent blind.
		const f = await fixture();
		const t = await f.tasks.create({ title: "rejected" });
		const resolved = await f.review.addComment({
			taskId: t.id,
			file: "a.ts",
			line: 1,
			side: "new",
			body: "already fixed",
		});
		await f.review.resolveComment(resolved?.id as number, true);
		await f.review.addComment({
			taskId: t.id,
			file: "src/auth.ts",
			line: 42,
			side: "new",
			body: "this swallows the error",
		});

		const brief = await f.review.repairBrief(t.id, "the retry logic is wrong");
		expect(brief).toContain("the retry logic is wrong");
		expect(brief).toContain("src/auth.ts:42");
		expect(brief).toContain("this swallows the error");
		// resolved comments are not re-litigated
		expect(brief).not.toContain("already fixed");
		await f.cleanup();
	});
});

describe("HISTORY digest", () => {
	const ev = (
		seq: number,
		type: string,
		payload: Record<string, unknown> = {},
		taskId?: string,
	) => ({ seq, type, ts: 1_700_000_000 + seq, payload, taskId }) as StoredEvent;

	test("folds the stream into readable prose and drops machine chatter", () => {
		const d = buildDigest("demo", 0, [
			ev(1, "task.created", { source: "planner", title: "a" }, "MFW-1"),
			ev(2, "task.created", { source: "planner", title: "b" }, "MFW-2"),
			ev(3, "run.finalize_step", { step: "verify", ok: true }), // noise
			ev(4, "task.claimed", { runId: "x" }, "MFW-1"), // noise
			ev(
				5,
				"task.status_changed",
				{ from: "in_progress", to: "done" },
				"MFW-1",
			),
			ev(6, "merge.completed", { sha: "abc", target: "main" }, "MFW-1"),
			ev(
				7,
				"task.status_changed",
				{ from: "in_progress", to: "blocked", reason: "cannot resolve dep" },
				"MFW-2",
			),
		]);
		expect(d.latestSeq).toBe(7);
		expect(d.summary).toContain("2 tasks created");
		expect(d.summary).toContain("1 task completed");
		const kinds = d.entries.map((e) => e.kind);
		expect(kinds).toContain("done");
		expect(kinds).toContain("merged");
		expect(kinds).toContain("blocked");
		// chatter never becomes a digest line
		expect(kinds).not.toContain("created_run");
		expect(d.entries.find((e) => e.kind === "blocked")?.detail).toBe(
			"cannot resolve dep",
		);
		// blocked work means the operator is needed
		expect(d.needsAttention).toBe(true);
	});

	test("a quiet window says so, and does not claim attention", () => {
		const d = buildDigest("demo", 10, []);
		expect(d.summary).toBe("Nothing happened.");
		expect(d.entries).toEqual([]);
		expect(d.needsAttention).toBe(false);
		expect(d.latestSeq).toBe(10); // cursor does not move backwards
	});

	/** Replays a live case: an empty review column showing "3 waiting for review" and an uncleared "needs attention" badge. */
	test("a review that is over does not keep demanding attention", () => {
		const events = [
			// Two throwaway probes: entered review, then deleted.
			ev(1, "task.created", { title: "probe" }, "MFW-13"),
			ev(2, "task.status_changed", { from: "backlog", to: "review" }, "MFW-13"),
			ev(3, "task.deleted", { title: "probe" }, "MFW-13"),
			ev(4, "task.created", { title: "probe" }, "MFW-14"),
			ev(5, "task.status_changed", { from: "ready", to: "review" }, "MFW-14"),
			ev(6, "task.deleted", { title: "probe" }, "MFW-14"),
			// And one real task, reviewed and merged.
			ev(7, "task.created", { title: "real" }, "MFW-17"),
			ev(
				8,
				"task.status_changed",
				{ from: "in_progress", to: "review" },
				"MFW-17",
			),
			ev(9, "merge.completed", { sha: "abc", target: "master" }, "MFW-17"),
			ev(10, "task.status_changed", { from: "review", to: "done" }, "MFW-17"),
		];

		// Replayed against the board as it actually is: the probes are gone and
		// MFW-17 is done.
		const board = new Map([["MFW-17", "done"]]);
		const d = buildDigest("demo", 0, events, (id) => board.get(id));

		expect(d.entries.map((e) => e.kind)).not.toContain("review");
		expect(d.summary).not.toContain("waiting for review");
		expect(d.needsAttention).toBe(false);
		// The past-tense facts survive, they are still true.
		expect(d.summary).toContain("3 tasks created");
		expect(d.summary).toContain("1 merge landed");
	});

	test("a task STILL in review keeps the badge", () => {
		const board = new Map([["MFW-20", "review"]]);
		const d = buildDigest(
			"demo",
			0,
			[
				ev(1, "task.created", { title: "x" }, "MFW-20"),
				ev(
					2,
					"task.status_changed",
					{ from: "in_progress", to: "review" },
					"MFW-20",
				),
			],
			(id) => board.get(id),
		);
		expect(d.entries.find((e) => e.kind === "review")?.taskIds).toEqual([
			"MFW-20",
		]);
		expect(d.needsAttention).toBe(true);
	});

	test("the count matches the list under it", () => {
		// The API write plus the board scan can emit two `task.created` events per task; count tasks, not events.
		const d = buildDigest("demo", 0, [
			ev(1, "task.created", { source: "human", title: "a" }, "MFW-12"),
			ev(2, "task.created", { source: "file", title: "a" }, "MFW-12"),
			ev(3, "task.created", { source: "human", title: "b" }, "MFW-13"),
		]);
		const created = d.entries.find((e) => e.kind === "created");
		expect(created?.taskIds).toEqual(["MFW-12", "MFW-13"]);
		expect(created?.count).toBe(2);
		expect(d.summary).toContain("2 tasks created");
	});

	test("purely routine progress does not demand attention", () => {
		const d = buildDigest("demo", 0, [
			ev(
				1,
				"task.status_changed",
				{ from: "in_progress", to: "done" },
				"MFW-1",
			),
			ev(2, "merge.completed", { sha: "a", target: "main" }, "MFW-1"),
		]);
		expect(d.needsAttention).toBe(false);
		expect(d.summary).toContain("completed");
	});
});
