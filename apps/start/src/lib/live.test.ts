import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppRouter } from "@mfw/api";
import { QueryClient } from "@tanstack/react-query";
import { createTRPCClient } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import type { LiveFrame } from "./live";
import { applyEvent, nextLiveSeq } from "./live";

test("task creation and ownership/dependency edits invalidate the cached Inbox", () => {
	const queryClient = new QueryClient();
	const trpc = createTRPCOptionsProxy<AppRouter>({
		client: createTRPCClient<AppRouter>({ links: [] }),
		queryClient,
	});
	const inboxKey = trpc.inbox.list.queryKey();
	for (const event of [
		{ type: "task.created", taskId: "MFW-1", payload: { title: "overlap" } },
		{ type: "task.edited", taskId: "MFW-1", payload: { fields: ["owns"] } },
		{
			type: "task.edited",
			taskId: "MFW-1",
			payload: { fields: ["dependsOn"] },
		},
	]) {
		queryClient.setQueryData(inboxKey, {
			items: [],
			counts: { total: 0, critical: 0, attention: 0 },
		});
		expect(queryClient.getQueryState(inboxKey)?.isInvalidated).toBe(false);
		applyEvent(queryClient, trpc, {
			project: "test",
			event: { ...event, seq: 1, ts: Date.now() } as never,
		});
		expect(queryClient.getQueryState(inboxKey)?.isInvalidated).toBe(true);
	}
	queryClient.clear();
});

describe("live task claim release", () => {
	const source = readFileSync(join(import.meta.dir, "live.ts"), "utf8");

	test("clears optimistic ownership and refreshes every dependent view", () => {
		const branch = source.slice(
			source.indexOf('case "task.claim_released"'),
			source.indexOf('case "task.lease_expired"'),
		);
		expect(branch).toContain("claimedByRunId: null");
		expect(branch).toContain("tasksList()");
		expect(branch).toContain("taskGet(event.taskId)");
		expect(branch).toContain("runsActive()");
		expect(branch).toContain("health()");
	});
});

describe("live cursor recovery", () => {
	const frame = (seq: number): LiveFrame =>
		({
			kind: "event",
			event: {
				type: "scheduler.paused",
				payload: { reason: "test" },
				seq,
				ts: seq,
			},
		}) as LiveFrame;

	test("advances a gap to the durable head and accepts only newer events", () => {
		const gap = { kind: "gap", fromSeq: 10, lastSeq: 750 } as LiveFrame;
		const afterGap = nextLiveSeq(10, gap);
		expect(afterGap).toBe(750);
		expect(nextLiveSeq(afterGap as number, frame(750))).toBeNull();
		expect(nextLiveSeq(afterGap as number, frame(751))).toBe(751);
	});

	test("never regresses on a replayed gap or duplicate event", () => {
		const oldGap = { kind: "gap", fromSeq: 0, lastSeq: 500 } as LiveFrame;
		expect(nextLiveSeq(700, oldGap)).toBeNull();
		expect(nextLiveSeq(700, frame(699))).toBeNull();
		expect(nextLiveSeq(700, frame(700))).toBeNull();
		expect(nextLiveSeq(700, frame(701))).toBe(701);
	});
});

describe("the agent dock follows run.state_changed", () => {
	const caps = {
		verified: true,
		steer: true,
		interrupt: true,
		approvals: true,
		plan: true,
		fileChanges: true,
		commandProgress: true,
		mcp: true,
	};
	const row = (project: string, runId: string, state = "starting") => ({
		project,
		runId,
		kind: "task",
		state,
		label: runId,
		model: "m",
		providerId: null,
		reasoningEffort: null,
		taskId: null,
		taskTitle: null,
		attempt: 1,
		capabilities: caps,
		steerable: false,
		startedAt: 0,
	});
	function setup() {
		const queryClient = new QueryClient();
		const trpc = createTRPCOptionsProxy<AppRouter>({
			client: createTRPCClient<AppRouter>({ links: [] }),
			queryClient,
		});
		const key = trpc.runs.active.queryKey();
		queryClient.setQueryData(key, [
			row("alpha", "01A"),
			row("beta", "01A"),
		] as never);
		const apply = (runId: string, to: string) =>
			applyEvent(queryClient, trpc, {
				project: "alpha",
				event: {
					type: "run.state_changed",
					runId,
					payload: { from: "starting", to },
					seq: 1,
					ts: 1,
				} as never,
			});
		const rows = () =>
			(queryClient.getQueryData(key) ?? []).map((r) => [
				r.project,
				r.state,
				r.steerable,
			]);
		return { queryClient, key, apply, rows };
	}

	test("an active transition patches the row in place, steerability included", () => {
		const { apply, rows, queryClient, key } = setup();
		apply("01A", "running");
		expect(rows()).toEqual([
			["alpha", "running", true],
			["beta", "starting", false],
		]);
		// The refetch still happens for the fields the payload does not carry.
		expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
	});

	test("leaving the active states drops the row from the dock at once", () => {
		const { apply, rows } = setup();
		apply("01A", "completed");
		expect(rows()).toEqual([["beta", "starting", false]]);
	});

	test("a run the dock has never seen is left to the refetch", () => {
		const { apply, rows } = setup();
		apply("01Z", "running");
		expect(rows()).toEqual([
			["alpha", "starting", false],
			["beta", "starting", false],
		]);
	});
});

