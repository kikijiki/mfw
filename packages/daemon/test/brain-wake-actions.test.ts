import { afterEach, describe, expect, test } from "bun:test";
import { type BrainUnit, brainUnit } from "./support/brain-unit.ts";

/** What the executor's outcomes do to the wake table (design §1.1, §6.3). */

let u: BrainUnit;
afterEach(async () => {
	await u.cleanup();
});

describe("executor outcomes wake the brain", () => {
	test("a spawn the engine refused wakes it as attention, not at the next heartbeat", async () => {
		u = await brainUnit({ maxConcurrent: 4 });
		await u.runtime.tick();
		await u.human("go");
		await u.runtime.tick();
		const turnRunId = u.launched[0]?.runId ?? "";
		await u.endRun(turnRunId);
		await u.runtime.tick(); // the turn closes ok

		const t = await u.tasks.create({ title: "x", status: "ready" });
		// ignore the task.created frontier wake: consume it
		u.advance(10 * 60_000);
		await u.runtime.tick();
		await u.endRun(u.launched.at(-1)?.runId ?? "");
		await u.runtime.tick();
		const launchedBefore = u.launched.length;

		// a live turn to act in: start one with a human message
		await u.human("act");
		await u.runtime.tick();
		const turn = u.launched.at(-1)?.runId ?? "";
		const r = await u.runtime.actions.act({
			turnRunId: turn,
			tool: "spawn",
			args: { taskId: t.id, role: "implement", rationale: "go" },
		});
		expect(r.status).toBe("accepted");
		u.hooks.failLaunch = "no worktree";
		for (const job of await u.runtime.executor.pendingSpawns()) {
			await u.runtime.executor.launch(job.actionId);
		}
		await u.endRun(turn);
		await u.runtime.tick();
		expect(u.launched.length).toBe(launchedBefore + 1);

		u.advance(6_000); // attention debounce is 5 s
		const out = await u.runtime.tick();
		expect(out).toMatchObject({ state: "started", wakeClass: "attention" });
	});

	test("sleep sets how long the quiet may last, and is spent by the next turn", async () => {
		u = await brainUnit({ config: { heartbeatMin: 30 } });
		await u.runtime.tick();
		await u.tasks.create({ title: "ready", status: "ready" });
		u.advance(31 * 60_000);
		await u.runtime.tick(); // frontier wake consumes the creation
		await u.endRun(u.launched[0]?.runId ?? "");
		await u.runtime.tick();
		const turn = u.launched.length;

		// the brain asks for a 90 minute sleep
		await u.human("sleep please");
		await u.runtime.tick();
		const live = u.launched.at(-1)?.runId ?? "";
		await u.runtime.actions.act({
			turnRunId: live,
			tool: "sleep",
			args: { wakeAfterMin: 90, rationale: "nothing to do" },
		});
		await u.endRun(live);
		await u.runtime.tick();
		const after = u.launched.length;
		expect(after).toBe(turn + 1);

		u.advance(60 * 60_000); // past the default heartbeat, inside the hint
		expect((await u.runtime.tick()).state).toBe("idle");
		u.advance(31 * 60_000);
		expect(await u.runtime.tick()).toMatchObject({
			state: "started",
			wakeClass: "heartbeat",
		});
		// the hint is spent by the turn it woke
		expect((await u.session())?.wakeHint).toBeNull();
	});

	test("ready tasks alone do not heartbeat the brain while dispatch is stopped", async () => {
		const block = {
			reason: "mfw is stopped everywhere (global stop)" as string | null,
		};
		u = await brainUnit({ config: { heartbeatMin: 30 }, dispatchBlock: block });
		await u.runtime.tick();
		await u.tasks.create({ title: "ready", status: "ready" });
		u.advance(31 * 60_000);
		await u.runtime.tick(); // the frontier wake consumes the creation
		await u.endRun(u.launched[0]?.runId ?? "");
		await u.runtime.tick();
		const turns = u.launched.length;

		u.advance(31 * 60_000);
		expect((await u.runtime.tick()).state).toBe("idle");
		expect(u.launched.length).toBe(turns);

		block.reason = null;
		expect(await u.runtime.tick()).toMatchObject({
			state: "started",
			wakeClass: "heartbeat",
		});
	});
});
