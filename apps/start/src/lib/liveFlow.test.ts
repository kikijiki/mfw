import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppRouter } from "@mfw/api";
import { QueryClient } from "@tanstack/react-query";
import { createTRPCClient } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";

import { applyEvent, invalidateEverything } from "./live";

interface FlowSpanLike {
	value: string;
	end: Date | null;
	detail?: unknown;
}

describe("the Flow caches follow the event stream", () => {
	const T = Date.UTC(2026, 9, 12, 12, 0, 0);
	const node = (over: Record<string, unknown>) => ({
		parent: null,
		needsMe: null,
		lastAt: new Date(T - 60_000),
		...over,
	});
	const treeData = () => ({
		seq: 5,
		nodes: [
			node({
				ref: "task:A",
				kind: "task",
				title: "A",
				status: { value: "in_progress", role: "in_progress" },
				rollup: { total: 1, done: 0, live: 1, needsMe: 0, costUsdToday: 0 },
			}),
			node({
				ref: "run:r1",
				parent: "task:A",
				kind: "run",
				title: "r1",
				run: {
					role: "worker",
					relation: "fresh",
					state: "running",
					activity: "working",
					harness: "claude-cli",
					model: "sonnet",
					effort: null,
					host: null,
					label: "r1",
					startedAt: new Date(T - 60_000),
					finishedAt: null,
					costUsd: null,
					liveCostUsd: null,
				},
			}),
		],
	});

	function setup() {
		const queryClient = new QueryClient();
		const trpc = createTRPCOptionsProxy<AppRouter>({
			client: createTRPCClient<AppRouter>({ links: [] }),
			queryClient,
		});
		const treeKey = trpc.flow.tree.queryKey({ project: "demo" });
		const liveKey = trpc.flow.live.queryKey({ project: "demo" });
		const spansKey = trpc.flow.spans.queryKey({
			project: "demo",
			from: new Date(T - 2 * 3_600_000),
			to: new Date(T + 3_600_000),
		});
		const pastKey = trpc.flow.spans.queryKey({
			project: "demo",
			from: new Date(T - 9 * 3_600_000),
			to: new Date(T - 8 * 3_600_000),
		});
		queryClient.setQueryData(treeKey, treeData() as never);
		queryClient.setQueryData(liveKey, treeData() as never);
		const openActivity = {
			subject: "run:r1",
			lane: "activity",
			value: "working",
			start: new Date(T - 60_000),
			end: null,
		};
		queryClient.setQueryData(spansKey, {
			spans: [openActivity],
			markers: [],
		} as never);
		queryClient.setQueryData(pastKey, {
			spans: [openActivity],
			markers: [],
		} as never);
		const apply = (event: Record<string, unknown>, seq = 6) =>
			applyEvent(queryClient, trpc, {
				project: "demo",
				event: { ...event, seq, ts: T } as never,
			});
		const nodes = (key: unknown) =>
			(
				queryClient.getQueryData(key as typeof treeKey) as ReturnType<
					typeof treeData
				>
			).nodes as unknown as {
				ref: string;
				parent: string | null;
				needsMe: string | null;
				status?: unknown;
				rollup?: Record<string, number>;
				run?: Record<string, unknown>;
			}[];
		const stale = (key: readonly unknown[]) =>
			queryClient.getQueryState(key)?.isInvalidated === true;
		return {
			queryClient,
			trpc,
			apply,
			treeKey,
			liveKey,
			spansKey,
			pastKey,
			nodes,
			stale,
		};
	}

	test("run.started inserts a node, in the tree and in Home's live subset", () => {
		const t = setup();
		t.apply({
			type: "run.started",
			runId: "r2",
			taskId: "A",
			payload: { kind: "task", model: "opus", taskId: "A", label: "A#2" },
		});
		for (const key of [t.treeKey, t.liveKey]) {
			const added = t.nodes(key).find((n) => n.ref === "run:r2");
			expect(added?.parent).toBe("task:A");
			expect(added?.run?.state).toBe("starting");
			expect(t.nodes(key).find((n) => n.ref === "task:A")?.rollup?.total).toBe(
				2,
			);
		}
		// The event lacks harness and host, so the details are refetched too.
		expect(t.stale(t.treeKey)).toBe(true);
		t.queryClient.clear();
	});

	test("run.activity_changed patches the node and the live span, with no refetch of the tree", () => {
		const t = setup();
		t.apply({
			type: "run.activity_changed",
			runId: "r1",
			taskId: "A",
			payload: { from: "working", to: "needs_answer", question: "Which?" },
		});
		const n = t.nodes(t.treeKey).find((x) => x.ref === "run:r1");
		expect(n?.run?.activity).toBe("needs_answer");
		expect(n?.needsMe).toBe("question");
		expect(
			t.nodes(t.treeKey).find((x) => x.ref === "task:A")?.rollup?.needsMe,
		).toBe(1);
		expect(t.stale(t.treeKey)).toBe(false);

		const spans = (
			t.queryClient.getQueryData(t.spansKey) as { spans: FlowSpanLike[] }
		).spans;
		expect(spans).toHaveLength(2);
		expect(spans[0]?.end?.getTime()).toBe(T);
		expect(spans[1]).toMatchObject({ value: "needs_answer", end: null });
		expect(spans[1]?.detail).toEqual({ question: "Which?" });
		// a window that ended before the event is history: left as it was
		const past = (
			t.queryClient.getQueryData(t.pastKey) as { spans: FlowSpanLike[] }
		).spans;
		expect(past).toHaveLength(1);
		expect(past[0]?.end).toBeNull();
		t.queryClient.clear();
	});

	test("task.status_changed updates the task row and its attention without a refetch", () => {
		const t = setup();
		t.apply({
			type: "task.status_changed",
			taskId: "A",
			payload: { from: "in_progress", to: "review", actor: "verifier" },
		});
		const a = t.nodes(t.treeKey).find((x) => x.ref === "task:A");
		expect(a?.status).toEqual({ value: "review", role: "review" });
		expect(a?.needsMe).toBe("inbox");
		expect(t.stale(t.treeKey)).toBe(false);
		t.queryClient.clear();
	});

	test("a finished run moves the rollup from live to done and refreshes the tree for cost", () => {
		const t = setup();
		t.apply({
			type: "run.state_changed",
			runId: "r1",
			taskId: "A",
			payload: { from: "running", to: "completed" },
		});
		const a = t.nodes(t.treeKey).find((x) => x.ref === "task:A");
		expect(a?.rollup).toMatchObject({ live: 0, done: 1 });
		expect(t.stale(t.treeKey)).toBe(true);
		// Home's live subset drops it on its next read
		expect(t.stale(t.liveKey)).toBe(true);
		t.queryClient.clear();
	});

	test("a failed check or a merge refetches the markers", () => {
		const t = setup();
		t.apply({
			type: "verify.check",
			runId: "r1",
			taskId: "A",
			payload: { check: "typecheck", passed: true },
		});
		expect(t.stale(t.spansKey)).toBe(false);
		t.apply({
			type: "verify.check",
			runId: "r1",
			taskId: "A",
			payload: { check: "typecheck", passed: false },
		});
		expect(t.stale(t.spansKey)).toBe(true);
		t.queryClient.clear();
	});

	test("run.group_changed refetches the group node, the compare view and the Story", () => {
		const t = setup();
		const groupKey = t.trpc.groups.get.queryKey({
			project: "demo",
			groupId: "g1",
		});
		const storyKey = t.trpc.node.story.queryKey({
			project: "demo",
			ref: "task:A",
		});
		t.queryClient.setQueryData(groupKey, { id: "g1" } as never);
		t.queryClient.setQueryData(storyKey, { entries: [] } as never);
		t.apply({
			type: "run.group_changed",
			taskId: "A",
			payload: { groupId: "g1", status: "selecting", winnerRunId: "r1" },
		});
		expect(t.stale(t.treeKey)).toBe(true);
		expect(t.stale(t.liveKey)).toBe(true);
		expect(t.stale(groupKey)).toBe(true);
		expect(t.stale(storyKey)).toBe(true);
		t.queryClient.clear();
	});

	test("a gap invalidates everything, the Flow caches included", () => {
		const t = setup();
		expect(t.stale(t.treeKey)).toBe(false);
		expect(t.stale(t.spansKey)).toBe(false);
		invalidateEverything(t.queryClient);
		expect(t.stale(t.treeKey)).toBe(true);
		expect(t.stale(t.liveKey)).toBe(true);
		expect(t.stale(t.spansKey)).toBe(true);
		expect(t.stale(t.pastKey)).toBe(true);
		t.queryClient.clear();
	});

	test("the live hook sends a gap frame through that same path", () => {
		const source = readFileSync(join(import.meta.dir, "live.ts"), "utf8");
		const start = source.indexOf('if (frame.kind === "gap")');
		const gap = source.slice(start, source.indexOf("Duplicate from", start));
		expect(gap).toContain("invalidateEverything(queryClient)");
	});
});
