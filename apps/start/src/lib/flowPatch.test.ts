import { describe, expect, test } from "bun:test";
import type { FlowNode, FlowSpan } from "@mfw/daemon/flow";

import {
	applySpanChange,
	attentionOf,
	insertRun,
	patchRunActivity,
	patchRunLiveCost,
	patchRunState,
	patchTaskStatus,
	spanChangesFor,
} from "./flowPatch";

const T = Date.UTC(2026, 9, 12, 12, 0, 0);
const rollup = (over: Partial<NonNullable<FlowNode["rollup"]>> = {}) => ({
	total: 0,
	done: 0,
	live: 0,
	needsMe: 0,
	costUsdToday: 0,
	...over,
});

const task = (
	id: string,
	parent: string | null,
	over: Partial<FlowNode> = {},
): FlowNode =>
	({
		ref: `task:${id}`,
		parent,
		kind: "task",
		title: id,
		status: { value: "in_progress", role: "in_progress" },
		rollup: rollup(),
		needsMe: null,
		lastAt: new Date(T - 3_600_000),
		...over,
	}) as FlowNode;

const runNode = (
	id: string,
	parent: string,
	over: {
		state?: string;
		activity?: string | null;
		needsMe?: FlowNode["needsMe"];
	} = {},
): FlowNode =>
	({
		ref: `run:${id}`,
		parent,
		kind: "run",
		title: id,
		needsMe: over.needsMe ?? null,
		lastAt: new Date(T - 600_000),
		run: {
			role: "worker",
			relation: "fresh",
			state: over.state ?? "running",
			activity: over.activity ?? "working",
			harness: "claude-cli",
			model: "sonnet",
			effort: null,
			host: null,
			label: id,
			startedAt: new Date(T - 600_000),
			finishedAt: null,
			costUsd: null,
			liveCostUsd: null,
		},
	}) as FlowNode;

const base = () => [
	task("E", null, { kind: "epic", rollup: rollup({ total: 1, live: 1 }) }),
	task("A", "task:E", { rollup: rollup({ total: 1, live: 1 }) }),
	runNode("r1", "task:A"),
];
const byRef = (nodes: FlowNode[], ref: string) =>
	nodes.find((n) => n.ref === ref) as FlowNode;

describe("run.started inserts a node", () => {
	const input = {
		runId: "r2",
		taskId: "A",
		ts: T,
		payload: { kind: "task", model: "opus", label: "A#2" },
	};

	test("under its task, with role, model and a starting state", () => {
		const nodes = insertRun(base(), input);
		const n = byRef(nodes, "run:r2");
		expect(n.parent).toBe("task:A");
		expect(n.kind).toBe("run");
		expect(n.title).toBe("A#2");
		expect(n.run).toMatchObject({
			role: "worker",
			model: "opus",
			state: "starting",
			relation: "fresh",
			finishedAt: null,
		});
		expect(n.run?.startedAt.getTime()).toBe(T);
	});

	test("counts into the rollups of every ancestor and freshens their lastAt", () => {
		const nodes = insertRun(base(), input);
		for (const ref of ["task:A", "task:E"]) {
			expect(byRef(nodes, ref).rollup).toMatchObject({ total: 2, live: 2 });
			expect(byRef(nodes, ref).lastAt.getTime()).toBe(T);
		}
	});

	test("a repair hangs under the run it grew from and names it", () => {
		const nodes = insertRun(base(), {
			...input,
			payload: { ...input.payload, parentRunId: "r1", relation: "repair" },
		});
		const n = byRef(nodes, "run:r2");
		expect(n.parent).toBe("run:r1");
		expect(n.run?.relation).toBe("repair");
		expect(n.run?.continues).toBe("run:r1");
	});

	test("a parent the tree does not hold falls back to the task; no task means a root", () => {
		const lost = insertRun(base(), {
			...input,
			payload: { ...input.payload, parentRunId: "gone", relation: "repair" },
		});
		expect(byRef(lost, "run:r2").parent).toBe("task:A");
		const root = insertRun(base(), { ...input, taskId: undefined });
		expect(byRef(root, "run:r2").parent).toBeNull();
	});

	test("is idempotent: a redelivered event adds nothing", () => {
		const once = insertRun(base(), input);
		expect(insertRun(once, input)).toBe(once);
		expect(byRef(once, "task:A").rollup?.total).toBe(2);
	});
});

