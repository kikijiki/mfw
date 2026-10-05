import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { decisions, mergeJobs, runs } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { Health } from "../src/health.ts";
import { RunRegistry } from "../src/run-registry.ts";
import type { TaskService } from "../src/task-service.ts";
import { makeTasks } from "./fixtures/board.ts";

interface F {
	handle: ProjectDbHandle;
	registry: RunRegistry;
	tasks: TaskService;
	health: Health;
	now: { value: number };
	cleanup: () => Promise<void>;
}

async function fixture(): Promise<F> {
	const root = await mkdtemp(join(tmpdir(), "mfw-health-"));
	const mfwDir = join(root, ".mfw");
	const handle = await openProjectDb(mfwDir);
	const bus = new EventBus();
	const registry = new RunRegistry({
		handle,
		bus,
		runsDir: join(mfwDir, "runs"),
	});
	const tasks = await makeTasks(handle, bus, mfwDir);
	const now = { value: Date.now() };
	const health = new Health({
		handle,
		tasks,
		bootId: "boot-1",
		startedAt: now.value - 60_000,
		supervisor: {
			stats: { lastPassAt: now.value - 3000, lastPassMs: 12, passErrors: 2 },
		},
		scheduler: { status: () => ({ enabled: true, inFlight: 1 }) },
		brain: { counters: () => ({ calls: 4, failures: 1 }) },
		now: () => now.value,
	});
	return {
		handle,
		registry,
		tasks,
		health,
		now,
		cleanup: async () => {
			handle.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

async function seedRun(
	f: F,
	over: {
		state?: string;
		kind?: string;
		taskId?: string;
		usage?: Record<string, number>;
		durationMs?: number;
	} = {},
) {
	const run = await f.registry.create({
		kind: (over.kind ?? "task") as never,
		taskId: over.taskId,
		label: "t",
		model: "sonnet",
		cwd: "/tmp",
	});
	if (over.state && over.state !== "starting") {
		await f.handle.db
			.update(runs)
			.set({
				state: over.state as never,
				usage: over.usage ?? null,
				finishedAt: over.durationMs
					? new Date(run.startedAt.getTime() + over.durationMs)
					: null,
			})
			.where(eq(runs.id, run.id));
	}
	return run;
}

describe("Health snapshot", () => {
	test("reports loop liveness, run/task counts, and queue depth", async () => {
		const f = await fixture();
		const t1 = await f.tasks.create({ title: "a" });
		await f.tasks.move(t1.id, "ready", "human");
		await f.tasks.create({ title: "b" });
		await seedRun(f, { state: "running" });
		await seedRun(f, { state: "completed" });
		const merging = await seedRun(f, { state: "merging" });
		await f.handle.db.insert(mergeJobs).values({
			runId: merging.id,
			branch: "mfw/x",
			targetBranch: "main",
			state: "queued",
			enqueuedAt: new Date(),
			updatedAt: new Date(),
		});

		const snap = await f.health.snapshot();
		expect(snap.bootId).toBe("boot-1");
		expect(snap.uptimeMs).toBe(60_000);
		// liveness: staleMs answers "is the loop wedged?"
		expect(snap.supervisor.staleMs).toBe(3000);
		expect(snap.supervisor.passErrors).toBe(2);
		expect(snap.runs.byState.running).toBe(1);
		expect(snap.runs.byState.completed).toBe(1);
		expect(snap.runs.active).toBe(2); // running + merging
		expect(snap.tasks.byStatus.ready).toBe(1);
		expect(snap.tasks.byStatus.backlog).toBe(1);
		expect(snap.mergeQueue.depth).toBe(1);
		expect(snap.scheduler).toEqual({ enabled: true, inFlight: 1 });
		expect(snap.brain).toEqual({ calls: 4, failures: 1 });
		expect(snap.events.lastSeq).toBeGreaterThan(0);
		await f.cleanup();
	});

	test("a loop that never ticked reports staleMs null, not a fake zero", async () => {
		const f = await fixture();
		const health = new Health({
			handle: f.handle,
			tasks: f.tasks,
			bootId: "b",
			startedAt: f.now.value,
			now: () => f.now.value,
		});
		const snap = await health.snapshot();
		expect(snap.supervisor.staleMs).toBeNull();
		expect(snap.scheduler).toBeNull();
		await f.cleanup();
	});
});

describe("Health metrics", () => {
	test("aggregates spend, durations, and failure rate across runs", async () => {
		const f = await fixture();
		await seedRun(f, {
			state: "completed",
			durationMs: 1000,
			usage: { costUsd: 0.5, inputTokens: 100, outputTokens: 20 },
		});
		await seedRun(f, {
			state: "completed",
			durationMs: 3000,
			usage: { costUsd: 0.25, inputTokens: 50, outputTokens: 10 },
		});
		await seedRun(f, { state: "failed", durationMs: 2000 });
		await seedRun(f, { state: "killed", durationMs: 500 });

		const m = await f.health.metrics();
		expect(m.runs).toBe(4);
		expect(m.spend.costUsd).toBeCloseTo(0.75, 5);
		expect(m.spend.inputTokens).toBe(150);
		// 2 failed/killed out of 4 decided
		expect(m.failureRate).toBeCloseTo(0.5, 5);
		expect(m.durationMs.max).toBe(3000);
		expect(m.durationMs.p50).toBeGreaterThan(0);
		expect(m.byKind.task).toBe(4);
		await f.cleanup();
	});

	test("an empty window reports zeros rather than NaN", async () => {
		const f = await fixture();
		const m = await f.health.metrics(1000);
		expect(m.runs).toBe(0);
		expect(m.failureRate).toBe(0);
		expect(m.durationMs).toEqual({ p50: 0, p95: 0, max: 0 });
		await f.cleanup();
	});
});

describe("Health taskTrace", () => {
	test("answers 'why is this task here' from one call", async () => {
		const f = await fixture();
		const t = await f.tasks.create({ title: "investigate me" });
		await f.tasks.move(t.id, "ready", "human");
		const run = await seedRun(f, { state: "failed", taskId: t.id });
		await f.handle.db.insert(decisions).values({
			ts: new Date(),
			role: "replan",
			taskId: t.id,
			subjectRunId: run.id,
			model: "sonnet",
			status: "ok",
			action: "escalate",
			reason: "cannot resolve the dependency",
			input: {},
			output: {},
		});
		await f.tasks.move(t.id, "blocked", "brain", "escalated");

		const trace = await f.health.taskTrace(t.id);
		expect(trace.runs.length).toBe(1);
		expect(trace.runs[0]?.state).toBe("failed");
		expect(trace.decisions[0]?.action).toBe("escalate");
		expect(trace.decisions[0]?.reason).toContain("dependency");
		// the status change that parked it is right there too
		const statuses = trace.events.filter(
			(e) => e.type === "task.status_changed",
		);
		expect(statuses.length).toBeGreaterThanOrEqual(1);
		await f.cleanup();
	});
});
