import { sql } from "drizzle-orm";
import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * One SQLite DB per project at `<project>/.mfw/mfw.db`, holding everything
 * that is NOT the board (tasks and ADRs are files, see `@mfw/core/board`).
 * What remains is machine bookkeeping, reconstructible from run directories or
 * worthless after a restart, so the file is deletable without changing the board.
 *
 * Task ids are plain text with no FK (a task is a file). A dangling id means the
 * file was deleted, which is legal; integrity is a resolve-at-read.
 *
 * Conventions: ULIDs and task ids are text; timestamps are epoch-ms integers;
 * JSON columns are zod-validated at the boundary, defaulted app-side.
 */

// ---------- runs ----------

export type RunKind =
	| "task"
	| "repair"
	| "import"
	| "plan"
	| "action"
	| "brain";
export type RunReasoningEffort =
	| "none"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";
/** starting → running → ended → finalizing → merging? → terminal. */
export type RunState =
	| "starting"
	| "running"
	| "ended"
	| "finalizing"
	| "merging"
	| "completed"
	| "failed"
	| "killed"
	| "interrupted"
	| "rate_limited"
	| "needs_review"
	| "finalize_error";
export type RunOutcome =
	| "completed"
	| "rate_limited"
	| "killed_manual"
	| "killed_watchdog"
	| "interrupted"
	| "start_failed";
export type KillReason =
	| "manual"
	| "watchdog-idle"
	| "watchdog-wall"
	| "watchdog-turns"
	| "watchdog-timebox";

export type TargetLifecycleState =
	| "legacy"
	| "preparing"
	| "prepared"
	| "launching"
	| "running"
	| "collecting"
	| "disposing"
	| "cleanup_pending"
	| "absent"
	| "failed";

export type TargetJournalPhase =
	| "prepare"
	| "launch"
	| "observe"
	| "control"
	| "collect"
	| "dispose"
	| "reconcile";