describe("run.activity_changed patches the node and the needs-me count", () => {
	test("a question lights the run and every ancestor's needs-me", () => {
		const nodes = patchRunActivity(base(), "r1", "needs_answer", T);
		expect(byRef(nodes, "run:r1").run?.activity).toBe("needs_answer");
		expect(byRef(nodes, "run:r1").needsMe).toBe("question");
		expect(byRef(nodes, "task:A").rollup?.needsMe).toBe(1);
		expect(byRef(nodes, "task:E").rollup?.needsMe).toBe(1);
	});

	test("answering clears it again, never below zero", () => {
		const asked = patchRunActivity(base(), "r1", "needs_answer", T);
		const back = patchRunActivity(asked, "r1", "working", T + 1000);
		expect(byRef(back, "run:r1").needsMe).toBeNull();
		expect(byRef(back, "task:A").rollup?.needsMe).toBe(0);
		const again = patchRunActivity(back, "r1", "idle", T + 2000);
		expect(byRef(again, "task:A").rollup?.needsMe).toBe(0);
	});

	test("an unknown run, or an unchanged activity, returns the same array", () => {
		const nodes = base();
		expect(patchRunActivity(nodes, "nope", "idle", T)).toBe(nodes);
		expect(patchRunActivity(nodes, "r1", "working", T)).toBe(nodes);
	});
});

describe("run.state_changed", () => {
	test("a finished run leaves live for done and gets an end time", () => {
		const nodes = patchRunState(base(), "r1", "completed", T);
		expect(byRef(nodes, "run:r1").run?.state).toBe("completed");
		expect(byRef(nodes, "run:r1").run?.finishedAt?.getTime()).toBe(T);
		expect(byRef(nodes, "task:A").rollup).toMatchObject({ live: 0, done: 1 });
		expect(byRef(nodes, "task:E").rollup).toMatchObject({ live: 0, done: 1 });
	});

	test("a run that was asking is no longer asking once it ends", () => {
		const asking = patchRunActivity(base(), "r1", "needs_answer", T);
		const ended = patchRunState(asking, "r1", "killed", T + 1000);
		expect(byRef(ended, "run:r1").needsMe).toBeNull();
		expect(byRef(ended, "task:A").rollup?.needsMe).toBe(0);
	});

	test("moving between live states changes only the state", () => {
		const nodes = patchRunState(base(), "r1", "finalizing", T);
		expect(byRef(nodes, "run:r1").run?.state).toBe("finalizing");
		expect(byRef(nodes, "task:A").rollup).toMatchObject({ live: 1, done: 0 });
	});
});

describe("task.status_changed", () => {
	test("sets the status and, for blocked or review, the inbox reason", () => {
		const blocked = patchTaskStatus(base(), "A", "blocked", T);
		expect(byRef(blocked, "task:A").status).toEqual({
			value: "blocked",
			role: "blocked",
		});
		expect(byRef(blocked, "task:A").needsMe).toBe("inbox");
		const done = patchTaskStatus(blocked, "A", "done", T + 1000);
		expect(byRef(done, "task:A").needsMe).toBeNull();
		expect(byRef(done, "task:A").status?.value).toBe("done");
	});

	test("a task's status never clears a question its run is asking", () => {
		const asking = patchRunActivity(base(), "r1", "needs_answer", T);
		const moved = patchTaskStatus(asking, "A", "review", T + 1);
		expect(byRef(moved, "run:r1").needsMe).toBe("question");
		expect(byRef(moved, "task:A").needsMe).toBe("inbox");
	});
});

