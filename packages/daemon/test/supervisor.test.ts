import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import { engineKv, runSpans } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import type { StepRunner } from "../src/finalize/step-runner.ts";
import { git } from "../src/git.ts";
import { silentLogger } from "../src/log.ts";
import type { NotificationType } from "../src/notify.ts";
import { RunRegistry } from "../src/run-registry.ts";
import { Supervisor, type WatchdogLimitsInput } from "../src/supervisor.ts";
import type { TaskService } from "../src/task-service.ts";
import { WorktreeManager } from "../src/worktree.ts";
import { makeTasks } from "./fixtures/board.ts";

/** A scriptable AgentHost double: no tmux, so these run in milliseconds. */
class FakeHost {
	alive = new Set<string>();
	killed: { runId: string; reason: string }[] = [];
	exits = new Map<string, { kind: string; code?: number; reason?: string }>();
	session(runId: string) {
		return `mfw_${runId}`;
	}
	async isAlive(runId: string) {
		return this.alive.has(runId);
	}
	async listSessions() {
		return [...this.alive].map((r) => this.session(r));
	}
	async kill(_dir: string, runId: string, reason: string) {
		this.alive.delete(runId);
		this.killed.push({ runId, reason });
		this.exits.set(runId, { kind: "killed", reason });
	}
	async readExit(dir: string) {
		const runId = dir.split("/").pop() ?? "";
		return (this.exits.get(runId) ?? { kind: "running" }) as never;
	}
	async appendSteer() {}
}

/** A StepRunner double that records calls and can be made slow / concurrent. */
class FakeStepRunner {
	calls: string[] = [];
	concurrent = 0;
	maxConcurrent = 0;
	delayMs = 0;
	private inflight = new Map<string, Promise<void>>();

	finalize(runId: string): Promise<void> {
		const existing = this.inflight.get(runId);
		if (existing) return existing;
		const p = this.run(runId).finally(() => this.inflight.delete(runId));
		this.inflight.set(runId, p);
		return p;
	}
	private async run(runId: string): Promise<void> {
		this.concurrent++;
		this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
		this.calls.push(runId);
		if (this.delayMs) await Bun.sleep(this.delayMs);
		this.concurrent--;
	}
}

interface Fixture {
	root: string;
	handle: ProjectDbHandle;
	registry: RunRegistry;
	tasks: TaskService;
	host: FakeHost;
	stepRunner: FakeStepRunner;
	sup: Supervisor;
	now: { value: number };
	cleanup: () => Promise<void>;
}

