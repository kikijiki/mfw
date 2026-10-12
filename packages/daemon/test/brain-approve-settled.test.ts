import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type BrainUnit, brainUnit } from "./support/brain-unit.ts";

/**
 * A settled single run whose review could not give a verdict (class
 * `infra_failure`) is merged after the brain's `request_review` returns
 * `merge`: through the same gates a first-pass success goes through, never
 * around them.
 */

let u: BrainUnit;
let turnRunId: string;
let n = 0;

beforeEach(async () => {
	n = 0;
	u = await brainUnit();
	await u.runtime.tick();
	await u.human("review it");
	await u.runtime.tick();
	turnRunId = u.launched[0]?.runId ?? "";
});
afterEach(async () => {
	await u.cleanup();
});

const review = (runId: string) =>
	u.runtime.actions.act({
		turnRunId,
		tool: "request_review",
		args: {
			runId,
			mode: "critic",
			rationale: "the first reviewer was not independent",
			key: `r${++n}`,
		},
	});

/** A run finalize settled: verified, review unusable, task back to ready. */
async function settledRun(
	over: { verified?: boolean; outside?: number; claimed?: boolean } = {},
) {
	const task = await u.tasks.create({
		title: "reviewed work",
		status: "ready",
	});
	const run = await u.registry.create({
		kind: "task",
		taskId: task.id,
		label: `${task.id}#implement`,
		model: "sonnet",
		cwd: u.root,
		worktreePath: u.root,
		branch: "mfw/reviewed",
		baseSha: "a".repeat(40),
		integrationBranch: "main",
	});
	await u.registry.beginStep(run.id, "verify");
	await u.registry.finishStep(run.id, "verify", {
		passed: over.verified !== false,
		checks: [],
	});
	if (over.outside !== undefined) {
		await u.registry.beginStep(run.id, "scope_check");
		await u.registry.finishStep(run.id, "scope_check", {
			files: 3,
			outside: over.outside,
			outsideFiles: [],
		});
	}
	await u.registry.transition(run.id, "needs_review", {
		exitCode: 0,
		outcome: "completed",
		finishedAt: new Date(),
	});
	if (over.claimed) {
		await u.tasks.tryClaim(task.id, "someone-else", 60_000);
	}
	return { task, run };
}

const enqueues = () => u.effects.filter((e) => e.tool === "enqueue");

describe("approving a settled run after a review the floor accepts", () => {
	test("a verified, in-scope, unclaimed run is enqueued with its claim restored", async () => {
		const { task, run } = await settledRun({ outside: 0 });

		const r = await review(run.id);

		expect(r.status).toBe("applied");
		expect(r.result).toMatchObject({ approved: true, enqueued: true });
		expect(enqueues()).toHaveLength(1);
		expect(enqueues()[0]?.args[0]).toMatchObject({
			runId: run.id,
			taskId: task.id,
			branch: "mfw/reviewed",
			targetBranch: "main",
		});
		expect((await u.registry.get(run.id))?.state).toBe("merging");
		expect((await u.tasks.get(task.id))?.claimedByGroupId).toBe(run.id);
	});

	test("an unverified run is never enqueued", async () => {
		const { run } = await settledRun({ verified: false });
		const r = await review(run.id);
		expect(r.result).toMatchObject({ approved: false });
		expect(enqueues()).toEqual([]);
	});

	test("a run with files outside owns is never enqueued", async () => {
		const { run } = await settledRun({ outside: 2 });
		const r = await review(run.id);
		expect(r.result).toMatchObject({ approved: false });
		expect(String((r.result as { why?: string }).why)).toContain("outside");
		expect(enqueues()).toEqual([]);
	});

	test("a task another run has claimed is left alone", async () => {
		const { run } = await settledRun({ claimed: true });
		const r = await review(run.id);
		expect(r.result).toMatchObject({ approved: false });
		expect(enqueues()).toEqual([]);
	});

	test("approving twice enqueues once", async () => {
		const { run } = await settledRun({ outside: 0 });
		await review(run.id);
		const again = await u.runtime.executor.approveSettled(run.id);
		expect(again).toMatchObject({ approved: true, replay: true });
		expect(enqueues()).toHaveLength(1);
	});
});