describe("spans: the live edge", () => {
	const span = (over: Partial<FlowSpan>): FlowSpan => ({
		subject: "run:r1",
		lane: "activity",
		value: "working",
		start: new Date(T - 600_000),
		end: null,
		...over,
	});

	test("closes the open span at the event and opens the next", () => {
		const next = applySpanChange([span({})], {
			subject: "run:r1",
			lane: "activity",
			value: "needs_answer",
			ts: T,
			detail: { question: "Reject?" },
		});
		expect(next).toHaveLength(2);
		expect(next[0]?.end?.getTime()).toBe(T);
		expect(next[1]).toMatchObject({
			value: "needs_answer",
			end: null,
			detail: { question: "Reject?" },
		});
		expect(next[1]?.start.getTime()).toBe(T);
	});

	test("the same value again is not a change; other lanes and runs are untouched", () => {
		const spans = [
			span({}),
			span({ subject: "run:r2" }),
			span({ lane: "state", value: "running" }),
		];
		expect(
			applySpanChange(spans, {
				subject: "run:r1",
				lane: "activity",
				value: "working",
				ts: T,
			}),
		).toBe(spans);
		const moved = applySpanChange(spans, {
			subject: "run:r1",
			lane: "activity",
			value: "idle",
			ts: T,
		});
		expect(moved[1]?.end).toBeNull();
		expect(moved[2]?.end).toBeNull();
	});

	test("a terminal state closes activity and leaves a zero-length outcome", () => {
		const changes = spanChangesFor({
			type: "run.state_changed",
			ts: T,
			runId: "r1",
			payload: { from: "running", to: "failed" },
		});
		let spans = [span({}), span({ lane: "state", value: "running" })];
		for (const c of changes) spans = applySpanChange(spans, c);
		expect(spans.find((s) => s.lane === "activity")?.end?.getTime()).toBe(T);
		const outcome = spans.find(
			(s) => s.lane === "state" && s.value === "failed",
		);
		expect(outcome?.start.getTime()).toBe(T);
		expect(outcome?.end?.getTime()).toBe(T);
		// the running state span closed too
		expect(spans.find((s) => s.value === "running")?.end?.getTime()).toBe(T);
	});

	test("events map to the lanes the lens draws, and others to nothing", () => {
		expect(
			spanChangesFor({
				type: "task.status_changed",
				ts: T,
				taskId: "A",
				payload: { to: "review" },
			}),
		).toEqual([{ subject: "task:A", lane: "status", value: "review", ts: T }]);
		expect(
			spanChangesFor({ type: "run.started", ts: T, runId: "r9", payload: {} }),
		).toEqual([{ subject: "run:r9", lane: "state", value: "starting", ts: T }]);
		expect(
			spanChangesFor({ type: "scheduler.paused", ts: T, payload: {} }),
		).toEqual([]);
	});
});

test("attention mirrors the daemon: only live runs ask", () => {
	expect(attentionOf("running", "needs_answer")).toBe("question");
	expect(attentionOf("running", "awaiting_approval")).toBe("approval");
	expect(attentionOf("running", "stalled")).toBe("stalled");
	expect(attentionOf("completed", "needs_answer")).toBeNull();
	expect(attentionOf("running", "working")).toBeNull();
});

describe("run.usage_sampled", () => {
	test("sets the run's live cost and nothing else; an unchanged cost is the same array", () => {
		const nodes = base();
		const next = patchRunLiveCost(nodes, "r1", 0.42);
		expect(byRef(next, "run:r1").run?.liveCostUsd).toBe(0.42);
		expect(byRef(next, "task:A")).toBe(byRef(nodes, "task:A"));
		expect(patchRunLiveCost(next, "r1", 0.42)).toBe(next);
		expect(patchRunLiveCost(nodes, "nope", 1)).toBe(nodes);
	});
});