async function fixture(
	limits?: WatchdogLimitsInput,
	extra: Partial<{
		triggers: { dispatch(): Promise<unknown> };
		maintenance: (mode: { exclusive: boolean }) => Promise<void>;
		maintenanceEveryNPasses: number;
		execution: {
			observeRun(runId: string): Promise<{
				state: "starting" | "running" | "unknown" | "exited" | "absent";
			}>;
			killRun(runId: string, reason: string): Promise<void>;
			finalizeExecutionTarget(
				runId: string,
			): Promise<{ collectionError: unknown | null }>;
		};
		ownedElsewhere?: (runId: string) => Promise<boolean>;
		renewAdmission: (runId: string) => Promise<unknown>;
		releaseSlots: (runId: string) => Promise<unknown>;
		notify: (
			kind: NotificationType,
			detail: Record<string, unknown>,
		) => Promise<unknown>;
	}> = {},
): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "mfw-sup-"));
	const mfwDir = join(root, ".mfw");
	const handle = await openProjectDb(mfwDir);
	const bus = new EventBus();
	const registry = new RunRegistry({
		handle,
		bus,
		runsDir: join(mfwDir, "runs"),
	});
	const tasks = await makeTasks(handle, bus, mfwDir);
	const host = new FakeHost();
	const stepRunner = new FakeStepRunner();
	const now = { value: Date.now() };
	const sup = new Supervisor({
		handle,
		registry,
		tasks,
		host: host as never,
		stepRunner: stepRunner as unknown as StepRunner,
		log: silentLogger(),
		projectRoot: root,
		bootId: "boot-1",
		limits,
		now: () => now.value,
		...extra,
	});
	return {
		root,
		handle,
		registry,
		tasks,
		host,
		stepRunner,
		sup,
		now,
		cleanup: async () => {
			await sup.stop();
			// Pending debounced mirror exports still query the DB, draining them
			// before close is exactly what the daemon's shutdown hook must do.
			handle.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

async function seedRun(
	f: Fixture,
	over: Partial<{
		state: string;
		taskId: string;
		startedAgo: number;
		executionTarget: string;
	}> = {},
) {
	const run = await f.registry.create({
		kind: "task",
		taskId: over.taskId,
		label: "t",
		model: "sonnet",
		cwd: f.root,
		worktreePath: join(f.root, "wt"),
		branch: "mfw/x",
		executionTarget: over.executionTarget ?? "local",
	});
	if (over.state && over.state !== "starting")
		await f.registry.transition(run.id, over.state as never);
	if (over.startedAgo) {
		await f.handle.client.execute({
			sql: "UPDATE runs SET started_at = ? WHERE id = ?",
			args: [f.now.value - over.startedAgo, run.id],
		});
	}
	return run;
}

describe("Supervisor v2: the loop", () => {
	test("failed process cleanup retains slots and its task claim across reconciliation", async () => {
		const released: string[] = [];
		const f = await fixture(undefined, {
			releaseSlots: async (id) => {
				released.push(id);
			},
		});
		try {
			const task = await f.tasks.create({
				title: "still writing",
				status: "ready",
			});
			const run = await seedRun(f, { taskId: task.id, state: "ended" });
			await f.tasks.tryClaim(task.id, run.id, 60_000);
			f.stepRunner.finalize = async () => {
				await f.registry.beginStep(run.id, "reap_leftovers");
				await f.registry.failStep(
					run.id,
					"reap_leftovers",
					"writer still alive",
				);
				await f.registry.transition(run.id, "finalize_error");
			};
			await f.sup.pass();
			expect(released).toEqual([]);
			expect(await f.registry.hasPendingCleanup(run.id)).toBe(true);
			await f.sup.reconcile();
			expect((await f.tasks.get(task.id))?.claimedByRunId).toBe(run.id);
		} finally {
			await f.cleanup();
		}
	});

	test("a live run is observed, not finalized", async () => {
		const f = await fixture();
		const run = await seedRun(f, { state: "running" });
		f.host.alive.add(run.id);
		const stats = await f.sup.pass();
		expect(stats.observed).toBe(1);
		expect(stats.finalized).toBe(0);
		expect(f.stepRunner.calls).toEqual([]);
		await f.cleanup();
	});

	test("a dead run transitions to ended and is finalized exactly once", async () => {
		const f = await fixture();
		const run = await seedRun(f, { state: "running" });
		f.host.exits.set(run.id, { kind: "exit", code: 0 });
		await f.sup.pass();
		expect(f.stepRunner.calls).toEqual([run.id]);
		expect((await f.registry.get(run.id))?.state).toBe("ended");
		// a second pass does not re-finalize: the DB claim is already ours
		await f.sup.pass();
		expect(f.stepRunner.calls).toEqual([run.id, run.id]);
		expect(f.stepRunner.maxConcurrent).toBe(1);
		await f.cleanup();
	});

	test("REENTRANCY: overlapping loop passes never double-finalize a run", async () => {
		// This is the v1 critical bug: setInterval fired every 2s while a
		// finalize took far longer, so two finalizations of one run overlapped.
		const f = await fixture();
		const run = await seedRun(f, { state: "running" });
		f.host.exits.set(run.id, { kind: "exit", code: 0 });
		f.stepRunner.delayMs = 120;

		// Drive the real loop at an interval far shorter than a finalization.
		f.sup.start(5);
		await Bun.sleep(400);
		await f.sup.stop();

		expect(f.stepRunner.maxConcurrent).toBe(1);
		await f.cleanup();
	});

	test("a starting run inside the grace window is left alone, then ages out", async () => {
		const f = await fixture();
		const run = await seedRun(f, { state: "starting" });
		await f.sup.pass();
		expect((await f.registry.get(run.id))?.state).toBe("starting");
		expect(f.stepRunner.calls).toEqual([]);

		f.now.value += 130_000; // past START_GRACE_MS
		await f.sup.pass();
		expect(f.stepRunner.calls).toEqual([run.id]);
		await f.cleanup();
	});

	test("transient remote observation failure retains starting/running admission and never finalizes", async () => {
		const attempts = new Map<string, number>();
		const finalized: string[] = [];
		const renewed: string[] = [];
		const released: string[] = [];
		const execution = {
			async observeRun(runId: string) {
				const attempt = (attempts.get(runId) ?? 0) + 1;
				attempts.set(runId, attempt);
				if (attempt === 1) throw new Error("network_lost");
				return { state: "running" as const };
			},
			async killRun() {},
			async finalizeExecutionTarget(runId: string) {
				finalized.push(runId);
				return { collectionError: null };
			},
		};
		const f = await fixture(undefined, {
			execution,
			renewAdmission: async (runId) => renewed.push(runId),
			releaseSlots: async (runId) => released.push(runId),
		});
		const starting = await seedRun(f, {
			state: "starting",
			executionTarget: "runpod",
		});
		const running = await seedRun(f, {
			state: "running",
			executionTarget: "runpod",
		});

		await f.sup.pass();
		expect((await f.registry.get(starting.id))?.state).toBe("starting");
		expect((await f.registry.get(running.id))?.state).toBe("running");
		expect(finalized).toEqual([]);
		expect(released).toEqual([]);
		expect(renewed.sort()).toEqual([running.id, starting.id].sort());

		await f.sup.pass();
		expect((await f.registry.get(starting.id))?.state).toBe("running");
		expect((await f.registry.get(running.id))?.state).toBe("running");
		expect(finalized).toEqual([]);
		expect(released).toEqual([]);
		expect(f.stepRunner.calls).toEqual([]);
		await f.cleanup();
	});

	test("slow maintenance never stalls observation and is single-flight", async () => {
		let starts = 0;
		let releaseMaintenance: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseMaintenance = resolve;
		});
		const f = await fixture(undefined, {
			maintenanceEveryNPasses: 1,
			maintenance: async () => {
				starts++;
				await gate;
			},
		});

		await f.sup.pass(); // starts the long sweep and returns immediately
		const run = await seedRun(f, { state: "running" });
		f.host.exits.set(run.id, { kind: "exit", code: 0 });
		await f.sup.pass(); // observes/finalizes while that sweep is still pending
		expect(f.stepRunner.calls).toContain(run.id);
		expect(starts).toBe(1); // the second cadence cannot overlap it

		let stopped = false;
		const stopping = f.sup.stop().then(() => {
			stopped = true;
		});
		await Bun.sleep(10);
		expect(stopped).toBe(false); // shutdown does not close DB under the sweep
		releaseMaintenance?.();
		await stopping;
		expect(stopped).toBe(true);
		await f.cleanup();
	});

	test("background maintenance failures are counted without rejecting a pass", async () => {
		const f = await fixture(undefined, {
			maintenanceEveryNPasses: 1,
			maintenance: async () => {
				throw new Error("sweep failed");
			},
		});
		await expect(f.sup.pass()).resolves.toMatchObject({ errors: 0 });
		await f.sup.stop();
		expect(f.sup.stats.passErrors).toBe(1);
		await f.cleanup();
	});

	test("cheap maintenance runs while a provider run is live; the exclusive part waits for idle", async () => {
		const modes: { exclusive: boolean }[] = [];
		const f = await fixture(undefined, {
			maintenanceEveryNPasses: 1,
			maintenance: async (mode) => {
				modes.push(mode);
			},
		});
		const run = await seedRun(f, { state: "running" });
		f.host.alive.add(run.id);
		f.sup.requestMaintenance();
		await f.sup.pass();
		await Bun.sleep(0);
		expect(modes).toEqual([{ exclusive: false }]);

		// Provider work ends: the next pass runs the full (sweep) maintenance.
		f.host.alive.delete(run.id);
		await f.registry.finish(run.id, "completed");
		await f.sup.pass();
		await Bun.sleep(0);
		expect(modes.at(-1)).toEqual({ exclusive: true });
		await f.cleanup();
	});

	test("requested recovery confirmation waits until provider work is idle", async () => {
		let starts = 0;
		const busy = await fixture(undefined, {
			maintenanceEveryNPasses: 10_000,
			maintenance: async () => {
				starts++;
			},
		});
		const run = await seedRun(busy, { state: "running" });
		busy.host.alive.add(run.id);
		busy.sup.requestMaintenance();
		await busy.sup.pass();
		expect(starts).toBe(0);
		await busy.sup.stop();
		await busy.cleanup();

		const idle = await fixture(undefined, {
			maintenanceEveryNPasses: 10_000,
			maintenance: async () => {
				starts++;
			},
		});
		idle.sup.requestMaintenance();
		await idle.sup.pass();
		await Bun.sleep(0);
		expect(starts).toBe(1);
		await idle.sup.stop();
		await idle.cleanup();
	});
});

