import type { ProjectDbHandle } from "@mfw/db/client";
import { appendEvent, type EventBus } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import { clarifications } from "@mfw/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Logger } from "./log.ts";

/**
 * The clarify gate: questions a planner or importer raised, and the answers
 * that unblock them.
 *
 * Answers feed back into a fresh plan run via `buildPrompts.plan`. The re-plan
 * is injected (`replan`) so this service does not depend on RunEngine.
 */

export interface ClarificationItem {
	question: string;
	answer: string | null;
}

export interface Clarification {
	/** The plan/import run that raised them; also the primary key. */
	runId: string;
	kind: string;
	goal: string | null;
	items: ClarificationItem[];
	createdAt: Date;
	resolvedAt: Date | null;
	/** Write-ahead id of the run consuming these answers. Kept through failures (a thrown launch cannot prove the child was not persisted) so retries reuse it. */
	continuationRunId: string | null;
	/** Convenience for the UI badge; derived, never stored. */
	openCount: number;
}

export interface AnswerInput {
	/** Index into `items`, as returned by `get`/`list`. */
	index: number;
	answer: string;
}

export interface AnswerResult {
	clarification: Clarification;
	continuation:
		| { status: "not_requested" }
		| { status: "started"; runId: string }
		| { status: "failed"; message: string };
}

/** Start a fresh plan run informed by what the human just answered. */
export type ReplanFn = (input: {
	goal: string;
	answers: { question: string; answer: string }[];
	sourceRunId: string;
	continuationRunId: string;
}) => Promise<{ runId: string }>;

export interface ClarifyDeps {
	handle: ProjectDbHandle;
	bus: EventBus;
	log: Logger;
	/** Wired by boot to `RunEngine.startPlan`. Absent = answering only. */
	replan?: ReplanFn;
}

export class ClarifyService {
	/** Coalesces concurrent callers so the same continuation id is not launched twice at once. Restart recovery uses the DB id. */
	private readonly continuationFlights = new Map<
		string,
		Promise<AnswerResult["continuation"]>
	>();

	constructor(private readonly deps: ClarifyDeps) {}

	/** Record a question set. Idempotent by `runId`: a crash between the insert and its journal row replays the step. */
	async raise(input: {
		runId: string;
		kind: string;
		goal?: string | null;
		questions: string[];
	}): Promise<Clarification | null> {
		const questions = input.questions
			.map((q) => q.trim())
			.filter((q) => q.length > 0);
		if (questions.length === 0) return null;
		const now = new Date();
		const inserted = await this.deps.handle.db
			.insert(clarifications)
			.values({
				runId: input.runId,
				kind: input.kind,
				goal: input.goal ?? null,
				items: questions.map((question) => ({ question, answer: null })),
				createdAt: now,
			})
			.onConflictDoNothing()
			.returning();
		if (inserted.length > 0) {
			await this.publish({
				type: "clarify.raised",
				runId: input.runId,
				payload: { kind: input.kind, count: questions.length },
			});
		}
		return this.get(input.runId);
	}

	async list(opts: { open?: boolean } = {}): Promise<Clarification[]> {
		const base = this.deps.handle.db.select().from(clarifications);
		const rows = await (opts.open
			? base.where(isNull(clarifications.resolvedAt))
			: base
		).orderBy(desc(clarifications.createdAt));
		return rows.map(toClarification);
	}

	async get(runId: string): Promise<Clarification | null> {
		const [row] = await this.deps.handle.db
			.select()
			.from(clarifications)
			.where(eq(clarifications.runId, runId));
		return row ? toClarification(row) : null;
	}

