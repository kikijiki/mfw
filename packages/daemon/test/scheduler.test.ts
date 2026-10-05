import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Priority as TaskPriority } from "@mfw/core/types";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { engineKv, events, resourceSlots, resources } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import type { HostAdmissionSnapshot } from "../src/host-resources/index.ts";
import { silentLogger } from "../src/log.ts";
import { RunRegistry } from "../src/run-registry.ts";
import {
	type DispatchPlanInput,
	type DispatchPlanner,
	Scheduler,
	SlotConflictError,
} from "../src/scheduler.ts";
import type { TaskService } from "../src/task-service.ts";
import { makeTasks } from "./fixtures/board.ts";

/** RunEngine double: claims the task and creates a real `runs` row (for the slot FK and concurrency count). No tmux/git. */
class FakeEngine {
	calls: string[] = [];
	admissionIntegrated = false;
	hostSnapshot: HostAdmissionSnapshot | undefined;
	hostSnapshotsSeen: Array<HostAdmissionSnapshot | undefined> = [];
	captureCalls = 0;
	runIds = new Map<string, string>();
	/** Task ids whose start should throw. */
	failOn = new Set<string>();
	delayMs = 0;
	concurrent = 0;
	maxConcurrent = 0;

	constructor(
		private readonly registry: RunRegistry,
		private readonly tasks: TaskService,
		private readonly cwd: string,
	) {}

	captureAdmissionSnapshot(): HostAdmissionSnapshot | undefined {
		this.captureCalls++;
		return this.hostSnapshot;
	}

	async startTask(
		taskId: string,
		opts?: { model?: string; hostSnapshot?: HostAdmissionSnapshot },
	): Promise<{ runId: string }> {
		this.concurrent++;
		this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
		try {
			this.calls.push(taskId);
			this.hostSnapshotsSeen.push(opts?.hostSnapshot);
			if (this.delayMs) await Bun.sleep(this.delayMs);
			if (this.failOn.has(taskId)) throw new Error(`start failed: ${taskId}`);
			const run = await this.registry.create({
				kind: "task",
				taskId,
				label: taskId,
				model: "sonnet",
				cwd: this.cwd,
			});
			await this.registry.transition(run.id, "running");
			if (!(await this.tasks.tryClaim(taskId, run.id, 60_000)))
				throw new Error(`task ${taskId} is not claimable`);
			this.runIds.set(taskId, run.id);
			return { runId: run.id };
		} finally {
			this.concurrent--;
		}
	}
}

interface Fixture {
	root: string;
	handle: ProjectDbHandle;
	registry: RunRegistry;
	tasks: TaskService;
	engine: FakeEngine;
	sched: Scheduler;
	now: { value: number };
	seed: (over?: SeedOpts) => Promise<string>;
	resource: (id: string, maxConcurrent: number) => Promise<void>;
	/** Park a slot under a throwaway run row (simulates another run holding it). */
	occupy: (resourceId: string, slot: number) => Promise<string>;
	eventTypes: () => Promise<string[]>;
	slotRows: () => Promise<
		{ resourceId: string; slot: number; runId: string }[]
	>;
	cleanup: () => Promise<void>;
}

interface SeedOpts {
	title?: string;
	priority?: TaskPriority;
	status?: "backlog" | "ready";
	labels?: string[];
	requiresResources?: string[];
	dependsOn?: string[];
	owns?: string[];
	withDod?: boolean;
	body?: string;
}

