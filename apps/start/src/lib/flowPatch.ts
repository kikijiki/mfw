import type { FlowNode, FlowSpan } from "@mfw/daemon/flow";

/**
 * Pure patches for the Flow caches (`flow.tree`, `flow.live`, `flow.spans`),
 * applied by `lib/live.ts` as audit events arrive. Each takes the cached
 * array and returns a new one (or the same array when there is nothing to
 * do), so the cache work is a `setQueryData` around a function that tests can
 * call directly.
 *
 * They patch only what the event's payload carries (state, activity, status,
 * a run's identity and lineage); anything else (cost, host, a task's title)
 * waits for the accompanying invalidation.
 */

const LIVE_STATES = new Set([
	"starting",
	"running",
	"ended",
	"finalizing",
	"merging",
]);
/** Relations that hang a run under another run rather than under its task (mirrors `flowTree`). */
const UNDER_PARENT_RUN = new Set([
	"continue",
	"repair",
	"resume",
	"answer",
	"unblock",
	"judge",
	"replan",
	"recovery",
]);
const CHAIN = new Set(["continue", "repair", "resume", "answer", "unblock"]);

type NeedsMe = FlowNode["needsMe"];

/** What a live run needs from a person (mirrors the daemon's `attentionOf`). */
export function attentionOf(state: string, activity: string | null): NeedsMe {
	if (!LIVE_STATES.has(state)) return null;
	switch (activity) {
		case "needs_answer":
			return "question";
		case "awaiting_approval":
			return "approval";
		case "stalled":
			return "stalled";
		default:
			return null;
	}
}

function roleOf(kind: string): string {
	switch (kind) {
		case "task":
			return "worker";
		case "brain":
			return "judge";
		case "repair":
			return "recovery";
		case "plan":
			return "planner";
		default:
			return kind;
	}
}

const isLive = (n: FlowNode) =>
	n.run !== undefined && LIVE_STATES.has(n.run.state);

/** Replace one node and, via `bump`, every ancestor that carries a rollup. Returns the same array when `ref` is absent. */
function update(
	nodes: readonly FlowNode[],
	ref: string,
	change: (node: FlowNode) => FlowNode,
	bump?: (rollup: NonNullable<FlowNode["rollup"]>) => void,
	at?: number,
): FlowNode[] {
	const byRef = new Map(nodes.map((n) => [n.ref, n]));
	const target = byRef.get(ref);
	if (!target) return nodes as FlowNode[];
	const changed = new Map<string, FlowNode>([[ref, change(target)]]);
	const guard = new Set<string>([ref]);
	let up = target.parent ? byRef.get(target.parent) : undefined;
	while (up && !guard.has(up.ref)) {
		guard.add(up.ref);
		const next: FlowNode = { ...up };
		if (at !== undefined && next.lastAt.getTime() < at)
			next.lastAt = new Date(at);
		if (bump && up.rollup) {
			const rollup = { ...up.rollup };
			bump(rollup);
			next.rollup = rollup;
		}
		changed.set(up.ref, next);
		up = up.parent ? byRef.get(up.parent) : undefined;
	}
	return nodes.map((n) => changed.get(n.ref) ?? n);
}

export interface RunStartedInput {
	runId: string;
	taskId?: string | undefined;
	ts: number;
	payload: {
		kind: string;
		model: string;
		parentRunId?: string | undefined;
		relation?: string | undefined;
		label?: string | undefined;
	};
}

