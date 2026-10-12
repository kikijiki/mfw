import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type BrainUnit, brainUnit } from "./support/brain-unit.ts";

/**
 * `spawn` role `import`: a read-only survey of the repository whose proposal
 * settles `plan_output` for the brain to apply with the board tools. The task
 * only anchors the audit row; the run claims nothing.
 */

let u: BrainUnit;
let turnRunId: string;
let n = 0;

beforeEach(async () => {
	n = 0;
	u = await brainUnit();
	await u.runtime.tick();
	await u.human("survey the repo");
	await u.runtime.tick();
	turnRunId = u.launched[0]?.runId ?? "";
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
			role: "import",
			rationale: "census the repository",
			key: `i${++n}`,
			...over,
		},
	});

describe("spawn role import", () => {
	test("is accepted, launches one import run under the pre-minted id, and claims nothing", async () => {
		const anchor = await u.tasks.create({ title: "Import the repo" });
		const r = await spawn(anchor.id);
		expect(r.status).toBe("accepted");
		const [runId] = (r.result?.runIds ?? []) as string[];
		expect(runId).toBeTruthy();

		const [job] = await u.runtime.executor.pendingSpawns();
		expect(job?.actionId).toBe(r.actionId);
		expect(await u.runtime.executor.launch(r.actionId)).toEqual({
			outcome: "applied",
			runIds: [runId as string],
		});

		const run = await u.registry.get(runId as string);
		expect(run).toMatchObject({
			kind: "import",
			originRef: `brain:${r.actionId}`,
		});
		expect(run?.taskId).toBeNull();
		expect((await u.tasks.get(anchor.id))?.claimedByGroupId).toBeNull();
		// Replaying the launch starts nothing twice.
		await u.runtime.executor.launch(r.actionId);
		expect(
			(await u.registry.list({ kinds: ["import"] })).map((x) => x.id),
		).toEqual([runId as string]);
	});

	test("a second import is refused while one is live or waiting", async () => {
		const anchor = await u.tasks.create({ title: "Import the repo" });
		expect((await spawn(anchor.id)).status).toBe("accepted");
		const waiting = await spawn(anchor.id);
		expect(waiting.rejection?.code).toBe("already_importing");

		await u.runtime.executor.launch(
			(await u.runtime.executor.pendingSpawns())[0]?.actionId ?? "",
		);
		const live = await spawn(anchor.id, { rationale: "again" });
		expect(live.rejection?.code).toBe("already_importing");
	});

	test("an import has no worktree to continue", async () => {
		const anchor = await u.tasks.create({ title: "Import the repo" });
		const r = await spawn(anchor.id, { worktree: "continue:abc" });
		expect(r.rejection?.code).toBe("worktree_unavailable");
	});
});