describe("Supervisor v2: watchdog", () => {
	test("wall-clock breach kills the run with the right reason", async () => {
		const f = await fixture({ wallMs: 1000, idleMs: 0 });
		const run = await seedRun(f, { state: "running", startedAgo: 5000 });
		f.host.alive.add(run.id);
		const stats = await f.sup.pass();
		expect(stats.killed).toBe(1);
		expect(f.host.killed[0]).toEqual({
			runId: run.id,
			reason: "watchdog-wall",
		});
		await f.cleanup();
	});

	test("idle is measured on events.jsonl, not raw.log heartbeats", async () => {
		const f = await fixture({ idleMs: 1000, wallMs: 0 });
		const run = await seedRun(f, { state: "running" });
		f.host.alive.add(run.id);
		const dir = f.registry.runDir(run.id);
		await mkdir(dir, { recursive: true });
		// raw.log churns (tmux heartbeats) but the agent produced no events
		await writeFile(join(dir, "raw.log"), "noise\n");
		f.now.value += 5000;
		await f.sup.pass();
		expect(f.host.killed[0]?.reason).toBe("watchdog-idle");
		await f.cleanup();
	});

	test("fresh events.jsonl output keeps a slow run alive", async () => {
		const f = await fixture({ idleMs: 60_000, wallMs: 0 });
		const run = await seedRun(f, { state: "running" });
		f.host.alive.add(run.id);
		const dir = f.registry.runDir(run.id);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "events.jsonl"), "");
		const stats = await f.sup.pass();
		expect(stats.killed).toBe(0);
		await f.cleanup();
	});

	test("turn cap kills a looping agent", async () => {
		const f = await fixture({ maxTurns: 2, idleMs: 0, wallMs: 0 });
		const run = await seedRun(f, { state: "running" });
		f.host.alive.add(run.id);
		const dir = f.registry.runDir(run.id);
		await mkdir(dir, { recursive: true });
		const turn = (seq: number) =>
			`${JSON.stringify({ ts: new Date().toISOString(), seq, type: "message", role: "assistant", text: "loop" })}\n`;
		await writeFile(join(dir, "events.jsonl"), turn(0) + turn(1) + turn(2));
		await f.sup.pass();
		expect(f.host.killed[0]?.reason).toBe("watchdog-turns");
		await f.cleanup();
	});

	test("the driver's verified hello is copied into the run row once", async () => {
		const f = await fixture({ idleMs: 0, wallMs: 0 });
		const run = await seedRun(f, { state: "running" });
		f.host.alive.add(run.id);
		const dir = f.registry.runDir(run.id);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "events.jsonl"),
			`${JSON.stringify({
				ts: new Date().toISOString(),
				seq: 0,
				type: "hello",
				provider: "claude-cli",
				capabilities: { steer: true },
			})}\n`,
		);
		expect((await f.registry.get(run.id))?.capabilities.verified).toBe(false);
		await f.sup.pass();
		const after = await f.registry.get(run.id);
		expect(after?.capabilities).toEqual({
			steer: true,
			verified: true,
			interrupt: false,
			approvals: false,
			plan: false,
			fileChanges: false,
			commandProgress: false,
			mcp: false,
		});
		await f.cleanup();
	});
});

