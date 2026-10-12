import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunState } from "@mfw/db/schema";
import { DEFAULT_ACTION_CAPS } from "../src/brain-runtime/actions.ts";
import { type BrainUnit, brainUnit } from "./support/brain-unit.ts";

/**
 * The loop guard (design I9, I10): a task that keeps failing is the brain's
 * to escalate or archive, not to retry for ever. Four consecutive failed
 * attempt groups on one task make `spawn` refuse with the fix "escalate or
 * archive"; twelve runs over its lifetime do the same.
 */

let u: BrainUnit;
let turnRunId: string;
let counter = 0;
const why = { rationale: "try again" };

beforeEach(async () => {
	counter = 0;
	u = await brainUnit({ maxConcurrent: 6 });
	await u.runtime.tick();
	await u.human("go");
	await u.runtime.tick();
	turnRunId = u.launched[0]?.runId ?? "";
	expect(turnRunId).not.toBe("");
});
afterEach(async () => {
	await u.cleanup();
});

const spawn = (taskId: string, over: Record<string, unknown> = {}) =>
	u.runtime.actions.act({
		turnRunId,
		tool: "spawn",
		args: {
			taskId,
			role: "implement",
			...why,
			key: `k${++counter}`,
			...over,
		},
	});

/** One finished run in its own group (a repair is a new group). */
async function endedRun(
	taskId: string,
	state: RunState,
	over: { outcome?: string; worktreePath?: string } = {},
) {
	const run = await u.registry.create({
		kind: "task",
		taskId,
		label: `${taskId}#implement`,
		model: "sonnet",
		cwd: u.root,
		...(over.worktreePath
			? { worktreePath: over.worktreePath, branch: "mfw/x" }
			: {}),
	});
	await u.registry.transition(run.id, state, {
		finishedAt: new Date(),
		...(over.outcome ? { outcome: over.outcome as never } : {}),
	});
	// Distinct start times keep "newest first" meaningful.
	await Bun.sleep(3);
	return run;
}

async function readyTask(title = "stubborn") {
	return (await u.tasks.create({ title, status: "ready" })).id;
}

describe("the loop guard", () => {
	test("the default cap is four consecutive failed groups", () => {
		expect(DEFAULT_ACTION_CAPS.consecutiveFailedGroups).toBe(4);
		expect(DEFAULT_ACTION_CAPS.runsPerTask).toBe(12);
	});

	test("three failed groups still allow a spawn; the fourth refuses it with the fix 'escalate or archive'", async () => {
		const id = await readyTask();
		for (let i = 0; i < 3; i++) await endedRun(id, "failed");
		const third = await spawn(id);
		expect(third.status).toBe("accepted");
		// (the accepted spawn is only an outbox row: no run exists for it)

		await endedRun(id, "failed");
		const fourth = await spawn(id);

		expect(fourth.status).toBe("rejected");
		expect(fourth.rejection?.code).toBe("task_stuck");
		expect(fourth.rejection?.fix?.text).toContain("escalate or archive");
		expect(fourth.rejection?.fix?.text).toContain("notify_human");
		expect(fourth.rejection?.message).toContain("4 attempt groups in a row");
	});

	test("review rejections and scope settles count as failures too", async () => {
		const id = await readyTask();
		for (const state of [
			"needs_review",
			"killed",
			"interrupted",
			"finalize_error",
		] as const) {
			await endedRun(id, state);
		}
		const r = await spawn(id);
		expect(r.rejection?.code).toBe("task_stuck");
	});

	test("a group that landed breaks the streak", async () => {
		const id = await readyTask();
		await endedRun(id, "failed");
		await endedRun(id, "failed");
		await endedRun(id, "completed"); // a question answered, or a merge
		await endedRun(id, "failed");
		await endedRun(id, "failed");
		await endedRun(id, "failed");
		expect((await spawn(id)).status).toBe("accepted");
	});

	test("rate limits and manual stops neither count nor break the streak", async () => {
		const id = await readyTask();
		await endedRun(id, "failed");
		await endedRun(id, "rate_limited");
		await endedRun(id, "failed");
		await endedRun(id, "killed", { outcome: "killed_manual" });
		await endedRun(id, "failed");
		// three failures so far: the neutral two are skipped
		expect((await spawn(id)).status).toBe("accepted");
		await endedRun(id, "failed");
		expect((await spawn(id)).rejection?.code).toBe("task_stuck");
	});

	test("the streak is per task", async () => {
		const stuck = await readyTask("stuck");
		const other = await readyTask("fine");
		for (let i = 0; i < 4; i++) await endedRun(stuck, "failed");
		expect((await spawn(stuck)).rejection?.code).toBe("task_stuck");
		expect((await spawn(other)).status).toBe("accepted");
	});

	test("a person moving the task resets it", async () => {
		const id = await readyTask();
		for (let i = 0; i < 4; i++) await endedRun(id, "failed");
		expect((await spawn(id)).rejection?.code).toBe("task_stuck");

		await Bun.sleep(5);
		await u.tasks.move(id, "backlog", "human", "rethought");
		await u.tasks.move(id, "ready", "human", "go again");

		expect((await spawn(id)).status).toBe("accepted");
	});

	test("twelve runs over a task's lifetime need an escalation too, however they ended", async () => {
		const id = await readyTask();
		for (let i = 0; i < 12; i++) {
			// alternate, so the consecutive-failure streak never reaches four
			await endedRun(id, i % 2 === 0 ? "completed" : "failed");
		}
		const r = await spawn(id);
		expect(r.status).toBe("rejected");
		expect(r.rejection?.code).toBe("task_run_budget");
		expect(r.rejection?.fix?.text).toContain("escalate or archive");
	});

	test("escalating is never refused: notify_human still works on a stuck task", async () => {
		const id = await readyTask();
		for (let i = 0; i < 4; i++) await endedRun(id, "failed");
		const r = await u.runtime.actions.act({
			turnRunId,
			tool: "notify_human",
			args: {
				...why,
				kind: "brain_stuck",
				title: "cannot make progress",
				body: "four repairs failed the same check",
				blocking: [id],
			},
		});
		expect(r.status).toBe("applied");
	});
});

describe("continue: spawns", () => {
	test("a run whose worktree is gone cannot be continued; one that is there can", async () => {
		const id = await readyTask();
		const dir = await mkdtemp(join(tmpdir(), "mfw-continue-"));
		try {
			const present = await endedRun(id, "failed", { worktreePath: dir });
			const gone = await endedRun(id, "failed", {
				worktreePath: join(dir, "does-not-exist"),
			});

			const ok = await spawn(id, { worktree: `continue:${present.id}` });
			expect(ok.status).toBe("accepted");

			const refused = await spawn(id, { worktree: `continue:${gone.id}` });
			expect(refused.rejection?.code).toBe("worktree_gone");
			expect(refused.rejection?.fix?.text).toContain("worktree: new");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a run that is still live cannot be continued", async () => {
		const id = await readyTask();
		const live = await u.registry.create({
			kind: "task",
			taskId: id,
			label: "t",
			model: "sonnet",
			cwd: u.root,
			worktreePath: u.root,
			branch: "mfw/x",
		});
		await u.registry.transition(live.id, "running");
		const r = await spawn(id, { worktree: `continue:${live.id}` });
		expect(r.rejection?.code).toBe("worktree_live");
	});
});