	/** Answer some or all of a set. It resolves once nothing is left unanswered. */
	async answer(
		runId: string,
		answers: AnswerInput[],
		opts: { continuePlanning?: boolean } = {},
	): Promise<AnswerResult> {
		const current = await this.get(runId);
		if (!current) throw new NotFoundError(`unknown clarification ${runId}`);
		if (current.resolvedAt) {
			return {
				clarification: current,
				continuation: current.continuationRunId
					? { status: "started", runId: current.continuationRunId }
					: { status: "not_requested" },
			};
		}
		const items = current.items.map((i) => ({ ...i }));
		for (const a of answers) {
			const item = items[a.index];
			if (!item) {
				throw new NotFoundError(
					`clarification ${runId} has no question at index ${a.index}`,
				);
			}
			const trimmed = a.answer.trim();
			item.answer = trimmed.length > 0 ? trimmed : null;
		}
		const open = items.filter((i) => i.answer === null).length;
		const continuable = Boolean(this.deps.replan && current.goal);
		const shouldContinue = Boolean(
			opts.continuePlanning && continuable && open === 0,
		);
		let continuation: AnswerResult["continuation"] = {
			status: "not_requested",
		};
		// A re-plan needs the original goal. Importer questions have none, so the
		// flag is ignored there rather than start a run on an empty goal.
		if (shouldContinue && this.deps.replan && current.goal) {
			let continuationRunId = current.continuationRunId;
			if (continuationRunId) {
				if (!sameItems(items, current.items)) {
					throw new ClarificationContinuationClaimedError(runId);
				}
			} else {
				const candidate = ulid();
				const [claimed] = await this.deps.handle.db
					.update(clarifications)
					.set({ items, continuationRunId: candidate })
					.where(
						and(
							eq(clarifications.runId, runId),
							isNull(clarifications.resolvedAt),
							isNull(clarifications.continuationRunId),
							eq(clarifications.items, current.items),
						),
					)
					.returning({
						continuationRunId: clarifications.continuationRunId,
					});
				if (claimed?.continuationRunId) {
					continuationRunId = claimed.continuationRunId;
				} else {
					const latest = await this.get(runId);
					if (!latest)
						throw new NotFoundError(`unknown clarification ${runId}`);
					if (!sameItems(latest.items, items)) {
						throw latest.continuationRunId
							? new ClarificationContinuationClaimedError(runId)
							: new ClarificationConflictError(runId);
					}
					continuationRunId = latest.continuationRunId;
				}
			}
			if (!continuationRunId) throw new ClarificationConflictError(runId);
			const answered = items
				.filter((i): i is { question: string; answer: string } =>
					Boolean(i.answer),
				)
				.map((i) => ({ question: i.question, answer: i.answer }));
			continuation = await this.continuePlanning(
				runId,
				current.goal,
				answered,
				continuationRunId,
			);
		} else {
			if (current.continuationRunId && !sameItems(items, current.items)) {
				throw new ClarificationContinuationClaimedError(runId);
			}
			const resolvedAt = open === 0 && !continuable ? new Date() : null;
			const updated = await this.deps.handle.db
				.update(clarifications)
				.set({ items, resolvedAt })
				.where(
					and(
						eq(clarifications.runId, runId),
						isNull(clarifications.resolvedAt),
						isNull(clarifications.continuationRunId),
						eq(clarifications.items, current.items),
					),
				)
				.returning({ runId: clarifications.runId });
			if (updated.length === 0 && !current.continuationRunId) {
				const latest = await this.get(runId);
				if (!latest) throw new NotFoundError(`unknown clarification ${runId}`);
				if (!sameItems(latest.items, items)) {
					throw latest.continuationRunId
						? new ClarificationContinuationClaimedError(runId)
						: new ClarificationConflictError(runId);
				}
			}
			if (resolvedAt && updated.length > 0) {
				await this.publish({
					type: "clarify.resolved",
					runId,
					payload: { answered: true },
				});
			}
		}
		const after = await this.get(runId);
		if (!after) throw new NotFoundError(`unknown clarification ${runId}`);
		return { clarification: after, continuation };
	}

	private async continuePlanning(
		runId: string,
		goal: string,
		answers: { question: string; answer: string }[],
		continuationRunId: string,
	): Promise<AnswerResult["continuation"]> {
		const active = this.continuationFlights.get(runId);
		if (active) return active;

		const flight = this.launchContinuation(
			runId,
			goal,
			answers,
			continuationRunId,
		);
		this.continuationFlights.set(runId, flight);
		try {
			return await flight;
		} finally {
			if (this.continuationFlights.get(runId) === flight) {
				this.continuationFlights.delete(runId);
			}
		}
	}