describe("the agent dock follows run.activity_changed", () => {
	test("the row's activity is patched in place, and the dock and inbox refetch", () => {
		const queryClient = new QueryClient();
		const trpc = createTRPCOptionsProxy<AppRouter>({
			client: createTRPCClient<AppRouter>({ links: [] }),
			queryClient,
		});
		const key = trpc.runs.active.queryKey();
		const inboxKey = trpc.inbox.list.queryKey();
		queryClient.setQueryData(key, [
			{ project: "alpha", runId: "01A", state: "running", activity: "working" },
			{ project: "beta", runId: "01A", state: "running", activity: "working" },
		] as never);
		queryClient.setQueryData(inboxKey, {
			items: [],
			counts: { total: 0, critical: 0, attention: 0 },
		});
		applyEvent(queryClient, trpc, {
			project: "alpha",
			event: {
				type: "run.activity_changed",
				runId: "01A",
				payload: { from: "working", to: "awaiting_approval" },
				seq: 1,
				ts: 1,
			} as never,
		});
		expect(
			(queryClient.getQueryData(key) ?? []).map((r) => [r.project, r.activity]),
		).toEqual([
			["alpha", "awaiting_approval"],
			["beta", "working"],
		]);
		expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
		expect(queryClient.getQueryState(inboxKey)?.isInvalidated).toBe(true);
	});
});

describe("the scope meter follows run.scope_changed", () => {
	test("the dock's runs refetch for the new sample", () => {
		const queryClient = new QueryClient();
		const trpc = createTRPCOptionsProxy<AppRouter>({
			client: createTRPCClient<AppRouter>({ links: [] }),
			queryClient,
		});
		const key = trpc.runs.active.queryKey();
		queryClient.setQueryData(key, [] as never);
		applyEvent(queryClient, trpc, {
			project: "alpha",
			event: {
				type: "run.scope_changed",
				runId: "01A",
				payload: {
					from: "ok",
					level: "violation",
					files: 3,
					outside: 1,
					foreign: 1,
				},
				seq: 1,
				ts: 1,
			} as never,
		});
		expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
	});
});

describe("the chip's $ follows run.usage_sampled", () => {
	test("patches the active row in place and does not refetch", () => {
		const queryClient = new QueryClient();
		const trpc = createTRPCOptionsProxy<AppRouter>({
			client: createTRPCClient<AppRouter>({ links: [] }),
			queryClient,
		});
		const key = trpc.runs.active.queryKey();
		queryClient.setQueryData(key, [
			{ project: "alpha", runId: "01A", liveCostUsd: null },
			{ project: "alpha", runId: "01B", liveCostUsd: null },
		] as never);
		applyEvent(queryClient, trpc, {
			project: "alpha",
			event: {
				type: "run.usage_sampled",
				runId: "01A",
				payload: { tokensIn: 10, tokensOut: 2, costUsd: 0.37 },
				seq: 1,
				ts: 1,
			} as never,
		});
		expect(
			(queryClient.getQueryData(key) ?? []).map((r) => [
				r.runId,
				r.liveCostUsd,
			]),
		).toEqual([
			["01A", 0.37],
			["01B", null],
		]);
		expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
	});
});

