import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { brainSessions, events } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { type BrainUnit, brainUnit } from "./support/brain-unit.ts";

let u: BrainUnit | undefined;
afterEach(async () => {
	await u?.cleanup();
	u = undefined;
});

/** The turn rows, oldest first. */
async function turns(unit: BrainUnit) {
	return (await unit.turns()).reverse();
}

describe("BrainWaker: debounce and coalescing", () => {
	test("events inside the debounce window coalesce into one turn", async () => {
		u = await brainUnit();
		await u.runtime.tick(); // creates the session at the current head
		const first = await u.taskCreated("T-1");
		u.advance(2_000);
		await u.taskCreated("T-2");
		u.advance(2_000);
		const last = await u.taskCreated("T-3");

		// frontier waits for 30s of quiet.
		u.advance(10_000);
		expect((await u.runtime.tick()).state).toBe("idle");
		expect(u.launched).toHaveLength(0);

		u.advance(30_000);
		const out = await u.runtime.tick();
		expect(out).toMatchObject({ state: "started", wakeClass: "frontier" });
		expect(u.launched).toHaveLength(1);
		const [t] = await turns(u);
		expect(t).toMatchObject({
			eventsFrom: first,
			eventsTo: last,
			status: "running",
			resumed: false,
		});

		// One turn at a time: nothing else starts while it is live.
		u.advance(60_000);
		await u.taskCreated("T-4");
		expect((await u.runtime.tick()).state).toBe("turn_live");
		expect(u.launched).toHaveLength(1);
	});

	test("a steady trickle cannot postpone the wake past the class maximum", async () => {
		u = await brainUnit();
		await u.runtime.tick();
		// `settled` is quiet 10s, at most 60s: an event every 5s never goes quiet.
		for (let i = 0; i < 14; i++) {
			await u.emit({
				type: "run.settled",
				runId: `r-${i}`,
				payload: { class: "verify_failed", facts: {} },
			});
			u.advance(5_000);
			const out = await u.runtime.tick();
			if (i < 11) expect(out.state).toBe("idle");
		}
		expect(u.launched).toHaveLength(1);
		const [t] = await turns(u);
		expect(t?.wakeClass).toBe("settled");
	});

	test("the most urgent due class names the turn", async () => {
		u = await brainUnit();
		await u.runtime.tick();
		await u.taskCreated("T-1");
		await u.human("stop doing that");
		u.advance(31_000);
		const out = await u.runtime.tick();
		expect(out).toMatchObject({ state: "started", wakeClass: "human" });
	});

	test("the brain's own turns never wake it", async () => {
		u = await brainUnit();
		await u.runtime.tick();
		await u.human();
		await u.runtime.tick();
		const [turn] = await turns(u);
		await u.endRun(turn?.runId ?? "");
		await u.runtime.tick();
		// The turn's run.state_changed events are pending but not wake events.
		u.advance(5 * 60_000);
		expect((await u.runtime.tick()).state).toBe("idle");
		expect(u.launched).toHaveLength(1);
	});

	test("a heartbeat wakes a quiet brain only while there is work", async () => {
		u = await brainUnit({ config: { heartbeatMin: 30 } });
		await u.runtime.tick();
		u.advance(31 * 60_000);
		// No live run, no ready task: nothing to watch.
		expect((await u.runtime.tick()).state).toBe("idle");

		// A ready task: its creation is a frontier wake, consumed first.
		const t = await u.tasks.create({ title: "ready one", status: "ready" });
		expect(t.status).toBe("ready");
		expect((await u.runtime.tick()).state).toBe("started");
		await u.endRun(u.launched[0]?.runId ?? "");
		await u.runtime.tick();

		// Quiet again, but work remains: the heartbeat fires after 30 minutes.
		u.advance(29 * 60_000);
		expect((await u.runtime.tick()).state).toBe("idle");
		u.advance(2 * 60_000);
		const out = await u.runtime.tick();
		expect(out).toMatchObject({ state: "started", wakeClass: "heartbeat" });
	});

	test("the hourly turn cap holds further wakes", async () => {
		u = await brainUnit({ config: { maxTurnsPerHour: 2 } });
		await u.runtime.tick();
		for (let i = 0; i < 2; i++) {
			await u.human(`m${i}`);
			const out = await u.runtime.tick();
			expect(out.state).toBe("started");
			await u.endRun(u.launched[i]?.runId ?? "");
			await u.runtime.tick();
		}
		await u.human("one more");
		expect((await u.runtime.tick()).state).toBe("capped");
		u.advance(61 * 60_000);
		expect((await u.runtime.tick()).state).toBe("started");
	});

	test("a held route waits; the next configured route is used", async () => {
		u = await brainUnit();
		await u.runtime.tick();
		u.state.held = {
			key: "claude-cli",
			until: u.clock.t + 60_000,
			reason: "rate limited",
		};
		await u.human();
		expect((await u.runtime.tick()).state).toBe("held");
		expect(u.launched).toHaveLength(0);
		u.state.held = null;
		expect((await u.runtime.tick()).state).toBe("started");
	});

	test("without a configured route the brain is off: no session, no turn, no rows", async () => {
		u = await brainUnit({ config: null });
		await u.human();
		u.advance(60 * 60_000);
		expect((await u.runtime.tick()).state).toBe("off");
		expect(await u.handle.db.select().from(brainSessions)).toHaveLength(0);
		expect(u.launched).toHaveLength(0);
	});
});