	private async launchContinuation(
		runId: string,
		goal: string,
		answers: { question: string; answer: string }[],
		continuationRunId: string,
		allowTerminalRetry = true,
	): Promise<AnswerResult["continuation"]> {
		if (!this.deps.replan) return { status: "not_requested" };

		try {
			const started = await this.deps.replan({
				goal,
				answers,
				sourceRunId: runId,
				continuationRunId,
			});
			if (started.runId !== continuationRunId) {
				throw new Error(
					`continuation returned ${started.runId}, expected ${continuationRunId}`,
				);
			}
			const completedAt = new Date();
			const resolved = await this.deps.handle.db
				.update(clarifications)
				.set({ resolvedAt: completedAt })
				.where(
					and(
						eq(clarifications.runId, runId),
						eq(clarifications.continuationRunId, continuationRunId),
						isNull(clarifications.resolvedAt),
					),
				)
				.returning({ runId: clarifications.runId });
			if (resolved.length > 0) {
				await this.publish({
					type: "clarify.resolved",
					runId,
					payload: { answered: true, continuationRunId },
				});
			}
			return { status: "started", runId: continuationRunId };
		} catch (e) {
			this.deps.log.error(
				{ err: e, runId, continuationRunId },
				"clarify continuation failed to start",
			);
			if (e instanceof ContinuationRunTerminalError) {
				const cleared = await this.deps.handle.db
					.update(clarifications)
					.set({ continuationRunId: null })
					.where(
						and(
							eq(clarifications.runId, runId),
							eq(clarifications.continuationRunId, continuationRunId),
							isNull(clarifications.resolvedAt),
						),
					)
					.returning({ runId: clarifications.runId });
				if (allowTerminalRetry && cleared.length > 0) {
					const replacement = ulid();
					const [claimed] = await this.deps.handle.db
						.update(clarifications)
						.set({ continuationRunId: replacement })
						.where(
							and(
								eq(clarifications.runId, runId),
								isNull(clarifications.resolvedAt),
								isNull(clarifications.continuationRunId),
							),
						)
						.returning({
							continuationRunId: clarifications.continuationRunId,
						});
					if (claimed?.continuationRunId) {
						return this.launchContinuation(
							runId,
							goal,
							answers,
							claimed.continuationRunId,
							false,
						);
					}
				}
			}
			return {
				status: "failed",
				message: e instanceof Error ? e.message : String(e),
			};
		}
	}

	/** Close a set without answering it: "I decided, no plan needed". */
	async dismiss(runId: string): Promise<Clarification | null> {
		const current = await this.get(runId);
		if (!current || current.resolvedAt) return current;
		await this.deps.handle.db
			.update(clarifications)
			.set({ resolvedAt: new Date() })
			.where(eq(clarifications.runId, runId));
		await this.publish({
			type: "clarify.resolved",
			runId,
			payload: { answered: false },
		});
		return this.get(runId);
	}

	private async publish(
		event: Parameters<typeof appendEvent>[1],
	): Promise<void> {
		try {
			const rows = await this.deps.handle.withTx(async (tx) => [
				await appendEvent(tx, event),
			]);
			this.deps.bus.publish(rows);
		} catch (e) {
			// Row already written; a lost audit line must not throw at the caller.
			this.deps.log.warn({ err: e }, "could not record clarify event");
		}
	}
}

/** Named so `trpc.ts`'s error map turns it into NOT_FOUND, not a 500. */
export class NotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NotFoundError";
	}
}

/** The continuation id freezes the answer snapshot it will consume. */
export class ClarificationContinuationClaimedError extends Error {
	constructor(readonly runId: string) {
		super(
			`clarification ${runId} is already continuing; its saved answers can no longer be changed`,
		);
		this.name = "ClarificationContinuationClaimedError";
	}
}

/** Optimistic answer update lost a race before a continuation was claimed. */
export class ClarificationConflictError extends Error {
	constructor(readonly runId: string) {
		super(`clarification ${runId} changed; reload it before saving`);
		this.name = "ClarificationConflictError";
	}
}

/** Boot proved the write-ahead child is terminal and unsuccessful, so the id can be retired and a retry claim a fresh one. Ambiguous throws keep the id. */
export class ContinuationRunTerminalError extends Error {
	constructor(
		readonly continuationRunId: string,
		detail: string,
	) {
		super(`continuation ${continuationRunId} cannot resume: ${detail}`);
		this.name = "ContinuationRunTerminalError";
	}
}

export function continuationTerminalError(run: {
	id: string;
	state: string;
	outcome: string | null;
}): ContinuationRunTerminalError | null {
	const terminalFailure = [
		"failed",
		"killed",
		"interrupted",
		"rate_limited",
		"needs_review",
	].includes(run.state);
	return run.outcome === "start_failed" || terminalFailure
		? new ContinuationRunTerminalError(run.id, run.outcome ?? run.state)
		: null;
}

const sameItems = (a: ClarificationItem[], b: ClarificationItem[]): boolean =>
	JSON.stringify(a) === JSON.stringify(b);

function toClarification(row: {
	runId: string;
	kind: string;
	goal: string | null;
	items: ClarificationItem[];
	continuationRunId: string | null;
	createdAt: Date;
	resolvedAt: Date | null;
}): Clarification {
	return {
		runId: row.runId,
		kind: row.kind,
		goal: row.goal,
		items: row.items.map((i) => ({ ...i })),
		createdAt: row.createdAt,
		resolvedAt: row.resolvedAt,
		continuationRunId: row.continuationRunId,
		openCount: row.items.filter((i) => i.answer === null).length,
	};
}