async function fixture(
	config: {
		maxConcurrent?: number;
		maintenanceEveryNTicks?: number;
		selfRepairMainRed?: boolean;
	} = {},
	maintenance?: () => Promise<void>,
	/** The machine-wide master stop, as boot injects it. */
	globalPaused?: () => { reason: string } | null,
	dispatchPlanner?: DispatchPlanner,
): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "mfw-sched-"));
	const mfwDir = join(root, ".mfw");
	const handle = await openProjectDb(mfwDir);
	const bus = new EventBus();
	const registry = new RunRegistry({
		handle,
		bus,
		runsDir: join(mfwDir, "runs"),
	});
	const tasks = await makeTasks(handle, bus, mfwDir);
	const engine = new FakeEngine(registry, tasks, root);
	const now = { value: Date.now() };
	const sched = new Scheduler({
		handle,
		bus,
		tasks,
		engine,
		registry,
		log: silentLogger(),
		config: { maxConcurrent: config.maxConcurrent ?? 5, ...config },
		maintenance,
		globalPaused,
		dispatchPlanner,
		now: () => now.value,
	});

	return {
		root,
		handle,
		registry,
		tasks,
		engine,
		sched,
		now,
		seed: async (over: SeedOpts = {}) => {
			const t = await tasks.create({
				title: over.title ?? "t",
				body: over.body ?? (over.withDod ? "specified goal" : ""),
				priority: over.priority ?? "medium",
				status: over.status ?? "ready",
				labels: over.labels ?? [],
				requiresResources: over.requiresResources ?? [],
				dependsOn: over.dependsOn ?? [],
				owns: over.owns ?? [],
				dod: over.withDod
					? {
							verifier: "deterministic",
							checks: [{ run: "true", expect_exit: 0 }],
						}
					: null,
			});
			return t.id;
		},
		resource: async (id, maxConcurrent) => {
			await handle.db.insert(resources).values({
				id,
				name: id,
				type: "fixed",
				cost: "free",
				maxConcurrent,
				createdAt: new Date(),
			});
		},
		occupy: async (resourceId, slot) => {
			const run = await registry.create({
				kind: "task",
				label: "squatter",
				model: "sonnet",
				cwd: root,
			});
			await handle.db
				.insert(resourceSlots)
				.values({ resourceId, slot, runId: run.id, lockedAt: new Date() });
			return run.id;
		},
		eventTypes: async () =>
			(await handle.db.select().from(events)).map((e) => e.type),
		slotRows: async () =>
			(await handle.db.select().from(resourceSlots)).map((r) => ({
				resourceId: r.resourceId,
				slot: r.slot,
				runId: r.runId,
			})),
		cleanup: async () => {
			await sched.stop();
			handle.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

describe("Scheduler v2: picking", () => {
	test("does not ask the brain when an idle frontier has only one possible run", async () => {
		let calls = 0;
		const planner: DispatchPlanner = {
			planDispatch: async () => {
				calls++;
				throw new Error("there is no parallel decision to make");
			},
		};
		const f = await fixture(
			{ maxConcurrent: 8 },
			undefined,
			undefined,
			planner,
		);
		const only = await f.seed({ title: "only ready task" });

		const stats = await f.sched.tick();
		expect(stats.started).toEqual([only]);
		expect(stats.planning).toBe("not_needed");
		expect(calls).toBe(0);
		await f.cleanup();
	});

	test("the brain chooses which task goes first even when the maximum is one", async () => {
		let calls = 0;
		let second = "";
		const planner: DispatchPlanner = {
			planDispatch: async (input) => {
				calls++;
				expect(input.maxToStart).toBe(1);
				return {
					status: "ok",
					selectedTaskIds: [second],
					reason: "the second task is safer to do first",
				};
			},
		};
		const f = await fixture(
			{ maxConcurrent: 1 },
			undefined,
			undefined,
			planner,
		);
		await f.seed({ title: "first by creation order" });
		second = await f.seed({ title: "chosen by the brain" });

		const stats = await f.sched.tick();
		expect(stats.started).toEqual([second]);
		expect(stats.planning).toBe("brain");
		expect(calls).toBe(1);
		await f.cleanup();
	});

	test("the brain chooses the wave below the hard maximum", async () => {
		const calls: DispatchPlanInput[] = [];
		let selected: string[] = [];
		const planner: DispatchPlanner = {
			planDispatch: async (input) => {
				calls.push(input);
				return {
					status: "ok",
					selectedTaskIds: selected,
					reason: "these tasks have disjoint scope",
				};
			},
		};
		const f = await fixture(
			{ maxConcurrent: 4 },
			undefined,
			undefined,
			planner,
		);
		const first = await f.seed({ title: "first", labels: ["frontend"] });
		await f.seed({ title: "second", labels: ["frontend"] });
		const third = await f.seed({
			title: "third",
			labels: ["backend"],
			requiresResources: ["gpu"],
		});
		selected = [first, third];

		const stats = await f.sched.tick();
		expect(stats.started).toEqual([first, third]);
		expect(stats.planning).toBe("brain");
		expect(stats.planReason).toContain("disjoint scope");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.maxToStart).toBe(4);
		expect(calls[0]?.candidates[2]).toMatchObject({
			id: third,
			labels: ["backend"],
			requiresResources: ["gpu"],
		});
		await f.cleanup();
	});

	test("a failed brain decision degrades to serial work and never fills the cap", async () => {
		const planner: DispatchPlanner = {
			planDispatch: async () => ({
				status: "failed",
				selectedTaskIds: [],
				reason: "model unavailable",
			}),
		};
		const f = await fixture(
			{ maxConcurrent: 4 },
			undefined,
			undefined,
			planner,
		);
		for (let index = 0; index < 4; index++) {
			await f.seed({ title: `fallback-${index}` });
		}

		const first = await f.sched.tick();
		expect(first.started).toHaveLength(1);
		expect(first.planning).toBe("fallback");
		expect(first.planReason).toContain("conservative serial fallback");
		const second = await f.sched.tick();
		expect(second.started).toEqual([]);
		expect(second.planning).toBe("fallback");
		await f.cleanup();
	});

	test("resource admission remains authoritative after a brain selection", async () => {
		const planner: DispatchPlanner = {
			planDispatch: async (input) => ({
				status: "ok",
				selectedTaskIds: input.candidates.map((task) => task.id),
				reason: "attempt the ready wave",
			}),
		};
		const f = await fixture(
			{ maxConcurrent: 3 },
			undefined,
			undefined,
			planner,
		);
		await f.resource("gpu", 1);
		const first = await f.seed({ title: "gpu-a", requiresResources: ["gpu"] });
		const second = await f.seed({
			title: "gpu-b",
			requiresResources: ["gpu"],
		});

		const stats = await f.sched.tick();
		expect(stats.started).toEqual([first]);
		expect(stats.heldForResource).toEqual([second]);
		expect(await f.slotRows()).toHaveLength(1);
		await f.cleanup();
	});

	test("integrated admission captures once and passes one snapshot to the entire candidate wave", async () => {
		const f = await fixture({ maxConcurrent: 3 });
		for (let index = 0; index < 3; index++) {
			await f.seed({ title: `snapshot-${index}` });
		}
		const snapshot: HostAdmissionSnapshot = {
			generation: 41n,
			capturedAt: 1_000,
			processBootId: "process-a",
			kernelBootId: "kernel-a",
			definitions: {},
			bindings: {},
			health: {},
			observations: {},
		};
		f.engine.admissionIntegrated = true;
		f.engine.hostSnapshot = snapshot;

		const stats = await f.sched.tick();
		expect(stats.started).toHaveLength(3);
		expect(f.engine.captureCalls).toBe(1);
		expect(f.engine.hostSnapshotsSeen).toEqual([snapshot, snapshot, snapshot]);
		expect(f.engine.hostSnapshotsSeen.every((item) => item === snapshot)).toBe(
			true,
		);
		await f.cleanup();
	});

	test("the concurrency cap is respected", async () => {
		const f = await fixture({ maxConcurrent: 2 });
		for (let i = 0; i < 5; i++) await f.seed({ title: `t${i}` });

		const stats = await f.sched.tick();
		expect(stats.ready).toBe(5);
		expect(stats.started.length).toBe(2);
		expect(f.engine.calls.length).toBe(2);

		const second = await f.sched.tick();
		expect(second.inFlight).toBe(2);
		expect(second.capped).toBe(true);
		expect(f.engine.calls.length).toBe(2);
		await f.cleanup();
	});

	test("priority rank beats creation order", async () => {
		const f = await fixture({ maxConcurrent: 1 });
		await f.seed({ title: "meh", priority: "medium" });
		const critical = await f.seed({ title: "now", priority: "critical" });

		const stats = await f.sched.tick();
		expect(stats.started).toEqual([critical]);
		await f.cleanup();
	});

	test("ties break on task number, oldest first", async () => {
		const f = await fixture({ maxConcurrent: 1 });
		const first = await f.seed({ title: "a", priority: "high" });
		await f.seed({ title: "b", priority: "high" });

		expect((await f.sched.tick()).started).toEqual([first]);
		await f.cleanup();
	});

	test("a task whose dependency is not done is never dispatched", async () => {
		const f = await fixture();
		const dep = await f.seed({ title: "dep", status: "backlog" });
		const blocked = await f.seed({ title: "blocked", dependsOn: [dep] });

		const started = (await f.sched.tick()).started;
		expect(started).not.toContain(blocked);
		expect(f.engine.calls).toEqual([]);

		await f.tasks.move(dep, "done", "human");
		expect((await f.sched.tick()).started).toEqual([blocked]);
		await f.cleanup();
	});

	// Guards against a label-based co-scheduling heuristic returning: real
	// contention is declared with `requires_resources` (see semaphore tests).
	test("labels do not gate co-scheduling: only resources and the cap do", async () => {
		const f = await fixture({ maxConcurrent: 5 });
		const a = await f.seed({ title: "a", labels: ["db"] });
		const b = await f.seed({ title: "b", labels: ["db"] });
		const c = await f.seed({ title: "c", labels: ["db"] });

		const stats = await f.sched.tick();
		expect(stats.started.sort()).toEqual([a, b, c].sort());
		await f.cleanup();
	});

	test("the DoR gate promotes and the SAME tick dispatches", async () => {
		const f = await fixture();
		const t = await f.seed({ title: "dor", status: "backlog", withDod: true });

		const stats = await f.sched.tick();
		expect(stats.promoted).toBe(1);
		expect(stats.started).toEqual([t]);
		expect((await f.tasks.get(t))?.status).toBe("in_progress");
		await f.cleanup();
	});
});

describe("Scheduler: declared ownership (owns)", () => {
	test("a held priority leader does not consume the only free slot", async () => {
		const f = await fixture({ maxConcurrent: 2 });
		const running = await f.seed({ owns: ["src/a"] });
		expect((await f.sched.tick()).started).toEqual([running]);
		const held = await f.seed({ priority: "high", owns: ["src/a/**"] });
		const independent = await f.seed({ priority: "low", owns: ["src/b"] });
		const stats = await f.sched.tick();
		expect(stats.started).toEqual([independent]);
		expect(stats.heldForOverlap).toEqual([held]);
		await f.cleanup();
	});

	test("without a planner, skips intra-wave conflicts until capacity is filled", async () => {
		const f = await fixture({ maxConcurrent: 2 });
		const first = await f.seed({ priority: "high", owns: ["src/a"] });
		const held = await f.seed({ priority: "high", owns: ["src/a/**"] });
		const independent = await f.seed({ priority: "low", owns: ["src/b"] });
		const stats = await f.sched.tick();
		expect(stats.started).toEqual([first, independent]);
		expect(stats.heldForOverlap).toEqual([held]);
		await f.cleanup();
	});

	test("filters running overlaps before the planner frontier and honors its subset", async () => {
		const seen: DispatchPlanInput[] = [];
		const f = await fixture({ maxConcurrent: 2 }, undefined, undefined, {
			async planDispatch(input) {
				seen.push(input);
				return { status: "ok", selectedTaskIds: [], reason: "hold for review" };
			},
		});
		const running = await f.seed({ owns: ["src/a"] });
		expect((await f.sched.tick()).started).toEqual([running]);
		const held = await f.seed({ priority: "high", owns: ["src/a/**"] });
		const independent = await f.seed({ priority: "low", owns: ["src/b"] });
		const stats = await f.sched.tick();
		expect(seen[0]?.candidates.map((task) => task.id)).toEqual([independent]);
		expect(stats.started).toEqual([]);
		expect(stats.heldForOverlap).toEqual([held]);
		await f.cleanup();
	});

	test("a candidate overlapping a running task is held and the hold is announced once", async () => {
		const f = await fixture({ maxConcurrent: 5 });
		const running = await f.seed({ title: "running", owns: ["src/api"] });
		expect((await f.sched.tick()).started).toEqual([running]);

		const held = await f.seed({ title: "held", owns: ["src/api/**/*.ts"] });
		const stats = await f.sched.tick();
		expect(stats.started).toEqual([]);
		expect(stats.heldForOverlap).toEqual([held]);
		expect(stats.heldForResource).toEqual([]);
		expect(f.engine.calls).not.toContain(held);

		const holds = (await f.handle.db.select().from(events)).filter(
			(e) => e.type === "task.held_for_resource",
		);
		expect(holds).toHaveLength(1);
		expect(holds[0]?.taskId).toBe(held);
		const payload = holds[0]?.payload as {
			waitingFor: string[];
			code?: string;
			reason?: string;
		};
		expect(payload.waitingFor).toEqual([running]);
		expect(payload.code).toBe("owns-overlap");
		expect(payload.reason).toContain("src/api/**/*.ts");
		expect(payload.reason).toContain("src/api");

		// Same hold on the next tick: not re-announced.
		expect((await f.sched.tick()).heldForOverlap).toEqual([held]);
		expect(
			(await f.eventTypes()).filter((t) => t === "task.held_for_resource"),
		).toHaveLength(1);
		await f.cleanup();
	});

	test("two overlapping candidates in one wave: only the higher priority starts", async () => {
		const f = await fixture({ maxConcurrent: 5 });
		const low = await f.seed({ title: "low", priority: "low", owns: ["a.ts"] });
		const high = await f.seed({
			title: "high",
			priority: "high",
			owns: ["a.ts", "b.ts"],
		});

		const stats = await f.sched.tick();
		expect(stats.started).toEqual([high]);
		expect(stats.heldForOverlap).toEqual([low]);
		await f.cleanup();
	});

	test("the overlap hold also applies under integrated admission", async () => {
		const f = await fixture({ maxConcurrent: 5 });
		const first = await f.seed({ title: "first", owns: ["pkg"] });
		const second = await f.seed({ title: "second", owns: ["pkg/x.ts"] });
		f.engine.admissionIntegrated = true;
		f.engine.hostSnapshot = {
			generation: 1n,
			capturedAt: 1_000,
			processBootId: "p",
			kernelBootId: "k",
			definitions: {},
			bindings: {},
			health: {},
			observations: {},
		};

		const stats = await f.sched.tick();
		expect(stats.started).toEqual([first]);
		expect(stats.heldForOverlap).toEqual([second]);
		await f.cleanup();
	});

	test("disjoint owns both start", async () => {
		const f = await fixture({ maxConcurrent: 5 });
		const a = await f.seed({ title: "a", owns: ["src/api"] });
		const b = await f.seed({ title: "b", owns: ["src/ui"] });

		const stats = await f.sched.tick();
		expect(stats.started.sort()).toEqual([a, b].sort());
		expect(stats.heldForOverlap).toEqual([]);
		await f.cleanup();
	});

	test("empty owns is unconstrained, beside a running owner and another empty one", async () => {
		const f = await fixture({ maxConcurrent: 5 });
		const owner = await f.seed({ title: "owner", owns: ["**"] });
		expect((await f.sched.tick()).started).toEqual([owner]);
		const x = await f.seed({ title: "x" });
		const y = await f.seed({ title: "y" });

		const stats = await f.sched.tick();
		expect(stats.started.sort()).toEqual([x, y].sort());
		expect(stats.heldForOverlap).toEqual([]);
		await f.cleanup();
	});
});

describe("Scheduler v2: resource semaphore", () => {
	test("maxConcurrent 2 really grants TWO holders (the v1 mutex bug)", async () => {
		const f = await fixture({ maxConcurrent: 5 });
		await f.resource("gpu", 2);
		const a = await f.seed({ title: "a", requiresResources: ["gpu"] });
		const b = await f.seed({ title: "b", requiresResources: ["gpu"] });
		const c = await f.seed({ title: "c", requiresResources: ["gpu"] });

		const stats = await f.sched.tick();
		expect(stats.started).toEqual([a, b]);
		expect(stats.heldForResource).toEqual([c]);
		expect(f.engine.calls).not.toContain(c);

		const slots = await f.slotRows();
		expect(slots.length).toBe(2);
		expect(slots.map((s) => s.slot).sort()).toEqual([0, 1]);
		expect(await f.eventTypes()).toContain("task.held_for_resource");
		expect(await f.eventTypes()).toContain("resource.locked");
		await f.cleanup();
	});

	test("maxConcurrent 1 admits exactly one", async () => {
		const f = await fixture({ maxConcurrent: 5 });
		await f.resource("serial", 1);
		const a = await f.seed({ title: "a", requiresResources: ["serial"] });
		const b = await f.seed({ title: "b", requiresResources: ["serial"] });

		const stats = await f.sched.tick();
		expect(stats.started).toEqual([a]);
		expect(stats.heldForResource).toEqual([b]);
		expect((await f.slotRows()).length).toBe(1);
		await f.cleanup();
	});

	test("an unknown resource id imposes no constraint", async () => {
		const f = await fixture();
		const a = await f.seed({ title: "a", requiresResources: ["nope"] });
		expect((await f.sched.tick()).started).toEqual([a]);
		expect((await f.slotRows()).length).toBe(0);
		await f.cleanup();
	});

	test("ALL-OR-NOTHING: one free + one full acquires neither", async () => {
		const f = await fixture();
		await f.resource("free", 1);
		await f.resource("busy", 1);
		await f.occupy("busy", 0);
		const t = await f.seed({
			title: "both",
			requiresResources: ["free", "busy"],
		});

		const stats = await f.sched.tick();
		expect(stats.started).toEqual([]);
		expect(stats.heldForResource).toEqual([t]);
		// no partial hold on the free resource
		expect((await f.slotRows()).filter((s) => s.resourceId === "free")).toEqual(
			[],
		);
		await f.cleanup();
	});

	test("ALL-OR-NOTHING: a lost race rolls the whole acquisition back", async () => {
		const f = await fixture();
		await f.resource("pool", 2);
		await f.occupy("pool", 1);
		const run = await f.registry.create({
			kind: "task",
			label: "mine",
			model: "sonnet",
			cwd: f.root,
		});

		await expect(
			f.sched.acquireSlots(run.id, [
				{ resourceId: "pool", slot: 0 },
				{ resourceId: "pool", slot: 1 },
			]),
		).rejects.toBeInstanceOf(SlotConflictError);
		// slot 0 was inserted first; rollback must undo it
		expect(await f.sched.heldSlots(run.id)).toEqual([]);
		await f.cleanup();
	});

	test("releaseSlots frees capacity for the next tick", async () => {
		const f = await fixture({ maxConcurrent: 5 });
		await f.resource("serial", 1);
		const a = await f.seed({ title: "a", requiresResources: ["serial"] });
		const b = await f.seed({ title: "b", requiresResources: ["serial"] });

		await f.sched.tick();
		const runA = f.engine.runIds.get(a) as string;
		expect((await f.sched.tick()).started).toEqual([]); // still held

		const freed = await f.sched.releaseSlots(runA);
		expect(freed).toBe(1);
		expect(await f.eventTypes()).toContain("resource.released");

		expect((await f.sched.tick()).started).toEqual([b]);
		expect((await f.slotRows()).map((s) => s.runId)).toEqual([
			f.engine.runIds.get(b) as string,
		]);
		await f.cleanup();
	});
});

describe("Scheduler v2: gates", () => {
	test("pause blocks dispatch and records its reason", async () => {
		const f = await fixture();
		await f.seed({ title: "a" });
		await f.sched.setEnabled(false, "operator");

		const stats = await f.sched.tick();
		expect(stats.skipped).toBe("paused");
		expect(stats.reason).toBe("operator");
		expect(f.engine.calls).toEqual([]);
		expect(await f.sched.isPaused()).toBe(true);
		expect((await f.sched.status()).enabled).toBe(false);
		expect(await f.eventTypes()).toContain("scheduler.paused");

		await f.sched.setEnabled(true);
		expect((await f.sched.tick()).started.length).toBe(1);
		expect(await f.eventTypes()).toContain("scheduler.resumed");
		await f.cleanup();
	});

	test("a live dispatch hold blocks; an elapsed one does not", async () => {
		const f = await fixture();
		await f.seed({ title: "a" });
		await f.sched.hold(f.now.value + 60_000, "rate-limited");

		const held = await f.sched.tick();
		expect(held.skipped).toBe("hold");
		expect(held.reason).toBe("rate-limited");
		expect(f.engine.calls).toEqual([]);
		expect((await f.sched.status()).hold?.until).toBe(f.now.value + 60_000);

		f.now.value += 61_000;
		const after = await f.sched.tick();
		expect(after.skipped).toBeNull();
		expect(after.started.length).toBe(1);
		expect((await f.sched.status()).hold).toBeNull();
		await f.cleanup();
	});

	test("hold keeps the FURTHEST until: a short hold never shortens a long one", async () => {
		const f = await fixture();
		await f.sched.hold(f.now.value + 5_000, "long");
		await f.sched.hold(f.now.value + 2_000, "short");

		const [row] = await f.handle.db
			.select()
			.from(engineKv)
			.where(eq(engineKv.key, "dispatch_hold"));
		expect((row?.value as { until: number; reason: string }).until).toBe(
			f.now.value + 5_000,
		);
		expect((row?.value as { reason: string }).reason).toBe("long");

		await f.sched.hold(f.now.value + 9_000, "longer");
		expect((await f.sched.status()).hold).toEqual({
			until: f.now.value + 9_000,
			reason: "longer",
		});
		await f.cleanup();
	});

	test("red main blocks dispatch", async () => {
		const f = await fixture();
		await f.seed({ title: "a" });
		await f.handle.db.insert(engineKv).values({
			key: "main_red",
			value: { red: true, since: f.now.value, causeTaskId: "MFW-1" },
			updatedAt: new Date(),
		});

		const stats = await f.sched.tick();
		expect(stats.skipped).toBe("main_red");
		expect(stats.reason).toContain("MFW-1");
		expect(f.engine.calls).toEqual([]);
		expect((await f.sched.status()).mainRed).toBe(true);

		await f.handle.db
			.update(engineKv)
			.set({ value: { red: false }, updatedAt: new Date() })
			.where(eq(engineKv.key, "main_red"));
		expect((await f.sched.tick()).started.length).toBe(1);
		await f.cleanup();
	});
});

// Self-repair exemption: off by default; when on, admits only the task the sweep named.
describe("Scheduler v2: self-repair exemption", () => {
	test("off by default: the cause task is blocked same as everything else", async () => {
		const f = await fixture();
		const cause = await f.seed({ title: "broke it" });
		await f.seed({ title: "unrelated" });
		await f.handle.db.insert(engineKv).values({
			key: "main_red",
			value: { red: true, since: f.now.value, causeTaskId: cause },
			updatedAt: new Date(),
		});

		const stats = await f.sched.tick();
		expect(stats.skipped).toBe("main_red");
		expect(stats.started).toEqual([]);
		expect(f.engine.calls).toEqual([]);
		await f.cleanup();
	});

	test("enabled: only the cause task dispatches; an unrelated ready task stays held", async () => {
		const f = await fixture({ selfRepairMainRed: true });
		const cause = await f.seed({ title: "broke it", priority: "low" });
		const other = await f.seed({ title: "unrelated", priority: "critical" });
		await f.handle.db.insert(engineKv).values({
			key: "main_red",
			value: { red: true, since: f.now.value, causeTaskId: cause },
			updatedAt: new Date(),
		});

		const stats = await f.sched.tick();
		expect(stats.skipped).toBeNull();
		expect(stats.started).toEqual([cause]);
		expect(f.engine.calls).toEqual([cause]);
		expect(f.engine.calls).not.toContain(other);
		await f.cleanup();
	});

	test("enabled but the cause task is not ready (already blocked): dispatches nothing", async () => {
		const f = await fixture({ selfRepairMainRed: true });
		const cause = await f.seed({ title: "past its stall cap" });
		await f.tasks.move(cause, "blocked", "verifier", "stall cap");
		await f.handle.db.insert(engineKv).values({
			key: "main_red",
			value: { red: true, since: f.now.value, causeTaskId: cause },
			updatedAt: new Date(),
		});

		const stats = await f.sched.tick();
		expect(stats.ready).toBe(0);
		expect(stats.started).toEqual([]);
		expect(f.engine.calls).toEqual([]);
		await f.cleanup();
	});

	test("enabled: status still reports main_red, and names the self-repair", async () => {
		const f = await fixture({ selfRepairMainRed: true });
		f.sched.start(60_000);
		const cause = await f.seed({ title: "broke it" });
		await f.handle.db.insert(engineKv).values({
			key: "main_red",
			value: { red: true, since: f.now.value, causeTaskId: cause },
			updatedAt: new Date(),
		});

		const status = await f.sched.status();
		expect(status.state).toBe("main_red");
		expect(status.selfStopped).toBe(true);
		expect(status.reason).toContain(cause);
		expect(status.reason).toContain("self-repair");
		await f.sched.stop();
		await f.cleanup();
	});

	test("a higher-precedence gate (pause) still wins over self-repair", async () => {
		const f = await fixture({ selfRepairMainRed: true });
		const cause = await f.seed({ title: "broke it" });
		await f.handle.db.insert(engineKv).values({
			key: "main_red",
			value: { red: true, since: f.now.value, causeTaskId: cause },
			updatedAt: new Date(),
		});
		await f.sched.setEnabled(false, "operator");

		const stats = await f.sched.tick();
		expect(stats.skipped).toBe("paused");
		expect(f.engine.calls).toEqual([]);
		await f.cleanup();
	});

	test("live toggle: setSelfRepairMainRed takes effect on the next tick", async () => {
		const f = await fixture();
		const cause = await f.seed({ title: "broke it" });
		await f.handle.db.insert(engineKv).values({
			key: "main_red",
			value: { red: true, since: f.now.value, causeTaskId: cause },
			updatedAt: new Date(),
		});

		expect((await f.sched.tick()).skipped).toBe("main_red");
		expect(f.engine.calls).toEqual([]);

		f.sched.setSelfRepairMainRed(true);
		expect((await f.sched.tick()).started).toEqual([cause]);
		await f.cleanup();
	});

	// `escalated`: the sweep already retried this cause past its threshold, so it
	// wins over `selfRepairMainRed` and a human must step in.
	test("escalated: the cause task is blocked same as everything else, even with self-repair on", async () => {
		const f = await fixture({ selfRepairMainRed: true });
		const cause = await f.seed({ title: "never gets fixed" });
		await f.handle.db.insert(engineKv).values({
			key: "main_red",
			value: {
				red: true,
				since: f.now.value,
				causeTaskId: cause,
				escalated: true,
			},
			updatedAt: new Date(),
		});

		const stats = await f.sched.tick();
		expect(stats.skipped).toBe("main_red");
		expect(stats.reason).toContain("needs a human");
		expect(stats.started).toEqual([]);
		expect(f.engine.calls).toEqual([]);
		expect((await f.sched.status()).mainRed).toBe(true);
		await f.cleanup();
	});
});

// `enabled` is only the persisted pause flag; status must also reflect whether the loop runs.
describe("Scheduler v2: status tells the truth about both switches", () => {
	test("a project whose loop was never started is STOPPED, not enabled", async () => {
		const f = await fixture();
		const status = await f.sched.status();
		expect(status.enabled).toBe(true);
		expect(status.running).toBe(false);
		expect(status.playing).toBe(false);
		expect(status.state).toBe("stopped");
		expect(status.reason).toBe("the dispatch loop is not running");
		expect(status.selfStopped).toBe(false);
		await f.cleanup();
	});

	test("starting the loop is what makes it dispatching; stopping it undoes that", async () => {
		const f = await fixture();
		f.sched.start(60_000);
		const playing = await f.sched.status();
		expect(playing.running).toBe(true);
		expect(playing.playing).toBe(true);
		expect(playing.state).toBe("dispatching");
		expect(playing.reason).toBeNull();

		await f.sched.stop();
		expect((await f.sched.status()).state).toBe("stopped");
		await f.cleanup();
	});

	test("a manual pause on a running loop reads as stopped, with the operator's reason", async () => {
		const f = await fixture();
		f.sched.start(60_000);
		await f.sched.setEnabled(false, "operator");

		const status = await f.sched.status();
		expect(status.running).toBe(true); // the loop is still there
		expect(status.enabled).toBe(false);
		expect(status.playing).toBe(false);
		expect(status.state).toBe("stopped");
		expect(status.reason).toBe("operator");
		expect(status.selfStopped).toBe(false);

		await f.sched.stop();
		// Both switches down: the reason names both.
		expect((await f.sched.status()).reason).toBe(
			"operator (and the dispatch loop is not running)",
		);
		await f.cleanup();
	});

	test("a rate-limit hold is NOT a manual stop, the project stays playing", async () => {
		const f = await fixture();
		f.sched.start(60_000);
		await f.sched.hold(f.now.value + 60_000, "rate-limited");

		const status = await f.sched.status();
		expect(status.playing).toBe(true); // the operator did not stop it
		expect(status.state).toBe("held");
		expect(status.selfStopped).toBe(true); // it stopped itself
		expect(status.reason).toBe("rate-limited");
		expect(status.hold?.until).toBe(f.now.value + 60_000);

		// and it clears itself, with nothing pressed
		f.now.value += 61_000;
		expect((await f.sched.status()).state).toBe("dispatching");
		await f.sched.stop();
		await f.cleanup();
	});

	test("a red main is the breaker, not a stop, and names the cause", async () => {
		const f = await fixture();
		f.sched.start(60_000);
		await f.handle.db.insert(engineKv).values({
			key: "main_red",
			value: { red: true, since: f.now.value, causeTaskId: "MFW-1" },
			updatedAt: new Date(),
		});

		const status = await f.sched.status();
		expect(status.playing).toBe(true);
		expect(status.state).toBe("main_red");
		expect(status.mainRed).toBe(true);
		expect(status.selfStopped).toBe(true);
		expect(status.reason).toContain("MFW-1");
		await f.sched.stop();
		await f.cleanup();
	});

	test("a suspended board is reported, and the loop agrees with the status", async () => {
		const f = await fixture();
		f.sched.start(60_000);
		// The board poller's circuit breaker; read from TaskService, not engine_kv.
		Object.defineProperty(f.tasks, "isBoardSuspended", {
			configurable: true,
			get: () => true,
		});

		const status = await f.sched.status();
		expect(status.boardSuspended).toBe(true);
		expect(status.state).toBe("board_suspended");
		expect(status.selfStopped).toBe(true);
		// The loop's gate must agree with status.
		expect((await f.sched.tick()).skipped).toBe("board");
		expect((await f.sched.tick()).reason).toBe(status.reason);
		await f.sched.stop();
		await f.cleanup();
	});

	test("an operator stop takes precedence over a gate the engine set itself", async () => {
		const f = await fixture();
		await f.sched.hold(f.now.value + 60_000, "rate-limited");
		// Loop never started and a hold is live: "stopped" is the switch play will move.
		const status = await f.sched.status();
		expect(status.state).toBe("stopped");
		expect(status.hold?.reason).toBe("rate-limited");
		await f.cleanup();
	});
});

describe("Scheduler v2: failure is surfaced, never swallowed", () => {
	test("a startTask failure is counted, logged, and the wave continues", async () => {
		const f = await fixture({ maxConcurrent: 5 });
		await f.resource("gpu", 1);
		const bad = await f.seed({
			title: "bad",
			priority: "critical",
			requiresResources: ["gpu"],
		});
		const good = await f.seed({ title: "good" });
		f.engine.failOn.add(bad);

		const stats = await f.sched.tick();
		expect(stats.errors).toBe(1);
		expect(stats.started).toEqual([good]);
		expect(f.engine.calls).toEqual([bad, good]);
		// the failed task leaked no slot
		expect((await f.slotRows()).length).toBe(0);
		expect(f.sched.stats.tickErrors).toBe(1);
		expect((await f.sched.status()).errors).toBe(1);

		f.engine.failOn.clear();
		expect((await f.sched.tick()).started).toEqual([bad]);
		expect((await f.slotRows()).length).toBe(1);
		await f.cleanup();
	});

	test("a maintenance failure is logged and counted, not swallowed", async () => {
		let calls = 0;
		const f = await fixture({ maintenanceEveryNTicks: 2 }, async () => {
			calls++;
			throw new Error("groom exploded");
		});
		await f.seed({ title: "a" });

		const first = await f.sched.tick();
		expect(first.maintenance).toBe(false);
		expect(calls).toBe(0);

		const second = await f.sched.tick();
		expect(second.maintenance).toBe(true);
		expect(second.errors).toBe(1);
		expect(calls).toBe(1);
		expect(first.started.length + second.started.length).toBe(1);
		await f.cleanup();
		// Headroom: the default 5s budget has blown under load from other tests.
	}, 15_000);

	test("maintenance runs even while a gate is blocking dispatch", async () => {
		let calls = 0;
		const f = await fixture({ maintenanceEveryNTicks: 1 }, async () => {
			calls++;
		});
		await f.seed({ title: "a" });
		await f.handle.db.insert(engineKv).values({
			key: "main_red",
			value: { red: true, since: f.now.value },
			updatedAt: new Date(),
		});

		// The regression sweep (in maintenance) clears main_red; gating it would wedge the breaker shut.
		const stats = await f.sched.tick();
		expect(stats.skipped).toBe("main_red");
		expect(calls).toBe(1);
		await f.cleanup();
	});
});

describe("Scheduler v2: the loop", () => {
	test("REENTRANCY: ticks are awaited, never overlapped", async () => {
		const f = await fixture({ maxConcurrent: 20 });
		for (let i = 0; i < 12; i++) await f.seed({ title: `t${i}` });
		f.engine.delayMs = 15; // tick is slower than the interval

		let inTick = 0;
		let maxInTick = 0;
		const real = f.sched.tick.bind(f.sched);
		// the loop calls `this.tick()`; an own property intercepts it
		(f.sched as unknown as { tick: () => Promise<unknown> }).tick =
			async () => {
				inTick++;
				maxInTick = Math.max(maxInTick, inTick);
				try {
					return await real();
				} finally {
					inTick--;
				}
			};

		f.sched.start(1);
		await Bun.sleep(300);
		await f.sched.stop();

		expect(maxInTick).toBe(1);
		expect(f.engine.maxConcurrent).toBe(1);
		await f.cleanup();
	});

	test("wake() shortens the sleep instead of starting a second dispatcher", async () => {
		const f = await fixture({ maxConcurrent: 5 });
		await f.seed({ title: "first" });
		f.sched.start(60_000);
		await Bun.sleep(50);
		expect(f.engine.calls.length).toBe(1);

		const later = await f.seed({ title: "later" });
		f.sched.wake(); // the UI's "dispatch now"
		await Bun.sleep(50);
		expect(f.engine.calls).toContain(later);

		await f.sched.stop();
		expect(f.sched.stats.lastTickAt).toBeGreaterThan(0);
		await f.cleanup();
	});

	test("stop() settles even when a tick threw", async () => {
		const f = await fixture();
		await f.seed({ title: "a" });
		f.engine.failOn.add("MFW-1");
		f.sched.start(5);
		await Bun.sleep(60);
		await f.sched.stop();
		expect(f.sched.stats.tickErrors).toBeGreaterThan(0);
		await f.cleanup();
	});
});

describe("resource slots are released when a run terminates", () => {
	test("capacity comes back without a manual releaseSlots call", async () => {
		const f = await fixture({ maxConcurrent: 4 });
		await f.handle.db.insert(resources).values({
			id: "gpu",
			name: "gpu",
			type: "fixed",
			cost: "paid",
			maxConcurrent: 1,
			createdAt: new Date(),
		});

		const mk = async (title: string) => {
			const t = await f.tasks.create({ title, requiresResources: ["gpu"] });
			await f.tasks.move(t.id, "ready", "human");
			return t;
		};
		const a = await mk("first");
		await mk("second");

		await f.sched.tick();
		expect(f.engine.calls.length).toBe(1); // the semaphore holds the second

		// terminate the holder the way the supervisor does, then release
		const runId = f.engine.runIds.get(a.id) as string;
		await f.registry.finish(runId, "completed");
		await f.sched.releaseSlots(runId);
		await f.tasks.release(a.id, runId, "done", "scheduler");

		await f.sched.tick();
		expect(f.engine.calls.length).toBe(2); // capacity really came back
		await f.cleanup();
	});
});

// The master stop is a third switch, ANDed with the project's two, so it never overwrites per-project settings.
describe("Scheduler: the machine-wide master stop", () => {
	const stopped = () => ({ reason: "mfw is stopped everywhere" });

	test("a project switched ON dispatches nothing while the master is off", async () => {
		const f = await fixture({}, undefined, stopped);
		try {
			await f.seed({ title: "t0" });
			await f.seed({ title: "t1" });
			await f.sched.setEnabled(true);

			const stats = await f.sched.tick();

			expect(stats.started).toEqual([]);
			expect(stats.skipped).toBe("global");
			expect(f.engine.calls).toEqual([]);
		} finally {
			await f.cleanup();
		}
	});

	test("status reports both switches, and `playing` is their AND", async () => {
		const f = await fixture({}, undefined, stopped);
		try {
			await f.sched.setEnabled(true);
			f.sched.start(60_000);
			const st = await f.sched.status();

			// The project's own switch is untouched (what the master restores to).
			expect(st.projectPlaying).toBe(true);
			expect(st.globalPlaying).toBe(false);
			expect(st.playing).toBe(false);
			expect(st.state).toBe("stopped_global");
			// Not a self-stop: the project's play button will not undo it.
			expect(st.selfStopped).toBe(false);
			expect(st.reason).toBe("mfw is stopped everywhere");
		} finally {
			await f.sched.stop();
			await f.cleanup();
		}
	});

	test("a project stopped on its own says so, and names the master too", async () => {
		const f = await fixture({}, undefined, stopped);
		try {
			await f.sched.setEnabled(false, "stopped from the UI");
			const st = await f.sched.status();

			// The nearer cause wins: this project stays stopped after the master returns.
			expect(st.state).toBe("stopped");
			expect(st.reason).toContain("stopped from the UI");
			// ...but the reason still mentions the master being off.
			expect(st.reason).toContain("stopped everywhere");
		} finally {
			await f.cleanup();
		}
	});

	test("with the master on, nothing changes for anyone", async () => {
		const f = await fixture({}, undefined, () => null);
		try {
			await f.seed({ title: "t0" });
			await f.sched.setEnabled(true);

			const stats = await f.sched.tick();
			const st = await f.sched.status();

			expect(stats.started).toHaveLength(1);
			expect(stats.skipped).toBeNull();
			expect(st.globalPlaying).toBe(true);
		} finally {
			await f.cleanup();
		}
	});
});
