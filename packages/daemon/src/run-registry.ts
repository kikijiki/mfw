import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@mfw/core/fsatomic";
import type { ProjectDbHandle, ProjectDbTx } from "@mfw/db/client";
import { appendEvent, type EventBus, type StoredEvent } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import {
	type KillReason,
	type RunKind,
	type RunOutcome,
	type RunReasoningEffort,
	type RunState,
	runSteps,
	runs,
	runTargetJournal,
	type TargetJournalPhase,
	type TargetLifecycleState,
} from "@mfw/db/schema";
import {
	and,
	asc,
	eq,
	inArray,
	isNotNull,
	isNull,
	ne,
	or,
	sql,
} from "drizzle-orm";

/**
 * The DB row is authoritative for run state; the run dir is a debugging
 * artifact and reconcile fallback (`meta.json` is written once, never read for
 * state). Every state change appends its event in the same transaction and
 * fans out on the bus after commit.
 */

export type RunRow = typeof runs.$inferSelect;
export type StepRow = typeof runSteps.$inferSelect;
export type TargetJournalRow = typeof runTargetJournal.$inferSelect;
export interface RunCapabilities {
	steer: boolean;
	verified: boolean;
	interrupt: boolean;
	approvals: boolean;
	plan: boolean;
	fileChanges: boolean;
	commandProgress: boolean;
	mcp: boolean;
}

export type RunCapabilitiesInput = Pick<RunCapabilities, "steer" | "verified"> &
	Partial<Omit<RunCapabilities, "steer" | "verified">>;

/** Old rows only contain steer/verified; fill the rest with false. */
export function normalizeRunCapabilities(
	caps: RunCapabilitiesInput,
): RunCapabilities {
	return {
		verified: caps.verified,
		steer: caps.steer,
		interrupt: caps.interrupt ?? false,
		approvals: caps.approvals ?? false,
		plan: caps.plan ?? false,
		fileChanges: caps.fileChanges ?? false,
		commandProgress: caps.commandProgress ?? false,
		mcp: caps.mcp ?? false,
	};
}

function normalizeRunRow(row: RunRow): RunRow {
	return {
		...row,
		capabilities: normalizeRunCapabilities(row.capabilities),
	};
}

/**
 * Non-terminal states in which a run still owns its task's claim. Not the same
 * as "has a live tmux session": `merging` has none but still holds the task.
 */
export const CLAIM_HOLDING_RUN_STATES: readonly RunState[] = [
	"starting",
	"running",
	"ended",
	"finalizing",
	"merging",
];

export interface NewRunSpec {
	/** Caller-minted ULID (guarded child spawns journal it pre-effect); minted here when absent. */
	id?: string;
	kind: RunKind;
	taskId?: string;
	parentRunId?: string;
	label: string;
	model: string;
	providerId?: string;
	reasoningEffort?: RunReasoningEffort;
	cwd: string;
	worktreePath?: string;
	branch?: string;
	integrationBranch?: string;
	baseSha?: string;
	attempt?: number;
	resumeOrdinal?: number;
	/** Repair budget for this run; the finalize machine reads it from the row. */
	maxRepairs?: number;
	argv?: string[];
	initialPrompt?: string;
	goal?: string;
	capabilities?: RunCapabilitiesInput;
	executionTarget?: string;
	targetProjectId?: string;
	targetLeaseRef?: string;
	targetExecutionPath?: string;
	targetRequestedShape?: Record<string, unknown>;
	targetObservedShape?: Record<string, unknown>;
	workloadSecretGrantIds?: string[];
	workloadSecretNames?: string[];
	workloadSecretBinding?: string;
	/** Stable write-ahead identity; defaults to `<runId>/prepare/intent`. */
	targetPrepareOperationId?: string;
}

