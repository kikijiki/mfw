import type { ProjectDb, ProjectDbHandle, ProjectDbTx } from "@mfw/db/client";
import type { EventBus } from "@mfw/db/eventlog";
import { appendEvent, type StoredEvent } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import {
	brainActions,
	brainSessions,
	brainTurns,
	engineKv,
} from "@mfw/db/schema";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";

/**
 * Give direction (DESIGN W2): the owner steers in one sentence and the brain,
 * as tech lead, drafts the work with its ordinary act tools under the decision
 * rights. A direction is a `human.brain_message`, so it wakes the brain at
 * once, is retried until a turn ends ok, and is tagged `owner` in the digest.
 *
 * The ledger (id, idempotency key, text) lives in `engine_kv`. Status is never
 * stored: it is read off the turns that received the event and their actions,
 * so it cannot disagree with them.
 */

export const DIRECTION_MAX_CHARS = 500;
export const DIRECTION_RATE = { perMinute: 5, perHour: 30 };

const DIRECTIONS_KEY = "brain_directions";
/** Must exceed `perHour`, since the rate limit is counted from this list. */
const KEEP = 100;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export type DirectionErrorCode =
	| "invalid"
	| "key_reused"
	| "rate_limited"
	| "no_brain";

export class DirectionError extends Error {
	constructor(
		readonly code: DirectionErrorCode,
		message: string,
	) {
		super(message);
		this.name = "DirectionError";
	}
}

/**
 * One plain line: whitespace collapses (so the text cannot start a digest
 * heading), and control, zero-width and bidi characters go.
 */
export function sanitizeDirection(raw: string): string {
	const text = raw
		.replace(/\s+/gu, " ")
		.replace(/[\p{Cc}\p{Cf}]/gu, "")
		.trim();
	if (text === "") throw new DirectionError("invalid", "Write one sentence.");
	if (text.length > DIRECTION_MAX_CHARS) {
		throw new DirectionError(
			"invalid",
			`Keep it to ${DIRECTION_MAX_CHARS} characters.`,
		);
	}
	return text;
}

export type DirectionStatus =
	| "drafting"
	| "drafted"
	| "held"
	| "done"
	/** The brain took its turn and drafted nothing: never shown as a draft. */
	| "no_draft";

/** The status rule. Only `done` tasks count as done; archived work did not land. */
export function directionStatus(f: {
	turnEnded: boolean;
	heldCount: number;
	draftCount: number;
	taskStates: readonly string[];
}): DirectionStatus {
	if (f.heldCount > 0) return "held";
	if (!f.turnEnded) return "drafting";
	if (f.draftCount === 0) return "no_draft";
	return f.taskStates.length > 0 && f.taskStates.every((s) => s === "done")
		? "done"
		: "drafted";
}

/** The act tools whose effect is a draft of the work. */
const DRAFT_TOOLS: ReadonlySet<string> = new Set([
	"create_tasks",
	"update_task",
	"split_task",
	"merge_tasks",
	"reparent",
	"spawn",
	"spawn_attempts",
]);
const DRAFT_STATES: ReadonlySet<string> = new Set([
	"accepted",
	"applied",
	"proposed",
]);

interface Entry {
	id: string;
	key: string;
	text: string;
	at: number;
	seq: number;
}

export interface DirectionView {
	id: string;
	text: string;
	at: number;
	status: DirectionStatus;
	/** False until a turn has picked it up. */
	received: boolean;
	taskIds: string[];
	heldActionIds: string[];
}

async function readLedger(db: ProjectDb | ProjectDbTx): Promise<Entry[]> {
	const [row] = await db
		.select()
		.from(engineKv)
		.where(eq(engineKv.key, DIRECTIONS_KEY));
	return (row?.value as { items?: Entry[] } | undefined)?.items ?? [];
}

function resultIds(effects: Record<string, unknown> | null): string[] {
	const r = effects?.result as { ids?: unknown; id?: unknown } | undefined;
	if (Array.isArray(r?.ids)) return r.ids.map(String);
	return typeof r?.id === "string" ? [r.id] : [];
}

export class BrainDirections {
	private readonly now: () => number;