/** One events.jsonl line. */
const line = (seq: number, e: Record<string, unknown>) =>
	`${JSON.stringify({ ts: new Date().toISOString(), seq, ...e })}\n`;

async function activityEvents(f: Fixture, runId: string) {
	const rows = await f.handle.client.execute({
		sql: "SELECT payload FROM events WHERE type = 'run.activity_changed' AND run_id = ? ORDER BY seq",
		args: [runId],
	});
	return rows.rows.map(
		(r) => JSON.parse(String(r.payload)) as { from: string | null; to: string },
	);
}

describe("Supervisor: activity", () => {
	test("activity is persisted and announced only when it changes, and a human is pinged once", async () => {
		const pings: { kind: string; detail: Record<string, unknown> }[] = [];
		const f = await fixture(
			{ idleMs: 0, wallMs: 0 },
			{
				notify: async (kind, detail) => {
					pings.push({ kind, detail });
				},
			},
		);
		const run = await seedRun(f, { state: "running" });
		f.host.alive.add(run.id);
		const dir = f.registry.runDir(run.id);
		await mkdir(dir, { recursive: true });
		const events = join(dir, "events.jsonl");
		await writeFile(
			events,
			line(0, { type: "message", role: "user", text: "go" }),
		);
		await f.sup.pass();
		expect((await f.registry.get(run.id))?.activity).toBe("working");

		const approval = line(1, {
			type: "approval",
			requestId: "r1",
			kind: "command",
			status: "pending",
			summary: "rm -rf dist",
		});
		await writeFile(
			events,
			line(0, { type: "message", role: "user", text: "go" }) + approval,
		);
		await f.sup.pass();
		await f.sup.pass(); // unchanged: no second event, no second ping
		const row = await f.registry.get(run.id);
		expect(row?.activity).toBe("awaiting_approval");
		expect(row?.activityDetail).toMatchObject({
			pendingApprovals: ["r1"],
			approvalSummary: "rm -rf dist",
		});
		expect(await activityEvents(f, run.id)).toEqual([
			expect.objectContaining({ from: null, to: "working" }),
			expect.objectContaining({ from: "working", to: "awaiting_approval" }),
		]);
		expect(pings).toEqual([
			{
				kind: "approval_pending",
				detail: expect.objectContaining({
					runId: run.id,
					message: "rm -rf dist",
				}),
			},
		]);
		await f.cleanup();
	});

	test("an approval requested past the first MiB of transcript still holds off the idle watchdog", async () => {
		const f = await fixture({ idleMs: 1000, wallMs: 0 });
		const run = await seedRun(f, { state: "running" });
		f.host.alive.add(run.id);
		const dir = f.registry.runDir(run.id);
		await mkdir(dir, { recursive: true });
		const filler = "x".repeat(4096);
		let body = "";
		let seq = 0;
		while (body.length < 2 * 1024 * 1024)
			body += line(seq++, { type: "message", role: "assistant", text: filler });
		body += line(seq++, {
			type: "approval",
			requestId: "late",
			kind: "command",
			status: "pending",
			summary: "late approval",
		});
		await writeFile(join(dir, "events.jsonl"), body);
		f.now.value += 60_000;
		await f.sup.pass();
		expect(f.host.killed).toEqual([]);
		expect((await f.registry.get(run.id))?.activity).toBe("awaiting_approval");
		await f.cleanup();
	});
});

