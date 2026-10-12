import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { appendEvent, EventBus } from "@mfw/db/eventlog";
import { events, runSpans, runs } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { RunRegistry } from "../src/run-registry.ts";
import { closeDanglingSpans } from "../src/spans.ts";

async function fresh() {
	const dir = await mkdtemp(join(tmpdir(), "mfw-spans-d-"));
	const h = await openProjectDb(dir);
	const registry = new RunRegistry({
		handle: h,
		bus: new EventBus(),
		runsDir: join(dir, "runs"),
	});
	return {
		h,
		registry,
		cleanup: async () => {
			h.close();
			await rm(dir, { recursive: true, force: true });
		},
	};
}

const spec = {
	kind: "task" as const,
	taskId: "T-1",
	label: "T-1",
	model: "sonnet",
	cwd: "/tmp/wt",
};

async function lane(h: ProjectDbHandle, subject: string, name: string) {
	const rows = await h.db
		.select()
		.from(runSpans)
		.where(eq(runSpans.subject, subject));
	return rows
		.filter((r) => r.lane === name)
		.sort((a, b) => a.id - b.id)
		.map((r) => ({
			value: r.value,
			start: r.startTs.getTime(),
			end: r.endTs?.getTime() ?? null,
		}));
}

describe("run spans written with the lifecycle", () => {
	test("starting, running(working, needs_answer, working), ended, completed", async () => {
		const f = await fresh();
		const run = await f.registry.create(spec);
		const detail = (question?: string) =>
			({ pendingApprovals: [], ...(question ? { question } : {}) }) as never;
		await f.registry.transition(run.id, "running", { from: "starting" });
		await f.registry.setActivity(run.id, "working", detail());
		await f.registry.setActivity(run.id, "needs_answer", detail("Keep v1?"));
		await f.registry.setActivity(run.id, "working", detail());
		await f.registry.recordExit(run.id, { exitCode: 0, outcome: "completed" });
		await f.registry.finish(run.id, "completed");

		const subject = `run:${run.id}`;
		const state = await lane(f.h, subject, "state");
		expect(state.map((s) => s.value)).toEqual([
			"starting",
			"running",
			"ended",
			"completed",
		]);
		const activity = await lane(f.h, subject, "activity");
		expect(activity.map((s) => s.value)).toEqual([
			"working",
			"needs_answer",
			"working",
		]);
		// no overlap and no open span left within a lane
		for (const spans of [state, activity]) {
			for (let i = 0; i < spans.length; i++) {
				const s = spans[i] as (typeof spans)[number];
				expect(s.end).not.toBeNull();
				const next = spans[i + 1];
				if (next) expect(s.end as number).toBeLessThanOrEqual(next.start);
			}
		}
		const asked = (
			await f.h.db
				.select()
				.from(runSpans)
				.where(eq(runSpans.value, "needs_answer"))
		)[0];
		expect(asked?.detail).toEqual({
			question: "Keep v1?",
		});
		await f.cleanup();
	});

	test("a rolled-back transaction leaves neither the event nor its span", async () => {
		const f = await fresh();
		const run = await f.registry.create(spec);
		const before = (await f.h.db.select().from(runSpans)).length;
		await expect(
			f.h.withTx(async (tx) => {
				await appendEvent(tx, {
					type: "run.state_changed",
					runId: run.id,
					taskId: "T-1",
					payload: { from: "starting", to: "running" },
				});
				throw new Error("crash after the event, before commit");
			}),
		).rejects.toThrow("crash after");
		expect((await f.h.db.select().from(runSpans)).length).toBe(before);
		const evs = await f.h.db
			.select()
			.from(events)
			.where(eq(events.type, "run.state_changed"));
		expect(evs).toHaveLength(0);
		await f.cleanup();
	});

	test("a committed event has its span even if nothing was published after commit", async () => {
		const f = await fresh();
		const run = await f.registry.create(spec);
		// Commit via the raw transaction with no bus fan-out: a span written by a
		// post-commit subscriber would be missing here (a crash in that window).
		await f.h.withTx((tx) =>
			appendEvent(tx, {
				type: "run.state_changed",
				runId: run.id,
				taskId: "T-1",
				payload: { from: "starting", to: "running" },
			}),
		);
		const state = await lane(f.h, `run:${run.id}`, "state");
		expect(state.map((s) => s.value)).toEqual(["starting", "running"]);
		expect(state[0]?.end).not.toBeNull();
		expect(state[1]?.end).toBeNull();
		await f.cleanup();
	});
});

describe("closeDanglingSpans", () => {
	test("closes spans of terminal or missing runs at finished_at; leaves live runs", async () => {
		const f = await fresh();
		const done = await f.registry.create({ ...spec, label: "done" });
		const live = await f.registry.create({ ...spec, label: "live" });
		await f.registry.transition(live.id, "running");
		const finishedAt = new Date(Date.now() + 10_000);
		await f.h.db
			.update(runs)
			.set({ state: "failed", finishedAt })
			.where(eq(runs.id, done.id));
		// done's state span is still open (its closing event was lost)
		const at = new Date(Date.now() - 5_000);
		await f.h.db.insert(runSpans).values([
			{ subject: "run:gone", lane: "activity", value: "working", startTs: at },
			{
				subject: `run:${done.id}`,
				lane: "activity",
				value: "working",
				startTs: at,
			},
		]);
		const closed = await closeDanglingSpans(f.h.db);
		// done's open `starting` state span, its activity span, and the missing run's
		expect(closed).toBe(3);
		const all = await f.h.db.select().from(runSpans);
		for (const s of all.filter((x) => x.subject === `run:${done.id}`)) {
			expect(s.endTs?.getTime()).toBe(finishedAt.getTime());
		}
		const liveOpen = all.filter(
			(x) => x.subject === `run:${live.id}` && x.endTs === null,
		);
		expect(liveOpen.map((s) => s.value)).toEqual(["running"]);
		// idempotent
		expect(await closeDanglingSpans(f.h.db)).toBe(0);
		await f.cleanup();
	});
});
