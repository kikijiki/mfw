import { asc, count, gt, inArray } from "drizzle-orm";
import type { ProjectDb } from "./client.ts";
import { events, runSpans } from "./schema.ts";
import { SPAN_EVENT_TYPES, type SpanOp, spanOpsFor } from "./spans.ts";

/**
 * Rebuild `run_spans` from recorded events (best effort, back to the event
 * retention horizon). It folds through the same `spanOpsFor` the live writer
 * uses, so replaying the events a live run produced yields the same spans.
 */

export interface FoldEvent {
	type: string;
	taskId?: string | null;
	runId?: string | null;
	payload?: unknown;
	seq: number;
	ts: number;
}

export interface FoldedSpan {
	subject: string;
	lane: string;
	value: string;
	startTs: number;
	endTs: number | null;
	detail: Record<string, unknown> | null;
	startSeq: number;
	endSeq: number | null;
}

/** Incremental in-memory fold; `rows` is every span so far, open ones last per lane. */
export class SpanFold {
	readonly rows: FoldedSpan[] = [];
	private readonly open = new Map<string, FoldedSpan>();

	push(e: FoldEvent): void {
		const ops = spanOpsFor({
			type: e.type,
			...(e.taskId ? { taskId: e.taskId } : {}),
			...(e.runId ? { runId: e.runId } : {}),
			payload: e.payload,
		} as Parameters<typeof spanOpsFor>[0]);
		for (const op of ops) this.apply(op, e);
	}

	private apply(op: SpanOp, e: FoldEvent): void {
		const key = `${op.subject}\u0000${op.lane}`;
		const open = this.open.get(key);
		if (op.value !== null && !op.instant && open?.value === op.value) {
			if (op.detail) open.detail = op.detail;
			return;
		}
		if (open) {
			open.endTs = e.ts;
			open.endSeq = e.seq;
			this.open.delete(key);
		}
		if (op.value === null) return;
		const span: FoldedSpan = {
			subject: op.subject,
			lane: op.lane,
			value: op.value,
			startTs: e.ts,
			endTs: op.instant ? e.ts : null,
			detail: op.detail ?? null,
			startSeq: e.seq,
			endSeq: op.instant ? e.seq : null,
		};
		this.rows.push(span);
		if (!op.instant) this.open.set(key, span);
	}
}

/** Fold a recorded event sequence (ascending `seq`) into spans. */
export function foldSpans(evs: readonly FoldEvent[]): FoldedSpan[] {
	const fold = new SpanFold();
	for (const e of evs) fold.push(e);
	return fold.rows;
}

const BATCH = 2_000;

/**
 * One-off backfill: fold every recorded event into spans. It only runs while
 * `run_spans` is empty AND some span-producing event exists, so a database
 * with spans (live writing owns it) or with nothing to fold is left alone, and
 * a fold always leaves the table non-empty (it never repeats). Returns the
 * number of spans written.
 */
export async function backfillSpansFromEvents(db: ProjectDb): Promise<number> {
	const [existing] = await db.select({ n: count() }).from(runSpans);
	if ((existing?.n ?? 0) > 0) return 0;
	const [producer] = await db
		.select({ seq: events.seq })
		.from(events)
		.where(inArray(events.type, [...SPAN_EVENT_TYPES]))
		.limit(1);
	if (!producer) return 0;
	const fold = new SpanFold();
	let after = 0;
	for (;;) {
		const batch = await db
			.select()
			.from(events)
			.where(gt(events.seq, after))
			.orderBy(asc(events.seq))
			.limit(BATCH);
		if (batch.length === 0) break;
		for (const e of batch) {
			fold.push({
				type: e.type,
				taskId: e.taskId,
				runId: e.runId,
				payload: e.payload,
				seq: e.seq,
				ts: e.ts.getTime(),
			});
		}
		after = (batch.at(-1) as { seq: number }).seq;
	}
	for (let i = 0; i < fold.rows.length; i += 200) {
		await db.insert(runSpans).values(
			fold.rows.slice(i, i + 200).map((r) => ({
				subject: r.subject,
				lane: r.lane,
				value: r.value,
				startTs: new Date(r.startTs),
				endTs: r.endTs === null ? null : new Date(r.endTs),
				detail: r.detail,
				startSeq: r.startSeq,
				endSeq: r.endSeq,
			})),
		);
	}
	return fold.rows.length;
}
