import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { clarifications, engineKv, mergeJobs, runs } from "@mfw/db/schema";
import { InboxService, mergeInboxes } from "../src/inbox.ts";
import { makeTasks } from "./fixtures/board.ts";

/**
 * U0-04: every item names the node to select (`ref`); answerable items say how
 * (`answer`), approvals carry the request id. The derivation itself (which
 * items exist, their ids, kinds, severities and the badge counts) is unchanged.
 */

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "mfw-inbox-ext-"));
	const handle = await openProjectDb(join(root, ".mfw"));
	const tasks = await makeTasks(handle, new EventBus(), join(root, ".mfw"));
	return {
		handle,
		tasks,
		inbox: new InboxService({ handle, project: "demo", tasks }),
		cleanup: async () => {
			handle.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

type F = Awaited<ReturnType<typeof fixture>>;

async function liveRun(
	f: F,
	id: string,
	over: Partial<typeof runs.$inferInsert> = {},
) {
	await f.handle.db.insert(runs).values({
		id,
		kind: "task",
		label: id,
		model: "sonnet",
		cwd: "/tmp",
		state: "running",
		startedAt: new Date(1_000),
		...over,
	});
}

describe("inbox: ref and answer extension", () => {
	test("a task question carries its options as answer.mode=options", async () => {
		const f = await fixture();
		try {
			const task = await f.tasks.create({ title: "ask" });
			await liveRun(f, "RUNQ", {
				taskId: task.id,
				state: "ended",
				activity: "needs_answer",
				activityDetail: {
					question: "which parser?",
					options: ["v1", "v2"],
				},
			});
			await f.handle.db.insert(clarifications).values({
				runId: "RUNQ",
				kind: "task",
				items: [{ question: "which parser?", answer: null }],
				createdAt: new Date(2_000),
			});
			const item = (await f.inbox.list()).find(
				(i) => i.kind === "needs_answer",
			);
			expect(item).toMatchObject({
				id: "needs_answer:RUNQ",
				ref: "run:RUNQ",
				taskId: task.id,
				answer: { mode: "options", options: ["v1", "v2"] },
			});
		} finally {
			await f.cleanup();
		}
	});

	test("a question without options is a free-text answer", async () => {
		const f = await fixture();
		try {
			const task = await f.tasks.create({ title: "ask" });
			await liveRun(f, "RUNT", { taskId: task.id, state: "ended" });
			await f.handle.db.insert(clarifications).values({
				runId: "RUNT",
				kind: "task",
				items: [{ question: "why?", answer: null }],
				createdAt: new Date(2_000),
			});
			const item = (await f.inbox.list()).find(
				(i) => i.kind === "needs_answer",
			);
			expect(item?.answer).toEqual({ mode: "text" });
		} finally {
			await f.cleanup();
		}
	});

	test("an approval carries mode approve and the newest pending request id", async () => {
		const f = await fixture();
		try {
			const task = await f.tasks.create({ title: "tool" });
			await liveRun(f, "RUNA", {
				taskId: task.id,
				activity: "awaiting_approval",
				activityDetail: {
					pendingApprovals: ["req-1", "req-2"],
					approvalSummary: "rm -rf build",
				},
			});
			const item = (await f.inbox.list()).find(
				(i) => i.kind === "approval_pending",
			);
			expect(item).toMatchObject({
				ref: "run:RUNA",
				requestId: "req-2",
				answer: { mode: "approve", requestId: "req-2" },
			});
		} finally {
			await f.cleanup();
		}
	});

	test("refs fall back from run to task to merge job to the project node", async () => {
		const f = await fixture();
		try {
			const review = await f.tasks.create({ title: "to review" });
			await f.tasks.move(review.id, "review", "human");
			await liveRun(f, "RUNM", { state: "ended" });
			const [job] = await f.handle.db
				.insert(mergeJobs)
				.values({
					runId: "RUNM",
					branch: "mfw/x",
					targetBranch: "main",
					state: "parked",
					parkRetries: 99,
					enqueuedAt: new Date(),
					updatedAt: new Date(),
				})
				.returning({ id: mergeJobs.id });
			await f.handle.db.insert(engineKv).values({
				key: "sweep_infra",
				value: { active: true, since: Date.now() },
				updatedAt: new Date(),
			});
			const items = await f.inbox.list();
			const byKind = Object.fromEntries(items.map((i) => [i.kind, i.ref]));
			expect(byKind.review).toBe(`task:${review.id}`);
			expect(byKind.merge_parked).toBe(`merge:${job?.id}`);
			expect(byKind.sweep_infra).toBe("brain");
			for (const i of items)
				expect(i.ref).toMatch(/^(task|run|merge):|^brain$/);
		} finally {
			await f.cleanup();
		}
	});

	test("existing ids, kinds, severities and counts are unchanged", async () => {
		const f = await fixture();
		try {
			const blocked = await f.tasks.create({ title: "stuck" });
			await f.tasks.move(blocked.id, "blocked", "scheduler", "gave up");
			const review = await f.tasks.create({ title: "check me" });
			await f.tasks.move(review.id, "review", "human");
			await liveRun(f, "RUNW", {
				activity: "awaiting_approval",
				activityDetail: { pendingApprovals: ["r"], approvalSummary: "x" },
			});
			await liveRun(f, "RUNS", {
				activity: "stalled",
				activityDetail: { stallCause: "silent" },
			});
			await liveRun(f, "RUNF", {
				state: "failed",
				finishedAt: new Date(5_000),
				note: "boom",
			});
			const { items, counts } = mergeInboxes([await f.inbox.list()]);
			expect(
				items
					.map((i) => `${i.severity}:${i.kind}:${i.id}`)
					.sort((a, b) => a.localeCompare(b)),
			).toEqual(
				[
					`critical:blocked:blocked:${blocked.id}`,
					`attention:review:review:${review.id}`,
					"attention:approval_pending:approval_pending:RUNW",
					"attention:stalled:stalled:RUNS",
					"info:failed_run:failed_run:RUNF",
				].sort((a, b) => a.localeCompare(b)),
			);
			expect(counts).toEqual({ total: 5, critical: 1, attention: 3 });
		} finally {
			await f.cleanup();
		}
	});
});
