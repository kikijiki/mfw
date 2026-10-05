import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus, type StoredEvent } from "@mfw/db/eventlog";
import { events, resourceSlots } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { silentLogger } from "../src/log.ts";
import { ResourceService } from "../src/resources.ts";
import { RunRegistry } from "../src/run-registry.ts";
import { Scheduler } from "../src/scheduler.ts";
import type { TaskService } from "../src/task-service.ts";
import { makeTasks } from "./fixtures/board.ts";

/**
 * Real DB, real scheduler, real slot rows. `forceRelease` is only meaningful
 * if it goes through the scheduler's release path, so the assertions are on
 * the emitted `resource.released` events, not just on row counts.
 */

interface Env {
	dir: string;
	handle: ProjectDbHandle;
	registry: RunRegistry;
	tasks: TaskService;
	sched: Scheduler;
	resources: ResourceService;
	seen: StoredEvent[];
	/** A run row holding the given slots (the FK requires a real run). */
	holder: (taskTitle: string, slots: number[]) => Promise<string>;
}

const envs: Env[] = [];

async function freshEnv(): Promise<Env> {
	const dir = await mkdtemp(join(tmpdir(), "mfw-res-"));
	const handle = await openProjectDb(dir);
	const bus = new EventBus();
	const seen: StoredEvent[] = [];
	bus.subscribe((e) => seen.push(e));
	const registry = new RunRegistry({ handle, bus, runsDir: join(dir, "runs") });
	const tasks = await makeTasks(handle, bus, dir);
	const sched = new Scheduler({
		handle,
		bus,
		tasks,
		registry,
		// The dispatch loop is never started here; only the slot API is used.
		engine: {
			startTask: () => Promise.reject(new Error("not dispatched in this test")),
		},
		log: silentLogger(),
		config: { maxConcurrent: 4 },
	});
	const env: Env = {
		dir,
		handle,
		registry,
		tasks,
		sched,
		resources: new ResourceService({ handle, scheduler: sched }),
		seen,
		holder: async (taskTitle, slots) => {
			const task = await tasks.create({ title: taskTitle });
			const run = await registry.create({
				kind: "task",
				taskId: task.id,
				label: task.id,
				model: "sonnet",
				cwd: dir,
			});
			await sched.acquireSlots(
				run.id,
				slots.map((slot) => ({ resourceId: "gpu", slot })),
			);
			return run.id;
		},
	};
	envs.push(env);
	return env;
}

afterEach(async () => {
	for (const env of envs.splice(0)) {
		env.handle.close();
		await rm(env.dir, { recursive: true, force: true });
	}
});

const released = (seen: StoredEvent[]) =>
	seen.filter((e) => e.type === "resource.released");

describe("list", () => {
	test("shows definitions, holders and remaining capacity", async () => {
		const env = await freshEnv();
		expect(await env.resources.list()).toEqual([]);

		await env.resources.register({
			id: "gpu",
			name: "local GPU",
			cost: "paid",
			maxConcurrent: 2,
		});
		const idle = await env.resources.list();
		expect(idle).toHaveLength(1);
		expect(idle[0]).toMatchObject({
			id: "gpu",
			name: "local GPU",
			type: "fixed",
			cost: "paid",
			maxConcurrent: 2,
			free: 2,
		});
		expect(idle[0]?.holders).toEqual([]);

		const runId = await env.holder("needs the gpu", [0]);
		const held = await env.resources.list();
		expect(held[0]?.free).toBe(1);
		expect(held[0]?.holders).toHaveLength(1);
		expect(held[0]?.holders[0]).toMatchObject({
			slot: 0,
			runId,
			taskId: "MFW-1",
			label: "MFW-1",
			state: "starting",
		});

		// Re-registering updates the definition instead of failing on the PK.
		await env.resources.register({ id: "gpu", maxConcurrent: 3 });
		expect((await env.resources.get("gpu"))?.free).toBe(2);
	});
});

describe("forceRelease", () => {
	test("frees capacity and emits resource.released with forced: true", async () => {
		const env = await freshEnv();
		await env.resources.register({ id: "gpu", maxConcurrent: 2 });
		const a = await env.holder("first", [0]);
		const b = await env.holder("second", [1]);
		expect((await env.resources.get("gpu"))?.free).toBe(0);
		env.seen.length = 0;

		const one = await env.resources.forceRelease("gpu", 0);
		expect(one).toEqual({ released: 1 });
		expect((await env.resources.get("gpu"))?.free).toBe(1);
		expect(released(env.seen)).toHaveLength(1);
		expect(released(env.seen)[0]?.payload).toEqual({
			resourceId: "gpu",
			slot: 0,
			runId: a,
			forced: true,
		});

		// The event is DURABLE, not just fanned out, the audit row carries the
		// forced flag too.
		const rows = await env.handle.db
			.select()
			.from(events)
			.where(eq(events.type, "resource.released"));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.payload).toMatchObject({ forced: true });

		// Releasing the whole resource frees the rest.
		env.seen.length = 0;
		expect(await env.resources.forceRelease("gpu")).toEqual({ released: 1 });
		expect(released(env.seen)[0]?.payload).toMatchObject({
			runId: b,
			slot: 1,
			forced: true,
		});
		expect((await env.resources.get("gpu"))?.free).toBe(2);

		// Idempotent: nothing held, nothing released, nothing emitted.
		env.seen.length = 0;
		expect(await env.resources.forceRelease("gpu")).toEqual({ released: 0 });
		expect(released(env.seen)).toEqual([]);
	});

	test("the engine's own release is NOT marked forced", async () => {
		const env = await freshEnv();
		await env.resources.register({ id: "gpu", maxConcurrent: 1 });
		const runId = await env.holder("first", [0]);
		env.seen.length = 0;

		expect(await env.sched.releaseSlots(runId)).toBe(1);
		expect(released(env.seen)[0]?.payload).toMatchObject({ forced: false });
	});
});

describe("unregister", () => {
	test("force-releases held slots before dropping the definition", async () => {
		const env = await freshEnv();
		await env.resources.register({ id: "gpu", maxConcurrent: 2 });
		await env.holder("first", [0, 1]);
		env.seen.length = 0;

		// The FK cascades resource_slots, so deleting without releasing first
		// would drop live holds with no audit trail at all.
		expect(await env.resources.unregister("gpu")).toEqual({ released: 2 });
		expect(released(env.seen)).toHaveLength(2);
		expect(released(env.seen).every((e) => e.payload.forced === true)).toBe(
			true,
		);
		expect(await env.resources.list()).toEqual([]);
		expect(await env.handle.db.select().from(resourceSlots)).toEqual([]);
	});
});
