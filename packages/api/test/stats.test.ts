import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { backfillAttemptOutcomes } from "@mfw/db/outcomes";
import { mergeJobs, runSteps, runs } from "@mfw/db/schema";
import { createCaller } from "../src/root.ts";

const t0 = Date.parse("2026-10-01T00:00:00Z");
const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
	for (const c of cleanups) await c();
});

type RunInsert = typeof runs.$inferInsert;
const run = (
	id: string,
	at: number,
	over: Partial<RunInsert> = {},
): RunInsert => ({
	id,
	kind: "task",
	taskId: id.toUpperCase(),
	label: id.toUpperCase(),
	model: "sonnet",
	providerId: "claude-cli",
	modelTier: "standard",
	cwd: "/w",
	state: "completed",
	outcome: "completed",
	startedAt: new Date(t0 + at),
	finishedAt: new Date(t0 + at + 60_000),
	...over,
});

async function merge(h: ProjectDbHandle, runId: string, taskId: string) {
	await h.db.insert(mergeJobs).values({
		runId,
		taskId,
		branch: runId,
		targetBranch: "main",
		state: "merged",
		enqueuedAt: new Date(t0),
		updatedAt: new Date(t0),
	});
}

async function project(
	name: string,
	seed: (h: ProjectDbHandle) => Promise<void>,
) {
	const dir = await mkdtemp(join(tmpdir(), "mfw-stats-"));
	const handle = await openProjectDb(dir);
	cleanups.push(async () => {
		handle.close();
		await rm(dir, { recursive: true, force: true });
	});
	await seed(handle);
	await backfillAttemptOutcomes(handle.db);
	return { name, handle } as unknown as ProjectServices;
}

async function api() {
	const alpha = await project("alpha", async (h) => {
		// first pass
		await h.db.insert(runs).values(run("a1", 0));
		await merge(h, "a1", "A1");
		// repaired, then merged
		await h.db.insert(runs).values([
			run("a2", 1000, { state: "failed" }),
			run("a2r", 2000, {
				taskId: "A2",
				parentRunId: "a2",
				label: "A2#repair",
				attempt: 2,
			}),
		]);
		await h.db.insert(runSteps).values({
			runId: "a2",
			step: "spawn_repair",
			seq: 1,
			status: "done",
			result: { childRunId: "a2r" },
			startedAt: new Date(t0),
		});
		await merge(h, "a2r", "A2");
	});
	const beta = await project("beta", async (h) => {
		await h.db.insert(runs).values([
			run("b1", 0, { providerId: "codex-cli", model: "gpt-5.6-sol" }),
			run("b2", 5000, { state: "running", outcome: null, finishedAt: null }),
			// Before the `since` window used below.
			run("old", -86_400_000),
		]);
		await h.db.insert(runSteps).values({
			runId: "b1",
			step: "release_task",
			seq: 1,
			status: "done",
			result: { released: true, to: "review" },
			startedAt: new Date(t0),
		});
		await merge(h, "old", "OLD");
	});
	const all = [alpha, beta];
	const orchestrator = {
		list: () => all,
		get: (n: string) => all.find((p) => p.name === n),
	} as unknown as Orchestrator;
	return createCaller({ orchestrator });
}

describe("stats.outcomes", () => {
	test("aggregates across projects by harness/model/tier, open chains out of rates", async () => {
		const caller = await api();
		const res = await caller.stats.outcomes({ since: t0 });
		expect(res.projects).toEqual(["alpha", "beta"]);
		expect(res.groupBy).toEqual(["harness", "model", "tier"]);
		const claude = res.groups.find((g) => g.key.harness === "claude-cli");
		expect(claude).toMatchObject({
			key: { harness: "claude-cli", model: "sonnet", tier: "standard" },
			attempts: 2, // a1 + a2 chain; b2 is open, `old` predates `since`
			open: 1,
			merged: 2,
			firstPass: 1,
			firstPassRate: 0.5,
			repairs: 1,
			meanRepairs: 0.5,
		});
		const codex = res.groups.find((g) => g.key.harness === "codex-cli");
		expect(codex).toMatchObject({
			attempts: 1,
			merged: 0,
			finals: { review_human: 1 },
			firstPassRate: 0,
		});
	});

	test("filters to one project and regroups", async () => {
		const caller = await api();
		const res = await caller.stats.outcomes({
			project: "beta",
			groupBy: ["modelVendor"],
		});
		expect(res.projects).toEqual(["beta"]);
		expect(res.groups.map((g) => [g.key.modelVendor, g.attempts])).toEqual([
			["anthropic", 1], // `old` merged; b2 still open
			["openai", 1],
		]);
		await expect(
			caller.stats.outcomes({ project: "nope" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
