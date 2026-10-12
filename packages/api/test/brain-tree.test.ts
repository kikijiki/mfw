import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeBrain } from "@mfw/daemon/brain-view";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";
import { openProjectDb } from "@mfw/db/client";
import {
	brainSessions,
	brainTurns,
	decisions,
	type RunKind,
	runs,
} from "@mfw/db/schema";
import { createCaller } from "../src/root.ts";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
	for (const c of cleanups) await c();
});

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const MIN = 60_000;

async function fixture(opts: { session?: "idle" | "turn" | "failed" } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "mfw-brain-tree-"));
	const handle = await openProjectDb(dir);
	cleanups.push(async () => {
		handle.close();
		await rm(dir, { recursive: true, force: true });
	});
	const db = handle.db;
	const run = (
		id: string,
		taskId: string | null,
		over: Partial<typeof runs.$inferInsert> = {},
	): typeof runs.$inferInsert => ({
		id,
		kind: "task" as RunKind,
		taskId,
		label: id,
		model: "sonnet",
		cwd: "/w",
		state: "completed",
		startedAt: new Date(NOW - 60 * MIN),
		finishedAt: new Date(NOW - 59 * MIN),
		...over,
	});
	await db.insert(runs).values([
		run("r-old", "T-1"),
		// The brain's turns are runs of kind "brain" with no task.
		run("turn-1", null, {
			kind: "brain" as RunKind,
			startedAt: new Date(NOW - 30 * MIN),
			finishedAt: new Date(NOW - 29 * MIN),
		}),
		run("turn-2", null, {
			kind: "brain" as RunKind,
			state: "running",
			startedAt: new Date(NOW - 2 * MIN),
			finishedAt: null,
		}),
	]);
	if (opts.session) {
		await db.insert(brainSessions).values({
			id: "S1",
			scope: { kind: "project" },
			status: opts.session,
			harness: "claude-cli",
			model: "opus",
			nativeHost: "h",
			generation: 3,
			generationStartedAt: new Date(NOW - 5 * 3600_000),
			consecutiveFailures: opts.session === "failed" ? 3 : 0,
			createdAt: new Date(NOW - 5 * 3600_000),
		});
		await db.insert(brainTurns).values([
			{
				runId: "turn-1",
				sessionId: "S1",
				seq: 1,
				generation: 3,
				wakeClass: "frontier",
				eventsFrom: 1,
				eventsTo: 5,
				resumed: false,
				status: opts.session === "failed" ? "failed" : "ok",
				actionsCount: 2,
				startedAt: new Date(NOW - 30 * MIN),
				endedAt: new Date(NOW - 29 * MIN),
				usage: { costUsd: 0.04 },
				error: opts.session === "failed" ? "spawn failed" : null,
			},
			{
				runId: "turn-2",
				sessionId: "S1",
				seq: 2,
				generation: 3,
				wakeClass: "heartbeat",
				eventsFrom: 6,
				eventsTo: 9,
				resumed: true,
				status: "running",
				actionsCount: 0,
				startedAt: new Date(NOW - 2 * MIN),
			},
		]);
	}
	const taskRows = ["T-1", "T-2"].map((id) => ({
		id,
		title: id,
		status: "ready",
		type: "feature",
		parentId: null,
		updatedAt: new Date(NOW - MIN),
	}));
	const svc = {
		name: "demo",
		handle,
		tasks: { list: async () => taskRows },
		registry: { runDir: (id: string) => join("/nonexistent", id) },
	} as unknown as ProjectServices;
	const orchestrator = {
		list: () => [svc],
		get: () => svc,
	} as unknown as Orchestrator;
	return { api: createCaller({ orchestrator }), db };
}

type DecisionInsert = typeof decisions.$inferInsert;
function decision(over: Partial<DecisionInsert> = {}): DecisionInsert {
	return {
		ts: new Date(NOW - 10 * MIN),
		role: "brain",
		model: "opus",
		status: "ok",
		kind: "action",
		action: "spawn",
		reason: "deps merged; owns free",
		turnRunId: "turn-1",
		brainSessionId: "S1",
		confidence: "high",
		output: { status: "proposed", dryRun: true },
		...over,
	};
}

