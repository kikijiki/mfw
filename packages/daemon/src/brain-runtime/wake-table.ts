import type { WakeClass } from "@mfw/core/events";

/**
 * The fixed wake table: which audit events wake the brain, and how long each
 * class waits for the burst to settle. Pure: `BrainWaker` feeds it the events
 * since the session's cursor and the clock.
 *
 * `settled` is exactly `run.settled`, which finalize's `settle` terminal (and
 * the merge queue's parked jobs) append. A run that merges through the
 * single-run fast path emits none: a verified success needs no brain, and it
 * is told in the next digest (`merge.completed` is a `frontier` event).
 */

export interface WakeEvent {
	seq: number;
	ts: number;
	type: string;
	taskId?: string | null;
	runId?: string | null;
	payload: Record<string, unknown>;
}

/** Quiet period before a class fires, and the longest a stream of events may keep postponing it. */
export const DEBOUNCE: Record<
	Exclude<WakeClass, "heartbeat">,
	{ quietMs: number; maxMs: number }
> = {
	settled: { quietMs: 10_000, maxMs: 60_000 },
	attention: { quietMs: 5_000, maxMs: 30_000 },
	frontier: { quietMs: 30_000, maxMs: 5 * 60_000 },
	capacity: { quietMs: 30_000, maxMs: 3 * 60_000 },
	merge: { quietMs: 10_000, maxMs: 60_000 },
	human: { quietMs: 0, maxMs: 0 },
};

/** When several classes are due the most urgent names the turn. */
export const WAKE_PRIORITY: readonly Exclude<WakeClass, "heartbeat">[] = [
	"human",
	"attention",
	"settled",
	"merge",
	"capacity",
	"frontier",
];

const ATTENTION_ACTIVITIES = new Set([
	"needs_answer",
	"awaiting_approval",
	"stalled",
]);

/**
 * The wake class an event belongs to, or null. `runKind` resolves a run id to
 * its kind: a brain turn's own state changes must never wake the brain.
 */
export function classifyEvent(
	e: WakeEvent,
	runKind: (runId: string) => string | undefined,
): Exclude<WakeClass, "heartbeat"> | null {
	const fromBrainRun = () => !!e.runId && runKind(e.runId) === "brain";
	switch (e.type) {
		case "run.settled":
			return "settled";
		case "run.activity_changed":
			if (fromBrainRun()) return null;
			return ATTENTION_ACTIVITIES.has(String(e.payload.to))
				? "attention"
				: null;
		case "run.scope_changed":
			return e.payload.level === "violation" ? "attention" : null;
		case "task.created":
			// Tasks the brain wrote itself are in its own record already.
			return String(e.payload.createdBy ?? "").startsWith("brain:")
				? null
				: "frontier";
		case "task.deleted":
		case "merge.completed":
			return "frontier";
		case "task.edited":
			// The brain's own edits (P4) must not wake it; a human's do.
			return e.payload.source === "brain" ? null : "frontier";
		case "task.status_changed":
			if (e.payload.actor === "brain") return null;
			return e.payload.to === "ready" || e.payload.from === "blocked"
				? "frontier"
				: null;
		case "rate_limit.hit":
		case "rate_limit.cleared":
		case "scheduler.paused":
		case "scheduler.resumed":
		case "budget.threshold":
		case "budget.exhausted":
		case "budget.restored":
			return "capacity";
		case "merge.parked":
		case "merge.abandoned":
		case "main.red":
		case "main.green":
		case "main.red_escalated":
			return "merge";
		case "human.brain_message":
		case "human.override":
			return "human";
		case "clarify.resolved":
			// A person answered a worker's question: the brain continues the run.
			return e.payload.answered === true && e.payload.by !== "brain"
				? "human"
				: null;
		// An effect the executor could not apply (a spawn the engine refused):
		// the brain must hear about it, not discover it at the next heartbeat.
		case "brain.action":
			return e.payload.status === "failed" ? "attention" : null;
		// A competing group that ended or was decided changes what is next.
		case "run.group_changed":
			return e.payload.status === "abandoned" ? "settled" : null;
		default:
			return null;
	}
}

/** Every event type `classifyEvent` can map to a class: lets a query skip the noise in SQL. */
export const WAKE_EVENT_TYPES = [
	"run.settled",
	"run.activity_changed",
	"run.scope_changed",
	"task.created",
	"task.deleted",
	"task.edited",
	"task.status_changed",
	"merge.completed",
	"merge.parked",
	"merge.abandoned",
	"main.red",
	"main.green",
	"main.red_escalated",
	"rate_limit.hit",
	"rate_limit.cleared",
	"scheduler.paused",
	"scheduler.resumed",
	"budget.threshold",
	"budget.exhausted",
	"budget.restored",
	"human.brain_message",
	"brain.action",
	"run.group_changed",
	"human.override",
	"clarify.resolved",
] as const;

export interface PendingWake {
	class: Exclude<WakeClass, "heartbeat">;
	count: number;
	firstAt: number;
	lastAt: number;
}

/** Fold classified events into one pending record per class. */
export function pendingWakes(
	events: readonly WakeEvent[],
	runKind: (runId: string) => string | undefined,
): PendingWake[] {
	const byClass = new Map<string, PendingWake>();
	for (const e of events) {
		const cls = classifyEvent(e, runKind);
		if (!cls) continue;
		const cur = byClass.get(cls);
		if (cur) {
			cur.count++;
			cur.firstAt = Math.min(cur.firstAt, e.ts);
			cur.lastAt = Math.max(cur.lastAt, e.ts);
		} else {
			byClass.set(cls, { class: cls, count: 1, firstAt: e.ts, lastAt: e.ts });
		}
	}
	return [...byClass.values()];
}

/**
 * The class that should wake the brain now: a class is due when its burst has
 * been quiet for `quietMs`, or has been open for `maxMs` (a steady trickle
 * must not postpone the wake forever). Returns the most urgent due class.
 */
export function dueWake(
	pending: readonly PendingWake[],
	now: number,
): Exclude<WakeClass, "heartbeat"> | null {
	const due = pending.filter((p) => {
		const d = DEBOUNCE[p.class];
		return now - p.lastAt >= d.quietMs || now - p.firstAt >= d.maxMs;
	});
	for (const cls of WAKE_PRIORITY) {
		if (due.some((p) => p.class === cls)) return cls;
	}
	return null;
}