describe("BrainWaker: the cursor", () => {
	test("the cursor advances only when a turn ends ok", async () => {
		u = await brainUnit();
		await u.runtime.tick();
		const start = (await u.session())?.cursor ?? -1;
		await u.human("a");
		const seq = await u.human("b");
		await u.runtime.tick();

		// Turn start does not move it.
		expect((await u.session())?.cursor).toBe(start);

		await u.endRun(u.launched[0]?.runId ?? "");
		await u.runtime.tick();
		const s = await u.session();
		expect(s?.cursor).toBe(seq);
		expect(s?.status).toBe("idle");
		expect((await turns(u))[0]?.status).toBe("ok");
	});

	test("a failed turn re-delivers the same events_from..events_to", async () => {
		u = await brainUnit();
		await u.runtime.tick();
		await u.human("a");
		await u.human("b");
		await u.runtime.tick();
		const [first] = await turns(u);

		await u.endRun(u.launched[0]?.runId ?? "", {
			state: "failed",
			exitCode: 1,
		});
		// The failed close happens in this tick; the retry waits out its backoff.
		expect((await u.runtime.tick()).state).toBe("backoff");
		const s = await u.session();
		expect(s?.cursor).toBe(first?.eventsFrom ? first.eventsFrom - 1 : 0);
		expect(s?.consecutiveFailures).toBe(1);

		u.advance(60_000);
		expect((await u.runtime.tick()).state).toBe("started");
		const [retry, failed] = await turns(u).then((t) => t.reverse());
		expect(failed?.status).toBe("failed");
		expect(retry?.eventsFrom).toBe(failed?.eventsFrom ?? -1);
		expect(retry?.eventsTo).toBe(failed?.eventsTo ?? -1);

		// Delivery is visible to the model: the digest lists the same events.
		const digest = await readFile(
			`${u.registry.runDir(retry?.runId ?? "")}/digest.md`,
			"utf8",
		);
		expect(digest).toContain("human.brain_message text=a");
		expect(digest).toContain("human.brain_message text=b");
	});

	test("a turn that overruns its wall clock is a timeout, not ok", async () => {
		u = await brainUnit();
		await u.runtime.tick();
		await u.human();
		await u.runtime.tick();
		await u.endRun(u.launched[0]?.runId ?? "", {
			state: "killed",
			exitCode: 137,
			killReason: "watchdog-wall",
		});
		await u.runtime.tick();
		const [t] = await turns(u);
		expect(t?.status).toBe("timeout");
		const ended = await u.handle.db
			.select()
			.from(events)
			.where(eq(events.type, "brain.turn_ended"));
		expect(ended).toHaveLength(1);
		expect(ended[0]?.payload).toMatchObject({ status: "timeout" });
	});

	test("a turn whose run row never appeared is aborted at recovery and its events stay pending", async () => {
		u = await brainUnit();
		await u.runtime.tick();
		const seq = await u.human();
		u.state.startFails = true;
		const out = await u.runtime.tick();
		expect(out.state).toBe("backoff");
		const [t] = await turns(u);
		expect(t?.status).toBe("failed");
		expect(t?.error).toContain("launch refused");
		expect((await u.session())?.cursor).toBeLessThan(seq);
	});
});
