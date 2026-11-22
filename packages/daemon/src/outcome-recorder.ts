import type { ProjectDbHandle, ProjectDbTx } from "@mfw/db/client";
import type { EventBus, StoredEvent } from "@mfw/db/eventlog";
import {
	backfillAttemptOutcomesOnce,
	harnessVendor,
	recordAttemptOutcome,
	recordDecisionOutcomesOfRun,
} from "@mfw/db/outcomes";
import { runs } from "@mfw/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import {
	type ActionableFailureClass,
	classifyRunFailure,
} from "./failure-class.ts";
import type { Logger } from "./log.ts";

/**
 * Writes task attempt outcomes from the audit bus, so finalize, the merge
 * tail and every other writer of run state need no hook of their own:
 *
 * - `run.started` (the run row was just inserted, at prepare): snapshot the
 *   task's size / type / tier and the harness / vendor onto the run, once, so
 *   later task edits never rewrite history; then open the chain's row.
 * - `run.state_changed` into a settled state (finalize terminals, the merge
 *   tail's `merged` / parked finish, `finalize_error`): re-fold the chain.
 *
 * A run that settles into a failure is also classified (`failure-class.ts`)
 * and reported through `onFailureClass`, once per settle event; `unconfirmed`
 * is reported too, so the consumer can leave it out of any failure count.
 *
 * Every write is an idempotent recompute (`@mfw/db/outcomes`), serialized
 * here so an older fold never lands after a newer one. Failures are logged
 * and never reach the publisher: outcome rows are analytics, not control.
 */

const SETTLED = new Set([
	"completed",
	"failed",
	"killed",
	"interrupted",
	"rate_limited",
	"needs_review",
	"finalize_error",
]);

export interface OutcomeTaskFacts {
	type: string | null;
	size: string | null;
	modelTier: string | null;
}

export interface OutcomeRecorderDeps {
	handle: ProjectDbHandle;
	bus: EventBus;
	tasks: { get(id: string): Promise<OutcomeTaskFacts | null> };
	log: Logger;
	/** Called for every settled run that is not a clean finish. Errors are logged. */
	onFailureClass?: (f: RunFailureClass) => void | Promise<void>;
}

export interface RunFailureClass {
	runId: string;
	taskId: string | null;
	harness: string | null;
	failureClass: ActionableFailureClass;
}

export class OutcomeRecorder {
	private queue: Promise<unknown> = Promise.resolve();
	private unsubscribe: (() => void) | null = null;

	constructor(private readonly deps: OutcomeRecorderDeps) {}

	/** Subscribe and queue the one-time backfill. Idempotent. */
	start(): this {
		if (this.unsubscribe) return this;
		this.unsubscribe = this.deps.bus.subscribe((e) => this.onEvent(e));
		this.enqueue("backfill", async () => {
			const chains = await this.deps.handle.withTx((tx) =>
				backfillAttemptOutcomesOnce(tx),
			);
			if (chains !== null)
				this.deps.log.info({ chains }, "backfilled task attempt outcomes");
		});
		return this;
	}

	stop(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	/** Resolves once every queued write has settled (tests, shutdown). */
	idle(): Promise<void> {
		return this.queue.then(() => undefined);
	}

	private onEvent(e: StoredEvent): void {
		if (e.type === "run.started") {
			const runId = e.runId;
			const { kind, taskId } = e.payload;
			if (kind !== "task" || !taskId) return;
			this.enqueue("snapshot", async () => {
				const task = await this.deps.tasks.get(taskId);
				await this.deps.handle.withTx(async (tx) => {
					await snapshot(tx, runId, task);
					await recordAttemptOutcome(tx, runId);
					await recordDecisionOutcomesOfRun(tx, runId);
				});
			});
		} else if (e.type === "run.state_changed" && SETTLED.has(e.payload.to)) {
			const runId = e.runId;
			const facts = e.payload;
			this.enqueue("classify", () => this.classify(runId, facts));
			this.enqueue("record", () =>
				this.deps.handle.withTx(async (tx) => {
					await recordAttemptOutcome(tx, runId);
					// The decision a chain was spawned by learns how it ended.
					await recordDecisionOutcomesOfRun(tx, runId);
				}),
			);
		}
	}

	private async classify(
		runId: string,
		facts: {
			to: string;
			exitCode?: number | null;
			killReason?: string;
			note?: string;
		},
	): Promise<void> {
		if (!this.deps.onFailureClass) return;
		const [row] = await this.deps.handle.db
			.select({
				taskId: runs.taskId,
				harness: runs.harness,
				providerId: runs.providerId,
				outcome: runs.outcome,
				killReason: runs.killReason,
				exitCode: runs.exitCode,
				note: runs.note,
			})
			.from(runs)
			.where(eq(runs.id, runId));
		const failureClass = classifyRunFailure({
			state: facts.to,
			outcome: row?.outcome,
			killReason: facts.killReason ?? row?.killReason,
			exitCode: facts.exitCode ?? row?.exitCode,
			text: facts.note ?? row?.note,
		});
		if (!failureClass) return;
		await this.deps.onFailureClass({
			runId,
			taskId: row?.taskId ?? null,
			harness: row?.harness ?? row?.providerId ?? null,
			failureClass,
		});
	}

	private enqueue(what: string, fn: () => Promise<unknown>): void {
		this.queue = this.queue.then(fn).catch((err) => {
			this.deps.log.warn({ err, what }, "outcome recording failed");
		});
	}
}

/** Fill the outcome facts of a fresh run row; never overwrites a set value. */
async function snapshot(
	tx: ProjectDbTx,
	runId: string,
	task: OutcomeTaskFacts | null,
): Promise<void> {
	const [row] = await tx
		.select({
			providerId: runs.providerId,
			harness: runs.harness,
			modelVendor: runs.modelVendor,
		})
		.from(runs)
		.where(eq(runs.id, runId));
	if (!row) return;
	const harness = row.harness ?? row.providerId ?? null;
	await tx
		.update(runs)
		.set({ harness, modelVendor: row.modelVendor ?? harnessVendor(harness) })
		.where(and(eq(runs.id, runId), isNull(runs.harness)));
	if (!task) return;
	await tx
		.update(runs)
		.set({
			taskSize: task.size,
			taskType: task.type,
			modelTier: task.modelTier,
		})
		.where(
			and(
				eq(runs.id, runId),
				isNull(runs.taskSize),
				isNull(runs.taskType),
				isNull(runs.modelTier),
			),
		);
}