/** `run.started`: insert the run's node under its task or parent run, and count it into the ancestors' rollups. */
export function insertRun(
	nodes: readonly FlowNode[],
	input: RunStartedInput,
): FlowNode[] {
	const ref = `run:${input.runId}`;
	if (nodes.some((n) => n.ref === ref)) return nodes as FlowNode[];
	const relation = input.payload.relation ?? "fresh";
	const taskId = input.taskId ?? undefined;
	const parentRunRef = input.payload.parentRunId
		? `run:${input.payload.parentRunId}`
		: null;
	let parent: string | null = null;
	if (
		parentRunRef &&
		UNDER_PARENT_RUN.has(relation) &&
		nodes.some((n) => n.ref === parentRunRef)
	)
		parent = parentRunRef;
	else if (taskId && nodes.some((n) => n.ref === `task:${taskId}`))
		parent = `task:${taskId}`;
	const at = new Date(input.ts);
	const label = input.payload.label ?? input.runId;
	const node: FlowNode = {
		ref,
		parent,
		kind: input.payload.kind === "brain" ? "judge" : "run",
		title: label,
		run: {
			role: roleOf(input.payload.kind),
			relation,
			state: "starting",
			activity: null,
			harness: null,
			model: input.payload.model,
			effort: null,
			host: null,
			label,
			startedAt: at,
			finishedAt: null,
			costUsd: null,
			liveCostUsd: null,
			...(parentRunRef && CHAIN.has(relation)
				? { continues: parentRunRef }
				: {}),
		},
		needsMe: null,
		lastAt: at,
	};
	// Count it into the rollups of everything above it.
	const withNode = [...nodes, node];
	return update(
		withNode,
		ref,
		(n) => n,
		(r) => {
			r.total += 1;
			r.live += 1;
		},
		input.ts,
	);
}

/** `run.state_changed`: the run's state, its end time, and the live/done/needs-me counts above it. */
export function patchRunState(
	nodes: readonly FlowNode[],
	runId: string,
	to: string,
	ts: number,
): FlowNode[] {
	const ref = `run:${runId}`;
	const node = nodes.find((n) => n.ref === ref);
	if (!node?.run || node.run.state === to) return nodes as FlowNode[];
	const wasLive = isLive(node);
	const nowLive = LIVE_STATES.has(to);
	const hadNeed = node.needsMe !== null;
	const needsMe = attentionOf(to, node.run.activity);
	return update(
		nodes,
		ref,
		(n) => ({
			...n,
			needsMe,
			lastAt: new Date(ts),
			run: {
				...(n.run as NonNullable<FlowNode["run"]>),
				state: to,
				finishedAt: nowLive ? null : new Date(ts),
			},
		}),
		(r) => {
			if (wasLive && !nowLive) {
				r.live = Math.max(0, r.live - 1);
				r.done += 1;
			} else if (!wasLive && nowLive) {
				r.live += 1;
				r.done = Math.max(0, r.done - 1);
			}
			if (hadNeed && needsMe === null) r.needsMe = Math.max(0, r.needsMe - 1);
			else if (!hadNeed && needsMe !== null) r.needsMe += 1;
		},
		ts,
	);
}

/** `run.activity_changed`: the run's activity, whether it now needs a person, and the needs-me count above it. */
export function patchRunActivity(
	nodes: readonly FlowNode[],
	runId: string,
	to: string,
	ts: number,
): FlowNode[] {
	const ref = `run:${runId}`;
	const node = nodes.find((n) => n.ref === ref);
	if (!node?.run || node.run.activity === to) return nodes as FlowNode[];
	const needsMe = attentionOf(node.run.state, to);
	const hadNeed = node.needsMe !== null;
	return update(
		nodes,
		ref,
		(n) => ({
			...n,
			needsMe,
			lastAt: new Date(ts),
			run: { ...(n.run as NonNullable<FlowNode["run"]>), activity: to },
		}),
		(r) => {
			if (hadNeed && needsMe === null) r.needsMe = Math.max(0, r.needsMe - 1);
			else if (!hadNeed && needsMe !== null) r.needsMe += 1;
		},
		ts,
	);
}

/** `run.usage_sampled`: the run's running cost, for the chip's `$`. Nothing above it changes. */
export function patchRunLiveCost(
	nodes: readonly FlowNode[],
	runId: string,
	costUsd: number | null,
): FlowNode[] {
	const ref = `run:${runId}`;
	const i = nodes.findIndex((n) => n.ref === ref);
	const node = nodes[i];
	if (!node?.run || node.run.liveCostUsd === costUsd)
		return nodes as FlowNode[];
	const next = nodes.slice();
	next[i] = { ...node, run: { ...node.run, liveCostUsd: costUsd } };
	return next;
}

