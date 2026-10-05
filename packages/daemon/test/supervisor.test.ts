import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { engineKv } from "@mfw/db/schema";
import type { StepRunner } from "../src/finalize/step-runner.ts";
import { silentLogger } from "../src/log.ts";
import { RunRegistry } from "../src/run-registry.ts";
import { Supervisor } from "../src/supervisor.ts";
import type { TaskService } from "../src/task-service.ts";
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
	limits?: Partial<{ idleMs: number; wallMs: number; maxTurns: number }>,
	extra: Partial<{
		triggers: { dispatch(): Promise<unknown> };
		maintenance: () => Promise<void>;
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
		renewAdmission: (runId: string) => Promise<unknown>;
		releaseSlots: (runId: string) => Promise<unknown>;
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

	test("orphan tmux sessions with no run row are killed", async () => {
		const f = await fixture();
		f.host.alive.add("01ORPHANRUNIDNOTINDB0000000");
		const report = await f.sup.reconcile();
		expect(report.orphanSessionsKilled).toBe(1);
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