export interface TargetLifecycleEntry {
	runId: string;
	operationId: string;
	phase: TargetJournalPhase;
	status: "intent" | "completed" | "failed";
	lifecycleState: TargetLifecycleState;
	targetKind: string;
	targetLeaseRef?: string | null;
	requestedShape?: Record<string, unknown> | null;
	observedShape?: Record<string, unknown> | null;
	/** Redacted codes and stable identifiers only, never provider payloads. */
	detail?: Record<string, unknown> | null;
	/** Additional durable run linkage recorded in the same transaction. */
	runPatch?: Partial<
		Pick<
			RunRow,
			| "cwd"
			| "worktreePath"
			| "branch"
			| "baseSha"
			| "targetProjectId"
			| "targetExecutionPath"
		>
	>;
	startingOnly?: boolean;
}

export interface RunListFilter {
	states?: RunState[];
	kinds?: RunKind[];
	taskId?: string;
}

/** Fields a transition may set alongside the state change. */
export type TransitionPatch = Partial<
	Pick<
		RunRow,
		| "outcome"
		| "exitCode"
		| "killReason"
		| "note"
		| "finishedAt"
		| "capabilities"
		| "usage"
		| "worktreePath"
		| "branch"
		| "baseSha"
		| "cwd"
	>
> & {
	/** Guard: the update only applies if the row is currently in this state. */
	from?: RunState;
};

export interface BeginStepResult {
	row: StepRow;
	/**
	 * null: fresh step, caller executes it.
	 * "done": journal says the side effect already completed; caller
	 *              MUST use `result` instead of re-executing.
	 * "restarted": a running/failed row was reset to running (crash recovery);
	 *              caller re-executes (guarded steps consult journalGuard()).
	 */
	resumed: "done" | "restarted" | null;
	result?: unknown;
}

export interface RunRegistryDeps {
	handle: ProjectDbHandle;
	bus: EventBus;
	runsDir: string;
}

export class RunRegistry {
	private readonly handle: ProjectDbHandle;
	private readonly bus: EventBus;
	private readonly runsDir: string;

	constructor(deps: RunRegistryDeps) {
		this.handle = deps.handle;
		this.bus = deps.bus;
		this.runsDir = deps.runsDir;
	}

	/** Serialized tx + post-commit event fan-out (listeners never see rollbacks). */
	private async withEvents<T>(
		fn: (tx: ProjectDbTx, events: StoredEvent[]) => Promise<T>,
	): Promise<T> {
		const pending: StoredEvent[] = [];
		const res = await this.handle.withTx((tx) => fn(tx, pending));
		this.bus.publish(pending);
		return res;
	}

	// ---------- lifecycle ----------