describe("flow.tree: the brain at the root", () => {
	test("with a session the brain is the root and top-level nodes hang under it", async () => {
		const { api } = await fixture({ session: "turn" });
		const tree = await api.flow.tree({ project: "demo" });
		const brain = tree.nodes.find((n) => n.ref === "brain");
		expect(brain).toMatchObject({
			kind: "brain",
			parent: null,
			needsMe: null,
			brain: {
				state: "turn",
				generation: 3,
				liveTurnRunId: "turn-2",
				turnsLast24h: 2,
			},
		});
		expect(tree.nodes.find((n) => n.ref === "task:T-1")?.parent).toBe("brain");
		// Turns are spans on the brain row, never nodes.
		expect(tree.nodes.some((n) => n.ref === "run:turn-1")).toBe(false);
		expect(tree.nodes.some((n) => n.ref === "run:turn-2")).toBe(false);
	});

	test("a failed session needs a person", async () => {
		const { api } = await fixture({ session: "failed" });
		const tree = await api.flow.tree({ project: "demo" });
		const brain = tree.nodes.find((n) => n.ref === "brain");
		expect(brain?.needsMe).toBe("brain_stuck");
		expect(brain?.brain?.state).toBe("failed");
	});

	test("no brain session: no brain node, tasks stay roots", async () => {
		const { api } = await fixture();
		const tree = await api.flow.tree({ project: "demo" });
		expect(tree.nodes.some((n) => n.ref === "brain")).toBe(false);
		expect(tree.nodes.find((n) => n.ref === "task:T-1")?.parent).toBeNull();
		// Without a session a brain-kind run is an ordinary judge node.
		expect(tree.nodes.find((n) => n.ref === "run:turn-1")?.kind).toBe("judge");
	});
});

describe("flow.spans: turn spans and decision markers", () => {
	test("turns are spans on the brain row; decisions are markers on brain and target rows", async () => {
		const { api, db } = await fixture({ session: "turn" });
		await db.insert(decisions).values([
			decision({ taskId: "T-2" }),
			decision({
				kind: "plan",
				action: "set_plan",
				ts: new Date(NOW - 9 * MIN),
				output: { status: "applied" },
			}),
			decision({
				action: "notify_human",
				input: { kind: "credential", title: "need a key" },
				ts: new Date(NOW - 8 * MIN),
			}),
			decision({
				action: "notify_human",
				input: { kind: "fyi", title: "fyi" },
				ts: new Date(NOW - 7 * MIN),
			}),
		]);
		const out = await api.flow.spans({
			project: "demo",
			from: new Date(NOW - 2 * 3600_000),
			to: new Date(NOW),
		});
		const turns = out.spans.filter((s) => s.lane === "turn");
		expect(turns.map((s) => [s.subject, s.value, s.detail?.ref])).toEqual([
			["brain", "ok", "turn:turn-1"],
			["brain", "running", "turn:turn-2"],
		]);
		expect(turns[1]?.end).toBeNull();
		expect(turns[0]?.detail).toMatchObject({ actions: 2, costUsd: 0.04 });

		const onBrain = out.markers.filter((m) => m.subject === "brain");
		expect(onBrain).toHaveLength(4);
		expect(onBrain.filter((m) => m.kind === "notify")).toHaveLength(1);
		// The targeted decision also keeps its marker on the task row.
		expect(
			out.markers.filter((m) => m.subject === "task:T-2").map((m) => m.kind),
		).toEqual(["decision"]);
		expect(onBrain.map((m) => m.label)).toContain("spawn (proposed)");
	});

	test("a subject filter that excludes the brain leaves its row out", async () => {
		const { api } = await fixture({ session: "turn" });
		const out = await api.flow.spans({
			project: "demo",
			from: new Date(NOW - 2 * 3600_000),
			to: new Date(NOW),
			subjects: ["task:T-1"],
		});
		expect(out.spans.filter((s) => s.lane === "turn")).toHaveLength(0);
	});
});

