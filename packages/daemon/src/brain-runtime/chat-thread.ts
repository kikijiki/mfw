import type { ProjectDb, ProjectDbHandle, ProjectDbTx } from "@mfw/db/client";
import { ulid } from "@mfw/db/ids";
import { engineKv } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import type { ChatCitation } from "./chat-tools.ts";
import type { Provenance } from "./decision-rights.ts";

/**
 * The chat transcript: append-only entries in one `engine_kv` row, and the
 * only thing a chat turn writes to the project database. Whether a question
 * is still open is derived (no answer entry names it), so a crash cannot leave
 * a status that disagrees with the entries.
 */

export const CHAT_THREAD_KEY = "brain_chat_thread";
export const CHAT_RATE = { perMinute: 6, perHour: 40 };
/** At most three entries per exchange, so this always covers `perHour`. */
export const CHAT_KEEP_ENTRIES = 240;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export type ChatErrorCode =
	| "invalid"
	| "key_reused"
	| "rate_limited"
	| "not_found"
	| "no_offer";

export class ChatError extends Error {
	constructor(
		readonly code: ChatErrorCode,
		message: string,
	) {
		super(message);
		this.name = "ChatError";
	}
}

export type ChatFallbackReason =
	| "off"
	| "unavailable"
	| "breaker_open"
	| "over_budget"
	| "busy"
	| "failed"
	| "interrupted"
	| "action_request";

export interface ChatQuestion {
	id: string;
	kind: "question";
	at: number;
	text: string;
	key: string;
}

export interface ChatAnswer {
	id: string;
	kind: "answer";
	at: number;
	questionId: string;
	text: string;
	source: "brain" | "records";
	reason?: ChatFallbackReason;
	citations: ChatCitation[];
	/** False: nothing backs this answer, and the UI says "unverified: no record". */
	grounded: boolean;
	/** Who wrote what the answer drew on. */
	provenance: Provenance[];
	/** The owner's own words, offered as a direction. Never model-authored. */
	offer?: string;
}

export interface ChatDirectionGiven {
	id: string;
	kind: "direction";
	at: number;
	answerId: string;
	directionId: string;
}

export type ChatEntry = ChatQuestion | ChatAnswer | ChatDirectionGiven;

type Db = Pick<ProjectDbHandle, "db" | "withTx">;

async function read(db: ProjectDb | ProjectDbTx): Promise<ChatEntry[]> {
	const [row] = await db
		.select()
		.from(engineKv)
		.where(eq(engineKv.key, CHAT_THREAD_KEY));
	return (row?.value as { items?: ChatEntry[] } | undefined)?.items ?? [];
}

async function write(
	tx: ProjectDbTx,
	items: ChatEntry[],
	now: number,
): Promise<void> {
	const value = { items } as Record<string, unknown>;
	await tx
		.insert(engineKv)
		.values({ key: CHAT_THREAD_KEY, value, updatedAt: new Date(now) })
		.onConflictDoUpdate({
			target: engineKv.key,
			set: { value, updatedAt: new Date(now) },
		});
}

/** Oldest answered exchanges go first, whole. An open question is never dropped. */
export function pruneThread(
	items: readonly ChatEntry[],
	keep = CHAT_KEEP_ENTRIES,
): ChatEntry[] {
	if (items.length <= keep) return [...items];
	const answersOf = new Map<string, ChatAnswer[]>();
	for (const e of items) {
		if (e.kind !== "answer") continue;
		answersOf.set(e.questionId, [...(answersOf.get(e.questionId) ?? []), e]);
	}
	const drop = new Set<string>();
	let over = items.length - keep;
	for (const q of items) {
		if (over <= 0) break;
		if (q.kind !== "question") continue;
		const answers = answersOf.get(q.id);
		if (!answers) continue;
		const ids = new Set(answers.map((a) => a.id));
		const given = items.filter(
			(e) => e.kind === "direction" && ids.has(e.answerId),
		);
		for (const e of [q, ...answers, ...given]) drop.add(e.id);
		over -= 1 + answers.length + given.length;
	}
	return items.filter((e) => !drop.has(e.id));
}

export class ChatThread {
	constructor(private readonly handle: Db) {}

	entries(): Promise<ChatEntry[]> {
		return read(this.handle.db);
	}

	async open(): Promise<ChatQuestion[]> {
		const items = await this.entries();
		const answered = new Set(
			items.flatMap((e) => (e.kind === "answer" ? [e.questionId] : [])),
		);
		return items.filter(
			(e): e is ChatQuestion => e.kind === "question" && !answered.has(e.id),
		);
	}

	/** The same `key` is the same submit. The rate limit counts only new ones. */
	appendQuestion(
		text: string,
		key: string,
		now: number,
	): Promise<{ question: ChatQuestion; duplicate: boolean }> {
		return this.handle.withTx(async (tx) => {
			const items = await read(tx);
			const twin = items.find(
				(e): e is ChatQuestion => e.kind === "question" && e.key === key,
			);
			if (twin) {
				if (twin.text !== text) {
					throw new ChatError(
						"key_reused",
						"This submit key was already used for different text.",
					);
				}
				return { question: twin, duplicate: true };
			}
			const asked = items.filter((e) => e.kind === "question");
			const within = (ms: number) =>
				asked.filter((e) => now - e.at < ms).length;
			if (
				within(MINUTE) >= CHAT_RATE.perMinute ||
				within(HOUR) >= CHAT_RATE.perHour
			) {
				throw new ChatError(
					"rate_limited",
					"Too many questions just now. Give it a moment.",
				);
			}
			const question: ChatQuestion = {
				id: ulid(),
				kind: "question",
				at: now,
				text,
				key,
			};
			await write(tx, pruneThread([...items, question]), now);
			return { question, duplicate: false };
		});
	}

	/** One answer per question: a late or repeated writer changes nothing. */
	appendAnswer(
		draft: Omit<ChatAnswer, "id" | "kind" | "at">,
		now: number,
	): Promise<ChatAnswer | null> {
		return this.handle.withTx(async (tx) => {
			const items = await read(tx);
			const asked = items.some(
				(e) => e.kind === "question" && e.id === draft.questionId,
			);
			const done = items.some(
				(e) => e.kind === "answer" && e.questionId === draft.questionId,
			);
			if (!asked || done) return null;
			const answer: ChatAnswer = {
				...draft,
				id: ulid(),
				kind: "answer",
				at: now,
			};
			await write(tx, pruneThread([...items, answer]), now);
			return answer;
		});
	}

	async appendDirection(
		answerId: string,
		directionId: string,
		now: number,
	): Promise<void> {
		await this.handle.withTx(async (tx) => {
			const items = await read(tx);
			if (items.some((e) => e.kind === "direction" && e.answerId === answerId))
				return;
			await write(
				tx,
				pruneThread([
					...items,
					{ id: ulid(), kind: "direction", at: now, answerId, directionId },
				]),
				now,
			);
		});
	}
}