	/** Mint a ULID, create the run dir + write-once meta.json, insert the row
	 *  in state "starting", and append `run.started` in the same tx. */
	async create(spec: NewRunSpec): Promise<RunRow> {
		const id = spec.id ?? ulid();
		const now = Date.now();
		const values = {
			id,
			kind: spec.kind,
			taskId: spec.taskId ?? null,
			parentRunId: spec.parentRunId ?? null,
			label: spec.label,
			model: spec.model,
			providerId: spec.providerId ?? null,
			reasoningEffort: spec.reasoningEffort ?? null,
			cwd: spec.cwd,
			worktreePath: spec.worktreePath ?? null,
			branch: spec.branch ?? null,
			integrationBranch: spec.integrationBranch ?? null,
			baseSha: spec.baseSha ?? null,
			attempt: spec.attempt ?? 1,
			resumeOrdinal: spec.resumeOrdinal ?? 0,
			maxRepairs: spec.maxRepairs ?? null,
			argv: spec.argv ?? [],
			initialPrompt: spec.initialPrompt ?? null,
			goal: spec.goal ?? null,
			executionTarget: spec.executionTarget ?? "local",
			targetProjectId: spec.targetProjectId ?? null,
			targetLeaseRef: spec.targetLeaseRef ?? null,
			targetExecutionPath: spec.targetExecutionPath ?? null,
			targetRequestedShape: spec.targetRequestedShape ?? {},
			targetObservedShape: spec.targetObservedShape ?? null,
			workloadSecretGrantIds: spec.workloadSecretGrantIds ?? [],
			workloadSecretNames: spec.workloadSecretNames ?? [],
			workloadSecretBinding: spec.workloadSecretBinding ?? null,
			targetLifecycleState: "preparing" as TargetLifecycleState,
			state: "starting" as RunState,
			capabilities: normalizeRunCapabilities(
				spec.capabilities ?? { steer: false, verified: false },
			),
			startedAt: new Date(now),
		};

		// Dir + meta exist before the row commits, so both exist before any git work.
		const dir = this.runDir(id);
		await mkdir(dir, { recursive: true });
		await writeFileAtomic(
			join(dir, "meta.json"),
			`${JSON.stringify({ ...values, startedAt: now }, null, "\t")}\n`,
		);

		return this.withEvents(async (tx, events) => {
			const [row] = await tx.insert(runs).values(values).returning();
			if (!row) throw new Error(`run insert returned no row for ${id}`);
			await tx.insert(runTargetJournal).values({
				operationId: spec.targetPrepareOperationId ?? `${id}/prepare/intent`,
				runId: id,
				seq: 1,
				targetKind: values.executionTarget,
				targetLeaseRef: values.targetLeaseRef,
				phase: "prepare",
				status: "intent",
				lifecycleState: "preparing",
				requestedShape: values.targetRequestedShape,
				observedShape: values.targetObservedShape,
				createdAt: new Date(now),
			});
			events.push(
				await appendEvent(
					tx,
					{
						type: "run.started",
						runId: id,
						payload: {
							kind: spec.kind,
							...(spec.taskId ? { taskId: spec.taskId } : {}),
							model: spec.model,
							...(spec.branch ? { branch: spec.branch } : {}),
						},
					},
					now,
				),
			);
			return normalizeRunRow(row);
		});
	}

	/**
	 * Append one idempotent target lifecycle entry and update the run's target
	 * projection in one transaction. Not a provider transaction: `targetLeaseRef`
	 * is an opaque join key.
	 */
	async recordTargetLifecycle(
		entry: TargetLifecycleEntry,
	): Promise<TargetJournalRow> {
		return this.handle.withTx(async (tx) => {
			const [existing] = await tx
				.select()
				.from(runTargetJournal)
				.where(eq(runTargetJournal.operationId, entry.operationId));
			if (existing) {
				if (existing.runId !== entry.runId) {
					throw new Error(
						`target operation ${entry.operationId} belongs to ${existing.runId}`,
					);
				}
				return existing;
			}

			const [run] = await tx
				.select()
				.from(runs)
				.where(eq(runs.id, entry.runId));
			if (!run) throw new Error(`unknown run ${entry.runId}`);
			if (entry.startingOnly && run.state !== "starting") {
				throw new Error(`run ${entry.runId} left starting state during setup`);
			}
			const [maximum] = await tx
				.select({ max: sql<number>`COALESCE(MAX(${runTargetJournal.seq}), 0)` })
				.from(runTargetJournal)
				.where(eq(runTargetJournal.runId, entry.runId));
			const now = new Date();
			const cleanupRequested =
				entry.phase === "dispose" && entry.status === "intent"
					? now
					: undefined;
			const absenceConfirmed =
				entry.lifecycleState === "absent" && entry.status === "completed"
					? now
					: undefined;
			await tx
				.update(runs)
				.set({
					executionTarget: entry.targetKind,
					targetLeaseRef: entry.targetLeaseRef ?? run.targetLeaseRef,
					targetRequestedShape:
						entry.requestedShape ?? run.targetRequestedShape,
					targetObservedShape: entry.observedShape ?? run.targetObservedShape,
					targetLifecycleState: entry.lifecycleState,
					...(cleanupRequested
						? { targetCleanupRequestedAt: cleanupRequested }
						: {}),
					...(absenceConfirmed
						? { targetAbsenceConfirmedAt: absenceConfirmed }
						: {}),
					...(entry.runPatch ?? {}),
				})
				.where(eq(runs.id, entry.runId));
			const [journal] = await tx
				.insert(runTargetJournal)
				.values({
					operationId: entry.operationId,
					runId: entry.runId,
					seq: (maximum?.max ?? 0) + 1,
					targetKind: entry.targetKind,
					targetLeaseRef: entry.targetLeaseRef ?? run.targetLeaseRef,
					phase: entry.phase,
					status: entry.status,
					lifecycleState: entry.lifecycleState,
					requestedShape: entry.requestedShape ?? run.targetRequestedShape,
					observedShape: entry.observedShape ?? run.targetObservedShape,
					detail: entry.detail ?? null,
					createdAt: now,
				})
				.returning();
			if (!journal) {
				throw new Error(
					`target journal insert returned no row: ${entry.runId}`,
				);
			}
			return journal;
		});
	}