export const runs = sqliteTable(
	"runs",
	{
		id: text("id").primaryKey(), // ULID, also the run dir name
		kind: text("kind").$type<RunKind>().notNull(),
		taskId: text("task_id"), // a board file id; no FK, see the note above
		parentRunId: text("parent_run_id"), // repair/resume lineage (no FK: parent may be pruned)
		label: text("label").notNull(),
		model: text("model").notNull(),
		providerId: text("provider_id"),
		reasoningEffort: text("reasoning_effort").$type<RunReasoningEffort>(),
		cwd: text("cwd").notNull(),
		worktreePath: text("worktree_path"),
		branch: text("branch"),
		integrationBranch: text("integration_branch"),
		baseSha: text("base_sha"),
		attempt: integer("attempt").notNull().default(1),
		resumeOrdinal: integer("resume_ordinal").notNull().default(0),
		maxRepairs: integer("max_repairs"),
		argv: text("argv", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.$defaultFn(() => []),
		initialPrompt: text("initial_prompt"),
		goal: text("goal"), // plan runs: for clarify re-plan

		// Execution placement. Credentials stay in the global account store; only
		// its opaque lease ref is copied here to join the two sagas.
		executionTarget: text("execution_target").notNull().default("local"),
		targetProjectId: text("target_project_id"),
		targetLeaseRef: text("target_lease_ref"),
		/** Opaque adapter-side workspace location; canonical work remains local. */
		targetExecutionPath: text("target_execution_path"),
		targetRequestedShape: text("target_requested_shape", { mode: "json" })
			.$type<Record<string, unknown>>()
			.notNull()
			.default(sql`'{}'`),
		targetObservedShape: text("target_observed_shape", {
			mode: "json",
		}).$type<Record<string, unknown> | null>(),
		/** IDs only; values are resolved from the machine store at launch/restart. */
		workloadSecretGrantIds: text("workload_secret_grant_ids", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'`),
		/** Environment names only, snapshotted before provider submission. */
		workloadSecretNames: text("workload_secret_names", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'`),
		/** Opaque machine credential-version binding; never a credential digest. */
		workloadSecretBinding: text("workload_secret_binding"),
		targetLifecycleState: text("target_lifecycle_state")
			.$type<TargetLifecycleState>()
			.notNull()
			.default("legacy"),
		targetCleanupRequestedAt: integer("target_cleanup_requested_at", {
			mode: "timestamp_ms",
		}),
		targetAbsenceConfirmedAt: integer("target_absence_confirmed_at", {
			mode: "timestamp_ms",
		}),

		state: text("state").$type<RunState>().notNull().default("starting"),
		outcome: text("outcome").$type<RunOutcome | null>(),
		/** Declared by the adapter, then overwritten by the driver's verified hello. */
		capabilities: text("capabilities", { mode: "json" })
			.$type<{
				steer: boolean;
				verified: boolean;
				interrupt: boolean;
				approvals: boolean;
				plan: boolean;
				fileChanges: boolean;
				commandProgress: boolean;
				mcp: boolean;
			}>()
			.notNull()
			.$defaultFn(() => ({
				steer: false,
				verified: false,
				interrupt: false,
				approvals: false,
				plan: false,
				fileChanges: false,
				commandProgress: false,
				mcp: false,
			})),

		// single-flight finalization claim
		finalizeOwner: text("finalize_owner"), // bootId of the claiming process
		finalizeClaimedAt: integer("finalize_claimed_at", { mode: "timestamp_ms" }),

		exitCode: integer("exit_code"),
		killReason: text("kill_reason").$type<KillReason | null>(),
		note: text("note"),
		usage: text("usage", { mode: "json" }).$type<Record<
			string,
			number
		> | null>(),

		startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
		finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
	},
	(t) => [
		index("ix_runs_state").on(t.state),
		index("ix_runs_task").on(t.taskId, t.startedAt),
		index("ix_runs_kind").on(t.kind, t.startedAt),
	],
);

/** Target lifecycle journal. Stable unique operation ids make write-ahead boundaries idempotent (no transaction spans the account store). */
export const runTargetJournal = sqliteTable(
	"run_target_journal",
	{
		operationId: text("operation_id").primaryKey(),
		runId: text("run_id")
			.notNull()
			.references(() => runs.id, { onDelete: "cascade" }),
		seq: integer("seq").notNull(),
		targetKind: text("target_kind").notNull(),
		targetLeaseRef: text("target_lease_ref"),
		phase: text("phase").$type<TargetJournalPhase>().notNull(),
		status: text("status").$type<"intent" | "completed" | "failed">().notNull(),
		lifecycleState: text("lifecycle_state")
			.$type<TargetLifecycleState>()
			.notNull(),
		requestedShape: text("requested_shape", { mode: "json" }).$type<Record<
			string,
			unknown
		> | null>(),
		observedShape: text("observed_shape", { mode: "json" }).$type<Record<
			string,
			unknown
		> | null>(),
		/** Codes/identifiers only; callers must not put credentials or provider payloads here. */
		detail: text("detail", { mode: "json" }).$type<Record<
			string,
			unknown
		> | null>(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(t) => [
		uniqueIndex("uq_run_target_journal_seq").on(t.runId, t.seq),
		index("ix_run_target_journal_run").on(t.runId, t.seq),
		index("ix_run_target_journal_phase").on(t.phase, t.status),
	],
);

/** Finalization journal: `done` is written only after the side effect completes; guarded steps journal key material in `result` BEFORE it (child runId, id map, merge job). */
export const runSteps = sqliteTable(
	"run_steps",
	{
		runId: text("run_id")
			.notNull()
			.references(() => runs.id, { onDelete: "cascade" }),
		step: text("step").notNull(),
		seq: integer("seq").notNull(), // execution order within the run
		status: text("status").$type<"running" | "done" | "failed">().notNull(),
		result: text("result", { mode: "json" }).$type<unknown>(),
		error: text("error"),
		startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
		finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
	},
	(t) => [
		primaryKey({ columns: [t.runId, t.step] }),
		index("ix_steps_run").on(t.runId, t.seq),
	],
);

// ---------- merge queue ----------

export type MergeJobState =
	| "queued"
	| "merging"
	| "rebasing"
	| "reverifying"
	| "merged"
	| "parked"
	// Terminal, operator-chosen (`abandon` or `sendToReady`); distinct from `merged`.
	| "abandoned";

export const mergeJobs = sqliteTable(
	"merge_jobs",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		runId: text("run_id")
			.notNull()
			.references(() => runs.id, { onDelete: "cascade" }),
		taskId: text("task_id"),
		branch: text("branch").notNull(),
		targetBranch: text("target_branch").notNull(), // recorded at enqueue, never re-resolved
		state: text("state").$type<MergeJobState>().notNull().default("queued"),
		attempt: integer("attempt").notNull().default(0),
		// Automatic park retries. Below the threshold `MergeQueue.retryParked()`
		// requeues; at it, `onParked` escalates to a human once (`MergeQueue.park()`).
		parkRetries: integer("park_retries").notNull().default(0),
		error: text("error"),
		enqueuedAt: integer("enqueued_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(t) => [
		uniqueIndex("uq_merge_run").on(t.runId), // enqueue is idempotent by runId
		index("ix_merge_state").on(t.state, t.enqueuedAt),
	],
);

// ---------- audit events ----------

export const events = sqliteTable(
	"events",
	{
		seq: integer("seq").primaryKey({ autoIncrement: true }),
		ts: integer("ts", { mode: "timestamp_ms" }).notNull(),
		type: text("type").notNull(),
		taskId: text("task_id"), // loose refs on purpose: audit rows
		runId: text("run_id"), // outlive the rows they describe
		payload: text("payload", { mode: "json" })
			.$type<Record<string, unknown>>()
			.notNull()
			.$defaultFn(() => ({})),
	},
	(t) => [
		index("ix_events_task").on(t.taskId, t.seq),
		index("ix_events_type").on(t.type, t.seq),
		index("ix_events_ts").on(t.ts),
	],
);

// ---------- comments ----------

export const comments = sqliteTable(
	"comments",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		taskId: text("task_id").notNull(),
		author: text("author").notNull(), // "human" | "run:<ulid>" | "brain:<role>"
		body: text("body").notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(t) => [index("ix_comments_task").on(t.taskId, t.createdAt)],
);

/** Structured diff-review comments. */
export const reviewComments = sqliteTable(
	"review_comments",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		taskId: text("task_id").notNull(),
		file: text("file").notNull(),
		line: integer("line").notNull(),
		side: text("side").$type<"old" | "new">().notNull().default("new"),
		body: text("body").notNull(),
		resolved: integer("resolved", { mode: "boolean" }).notNull().default(false),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(t) => [index("ix_review_comments_task").on(t.taskId, t.createdAt)],
);

/** Per-item inbox suppression; pruned when the item clears naturally. */
export const inboxDismissals = sqliteTable("inbox_dismissals", {
	itemId: text("item_id").primaryKey(), // stable derived id, e.g. "blocked:MFW-42"
	dismissedAt: integer("dismissed_at", { mode: "timestamp_ms" }).notNull(),
});

// ---------- resources + slots ----------

export const resources = sqliteTable("resources", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	type: text("type").$type<"fixed" | "dynamic">().notNull(),
	cost: text("cost").$type<"free" | "paid">().notNull(),
	maxConcurrent: integer("max_concurrent").notNull().default(1),
	policy: text("policy", { mode: "json" })
		.$type<Record<string, unknown>>()
		.notNull()
		.$defaultFn(() => ({})),
	metadata: text("metadata", { mode: "json" })
		.$type<Record<string, unknown>>()
		.notNull()
		.$defaultFn(() => ({})),
	lastUnlockedAt: integer("last_unlocked_at", { mode: "timestamp_ms" }),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/** Semaphore: one row per held slot. */
export const resourceSlots = sqliteTable(
	"resource_slots",
	{
		resourceId: text("resource_id")
			.notNull()
			.references(() => resources.id, { onDelete: "cascade" }),
		slot: integer("slot").notNull(), // 0 .. maxConcurrent-1
		runId: text("run_id")
			.notNull()
			.references(() => runs.id, { onDelete: "cascade" }),
		lockedAt: integer("locked_at", { mode: "timestamp_ms" }).notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.resourceId, t.slot] }), // single winner per slot
		index("ix_slots_run").on(t.runId),
	],
);

// ---------- project-to-host dispatch admission ----------

export type DispatchAdmissionState =
	| "resolving"
	| "waiting_host"
	| "host_granted"
	| "prepared"
	| "project_acquired"
	| "host_active"
	| "launched"
	| "compensating"
	| "released"
	| "cancelled"
	| "failed";

export type DispatchCompensationTarget = "released" | "cancelled" | "failed";

/** Project half of the cross-store admission saga. host.db stays authoritative; these ids/fences let restart recovery continue or compensate (no shared transaction). */
export const dispatchAdmissions = sqliteTable(
	"dispatch_admissions",
	{
		id: text("id").primaryKey(),
		taskId: text("task_id").notNull(),
		runId: text("run_id").notNull(),
		actor: text("actor").notNull(),
		state: text("state").$type<DispatchAdmissionState>().notNull(),
		requestKey: text("request_key").notNull().unique(),
		requirementsHash: text("requirements_hash").notNull(),
		resolution: text("resolution", { mode: "json" })
			.$type<Record<string, unknown>>()
			.notNull(),
		waiterId: text("waiter_id"),
		waiterGeneration: text("waiter_generation"),
		hostLeaseId: text("host_lease_id"),
		hostFence: text("host_fence"),
		holdCode: text("hold_code"),
		holdReason: text("hold_reason"),
		compensationTarget: text(
			"compensation_target",
		).$type<DispatchCompensationTarget>(),
		ownerBootId: text("owner_boot_id"),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(t) => [
		uniqueIndex("uq_dispatch_admission_run").on(t.runId),
		index("ix_dispatch_admission_task").on(t.taskId, t.createdAt),
		index("ix_dispatch_admission_state").on(t.state, t.updatedAt),
	],
);

// ---------- durable engine state ----------

/** Small KV of restart-critical facts. Enumerated keys:
 *  "pause"                  → { paused: bool, reason?, until?: ms }
 *  "main_red"               → { red: bool, since: ms, causeTaskId?, causeRunId? }
 *  "dispatch_hold"          → { until: ms, reason }
 *  "rate_limit:<providerId>"→ { until: ms, reason }
 */
export const engineKv = sqliteTable("engine_kv", {
	key: text("key").primaryKey(),
	value: text("value", { mode: "json" })
		.$type<Record<string, unknown>>()
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// ---------- project triggers ----------

/**
 * One row per armed trigger. `last_seq` is the durable delivery cursor,
 * advanced only AFTER the action reaches a terminal state: a crash then repeats
 * the action (visible, idempotence is the author's job) instead of silently
 * skipping it. On first arm it starts at `latestSeq()`, not zero, so arming
 * never replays project history.
 */
export const triggerCursor = sqliteTable("trigger_cursor", {
	defId: text("def_id").primaryKey(), // id from .mfw/triggers/<def>.md
	lastSeq: integer("last_seq").notNull().default(0),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type TriggerDeliveryState =
	| "pending"
	| "running"
	| "ok"
	| "failed"
	| "dead"
	| "skipped";

/**
 * Human-facing audit: what fired, when, the outcome, and what a coalescing
 * catch-up skipped.
 *
 * NEVER consulted to decide whether to dispatch: a row only says mfw STARTED the
 * action, and suppressing on it would block the retry a crash requires.
 * Idempotence belongs to the action, keyed on the delivery id.
 */
export const triggerDeliveries = sqliteTable(
	"trigger_deliveries",
	{
		/** `sha256(defId + ":" + eventSeq)`, first 16 hex; stable so redelivery reuses it. */
		id: text("id").primaryKey(),
		defId: text("def_id").notNull(),
		eventSeq: integer("event_seq").notNull(),
		eventType: text("event_type").notNull(),
		state: text("state")
			.$type<TriggerDeliveryState>()
			.notNull()
			.default("pending"),
		attempt: integer("attempt").notNull().default(0),
		startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
		finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
		durationMs: integer("duration_ms"),
		exitCode: integer("exit_code"),
		runId: text("run_id"), // set for agent actions
		/** Last 8 KB of stderr, or the agent's summary, or the failure reason. */
		detail: text("detail"),
		/** Seqs `catchup: latest` coalesced past. */
		skippedSeqs: text("skipped_seqs", { mode: "json" })
			.$type<number[]>()
			.notNull()
			.$defaultFn(() => []),
	},
	(t) => [
		index("ix_trigger_deliveries_def").on(t.defId, t.eventSeq),
		index("ix_trigger_deliveries_state").on(t.state, t.startedAt),
	],
);

export const lifetimeState = sqliteTable("lifetime_state", {
	defId: text("def_id").primaryKey(), // id from .mfw/lifetime/<def>.md
	lastFiredAt: integer("last_fired_at", { mode: "timestamp_ms" }),
	lastTaskId: text("last_task_id"),
	lastError: text("last_error"),
});

// ---------- clarify gate ----------

export const clarifications = sqliteTable(
	"clarifications",
	{
		runId: text("run_id").primaryKey(), // the plan run that raised them
		kind: text("kind").notNull(), // "planner" | "importer" | …
		goal: text("goal"),
		items: text("items", { mode: "json" })
			.$type<{ question: string; answer: string | null }[]>()
			.notNull(),
		/** Write-ahead idempotency key for the plan run consuming the answers; claimed before launch and kept through ambiguous failures so retries resume the same child. */
		continuationRunId: text("continuation_run_id"),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
	},
	(t) => [index("ix_clarify_open").on(t.resolvedAt)],
);

// ---------- decision records (brain calls) ----------

export type DecisionRole =
	| "planner"
	| "supervisor"
	| "replan"
	| "critic"
	| "import_review"
	| "groomer"
	// Picks a subset of the dependency-ready frontier; the scheduler still enforces hard limits.
	| "dispatch_plan"
	// Second opinion on a sweep failure that neither the crash check nor
	// green-sha corroboration could place as infra.
	| "diagnose";
export type DecisionStatus =
	| "running"
	| "ok"
	| "failed"
	| "timeout"
	| "aborted";

// ---------- escalation sessions ----------

/** What exhausted its own recovery: the three "critical" shapes in `InboxService`'s SEVERITY table. */
export type SessionSource = "main_red" | "merge_parked" | "blocked";

export type SessionResolution = "fixed" | "retried" | "dismissed";

/** A pre-loaded brain session composed when recovery is exhausted. `context` is the full brief, built once at `raise()`; opening costs nothing until a human asks for the run. */
export const sessions = sqliteTable(
	"sessions",
	{
		id: text("id").primaryKey(), // ULID
		source: text("source").$type<SessionSource>().notNull(),
		/** Dedup key within `source` (task id, merge job id, ...): `raise()` is a no-op while an unresolved session exists for it. */
		sourceKey: text("source_key").notNull(),
		taskId: text("task_id"),
		/** Run whose worktree/branch `open()` reuses; absent for `main_red`. */
		runId: text("run_id"),
		mergeJobId: integer("merge_job_id"),
		title: text("title").notNull(),
		context: text("context").notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		/** Set once a human opens it (`SessionService.open`); this run costs money. */
		openedRunId: text("opened_run_id"),
		openedAt: integer("opened_at", { mode: "timestamp_ms" }),
		/** Never set without `resolution`; `"dismissed"` requires `resolutionReason`. */
		resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
		resolution: text("resolution").$type<SessionResolution | null>(),
		resolutionReason: text("resolution_reason"),
	},
	(t) => [
		index("ix_sessions_open").on(t.source, t.sourceKey, t.resolvedAt),
		index("ix_sessions_task").on(t.taskId, t.createdAt),
	],
);

export const decisions = sqliteTable(
	"decisions",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		ts: integer("ts", { mode: "timestamp_ms" }).notNull(),
		role: text("role").$type<DecisionRole>().notNull(),
		taskId: text("task_id"),
		/** The run being decided about. */
		subjectRunId: text("subject_run_id"),
		/** The registry run (kind "brain") executing this call; its run dir holds
		 *  prompt.md + raw.log, the full auditable context. */
		brainRunId: text("brain_run_id"),
		model: text("model").notNull(),
		status: text("status").$type<DecisionStatus>().notNull().default("running"),
		action: text("action"), // the decision enum, e.g. "resume" (null until ok)
		reason: text("reason"),
		input: text("input", { mode: "json" })
			.$type<Record<string, unknown>>()
			.notNull()
			.$defaultFn(() => ({})),
		output: text("output", { mode: "json" })
			.$type<Record<string, unknown>>()
			.notNull()
			.$defaultFn(() => ({})),
		durationMs: integer("duration_ms"),
		supersededBy: integer("superseded_by"),
		finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
	},
	(t) => [
		index("ix_decisions_task").on(t.taskId, t.ts),
		index("ix_decisions_role").on(t.role, t.ts),
		index("ix_decisions_subject").on(t.subjectRunId),
	],
);
