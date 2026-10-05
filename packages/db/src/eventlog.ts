import { EventSchema, type MfwEvent } from "@mfw/core/events";
import { and, asc, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { ProjectDb, ProjectDbTx } from "./client.ts";
import { events } from "./schema.ts";

/** Audit stream: typed appends inside the state-change transaction, post-commit fan-out, retention pruning. */

export type StoredEvent = MfwEvent & { seq: number; ts: number };
type Listener = (e: StoredEvent) => void;

/**
 * Validate and append an event in the same transaction as the state change.
 * Schema drift throws at the write site. Call `EventBus.publish` with the result after commit.
 */
export async function appendEvent(
	tx: ProjectDbTx,
	event: MfwEvent,
	now = Date.now(),
): Promise<StoredEvent> {
	const parsed = EventSchema.parse(event);
	const [row] = await tx
		.insert(events)
		.values({
			ts: new Date(now),
			type: parsed.type,
			taskId: "taskId" in parsed ? parsed.taskId : null,
			runId: "runId" in parsed ? parsed.runId : null,
			payload: parsed.payload as Record<string, unknown>,
		})
		.returning({ seq: events.seq });
	if (!row) throw new Error("event insert returned no row");
	return { ...parsed, seq: row.seq, ts: now };
}

/** Post-commit fan-out to the UI SSE subscription and lifetime on_event triggers. */
export class EventBus {
	private listeners = new Set<Listener>();

	subscribe(fn: Listener): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	publish(rows: StoredEvent[]): void {
		for (const row of rows) {
			for (const fn of this.listeners) {
				try {
					fn(row);
				} catch {
					// best-effort: a broken subscriber must not break the publisher
				}
			}
		}
	}
}

/** Cast, not re-parsed: validated at write, and old rows may predate the current union. */
function toStored(row: typeof events.$inferSelect): StoredEvent {
	return {
		type: row.type,
		taskId: row.taskId ?? undefined,
		runId: row.runId ?? undefined,
		payload: row.payload,
		seq: row.seq,
		ts: row.ts.getTime(),
	} as StoredEvent;
}

export async function eventsSince(
	db: ProjectDb,
	seq: number,
	limit = 500,
): Promise<StoredEvent[]> {
	const rows = await db
		.select()
		.from(events)
		.where(gt(events.seq, seq))
		.orderBy(events.seq)
		.limit(limit);
	return rows.map(toStored);
}

/** Filters for the paged audit feed. */
export interface EventQuery {
	/** Forward page: rows with seq > sinceSeq, oldest first (tailing). */
	sinceSeq?: number;
	/** Backward page: rows with seq < beforeSeq, newest first (scrollback). */
	beforeSeq?: number;
	limit?: number;
	types?: string[];
	taskId?: string;
}

export interface EventPage {
	events: StoredEvent[];
	cursor: {
		/** Feed back as `beforeSeq` for the next older page; null at the end. */
		nextBeforeSeq: number | null;
		/** Feed back as `sinceSeq` to tail everything newer than this page. */
		nextSinceSeq: number;
		hasMore: boolean;
	};
}

/**
 * One page of the audit stream, newest-first by `beforeSeq`. A seq cursor is
 * stable under concurrent appends (new rows get higher seq). `sinceSeq` flips to oldest-first for tailing.
 */
export async function listEvents(
	db: ProjectDb,
	query: EventQuery = {},
): Promise<EventPage> {
	const limit = Math.min(Math.max(query.limit ?? 100, 1), 200);
	const forward = query.sinceSeq !== undefined;
	const conds = [
		query.sinceSeq !== undefined ? gt(events.seq, query.sinceSeq) : undefined,
		query.beforeSeq !== undefined ? lt(events.seq, query.beforeSeq) : undefined,
		query.types?.length ? inArray(events.type, query.types) : undefined,
		query.taskId ? eq(events.taskId, query.taskId) : undefined,
	].filter((c) => c !== undefined);

	const rows = await db
		.select()
		.from(events)
		.where(conds.length > 0 ? and(...conds) : undefined)
		.orderBy(forward ? asc(events.seq) : desc(events.seq))
		.limit(limit + 1); // one extra row answers hasMore without a count query

	const hasMore = rows.length > limit;
	const page = (hasMore ? rows.slice(0, limit) : rows).map(toStored);
	const seqs = page.map((e) => e.seq);
	return {
		events: page,
		cursor: {
			nextBeforeSeq:
				!forward && hasMore && seqs.length > 0 ? (seqs.at(-1) as number) : null,
			nextSinceSeq: seqs.length > 0 ? Math.max(...seqs) : (query.sinceSeq ?? 0),
			hasMore,
		},
	};
}

/** Drop events older than `maxAgeDays`, always keeping the newest `keepAtLeast` rows. */
export async function pruneEvents(
	db: ProjectDb,
	opts: { maxAgeDays?: number; keepAtLeast?: number } = {},
): Promise<number> {
	const maxAgeDays = opts.maxAgeDays ?? 90;
	const keepAtLeast = opts.keepAtLeast ?? 50_000;
	const cutoffTs = new Date(Date.now() - maxAgeDays * 86_400_000);
	const [nth] = await db
		.select({ seq: events.seq })
		.from(events)
		.orderBy(desc(events.seq))
		.limit(1)
		.offset(keepAtLeast - 1);
	if (!nth) return 0; // fewer rows than the floor, nothing to prune
	const res = await db
		.delete(events)
		.where(and(lt(events.ts, cutoffTs), lt(events.seq, nth.seq)))
		.returning({ seq: events.seq });
	return res.length;
}

/** Cheap head for "what changed since I was away" cursors. */
export async function latestSeq(db: ProjectDb): Promise<number> {
	const [row] = await db
		.select({ seq: sql<number>`COALESCE(MAX(${events.seq}), 0)` })
		.from(events);
	return row?.seq ?? 0;
}