	async targetJournal(runId: string): Promise<TargetJournalRow[]> {
		return this.handle.db
			.select()
			.from(runTargetJournal)
			.where(eq(runTargetJournal.runId, runId))
			.orderBy(asc(runTargetJournal.seq));
	}

	async get(runId: string): Promise<RunRow | null> {
		const [row] = await this.handle.db
			.select()
			.from(runs)
			.where(eq(runs.id, runId));
		return row ? normalizeRunRow(row) : null;
	}

	async list(filter: RunListFilter = {}): Promise<RunRow[]> {
		const conds = [
			filter.states?.length ? inArray(runs.state, filter.states) : undefined,
			filter.kinds?.length ? inArray(runs.kind, filter.kinds) : undefined,
			filter.taskId ? eq(runs.taskId, filter.taskId) : undefined,
		].filter((c) => c !== undefined);
		const rows = await this.handle.db
			.select()
			.from(runs)
			.where(conds.length ? and(...conds) : undefined)
			.orderBy(asc(runs.startedAt), asc(runs.id));
		return rows.map(normalizeRunRow);
	}

	/**
	 * Guarded state change: if `patch.from` is given the update applies only
	 * while the row is still in that state (compare-and-set); otherwise it is
	 * unconditional. Appends `run.state_changed` in-tx. Returns the updated
	 * row, or null when the guard missed (no event written).
	 */
	async transition(
		runId: string,
		to: RunState,
		patch: TransitionPatch = {},
	): Promise<RunRow | null> {
		const { from, ...fields } = patch;
		return this.withEvents(async (tx, events) => {
			const [prev] = await tx.select().from(runs).where(eq(runs.id, runId));
			if (!prev) return null;
			if (from !== undefined && prev.state !== from) return null;
			const [row] = await tx
				.update(runs)
				.set({ state: to, ...fields })
				.where(eq(runs.id, runId))
				.returning();
			if (!row) return null;
			events.push(
				await appendEvent(tx, {
					type: "run.state_changed",
					runId,
					payload: {
						from: prev.state,
						to,
						...("exitCode" in patch
							? { exitCode: patch.exitCode ?? null }
							: {}),
						...(patch.killReason ? { killReason: patch.killReason } : {}),
						...(patch.note ? { note: patch.note } : {}),
					},
				}),
			);
			return normalizeRunRow(row);
		});
	}

	/** Record a new worktree while the run is still starting. Not a transition/event; closes the crash window between `git worktree add` and agent launch. */
	async setStartingWorktree(
		runId: string,
		patch: {
			worktreePath: string;
			branch: string;
			baseSha: string;
			cwd: string;
		},
	): Promise<boolean> {
		const rows = await this.handle.db
			.update(runs)
			.set(patch)
			.where(and(eq(runs.id, runId), eq(runs.state, "starting")))
			.returning({ id: runs.id });
		return rows.length === 1;
	}

	// ---------- single-flight finalization claim ----------

	/** Atomic claim: succeeds iff unowned or already owned by this bootId
	 *  (re-entry after an in-process crash resumes the same claim). */
	async claimFinalize(runId: string, bootId: string): Promise<boolean> {
		const res = await this.handle.db
			.update(runs)
			.set({ finalizeOwner: bootId, finalizeClaimedAt: new Date() })
			.where(
				and(
					eq(runs.id, runId),
					or(isNull(runs.finalizeOwner), eq(runs.finalizeOwner, bootId)),
				),
			)
			.returning({ id: runs.id });
		return res.length > 0;
	}