describe("Supervisor v2: boot reconciliation", () => {
	test("restart retains a remote run through transient inventory/SSH failure and later adopts it", async () => {
		let observeCalls = 0;
		const finalized: string[] = [];
		const renewed: string[] = [];
		const f = await fixture(undefined, {
			execution: {
				async observeRun() {
					observeCalls++;
					if (observeCalls === 1) throw new Error("inventory timeout");
					return { state: "running" };
				},
				async killRun() {},
				async finalizeExecutionTarget(runId) {
					finalized.push(runId);
					return { collectionError: null };
				},
			},
			renewAdmission: async (runId) => renewed.push(runId),
		});
		const run = await seedRun(f, {
			state: "starting",
			executionTarget: "runpod",
		});
		const uncertain = await f.sup.reconcile();
		expect(uncertain.adopted).toBe(1);
		expect((await f.registry.get(run.id))?.state).toBe("starting");
		expect(finalized).toEqual([]);
		expect(renewed).toEqual([run.id]);

		const recovered = await f.sup.reconcile();
		expect(recovered.adopted).toBe(1);
		expect((await f.registry.get(run.id))?.state).toBe("running");
		expect(finalized).toEqual([]);
		await f.cleanup();
	});

	test("adopts live sessions, ends exited runs, marks the rest interrupted", async () => {
		const f = await fixture();
		const alive = await seedRun(f, { state: "running" });
		const exited = await seedRun(f, { state: "running" });
		const gone = await seedRun(f, { state: "running" });
		f.host.alive.add(alive.id);
		f.host.exits.set(exited.id, { kind: "exit", code: 0 });

		const report = await f.sup.reconcile();
		expect(report.adopted).toBe(1);
		expect(report.endedByExit).toBe(1);
		expect(report.interrupted).toBe(1);
		expect((await f.registry.get(gone.id))?.outcome).toBe("interrupted");
		await f.cleanup();
	});

	test("a crashed daemon's finalize claim is cleared so this boot can proceed", async () => {
		const f = await fixture();
		const run = await seedRun(f, { state: "ended" });
		await f.registry.claimFinalize(run.id, "boot-0-crashed");
		const report = await f.sup.reconcile();
		expect(report.staleClaimsCleared).toBe(1);
		expect(await f.registry.claimFinalize(run.id, "boot-1")).toBe(true);
		await f.cleanup();
	});

	test("boot closes spans left open on a terminal run, and leaves a live run's spans to its own events", async () => {
		const f = await fixture();
		const done = await seedRun(f, { state: "completed" });
		const alive = await seedRun(f, { state: "running" });
		f.host.alive.add(alive.id);
		// A lost closing event: the activity lane was never ended.
		const at = new Date(Date.now() - 60_000);
		await f.handle.client.execute({
			sql: "UPDATE runs SET finished_at = ? WHERE id = ?",
			args: [at.getTime() + 5_000, done.id],
		});
		for (const id of [done.id, alive.id]) {
			await f.handle.db.insert(runSpans).values({
				subject: `run:${id}`,
				lane: "activity",
				value: "working",
				startTs: at,
			});
		}
		await f.sup.reconcile();
		const spans = await f.handle.db
			.select()
			.from(runSpans)
			.where(eq(runSpans.value, "working"));
		const doneRow = await f.registry.get(done.id);
		const doneSpan = spans.find((s) => s.subject === `run:${done.id}`);
		expect(doneSpan?.endTs?.getTime()).toBe(doneRow?.finishedAt?.getTime());
		expect(
			spans.find((s) => s.subject === `run:${alive.id}`)?.endTs,
		).toBeNull();
		await f.cleanup();
	});

	test("orphan tmux sessions with no run row are killed", async () => {
		const f = await fixture();
		f.host.alive.add("01ORPHANRUNIDNOTINDB0000000");
		const report = await f.sup.reconcile();
		expect(report.orphanSessionsKilled).toBe(1);
		await f.cleanup();
	});

	test("a session another project owns is not an orphan", async () => {
		const f = await fixture(undefined, {
			ownedElsewhere: async (runId: string) =>
				runId === "01SIBLINGPROJECTRUN000000",
		});
		f.host.alive.add("01SIBLINGPROJECTRUN000000");
		f.host.alive.add("01ORPHANRUNIDNOTINDB0000000");
		const report = await f.sup.reconcile();
		expect(report.orphanSessionsKilled).toBe(1);
		expect(f.host.alive.has("01SIBLINGPROJECTRUN000000")).toBe(true);
		await f.cleanup();
	});

	test("a task claimed by a vanished run is released back to ready", async () => {
		const f = await fixture();
		const t = await f.tasks.create({ title: "stranded" });
		await f.tasks.move(t.id, "ready", "human");
		await f.tasks.tryClaim(t.id, "01RUNTHATNEVEREXISTED000000", 60_000);
		expect((await f.tasks.get(t.id))?.status).toBe("in_progress");

		const report = await f.sup.reconcile();
		expect(report.leasesReleased).toBe(1);
		const after = await f.tasks.get(t.id);
		expect(after?.status).toBe("ready");
		expect(after?.claimedByRunId).toBeNull();
		await f.cleanup();
	});

	test("an orphan Draft claim with no persisted run is released back to Draft", async () => {
		const f = await fixture();
		const draft = await f.tasks.captureQuick("expand me");
		await f.tasks.tryClaimDraftExpansion(
			draft.id,
			"01DRAFTTHATNEVEREXISTED0000",
			60_000,
		);
		expect((await f.tasks.get(draft.id))?.claimedByRunId).not.toBeNull();

		const report = await f.sup.reconcile();
		expect(report.leasesReleased).toBe(1);
		const after = await f.tasks.get(draft.id);
		expect(after?.status).toBe("draft");
		expect(after?.claimedByRunId).toBeNull();
		await f.cleanup();
	});

	test("a Draft claim backed by a live persisted run survives reconciliation", async () => {
		const f = await fixture();
		const draft = await f.tasks.captureQuick("expand me");
		const runId = "01LIVEDRAFTEXPANSION00000000";
		expect(await f.tasks.tryClaimDraftExpansion(draft.id, runId, 60_000)).toBe(
			true,
		);
		await f.registry.create({
			id: runId,
			kind: "plan",
			taskId: draft.id,
			label: "plan#expand",
			model: "sonnet",
			cwd: f.root,
		});
		await f.registry.transition(runId, "running");
		f.host.alive.add(runId);

		const report = await f.sup.reconcile();
		expect(report.adopted).toBe(1);
		expect(report.leasesReleased).toBe(0);
		expect((await f.tasks.get(draft.id))?.claimedByRunId).toBe(runId);
		await f.cleanup();
	});

	test("an expired dispatch hold is dropped; a live one survives", async () => {
		const f = await fixture();
		await f.handle.db.insert(engineKv).values({
			key: "dispatch_hold",
			value: { until: f.now.value - 1000, reason: "rate-limit" },
			updatedAt: new Date(),
		});
		await f.sup.reconcile();
		expect((await f.handle.db.select().from(engineKv)).length).toBe(0);

		await f.handle.db.insert(engineKv).values({
			key: "dispatch_hold",
			value: { until: f.now.value + 60_000, reason: "rate-limit" },
			updatedAt: new Date(),
		});
		await f.sup.reconcile();
		// survives: a reboot during a quota hold must not resume dispatch
		expect((await f.handle.db.select().from(engineKv)).length).toBe(1);
		await f.cleanup();
	});
});