	constructor(
		private readonly deps: {
			handle: Pick<ProjectDbHandle, "db" | "withTx">;
			bus: EventBus;
			taskStatus: (id: string) => Promise<string | null>;
			now?: () => number;
		},
	) {
		this.now = deps.now ?? (() => Date.now());
	}

	/** Record and deliver one direction. The same `key` is the same submit. */
	async give(input: {
		text: string;
		key: string;
	}): Promise<{ id: string; duplicate: boolean }> {
		const text = sanitizeDirection(input.text);
		const now = this.now();
		let event: StoredEvent | null = null;
		const id = await this.deps.handle.withTx(async (tx) => {
			const items = await readLedger(tx);
			const twin = items.find((i) => i.key === input.key);
			if (twin) {
				if (twin.text !== text) {
					throw new DirectionError(
						"key_reused",
						"This submit key was already used for different text.",
					);
				}
				return twin.id;
			}
			const within = (ms: number) =>
				items.filter((i) => now - i.at < ms).length;
			if (
				within(MINUTE) >= DIRECTION_RATE.perMinute ||
				within(HOUR) >= DIRECTION_RATE.perHour
			) {
				throw new DirectionError(
					"rate_limited",
					"Too many directions just now. Give the brain a moment.",
				);
			}
			// A new session starts at the log's head, so an event written before
			// the first one would never be delivered.
			const [session] = await tx
				.select({ id: brainSessions.id })
				.from(brainSessions)
				.orderBy(desc(brainSessions.createdAt))
				.limit(1);
			if (!session) {
				throw new DirectionError(
					"no_brain",
					"The brain has not started in this project yet.",
				);
			}
			const newId = ulid();
			event = await appendEvent(
				tx,
				{
					type: "human.brain_message",
					payload: {
						sessionId: session.id,
						text,
						about: `direction:${newId}`,
					},
				},
				now,
			);
			const next = [
				...items,
				{ id: newId, key: input.key, text, at: now, seq: event.seq },
			].slice(-KEEP);
			const value = { items: next } as Record<string, unknown>;
			await tx
				.insert(engineKv)
				.values({ key: DIRECTIONS_KEY, value, updatedAt: new Date(now) })
				.onConflictDoUpdate({
					target: engineKv.key,
					set: { value, updatedAt: new Date(now) },
				});
			return newId;
		});
		if (event) this.deps.bus.publish([event]);
		return { id, duplicate: event === null };
	}

	/**
	 * Newest first, with status. A turn that received several directions
	 * counts for each of them: the host cannot tell which one an action served.
	 */
	async list(limit = 10): Promise<DirectionView[]> {
		const db = this.deps.handle.db;
		const items = (await readLedger(db)).slice(-limit).reverse();
		const out: DirectionView[] = [];
		for (const d of items) {
			const turns = await db
				.select({ runId: brainTurns.runId, status: brainTurns.status })
				.from(brainTurns)
				.where(
					and(
						lte(brainTurns.eventsFrom, d.seq),
						gte(brainTurns.eventsTo, d.seq),
					),
				);
			const actions = turns.length
				? await db
						.select()
						.from(brainActions)
						.where(
							inArray(
								brainActions.turnRunId,
								turns.map((t) => t.runId),
							),
						)
				: [];
			const held = actions.filter((a) => a.status === "held");
			const drafts = actions.filter(
				(a) => DRAFT_TOOLS.has(a.tool) && DRAFT_STATES.has(a.status),
			);
			const taskIds = [...new Set(drafts.flatMap((a) => resultIds(a.effects)))];
			const taskStates: string[] = [];
			for (const id of taskIds) {
				const s = await this.deps.taskStatus(id);
				if (s) taskStates.push(s);
			}
			out.push({
				id: d.id,
				text: d.text,
				at: d.at,
				status: directionStatus({
					turnEnded: turns.some((t) => t.status === "ok"),
					heldCount: held.length,
					draftCount: drafts.length,
					taskStates,
				}),
				received: turns.length > 0,
				taskIds,
				heldActionIds: held.map((a) => a.id),
			});
		}
		return out;
	}
}