	/** Boot reconciliation: clear every owner that is not the live boot (a dead process's claims are stale). */
	async clearStaleFinalizeOwners(liveBootId: string): Promise<number> {
		const res = await this.handle.db
			.update(runs)
			.set({ finalizeOwner: null, finalizeClaimedAt: null })
			.where(
				and(isNotNull(runs.finalizeOwner), ne(runs.finalizeOwner, liveBootId)),
			)
			.returning({ id: runs.id });
		return res.length;
	}

	// ---------- the finalization journal ----------

	/**
	 * Upsert the step row to "running" with the next seq. A `done` row returns
	 * `resumed: "done"` plus its result (must not re-execute); a `running`/`failed`
	 * row is reset (`resumed: "restarted"`) keeping its `result` for journalGuard().
	 */
	async beginStep(runId: string, step: string): Promise<BeginStepResult> {
		return this.handle.withTx(async (tx) => {
			const [existing] = await tx
				.select()
				.from(runSteps)
				.where(and(eq(runSteps.runId, runId), eq(runSteps.step, step)));
			if (existing) {
				if (existing.status === "done") {
					return { row: existing, resumed: "done", result: existing.result };
				}
				const [row] = await tx
					.update(runSteps)
					.set({ status: "running", error: null, finishedAt: null })
					.where(and(eq(runSteps.runId, runId), eq(runSteps.step, step)))
					.returning();
				if (!row) throw new Error(`step reset lost row: ${runId}/${step}`);
				return { row, resumed: "restarted", result: row.result };
			}
			const [m] = await tx
				.select({
					max: sql<number>`COALESCE(MAX(${runSteps.seq}), 0)`,
				})
				.from(runSteps)
				.where(eq(runSteps.runId, runId));
			const [row] = await tx
				.insert(runSteps)
				.values({
					runId,
					step,
					seq: (m?.max ?? 0) + 1,
					status: "running",
					startedAt: new Date(),
				})
				.returning();
			if (!row)
				throw new Error(`step insert returned no row: ${runId}/${step}`);
			return { row, resumed: null };
		});
	}

	/** Persist replay intent without claiming the side effect completed. */
	async saveStepGuard(
		runId: string,
		step: string,
		result: unknown,
	): Promise<void> {
		const rows = await this.handle.db
			.update(runSteps)
			.set({ result })
			.where(and(eq(runSteps.runId, runId), eq(runSteps.step, step)))
			.returning({ step: runSteps.step });
		if (rows.length === 0)
			throw new Error(`saveStepGuard without beginStep: ${runId}/${step}`);
	}

	/** Written only AFTER the step's side effect completed. */
	async finishStep(
		runId: string,
		step: string,
		result: unknown,
	): Promise<void> {
		const res = await this.handle.db
			.update(runSteps)
			.set({ status: "done", result, finishedAt: new Date() })
			.where(and(eq(runSteps.runId, runId), eq(runSteps.step, step)))
			.returning({ step: runSteps.step });
		if (res.length === 0)
			throw new Error(`finishStep without beginStep: ${runId}/${step}`);
	}

	async failStep(runId: string, step: string, error: string): Promise<void> {
		const res = await this.handle.db
			.update(runSteps)
			.set({ status: "failed", error, finishedAt: new Date() })
			.where(and(eq(runSteps.runId, runId), eq(runSteps.step, step)))
			.returning({ step: runSteps.step });
		if (res.length === 0)
			throw new Error(`failStep without beginStep: ${runId}/${step}`);
	}

	async steps(runId: string): Promise<StepRow[]> {
		return this.handle.db
			.select()
			.from(runSteps)
			.where(eq(runSteps.runId, runId))
			.orderBy(asc(runSteps.seq));
	}

