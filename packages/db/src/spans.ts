import type { MfwEvent } from "@mfw/core/events";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { ProjectDbTx } from "./client.ts";
import { runSpans } from "./schema.ts";

/**
 * `run_spans`: a durable per-subject timeline (data-and-api §2.3). A span is a
 * value held on one lane of one subject between two events. Spans are derived
 * from the audit events themselves, by `spanOpsFor`, and written by
 * `appendEvent` in the SAME transaction as the event, so a span and the event
 * that opened or closed it commit or roll back together. The boot backfill
 * (`spans-backfill.ts`) folds old events through the same ops, so live writing
 * and replay cannot drift.
 */

export type SpanLane =
	| "state"
	| "activity"
	| "status"
	| "hold"
	| "admission"
	| "merge";

/** Run states in which a run no longer owns its task's claim (mirror of the registry's CLAIM_HOLDING set). */
const LIVE_RUN_STATES = new Set([
	"starting",
	"running",
	"ended",
	"finalizing",
	"merging",
]);
export const isTerminalRunState = (s: string): boolean =>
	!LIVE_RUN_STATES.has(s);

/** Admission states after which the admission no longer holds anything back. */
const TERMINAL_ADMISSION = new Set([
	"launched",
	"released",
	"cancelled",
	"failed",
]);

/** Event types that can open or close a span (`spanOpsFor` returns ops for exactly these). */
export const SPAN_EVENT_TYPES = [
	"run.started",
	"run.state_changed",
	"run.activity_changed",
	"task.status_changed",
	"task.deleted",
	"admission.state_changed",
	"merge.parked",
	"merge.retried",
	"merge.unblock_started",
	"merge.completed",
	"merge.abandoned",
] as const;

export interface SpanOp {
	subject: string;
	lane: SpanLane;
	/** `null` closes the lane's open span and opens nothing. */
	value: string | null;
	detail?: Record<string, unknown>;
	/** Zero-length span (open and close at the event): a point-in-time outcome. */
	instant?: boolean;
}

type EventLike = Pick<MfwEvent, "type"> & {
	taskId?: string;
	runId?: string;
	payload?: unknown;
};

const runSubject = (id: string) => `run:${id}`;

/** What one event does to the timeline. Pure; the only place event semantics map to spans. */
export function spanOpsFor(event: EventLike): SpanOp[] {
	const p = (event.payload ?? {}) as Record<string, unknown>;
	const runId = event.runId;
	switch (event.type) {
		case "run.started":
			if (!runId) return [];
			return [{ subject: runSubject(runId), lane: "state", value: "starting" }];
		case "run.state_changed": {
			if (!runId || typeof p.to !== "string") return [];
			const subject = runSubject(runId);
			if (!isTerminalRunState(p.to)) {
				return [{ subject, lane: "state", value: p.to }];
			}
			// Terminal: everything the run had open ends with it, and the final
			// state is kept as a zero-length span so the outcome shows on the lane.
			return [
				{ subject, lane: "activity", value: null },
				{ subject, lane: "admission", value: null },
				{ subject, lane: "merge", value: null },
				{ subject, lane: "state", value: p.to, instant: true },
			];
		}
		case "run.activity_changed": {
			if (!runId || typeof p.to !== "string") return [];
			const detail: Record<string, unknown> = {};
			if (typeof p.question === "string") detail.question = p.question;
			if (typeof p.stallCause === "string") detail.stallCause = p.stallCause;
			if (typeof p.pendingApprovals === "number")
				detail.pendingApprovals = p.pendingApprovals;
			return [
				{
					subject: runSubject(runId),
					lane: "activity",
					value: p.to,
					...(Object.keys(detail).length ? { detail } : {}),
				},
			];
		}
		case "task.status_changed": {
			if (!event.taskId || typeof p.to !== "string") return [];
			const detail: Record<string, unknown> = {};
			if (typeof p.from === "string") detail.from = p.from;
			if (typeof p.actor === "string") detail.actor = p.actor;
			if (typeof p.reason === "string") detail.reason = p.reason;
			return [
				{
					subject: `task:${event.taskId}`,
					lane: "status",
					value: p.to,
					detail,
				},
			];
		}
		case "task.deleted":
			if (!event.taskId) return [];
			return [{ subject: `task:${event.taskId}`, lane: "status", value: null }];
		case "admission.state_changed": {
			if (!runId || typeof p.to !== "string") return [];
			return [
				{
					subject: runSubject(runId),
					lane: "admission",
					value: TERMINAL_ADMISSION.has(p.to) ? null : p.to,
				},
			];
		}
		case "merge.parked":
			if (!runId) return [];
			return [
				{
					subject: runSubject(runId),
					lane: "merge",
					value: "parked",
					...(typeof p.reason === "string"
						? { detail: { reason: p.reason } }
						: {}),
				},
			];
		case "merge.retried":
		case "merge.unblock_started":
			if (!runId) return [];
			return [{ subject: runSubject(runId), lane: "merge", value: null }];
		case "merge.completed":
			if (!runId) return [];
			return [
				{
					subject: runSubject(runId),
					lane: "merge",
					value: "merged",
					instant: true,
				},
			];
		case "merge.abandoned":
			if (!runId) return [];
			return [
				{
					subject: runSubject(runId),
					lane: "merge",
					value: "abandoned",
					instant: true,
				},
			];
		default:
			return [];
	}
}

/** Write one event's span ops inside the caller's transaction. */
export async function applySpanOps(
	tx: ProjectDbTx,
	ops: readonly SpanOp[],
	at: { ts: number; seq: number },
): Promise<void> {
	for (const op of ops) {
		const [open] = await tx
			.select({
				id: runSpans.id,
				value: runSpans.value,
			})
			.from(runSpans)
			.where(
				and(
					eq(runSpans.subject, op.subject),
					eq(runSpans.lane, op.lane),
					isNull(runSpans.endTs),
				),
			)
			.orderBy(desc(runSpans.id))
			.limit(1);
		if (op.value !== null && !op.instant && open?.value === op.value) {
			// Same value again (a detail refresh): the span carries on.
			if (op.detail) {
				await tx
					.update(runSpans)
					.set({ detail: op.detail })
					.where(eq(runSpans.id, open.id));
			}
			continue;
		}
		if (open) {
			await tx
				.update(runSpans)
				.set({ endTs: new Date(at.ts), endSeq: at.seq })
				.where(eq(runSpans.id, open.id));
		}
		if (op.value === null) continue;
		await tx.insert(runSpans).values({
			subject: op.subject,
			lane: op.lane,
			value: op.value,
			startTs: new Date(at.ts),
			endTs: op.instant ? new Date(at.ts) : null,
			detail: op.detail ?? null,
			startSeq: at.seq,
			endSeq: op.instant ? at.seq : null,
		});
	}
}