describe("trigger dispatch rides the supervisor loop, not the scheduler", () => {
	test("every pass gives triggers a turn", async () => {
		// Not the scheduler: it is opt-in dispatch and defaults to OFF, and a
		// project with dispatch disabled must still notify when main goes red.
		// This repeats a fix already made once for the merge queue.
		let passes = 0;
		const f = await fixture(undefined, {
			triggers: {
				dispatch: async () => {
					passes++;
				},
			},
		});
		await f.sup.pass();
		await f.sup.pass();
		expect(passes).toBe(2);
		await f.cleanup();
	});

	test("a throwing dispatch is recorded, never fatal to the pass", async () => {
		const f = await fixture(undefined, {
			triggers: {
				dispatch: async () => {
					throw new Error("the deploy blew up");
				},
			},
		});
		const stats = await f.sup.pass();
		expect(stats.errors).toBe(1);
		expect(f.sup.stats.passErrors).toBe(1);
		await f.cleanup();
	});
});

// ---------------------------------------------------------------------------
// Diff-scope watchdog over a real fixture worktree
// ---------------------------------------------------------------------------

/** A git repo at the fixture root and a worktree whose run claims a task. */
async function scopeFixture(
	limits: Parameters<typeof fixture>[0] = {},
	extra: Record<string, unknown> = {},
) {
	const f = await fixture({ idleMs: 0, wallMs: 0, ...limits }, extra as never);
	await git(["init", "-q", "-b", "main"], f.root);
	await git(["config", "user.email", "t@t"], f.root);
	await git(["config", "user.name", "t"], f.root);
	await writeFile(join(f.root, ".git/info/exclude"), ".mfw/\nworktrees/\n");
	await mkdir(join(f.root, "src/mine"), { recursive: true });
	await writeFile(join(f.root, "src/mine/a.ts"), "a\n");
	await git(["add", "-A"], f.root);
	await git(["commit", "-q", "-m", "init"], f.root);

	const runId = ulid();
	const wt = await new WorktreeManager(f.root).create(runId, "main");
	const own = await f.tasks.create({
		title: "mine",
		status: "ready",
		owns: ["src/mine/**"],
	});
	expect(await f.tasks.tryClaim(own.id, runId, 600_000)).toBe(true);
	const other = await f.tasks.create({
		title: "theirs",
		status: "ready",
		owns: ["src/other/**"],
	});
	expect(await f.tasks.tryClaim(other.id, ulid(), 600_000)).toBe(true);

	const run = await f.registry.create({
		id: runId,
		kind: "task",
		taskId: own.id,
		label: "t",
		model: "sonnet",
		cwd: wt.path,
		worktreePath: wt.path,
		branch: wt.branch,
		baseSha: wt.baseSha,
		executionTarget: "local",
	});
	await f.registry.transition(run.id, "running");
	f.host.alive.add(run.id);
	const dir = f.registry.runDir(run.id);
	await mkdir(dir, { recursive: true });
	let seq = 0;
	/** The agent did something: events.jsonl moves (the sampler's gate). */
	const progress = async () => {
		await writeFile(
			join(dir, "events.jsonl"),
			line(seq++, { type: "message", role: "assistant", text: "editing" }),
			{ flag: "a" },
		);
	};
	await progress();
	const write = async (path: string, text = "x\n") => {
		await mkdir(dirname(join(wt.path, path)), { recursive: true });
		await writeFile(join(wt.path, path), text);
	};
	return { f, run, wt, own, other, write, progress };
}

async function scopeEvents(f: Fixture, runId: string) {
	const rows = await f.handle.client.execute({
		sql: "SELECT payload FROM events WHERE type = 'run.scope_changed' AND run_id = ? ORDER BY seq",
		args: [runId],
	});
	return rows.rows.map((r) => JSON.parse(String(r.payload)));
}

/** Real git and worktrees: generous on a loaded machine. */
const SCOPE_TEST_MS = 30_000;