	/** A failed cleanup still owns its writers, task claim and resource slots. */
	async hasPendingCleanup(runId: string): Promise<boolean> {
		const [step] = await this.handle.db
			.select({ status: runSteps.status })
			.from(runSteps)
			.where(
				and(eq(runSteps.runId, runId), eq(runSteps.step, "reap_leftovers")),
			);
		return step !== undefined && step.status !== "done";
	}

	/**
	 * Returns whatever the step journaled into `result` (child run id, task id
	 * map, ...) regardless of status, or null. Guarded steps journal before the
	 * side effect, so a crash resumes with the same identifiers.
	 */
	async journalGuard(runId: string, step: string): Promise<unknown> {
		const [row] = await this.handle.db
			.select({ result: runSteps.result })
			.from(runSteps)
			.where(and(eq(runSteps.runId, runId), eq(runSteps.step, step)));
		return row?.result ?? null;
	}

	// ---------- run facts ----------

	/** Persist environment names only before any remote provider submission. */
	async bindWorkloadSecrets(
		runId: string,
		names: readonly string[],
		binding: string | null,
	): Promise<void> {
		const normalized = [...new Set(names)].sort();
		if (normalized.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
			throw new Error("invalid workload secret environment name");
		}
		await this.handle.db
			.update(runs)
			.set({ workloadSecretNames: normalized, workloadSecretBinding: binding })
			.where(eq(runs.id, runId));
	}

	/** Overwrite declared capabilities with the driver's verified hello. */
	async setCapabilities(
		runId: string,
		caps: RunCapabilitiesInput,
	): Promise<void> {
		await this.handle.db
			.update(runs)
			.set({ capabilities: normalizeRunCapabilities(caps) })
			.where(eq(runs.id, runId));
	}

	/** The run's process is gone: state → "ended" plus the exit facts. */
	async recordExit(
		runId: string,
		exit: {
			exitCode?: number | null;
			killReason?: KillReason;
			outcome: RunOutcome;
		},
	): Promise<RunRow | null> {
		return this.transition(runId, "ended", {
			exitCode: exit.exitCode ?? null,
			killReason: exit.killReason ?? null,
			outcome: exit.outcome,
		});
	}

	/** Terminal state + finishedAt. */
	async finish(
		runId: string,
		state: RunState,
		note?: string,
	): Promise<RunRow | null> {
		return this.transition(runId, state, {
			finishedAt: new Date(),
			...(note ? { note } : {}),
		});
	}

	// ---------- run dir access ----------

	runDir(runId: string): string {
		return join(this.runsDir, runId);
	}

	/** Byte-offset read for UI polling: never loads more than the delta.
	 *  A missing file reads as empty (the run may not have produced it yet). */
	async readOutput(
		runId: string,
		file: "events.jsonl" | "raw.log",
		offset = 0,
	): Promise<{ chunk: string; size: number; complete: boolean }> {
		// Resolve the id through the run table before it becomes a path segment.
		if (!(await this.get(runId))) throw new Error(`unknown run ${runId}`);
		const path = join(this.runDir(runId), file);
		let fh: Awaited<ReturnType<typeof open>>;
		try {
			fh = await open(path, "r");
		} catch {
			return { chunk: "", size: 0, complete: true };
		}
		try {
			const size = (await fh.stat()).size;
			const start = Math.min(Math.max(0, offset), size);
			const len = Math.min(size - start, 1024 * 1024);
			if (len === 0) return { chunk: "", size, complete: true };
			const buf = Buffer.alloc(len);
			const { bytesRead } = await fh.read(buf, 0, len, start);
			let bytesReturned = bytesRead;
			if (file === "events.jsonl" && start + bytesRead < size) {
				// Don't end a capped read mid-JSONL-record (the next read would start
				// mid-line). Fall back to the full buffer only for a giant malformed line.
				const lastNewline = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
				if (lastNewline >= 0) bytesReturned = lastNewline + 1;
			}
			return {
				chunk: buf.subarray(0, bytesReturned).toString("utf8"),
				// Next byte cursor; less than the file size when the 1 MiB cap hit.
				size: start + bytesReturned,
				complete: start + bytesReturned >= size,
			};
		} finally {
			await fh.close();
		}
	}
}
