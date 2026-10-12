import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { mergeJobs, runs, taskAttemptOutcomes } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import pino from "pino";
import { OutcomeRecorder } from "../src/outcome-recorder.ts";
import { RunRegistry } from "../src/run-registry.ts";

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "mfw-outcomes-"));
	const handle = await openProjectDb(dir);
	const bus = new EventBus();
	const registry = new RunRegistry({
		handle,
		bus,
		runsDir: join(dir, "runs"),
	});
	const task = { type: "feature", size: "m", modelTier: "strong" };
	const recorder = new OutcomeRecorder({
		handle,
		bus,
		tasks: { get: async () => task },
		log: pino({ level: "silent" }),
	}).start();
	return {
		handle,
		registry,
		recorder,
		task,
		async done() {
			recorder.stop();
			await recorder.idle();
			handle.close();
			await rm(dir, { recursive: true, force: true });
		},
	};
}

describe("OutcomeRecorder", () => {
	test("snapshots task facts at run creation and folds the chain on each settle", async () => {
		const f = await fixture();
		const root = await f.registry.create({
			kind: "task",
			taskId: "MFW-1",
			label: "MFW-1",
			model: "opus",
			providerId: "claude-cli",
			cwd: "/w",
		});
		await f.recorder.idle();
		const [snap] = await f.handle.db
			.select()
			.from(runs)
			.where(eq(runs.id, root.id));
		expect(snap).toMatchObject({
			harness: "claude-cli",
			modelVendor: "anthropic",
			taskSize: "m",
			taskType: "feature",
			modelTier: "strong",
		});
		// Later task edits never rewrite history: the chain keeps the root snapshot.
		f.task.size = "xl";

		const [open] = await f.handle.db.select().from(taskAttemptOutcomes);
		expect(open).toMatchObject({ rootRunId: root.id, final: null });

		await f.registry.finish(root.id, "failed", "verify failed");
		const child = await f.registry.create({
			kind: "task",
			taskId: "MFW-1",
			parentRunId: root.id,
			label: "MFW-1#repair",
			model: "opus",
			providerId: "claude-cli",
			cwd: "/w",
			attempt: 2,
		});
		await f.registry.transition(child.id, "merging");
		await f.handle.db.insert(mergeJobs).values({
			runId: child.id,
			taskId: "MFW-1",
			branch: "b",
			targetBranch: "main",
			state: "merged",
			enqueuedAt: new Date(),
			updatedAt: new Date(),
		});
		// The merge tail's finish is what settles the chain.
		await f.registry.finish(child.id, "completed", "merged");
		await f.recorder.idle();

		const rows = await f.handle.db.select().from(taskAttemptOutcomes);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			rootRunId: root.id,
			model: "opus",
			tier: "strong",
			size: "m",
			type: "feature",
			runs: 2,
			repairs: 1,
			final: "merged",
			firstPass: false,
		});
		await f.done();
	});

	test("ignores non-task runs", async () => {
		const f = await fixture();
		const plan = await f.registry.create({
			kind: "plan",
			label: "plan",
			model: "sonnet",
			cwd: "/w",
		});
		await f.registry.finish(plan.id, "completed");
		await f.recorder.idle();
		expect(await f.handle.db.select().from(taskAttemptOutcomes)).toEqual([]);
		await f.done();
	});
});
