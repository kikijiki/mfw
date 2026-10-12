import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import {
	backfillDecisionOutcomes,
	listAttemptOutcomes,
	recordDecisionOutcome,
	summarizeOutcomes,
} from "@mfw/db/outcomes";
import { decisions, mergeJobs } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import pino from "pino";
import { OutcomeRecorder } from "../src/outcome-recorder.ts";
import { RunRegistry } from "../src/run-registry.ts";

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "mfw-decision-outcomes-"));
	const handle = await openProjectDb(dir);
	const bus = new EventBus();
	const registry = new RunRegistry({
		handle,
		bus,
		runsDir: join(dir, "runs"),
	});
	const recorder = new OutcomeRecorder({
		handle,
		bus,
		tasks: {
			get: async () => ({ type: "implementation", size: "s", modelTier: null }),
		},
		log: pino({ level: "silent" }),
	}).start();
	async function decision(model = "opus"): Promise<number> {
		await recorder.idle();
		const [d] = await handle.db
			.insert(decisions)
			.values({
				ts: new Date(),
				role: "brain",
				model,
				status: "ok",
				action: "spawn",
				kind: "action",
				harness: "claude-cli",
				taskId: "T-1",
			})
			.returning({ id: decisions.id });
		return (d as { id: number }).id;
	}
	async function outcomeOf(id: number) {
		await recorder.idle();
		const [d] = await handle.db
			.select()
			.from(decisions)
			.where(eq(decisions.id, id));
		return d?.outcome ?? null;
	}
	async function merge(runId: string, taskId = "T-1") {
		await recorder.idle();
		await handle.db.insert(mergeJobs).values({
			runId,
			taskId,
			branch: "b",
			targetBranch: "main",
			state: "merged",
			enqueuedAt: new Date(),
			updatedAt: new Date(),
		});
	}
	return {
		handle,
		registry,
		recorder,
		decision,
		outcomeOf,
		merge,
		async done() {
			recorder.stop();
			await recorder.idle();
			handle.close();
			await rm(dir, { recursive: true, force: true });
		},
	};
}

describe("decision outcomes", () => {
	test("a brain-spawned chain that merges first pass sets the decision's outcome, and re-folding is idempotent", async () => {
		const f = await fixture();
		const id = await f.decision();
		await f.recorder.idle();
		const run = await f.registry.create({
			kind: "task",
			taskId: "T-1",
			label: "T-1",
			model: "opus",
			providerId: "claude-cli",
			cwd: "/w",
			spawnedByDecisionId: id,
		});
		await f.recorder.idle();
		// Open chain: nothing to say yet.
		expect(await f.outcomeOf(id)).toBeNull();

		await f.recorder.idle();
		await f.registry.transition(run.id, "merging");
		await f.merge(run.id);
		await f.recorder.idle();
		await f.registry.finish(run.id, "completed", "merged");
		await f.recorder.idle();

		const out = (await f.outcomeOf(id)) as Record<string, unknown>;
		expect(out).toMatchObject({
			final: "merged",
			firstPass: true,
			repairs: 0,
			rootRunId: run.id,
			chains: 1,
		});

		// Idempotent: an explicit re-fold leaves the same value.
		const before = JSON.stringify(out);
		await f.handle.withTx((tx) => recordDecisionOutcome(tx, id));
		await f.handle.withTx((tx) => backfillDecisionOutcomes(tx));
		expect(JSON.stringify(await f.outcomeOf(id))).toBe(before);
		await f.done();
	});

	test("a chain that merged after a repair is not first pass; abandoned chains say so", async () => {
		const f = await fixture();
		const repaired = await f.decision();
		await f.recorder.idle();
		const root = await f.registry.create({
			kind: "task",
			taskId: "T-1",
			label: "T-1",
			model: "opus",
			providerId: "claude-cli",
			cwd: "/w",
			spawnedByDecisionId: repaired,
		});
		await f.recorder.idle();
		await f.registry.finish(root.id, "failed", "verify failed");
		await f.recorder.idle();
		const child = await f.registry.create({
			kind: "task",
			taskId: "T-1",
			parentRunId: root.id,
			label: "T-1#repair",
			model: "opus",
			providerId: "claude-cli",
			cwd: "/w",
			attempt: 2,
		});
		await f.recorder.idle();
		await f.registry.transition(child.id, "merging");
		await f.merge(child.id);
		await f.recorder.idle();
		await f.registry.finish(child.id, "completed", "merged");
		await f.recorder.idle();
		expect(await f.outcomeOf(repaired)).toMatchObject({
			final: "merged",
			firstPass: false,
			repairs: 1,
		});

		const dropped = await f.decision();
		await f.recorder.idle();
		const killed = await f.registry.create({
			kind: "task",
			taskId: "T-2",
			label: "T-2",
			model: "opus",
			providerId: "claude-cli",
			cwd: "/w",
			spawnedByDecisionId: dropped,
		});
		await f.recorder.idle();
		await f.registry.finish(killed.id, "killed", "killed_manual");
		await f.recorder.idle();
		const out = (await f.outcomeOf(dropped)) as { final?: string } | null;
		expect(out?.final).not.toBeNull();
		expect(out?.final).not.toBe("merged");
		await f.done();
	});

	test("outcomes group by decided_by, role and brain route", async () => {
		const f = await fixture();
		const id = await f.decision("opus");
		await f.recorder.idle();
		const run = await f.registry.create({
			kind: "task",
			taskId: "T-1",
			label: "T-1",
			model: "sonnet",
			providerId: "claude-cli",
			cwd: "/w",
			spawnedByDecisionId: id,
		});
		await f.recorder.idle();
		await f.registry.transition(run.id, "merging");
		await f.merge(run.id);
		await f.recorder.idle();
		await f.registry.finish(run.id, "completed", "merged");
		await f.recorder.idle();
		const manual = await f.registry.create({
			kind: "task",
			taskId: "T-3",
			label: "T-3",
			model: "sonnet",
			providerId: "claude-cli",
			cwd: "/w",
		});
		await f.recorder.idle();
		await f.registry.finish(manual.id, "failed", "boom");
		await f.recorder.idle();

		const rows = await listAttemptOutcomes(f.handle.db);
		const byDecider = summarizeOutcomes(rows, ["decidedBy"]);
		expect(
			Object.fromEntries(byDecider.map((g) => [g.key.decidedBy, g.attempts])),
		).toEqual({ brain: 1, pipeline: 1 });
		const byRoute = summarizeOutcomes(rows, ["brainRoute"]);
		expect(byRoute.map((g) => g.key.brainRoute).sort()).toEqual([
			"claude-cli:opus",
			null,
		]);
		const brain = byDecider.find((g) => g.key.decidedBy === "brain");
		expect(brain?.firstPassRate).toBe(1);
		await f.done();
	});
});