describe("Supervisor: diff-scope watchdog", () => {
	test(
		"touching a file another claimed task owns kills with watchdog-scope within one sample",
		async () => {
			const s = await scopeFixture();
			try {
				await s.write("src/mine/b.ts");
				await s.write("src/other/x.ts");
				const stats = await s.f.sup.pass();
				expect(stats.killed).toBe(1);
				expect(s.f.host.killed).toEqual([
					{ runId: s.run.id, reason: "watchdog-scope" },
				]);
				// The sample the kill was based on is on the row for the brief and the UI.
				const row = await s.f.registry.get(s.run.id);
				expect(row?.scopeSample).toMatchObject({
					files: 2,
					outside: 1,
					foreign: 1,
					level: "violation",
					foreignFiles: [{ path: "src/other/x.ts", taskId: s.other.id }],
				});
				expect(await scopeEvents(s.f, s.run.id)).toEqual([
					{ from: null, level: "violation", files: 2, outside: 1, foreign: 1 },
				]);
			} finally {
				await s.f.cleanup();
			}
		},
		SCOPE_TEST_MS,
	);

	test(
		"more than maxFiles changed files (151 of 150) kills with watchdog-files",
		async () => {
			const s = await scopeFixture();
			try {
				for (let i = 0; i < 151; i++) await s.write(`src/mine/gen/f${i}.ts`);
				await s.f.sup.pass();
				expect(s.f.host.killed).toEqual([
					{ runId: s.run.id, reason: "watchdog-files" },
				]);
				expect((await s.f.registry.get(s.run.id))?.scopeSample).toMatchObject({
					files: 151,
					outside: 0,
					foreign: 0,
				});
			} finally {
				await s.f.cleanup();
			}
		},
		SCOPE_TEST_MS,
	);

	test(
		"150 files is still inside the limit",
		async () => {
			const s = await scopeFixture();
			try {
				for (let i = 0; i < 150; i++) await s.write(`src/mine/gen/f${i}.ts`);
				await s.f.sup.pass();
				expect(s.f.host.killed).toEqual([]);
			} finally {
				await s.f.cleanup();
			}
		},
		SCOPE_TEST_MS,
	);

	test(
		"files outside the task's own owns (owned by nobody) do not kill; they warn",
		async () => {
			const s = await scopeFixture();
			try {
				await s.write("docs/notes.md");
				// Committed work counts too (diff against the base, not HEAD).
				await git(["add", "-A"], s.wt.path);
				await git(["commit", "-q", "-m", "notes"], s.wt.path);
				await s.f.sup.pass();
				expect(s.f.host.killed).toEqual([]);
				expect((await s.f.registry.get(s.run.id))?.scopeSample).toMatchObject({
					files: 1,
					outside: 1,
					foreign: 0,
					level: "warn",
					outsideFiles: ["docs/notes.md"],
				});
			} finally {
				await s.f.cleanup();
			}
		},
		SCOPE_TEST_MS,
	);

	test(
		"a failed sample never kills and is retried",
		async () => {
			let fail = true;
			const s = await scopeFixture(
				{ scope: { sampleMs: 1000 } },
				{
					scopeFiles: async () => {
						if (fail) throw new Error("index.lock: worktree mid-rewrite");
						return { files: ["src/other/x.ts"], truncated: false };
					},
				},
			);
			try {
				await s.f.sup.pass();
				expect(s.f.host.killed).toEqual([]);
				expect((await s.f.registry.get(s.run.id))?.scopeSample).toBeNull();
				fail = false;
				await s.f.sup.pass(); // the failure recorded no throttle entry
				expect(s.f.host.killed[0]?.reason).toBe("watchdog-scope");
			} finally {
				await s.f.cleanup();
			}
		},
		SCOPE_TEST_MS,
	);

	test(
		"sampling is throttled to sampleMs and gated on new transcript output",
		async () => {
			let calls = 0;
			const s = await scopeFixture(
				{ scope: { sampleMs: 30_000 } },
				{
					scopeFiles: async () => {
						calls++;
						return { files: ["src/mine/a.ts"], truncated: false };
					},
				},
			);
			try {
				await s.f.sup.pass();
				expect(calls).toBe(1);
				s.f.now.value += 5_000;
				await Bun.sleep(5); // a distinct mtime
				await s.progress();
				await s.f.sup.pass(); // too soon
				expect(calls).toBe(1);
				s.f.now.value += 30_000;
				await s.f.sup.pass(); // due, and the transcript moved since the sample
				expect(calls).toBe(2);
				s.f.now.value += 60_000;
				await s.f.sup.pass(); // due, but nothing new happened
				expect(calls).toBe(2);
			} finally {
				await s.f.cleanup();
			}
		},
		SCOPE_TEST_MS,
	);

	test(
		"setLimits applies at the next pass: warn mode samples but never kills",
		async () => {
			const s = await scopeFixture();
			try {
				s.f.sup.setLimits({ idleMs: 0, wallMs: 0, scope: { mode: "warn" } });
				await s.write("src/other/x.ts");
				await s.f.sup.pass();
				expect(s.f.host.killed).toEqual([]);
				expect((await s.f.registry.get(s.run.id))?.scopeSample).toMatchObject({
					foreign: 1,
					level: "violation",
				});
			} finally {
				await s.f.cleanup();
			}
		},
		SCOPE_TEST_MS,
	);

	test(
		"remote runs are not sampled",
		async () => {
			let calls = 0;
			const f = await fixture({ idleMs: 0, wallMs: 0 }, {
				scopeFiles: async () => {
					calls++;
					return { files: [], truncated: false };
				},
				execution: {
					observeRun: async () => ({ state: "running" as const }),
					killRun: async () => {},
					finalizeExecutionTarget: async () => ({ collectionError: null }),
				},
			} as never);
			try {
				const run = await f.registry.create({
					kind: "task",
					label: "t",
					model: "sonnet",
					cwd: f.root,
					worktreePath: join(f.root, "wt"),
					branch: "mfw/x",
					baseSha: "0".repeat(40),
					executionTarget: "runpod",
				});
				await f.registry.transition(run.id, "running");
				await f.sup.pass();
				expect(calls).toBe(0);
			} finally {
				await f.cleanup();
			}
		},
		SCOPE_TEST_MS,
	);
});