/** `task.status_changed`: the task's status, and the "needs you" an unattended `blocked` or `review` implies. */
export function patchTaskStatus(
	nodes: readonly FlowNode[],
	taskId: string,
	to: string,
	ts: number,
): FlowNode[] {
	const ref = `task:${taskId}`;
	const node = nodes.find((n) => n.ref === ref);
	if (!node || node.status?.value === to) return nodes as FlowNode[];
	const inbox = to === "blocked" || to === "review";
	return update(
		nodes,
		ref,
		(n) => ({
			...n,
			status: { value: to, role: to },
			// Only the inbox reason is a task's own; a run's question is not touched.
			needsMe: inbox ? "inbox" : n.needsMe === "inbox" ? null : n.needsMe,
			lastAt: new Date(ts),
		}),
		undefined,
		ts,
	);
}

// ---------------------------------------------------------------------------
// spans
// ---------------------------------------------------------------------------

export interface SpanChange {
	subject: string;
	lane: string;
	/** `null` closes the lane's open span and opens nothing. */
	value: string | null;
	ts: number;
	detail?: Record<string, unknown>;
	/** A zero-length outcome span (a run's terminal state). */
	instant?: boolean;
}

/** Close the lane's open span at `ts` and open the next one: the live edge of the timeline. */
export function applySpanChange(
	spans: readonly FlowSpan[],
	change: SpanChange,
): FlowSpan[] {
	const at = new Date(change.ts);
	let closed = false;
	const out = spans.map((s) => {
		if (
			!closed &&
			s.subject === change.subject &&
			s.lane === change.lane &&
			s.end === null
		) {
			closed = true;
			return { ...s, end: at };
		}
		return s;
	});
	// A value the lane already holds open is not a change.
	if (
		change.value !== null &&
		!change.instant &&
		spans.some(
			(s) =>
				s.subject === change.subject &&
				s.lane === change.lane &&
				s.end === null &&
				s.value === change.value,
		)
	)
		return spans as FlowSpan[];
	if (change.value === null) return closed ? out : (spans as FlowSpan[]);
	out.push({
		subject: change.subject,
		lane: change.lane,
		value: change.value,
		start: at,
		end: change.instant ? at : null,
		...(change.detail ? { detail: change.detail } : {}),
	});
	return out;
}

/** The span changes one audit event makes, for the lanes the lens draws (mirrors `spanOpsFor`). */
export function spanChangesFor(event: {
	type: string;
	ts: number;
	runId?: string | undefined;
	taskId?: string | undefined;
	payload: unknown;
}): SpanChange[] {
	const p = (event.payload ?? {}) as Record<string, unknown>;
	const run = event.runId ? `run:${event.runId}` : null;
	switch (event.type) {
		case "run.started":
			return run
				? [{ subject: run, lane: "state", value: "starting", ts: event.ts }]
				: [];
		case "run.state_changed": {
			if (!run || typeof p.to !== "string") return [];
			if (LIVE_STATES.has(p.to))
				return [{ subject: run, lane: "state", value: p.to, ts: event.ts }];
			return [
				{ subject: run, lane: "activity", value: null, ts: event.ts },
				{ subject: run, lane: "admission", value: null, ts: event.ts },
				{ subject: run, lane: "merge", value: null, ts: event.ts },
				{
					subject: run,
					lane: "state",
					value: p.to,
					ts: event.ts,
					instant: true,
				},
			];
		}
		case "run.activity_changed": {
			if (!run || typeof p.to !== "string") return [];
			const detail: Record<string, unknown> = {};
			if (typeof p.question === "string") detail.question = p.question;
			if (typeof p.stallCause === "string") detail.stallCause = p.stallCause;
			if (typeof p.pendingApprovals === "number")
				detail.pendingApprovals = p.pendingApprovals;
			return [
				{
					subject: run,
					lane: "activity",
					value: p.to,
					ts: event.ts,
					...(Object.keys(detail).length ? { detail } : {}),
				},
			];
		}
		case "task.status_changed":
			return event.taskId && typeof p.to === "string"
				? [
						{
							subject: `task:${event.taskId}`,
							lane: "status",
							value: p.to,
							ts: event.ts,
						},
					]
				: [];
		default:
			return [];
	}
}