describe("subagents refresh the flow tree and spans", () => {
	test("run.subagents_changed invalidates flow.tree and flow.spans", () => {
		const queryClient = new QueryClient();
		const trpc = createTRPCOptionsProxy<AppRouter>({
			client: createTRPCClient<AppRouter>({ links: [] }),
			queryClient,
		});
		const tree = trpc.flow.tree.queryKey({ project: "alpha" });
		const spans = trpc.flow.spans.queryKey({
			project: "alpha",
			from: new Date(0),
			to: new Date(1),
		});
		queryClient.setQueryData(tree, { nodes: [], seq: 0 } as never);
		queryClient.setQueryData(spans, { spans: [], markers: [] } as never);
		applyEvent(queryClient, trpc, {
			project: "alpha",
			event: {
				type: "run.subagents_changed",
				runId: "01A",
				payload: { total: 1, running: 1 },
				seq: 1,
				ts: 1,
			} as never,
		});
		expect(queryClient.getQueryState(tree)?.isInvalidated).toBe(true);
		expect(queryClient.getQueryState(spans)?.isInvalidated).toBe(true);
	});
});

describe("escalation sessions and questions refresh their surfaces", () => {
	function setup() {
		const queryClient = new QueryClient();
		const trpc = createTRPCOptionsProxy<AppRouter>({
			client: createTRPCClient<AppRouter>({ links: [] }),
			queryClient,
		});
		return { queryClient, trpc };
	}

	test.each([
		["session.raised", { sessionId: "s1", source: "blocked" }],
		["session.opened", { sessionId: "s1" }],
		["session.resolved", { sessionId: "s1", resolution: "fixed" }],
	])("%s invalidates sessions.open", (type, payload) => {
		const { queryClient, trpc } = setup();
		const key = trpc.sessions.open.queryKey();
		queryClient.setQueryData(key, []);
		applyEvent(queryClient, trpc, {
			project: "alpha",
			event: { type, runId: "01R", payload, seq: 1, ts: 1 } as never,
		});
		expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
	});

	test("a raised question refreshes the console's Answer strip", () => {
		const { queryClient, trpc } = setup();
		const key = trpc.clarify.open.queryKey();
		queryClient.setQueryData(key, []);
		applyEvent(queryClient, trpc, {
			project: "alpha",
			event: {
				type: "clarify.raised",
				runId: "01R",
				payload: { count: 1 },
				seq: 1,
				ts: 1,
			} as never,
		});
		expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
	});
});

describe("the project brain", () => {
	function setup() {
		const queryClient = new QueryClient();
		const trpc = createTRPCOptionsProxy<AppRouter>({
			client: createTRPCClient<AppRouter>({ links: [] }),
			queryClient,
		});
		return { queryClient, trpc };
	}

	test.each([
		["brain.turn_started", { sessionId: "S", seq: 1 }],
		["brain.turn_ended", { sessionId: "S", status: "failed", actionsCount: 0 }],
		["brain.action", { actionId: "A", tool: "spawn", status: "proposed" }],
		["brain.rollover", { sessionId: "S", reason: "tokens" }],
	])("%s refreshes the brain views, the inbox and the tree", (type, payload) => {
		const { queryClient, trpc } = setup();
		const keys = [
			trpc.brain.session.queryKey({ project: "alpha" }),
			trpc.brain.decisions.queryKey({ project: "alpha" }),
			trpc.brain.intents.queryKey({ project: "alpha" }),
			trpc.brain.states.queryKey(),
			trpc.inbox.list.queryKey(),
			trpc.flow.tree.queryKey({ project: "alpha" }),
		];
		for (const k of keys) queryClient.setQueryData(k, []);
		applyEvent(queryClient, trpc, {
			project: "alpha",
			event: { type, runId: "01T", payload, seq: 1, ts: 1 } as never,
		});
		for (const k of keys) {
			expect(queryClient.getQueryState(k)?.isInvalidated).toBe(true);
		}
		queryClient.clear();
	});

	test("an action on a task refreshes that task's story", () => {
		const { queryClient, trpc } = setup();
		const key = trpc.node.story.queryKey({ project: "alpha", ref: "task:T-1" });
		queryClient.setQueryData(key, { entries: [], cursor: null });
		applyEvent(queryClient, trpc, {
			project: "alpha",
			event: {
				type: "brain.action",
				taskId: "T-1",
				payload: { actionId: "A", tool: "spawn", status: "proposed" },
				seq: 1,
				ts: 1,
			} as never,
		});
		expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
		queryClient.clear();
	});
});