describe("Supervisor: live usage sampling (run.usage_sampled)", () => {
	async function usageEvents(f: Fixture, runId: string) {
		const rows = await f.handle.client.execute({
			sql: "SELECT payload FROM events WHERE type = 'run.usage_sampled' AND run_id = ? ORDER BY seq",
			args: [runId],
		});
		return rows.rows.map((r) => JSON.parse(String(r.payload)));
	}

	test("at most one event per 30 s per run, patches usage_live, leaves the final usage alone", async () => {
		const f = await fixture();
		try {
			const run = await seedRun(f, { state: "running" });
			f.host.alive.add(run.id);
			const dir = f.registry.runDir(run.id);
			await mkdir(dir, { recursive: true });
			const usage = (inputTokens: number, costUsd: number) =>
				writeFile(
					join(dir, "events.jsonl"),
					line(1, { type: "usage", inputTokens, outputTokens: 5, costUsd }),
					{ flag: "a" },
				);

			await usage(100, 0.01);
			await f.sup.pass();
			expect(await usageEvents(f, run.id)).toEqual([
				{ tokensIn: 100, tokensOut: 5, costUsd: 0.01 },
			]);
			const row = await f.registry.get(run.id);
			expect(row?.usageLive).toEqual({
				inputTokens: 100,
				outputTokens: 5,
				costUsd: 0.01,
			});
			expect(row?.usage ?? null).toBeNull();

			// New numbers inside the window: no second event.
			await usage(200, 0.02);
			f.now.value += 10_000;
			await f.sup.pass();
			expect(await usageEvents(f, run.id)).toHaveLength(1);

			// Past the window the newest total goes out.
			f.now.value += 25_000;
			await f.sup.pass();
			expect(await usageEvents(f, run.id)).toEqual([
				{ tokensIn: 100, tokensOut: 5, costUsd: 0.01 },
				{ tokensIn: 200, tokensOut: 5, costUsd: 0.02 },
			]);

			// Nothing changed: no event even after another window.
			f.now.value += 60_000;
			await f.sup.pass();
			expect(await usageEvents(f, run.id)).toHaveLength(2);
		} finally {
			await f.cleanup();
		}
	});
});

describe("Supervisor: subagents (run_subagents, U7-02)", () => {
	test("a live run's Agent calls become rows and one event per start and finish", async () => {
		const f = await fixture();
		try {
			const run = await seedRun(f, { state: "running" });
			f.host.alive.add(run.id);
			const dir = f.registry.runDir(run.id);
			await mkdir(dir, { recursive: true });
			const append = (text: string) =>
				writeFile(join(dir, "events.jsonl"), text, { flag: "a" });
			const rows = async () =>
				(
					await f.handle.client.execute({
						sql: "SELECT tool_use_id, status, tools FROM run_subagents WHERE run_id = ?",
						args: [run.id],
					})
				).rows.map((r) => [
					r.tool_use_id,
					r.status,
					JSON.parse(String(r.tools)),
				]);
			const changed = async () =>
				(
					await f.handle.client.execute({
						sql: "SELECT payload FROM events WHERE type = 'run.subagents_changed' AND run_id = ? ORDER BY seq",
						args: [run.id],
					})
				).rows.map((r) => JSON.parse(String(r.payload)));

			await append(
				line(1, {
					type: "tool_call",
					id: "ag1",
					name: "Agent",
					input: { description: "look", subagent_type: "Explore" },
				}) +
					line(2, {
						type: "tool_call",
						id: "s1",
						name: "Read",
						input: {},
						parent: { toolUseId: "ag1" },
					}),
			);
			await f.sup.pass();
			expect(await rows()).toEqual([["ag1", "running", { Read: 1 }]]);
			expect(await changed()).toEqual([{ total: 1, running: 1 }]);

			await append(
				line(3, { type: "tool_result", id: "ag1", ok: true, output: "done" }),
			);
			await f.sup.pass();
			expect(await rows()).toEqual([["ag1", "ok", { Read: 1 }]]);
			expect(await changed()).toEqual([
				{ total: 1, running: 1 },
				{ total: 1, running: 0 },
			]);

			// Nothing new: no further event.
			f.now.value += 60_000;
			await f.sup.pass();
			expect(await changed()).toHaveLength(2);
		} finally {
			await f.cleanup();
		}
	});
});