describe("brain.intents", () => {
	test("the newest non-rejected action is an intent only until a run starts after it", async () => {
		const { api, db } = await fixture({ session: "idle" });
		await db.insert(decisions).values([
			// T-1 has r-old at NOW-60m; this decision is newer: an intent.
			decision({
				taskId: "T-1",
				action: "spawn",
				ts: new Date(NOW - 20 * MIN),
			}),
			// A newer rejected call changed nothing: the older proposal stands.
			decision({
				taskId: "T-1",
				action: "stop",
				ts: new Date(NOW - 5 * MIN),
				output: { status: "rejected" },
			}),
			// T-2's decision predates its run: history, not intent.
			decision({
				taskId: "T-2",
				action: "steer",
				ts: new Date(NOW - 120 * MIN),
			}),
			// Notes are memory, not intent.
			decision({ taskId: "T-2", kind: "note", action: "note" }),
		]);
		await db.insert(runs).values({
			id: "r-t2",
			kind: "task" as RunKind,
			taskId: "T-2",
			label: "r-t2",
			model: "sonnet",
			cwd: "/w",
			state: "completed",
			startedAt: new Date(NOW - 90 * MIN),
			finishedAt: new Date(NOW - 80 * MIN),
		});
		const intents = await api.brain.intents({ project: "demo" });
		expect(intents).toHaveLength(1);
		expect(intents[0]).toMatchObject({
			taskId: "T-1",
			tool: "spawn",
			state: "proposed",
			confidence: "high",
			rationale: "deps merged; owns free",
		});
	});
});

describe("node.story: brain decisions", () => {
	test("carries state, confidence, alternatives and the turn", async () => {
		const { api, db } = await fixture({ session: "idle" });
		await db.insert(decisions).values(
			decision({
				taskId: "T-1",
				alternatives: [{ option: "wait", why_not: "owns are free" }],
				output: { status: "proposed", result: { runId: "r-new" } },
			}),
		);
		const page = await api.node.story({ project: "demo", ref: "task:T-1" });
		const d = page.entries.find((e) => e.kind === "decision");
		expect(d).toMatchObject({
			kind: "decision",
			role: "brain",
			tool: "spawn",
			outcome: "proposed",
			effects: ["run:r-new"],
			brain: {
				actionState: "proposed",
				confidence: "high",
				turnRunId: "turn-1",
				alternatives: [{ option: "wait", why_not: "owns are free" }],
			},
		});
	});

	test("decision pips interleave with run pips and skip rejected calls", async () => {
		const { api, db } = await fixture({ session: "idle" });
		await db.insert(decisions).values([
			decision({ taskId: "T-1", ts: new Date(NOW - 20 * MIN) }),
			decision({
				taskId: "T-1",
				ts: new Date(NOW - 10 * MIN),
				output: { status: "rejected" },
			}),
		]);
		const pips = await api.runs.pipsByTask({ project: "demo" });
		expect(pips["T-1"]?.map((p) => p.glyph)).toEqual(["ok", "decision"]);
	});
});

describe("summarizeBrain", () => {
	test("off when not configured, failed carries the error", () => {
		expect(summarizeBrain({ enabled: false, session: null }).state).toBe("off");
		expect(summarizeBrain({ enabled: true, session: null }).state).toBe("idle");
		expect(
			summarizeBrain({
				enabled: true,
				session: {
					status: "failed",
					generation: 1,
					consecutiveFailures: 3,
					liveTurnRunId: null,
					lastTurn: { status: "failed", error: "boom" },
				},
			}),
		).toMatchObject({ state: "failed", failures: 3, error: "boom" });
	});

	test("brain.states reads every project", async () => {
		const svc = {
			name: "alpha",
			brainRuntime: { view: async () => ({ enabled: false, session: null }) },
		} as unknown as ProjectServices;
		const orchestrator = {
			list: () => [svc],
			get: () => svc,
		} as unknown as Orchestrator;
		const api = createCaller({ orchestrator });
		expect(await api.brain.states()).toMatchObject([
			{ project: "alpha", enabled: false, state: "off" },
		]);
	});
});
