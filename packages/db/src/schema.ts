import { sql } from "drizzle-orm";
import {
	index,
	integer,
	primaryKey,
	real,
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
/** Why a run exists relative to its `parent_run_id` (data-and-api §2.1). */
export type RunRelation =
	| "fresh"
	| "continue"
	| "repair"
	| "resume"
	| "answer"
	| "unblock"
	| "replan"
	| "judge"
	| "recovery"
	| "session"
	| "trigger"
	| "attempt";

/** What a run is for inside its group (0017). NULL on runs that predate groups. */
export type RunRole =
	| "implement"
	| "attempt"
	| "review"
	| "verify"
	| "spike"
	| "research"
	| "plan"
	| "conflict"
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
	| "watchdog-timebox"
	/** Touched files another claimed task owns (scope watchdog). */
	| "watchdog-scope"
	/** Changed more files than the scope watchdog allows. */
	| "watchdog-files";

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
		/**
		 * The running total while the run is live (0017): sampled from the
		 * transcript, at most every 30 s. Display only; `usage` (final) and the
		 * spend ledger stay the source for budgets.
		 */
		usageLive: text("usage_live", { mode: "json" }).$type<Record<
			string,
			number
		> | null>(),

		startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
		finishedAt: integer("finished_at", { mode: "timestamp_ms" }),

		// Outcome facts (0009). Snapshotted when the run row is created so later
		// task edits never rewrite history; NULL on rows that predate them.
		/** Adapter that drove the run (today equal to `provider_id`). */
		harness: text("harness"),
		/** Who serves the model: `anthropic | openai | openrouter | local | …`. */
		modelVendor: text("model_vendor"),
		/** Routing decision that picked harness/model (routing phase). */
		routing: text("routing", { mode: "json" }).$type<Record<
			string,
			unknown
		> | null>(),
		/** Last diff-scope sample (scope watchdog phase). */
		scopeSample: text("scope_sample", { mode: "json" }).$type<Record<
			string,
			unknown
		> | null>(),
		/** Activity classification, separate from lifecycle `state`. */
		activity: text("activity"),
		activityDetail: text("activity_detail", { mode: "json" }).$type<Record<
			string,
			unknown
		> | null>(),
		taskSize: text("task_size"),
		taskType: text("task_type"),
		modelTier: text("model_tier"),
		/** Execution host id (host registry phase). */
		hostId: text("host_id"),
		/**
		 * The harness's own session handle (0010): Claude's `--session-id` uuid,
		 * Codex's `thread/start` thread id. Lets a later run resume the native
		 * conversation. NULL until the session is reported.
		 */
		nativeSessionId: text("native_session_id"),

		// Typed lineage (0012). `parent_run_id` alone is overloaded (worktree
		// continuation, source plan, subject run); `relation` says which.
		/** Why this run exists relative to `parent_run_id` (or `fresh`). NULL only before backfill. */
		relation: text("relation").$type<RunRelation>(),
		/** First run of this worktree chain; equals `id` for a root. */
		chainRootId: text("chain_root_id"),
		/** The `decisions.id` whose action created this run. */
		spawnedByDecisionId: integer("spawned_by_decision_id"),
		/** Non-run origin: `session:<id>`, `trigger:<deliveryId>`, `clarify:<runId>`, `human:<actor>`. */
		originRef: text("origin_ref"),
		/**
		 * The attempt group this run belongs to (0017). NULL means "a group of
		 * one whose id is this run's own id": every claim is held by a group, and
		 * a single-run group is named after its run (`groupIdOf`).
		 */
		groupId: text("group_id"),
		/** What the run is for inside its group (0017). */
		role: text("role").$type<RunRole>(),
		/**
		 * What remains once gc removed the run directory (0015): last assistant
		 * message, tool counts, files touched, first error, `prunedAt`. Written
		 * before the directory is deleted; NULL while the transcript exists.
		 */
		transcriptSummary: text("transcript_summary", {
			mode: "json",
		}).$type<Record<string, unknown> | null>(),
	},
	(t) => [
		index("ix_runs_state").on(t.state),
		index("ix_runs_task").on(t.taskId, t.startedAt),
		index("ix_runs_kind").on(t.kind, t.startedAt),
		index("ix_runs_parent").on(t.parentRunId),
		index("ix_runs_chain").on(t.chainRootId),
		index("ix_runs_group").on(t.groupId),
	],
);

/** The group a run belongs to: its stored group, else itself (a group of one). */
export function groupIdOf(run: {
	id: string;
	groupId?: string | null;
}): string {
	return run.groupId ?? run.id;
}

export type RunGroupKind = "single" | "competing" | "pipeline";
export type RunGroupSelection = "brain" | "first_verified";
export type RunGroupStatus = "open" | "selecting" | "merged" | "abandoned";

/**
 * The unit that holds a task's claim (design §3.5). A `single` group is named
 * after its only run; a `competing` group has N sibling `attempt` runs, each
 * in its own worktree, of which one may win and be merged.
 */
export const runGroups = sqliteTable(
	"run_groups",
	{
		id: text("id").primaryKey(),
		taskId: text("task_id").notNull(),
		kind: text("kind").$type<RunGroupKind>().notNull(),
		selection: text("selection").$type<RunGroupSelection>().notNull(),
		status: text("status").$type<RunGroupStatus>().notNull(),
		winnerRunId: text("winner_run_id"),
		/** The `brain_actions.id` that created the group (NULL for human starts). */
		createdByAction: text("created_by_action"),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		closedAt: integer("closed_at", { mode: "timestamp_ms" }),
	},
	(t) => [index("ix_run_groups_task").on(t.taskId, t.createdAt)],
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
		index("ix_events_run").on(t.runId, t.seq),
		index("ix_events_type").on(t.type, t.seq),
		index("ix_events_ts").on(t.ts),
	],
);

// ---------- spans ----------

/**
 * Durable per-subject timeline (0014): a value held on one lane between two
 * events. Written by `appendEvent` in the event's own transaction (`spans.ts`);
 * `end_ts` is NULL while the span is open. Subjects: `run:<id>`, `task:<id>`.
 */
export const runSpans = sqliteTable(
	"run_spans",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		subject: text("subject").notNull(),
		/** `state | activity | status | hold | admission | merge` */
		lane: text("lane").notNull(),
		value: text("value").notNull(),
		startTs: integer("start_ts", { mode: "timestamp_ms" }).notNull(),
		endTs: integer("end_ts", { mode: "timestamp_ms" }),
		/** Question text, stall cause, hold reason, actor. */
		detail: text("detail", { mode: "json" }).$type<Record<
			string,
			unknown
		> | null>(),
		/** The `events.seq` that opened / closed it, for scrub alignment. */
		startSeq: integer("start_seq"),
		endSeq: integer("end_seq"),
	},
	(t) => [
		index("ix_run_spans_subject").on(t.subject, t.lane, t.startTs),
		index("ix_run_spans_start").on(t.startTs),
	],
);

/**
 * `run_subagents`: one row per subagent a run started (U7, data-and-api §2.5),
 * written by the run-event tail as it reads `events.jsonl`. The key is the
 * run and the id of the subagent's starting tool call (Claude `Agent` /
 * `Task`) or, for a Codex sub-thread, the thread id. `entry_from_seq` and
 * `entry_to_seq` are the `events.jsonl` seqs the subagent's own entries span,
 * so the UI can slice the parent transcript without a second file.
 */
export const runSubagents = sqliteTable(
	"run_subagents",
	{
		runId: text("run_id").notNull(),
		toolUseId: text("tool_use_id").notNull(),
		/** The subagent that started this one (nested), else null: the run itself. */
		parentToolUseId: text("parent_tool_use_id"),
		agentType: text("agent_type").notNull(),
		description: text("description").notNull(),
		startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
		endedAt: integer("ended_at", { mode: "timestamp_ms" }),
		/** `running | ok | error` */
		status: text("status").notNull(),
		/** Tool calls the subagent made, by tool name. */
		tools: text("tools", { mode: "json" })
			.$type<Record<string, number>>()
			.notNull(),
		entryFromSeq: integer("entry_from_seq").notNull(),
		entryToSeq: integer("entry_to_seq").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.runId, t.toolUseId] }),
		index("ix_run_subagents_started").on(t.startedAt),
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
	| "brain"
	| "supervisor"
	| "replan"
	| "critic"
	| "import_review"
	| "groomer"
	// A person's mutation through the API (U4-03): the human half of the audit trail.
	| "human"
	// Retired: the project brain's `spawn` actions replaced wave planning. Old rows only.
	| "dispatch_plan"
	// Second opinion on a sweep failure that neither the crash check nor
	// green-sha corroboration could place as infra.
	| "diagnose";
/** What a decisions row records (0010); NULL on rows that predate the column. */
export type DecisionKind =
	| "action"
	| "plan"
	| "note"
	| "rollover"
	| "escalation"
	| "judge"
	| "override";
export type DecisionConfidence = "low" | "medium" | "high";
/** What a decision cited: event seqs, run ids and task revs read before it. */
export interface DecisionContextRefs {
	events?: number[];
	runs?: string[];
	tasks?: { id: string; rev: number | string }[];
}
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
		/** Token/cost envelope of the brain call itself (0009); NULL when unknown. */
		usage: text("usage", { mode: "json" }).$type<Record<
			string,
			number
		> | null>(),
		supersededBy: integer("superseded_by"),
		finishedAt: integer("finished_at", { mode: "timestamp_ms" }),

		// Audit-trail columns (0010), all nullable and additive: written by the
		// brain-led design; legacy rows leave them NULL.
		brainSessionId: text("brain_session_id"),
		turnRunId: text("turn_run_id"),
		kind: text("kind").$type<DecisionKind | null>(),
		alternatives: text("alternatives", { mode: "json" }).$type<
			{ option: string; why_not: string }[] | null
		>(),
		confidence: text("confidence").$type<DecisionConfidence | null>(),
		contextRefs: text("context_refs", {
			mode: "json",
		}).$type<DecisionContextRefs | null>(),
		harness: text("harness"),
		/** Filled when the effect's attempt chain closes: `{final, firstPass, repairs, costUsd, durationMs}`. */
		outcome: text("outcome", { mode: "json" }).$type<Record<
			string,
			unknown
		> | null>(),
		/** Id of the human override decision that reversed this one. */
		overriddenBy: integer("overridden_by"),
	},
	(t) => [
		index("ix_decisions_task").on(t.taskId, t.ts),
		index("ix_decisions_role").on(t.role, t.ts),
		index("ix_decisions_subject").on(t.subjectRunId),
	],
);

// ---------- spend ledger ----------

export type SpendKind = "agent" | "brain" | "resource";
export type SpendSource =
	| "run_usage"
	| "brain_usage"
	| "runpod_billing"
	| "host_slot_time";

/**
 * Append-only spend facts (0010). One row per usage ingest: a run's final
 * usage (`run_usage`, upserted on `run_id + source`), a brain call's delta
 * (`brain_usage`), or a resource charge. A budget is a windowed sum over
 * `(account_key, ts)`. `usd` is NULL when the harness reports no dollars;
 * tokens still count.
 */
export const spendLedger = sqliteTable(
	"spend_ledger",
	{
		id: text("id").primaryKey(), // ULID
		ts: integer("ts", { mode: "timestamp_ms" }).notNull(),
		kind: text("kind").$type<SpendKind>().notNull(),
		/** Provider hold key (`claude-cli`, `codex-cli@<ep>`) or resource key (`runpod:<acct>`, `host:<id>`). */
		accountKey: text("account_key").notNull(),
		runId: text("run_id"),
		brainSessionId: text("brain_session_id"),
		taskId: text("task_id"),
		usd: real("usd"),
		tokensIn: integer("tokens_in"),
		tokensOut: integer("tokens_out"),
		estimated: integer("estimated", { mode: "boolean" })
			.notNull()
			.default(false),
		source: text("source").$type<SpendSource>().notNull(),
	},
	(t) => [
		index("ix_spend_account_ts").on(t.accountKey, t.ts),
		// NULL run ids (resource charges) never collide: SQLite unique indexes treat NULLs as distinct.
		uniqueIndex("uq_spend_run_source").on(t.runId, t.source),
	],
);

// ---------- project brain runtime ----------

export type BrainSessionStatus =
	/** Asleep between wakes. */
	| "idle"
	/** A turn is live. */
	| "turn"
	/** Held by a human or a budget; no wake starts a turn. */
	| "paused"
	/** Circuit open after repeated failed turns; a human resets it. */
	| "failed"
	| "retired";

export type BrainTurnStatus =
	| "running"
	| "ok"
	| "failed"
	| "timeout"
	| "aborted";

/**
 * One row per brain (0011). `scope` is `{kind: "project"}` today; the field is
 * there so a subtree brain is another row later. The native session is a cache:
 * everything the brain needs is rebuilt from the board, `events` and
 * `decisions` by a rollover (new `generation`).
 */
export const brainSessions = sqliteTable(
	"brain_sessions",
	{
		id: text("id").primaryKey(), // ULID
		scope: text("scope", { mode: "json" })
			.$type<{ kind: "project" } | { kind: "subtree"; root: string }>()
			.notNull(),
		status: text("status").$type<BrainSessionStatus>().notNull(),
		harness: text("harness").notNull(),
		model: text("model").notNull(),
		effort: text("effort"),
		endpoint: text("endpoint"),
		/** Claude `--session-id` uuid (minted by mfw) / Codex thread id. NULL until the first turn of a generation reports it. */
		nativeSessionId: text("native_session_id"),
		/** Cumulative `total_cost_usd` the last turn reported, so the ledger writes deltas. */
		lastCostTotal: real("last_cost_total"),
		/** Hostname the session file lives on; resume is host-local. */
		nativeHost: text("native_host").notNull(),
		generation: integer("generation").notNull().default(0),
		generationStartedAt: integer("generation_started_at", {
			mode: "timestamp_ms",
		}).notNull(),
		contextTokens: integer("context_tokens").notNull().default(0),
		/** Last consumed `events.seq`; advances only when a turn ends `ok`. */
		cursor: integer("cursor").notNull().default(0),
		wakeHint: text("wake_hint", { mode: "json" }).$type<Record<
			string,
			unknown
		> | null>(),
		/** bootId fencing, as `runs.finalize_owner`. */
		leaseOwner: text("lease_owner"),
		leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
		consecutiveFailures: integer("consecutive_failures").notNull().default(0),
		/** Earliest next attempt after a failed turn (retry backoff). */
		retryAfter: integer("retry_after", { mode: "timestamp_ms" }),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		retiredAt: integer("retired_at", { mode: "timestamp_ms" }),
		retireReason: text("retire_reason"),
	},
	(t) => [index("ix_brain_sessions_status").on(t.status)],
);

/** One turn: a `kind: brain` run, its wake, the event range it consumes. */
export const brainTurns = sqliteTable(
	"brain_turns",
	{
		runId: text("run_id").primaryKey(),
		sessionId: text("session_id").notNull(),
		seq: integer("seq").notNull(),
		generation: integer("generation").notNull(),
		wakeClass: text("wake_class").notNull(),
		eventsFrom: integer("events_from").notNull(),
		eventsTo: integer("events_to").notNull(),
		resumed: integer("resumed", { mode: "boolean" }).notNull(),
		status: text("status").$type<BrainTurnStatus>().notNull(),
		/** Cumulative usage as the turn reported it, plus the `deltaUsd` it added to the ledger. */
		usage: text("usage", { mode: "json" }).$type<Record<
			string,
			number
		> | null>(),
		actionsCount: integer("actions_count").notNull().default(0),
		startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
		endedAt: integer("ended_at", { mode: "timestamp_ms" }),
		error: text("error"),
	},
	(t) => [
		uniqueIndex("uq_brain_turn_seq").on(t.sessionId, t.seq),
		index("ix_brain_turns_status").on(t.status, t.startedAt),
	],
);

export type BrainActionStatus =
	| "accepted"
	| "applied"
	| "rejected"
	| "failed"
	/** Validated by the real invariants, recorded, never executed (shadow mode). */
	| "proposed";

/** Outbox and action audit: one row per act-tool call, keyed for idempotency. */
export const brainActions = sqliteTable(
	"brain_actions",
	{
		id: text("id").primaryKey(), // ULID, returned to the brain
		idemKey: text("idem_key").notNull(),
		sessionId: text("session_id").notNull(),
		turnRunId: text("turn_run_id").notNull(),
		tool: text("tool").notNull(),
		args: text("args", { mode: "json" })
			.$type<Record<string, unknown>>()
			.notNull(),
		status: text("status").$type<BrainActionStatus>().notNull(),
		rejection: text("rejection", { mode: "json" }).$type<{
			code: string;
			message: string;
			fix?: { kind: string; text: string };
		} | null>(),
		/** Ids written before the effect (pre-minted run ids, created task ids). */
		effects: text("effects", { mode: "json" }).$type<Record<
			string,
			unknown
		> | null>(),
		decisionId: integer("decision_id"),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
		appliedAt: integer("applied_at", { mode: "timestamp_ms" }),
	},
	(t) => [
		uniqueIndex("uq_brain_action_idem").on(t.idemKey),
		index("ix_brain_actions_turn").on(t.turnRunId, t.createdAt),
		index("ix_brain_actions_session").on(t.sessionId, t.createdAt),
	],
);

// ---------- outcomes ----------

/** How a task attempt chain ended. NULL `final` = the chain is still open. */
export type AttemptFinal =
	| "merged"
	| "blocked"
	| "review_human"
	| "abandoned"
	| "killed_scope"
	| "killed_watchdog"
	| "rate_limited"
	| "interrupted";

/**
 * One row per task attempt chain: a root `task` run plus the repair, resume
 * and unblock children that continue it in the same worktree (`parent_run_id`
 * lineage). A derived cache: `rollupAttemptChain` recomputes a row from
 * `runs` / `run_steps` / `merge_jobs` / `review_verdicts` from scratch, so
 * writes are idempotent and the table is safe to drop and backfill.
 */
export const taskAttemptOutcomes = sqliteTable(
	"task_attempt_outcomes",
	{
		rootRunId: text("root_run_id").primaryKey(),
		taskId: text("task_id"),
		harness: text("harness"),
		modelVendor: text("model_vendor"),
		model: text("model").notNull(),
		effort: text("effort"),
		tier: text("tier"),
		size: text("size"),
		type: text("type"),
		target: text("target"),
		hostId: text("host_id"),
		startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
		finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
		/** Agent runs in the chain (root included). */
		runs: integer("runs").notNull(),
		/** Repair children in the chain, counted from lineage, never from `attempt`. */
		repairs: integer("repairs").notNull(),
		/** Review `fix` verdicts on chain runs. */
		reviewRounds: integer("review_rounds").notNull(),
		/** Merged with zero repairs and zero review fix rounds. */
		firstPass: integer("first_pass", { mode: "boolean" }).notNull(),
		final: text("final").$type<AttemptFinal | null>(),
		/** Verdict counts on chain runs, e.g. `{ "merge": 1, "critic:flagged": 1 }`. */
		verdicts: text("verdicts", { mode: "json" })
			.$type<Record<string, number>>()
			.notNull()
			.default(sql`'{}'`),
		tokensIn: integer("tokens_in"),
		tokensOut: integer("tokens_out"),
		tokensCached: integer("tokens_cached"),
		tokensReasoning: integer("tokens_reasoning"),
		costUsd: real("cost_usd"),
		/** False when any agent run in the chain reported no cost. */
		costComplete: integer("cost_complete", { mode: "boolean" }).notNull(),
		filesChanged: integer("files_changed"),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	},
	(t) => [
		index("ix_outcomes_task").on(t.taskId, t.startedAt),
		index("ix_outcomes_started").on(t.startedAt),
	],
);

export type ReviewVerdictValue = "merge" | "fix" | "reject";

/** One reviewer verdict on a subject run (review phase writes these). */
export const reviewVerdicts = sqliteTable(
	"review_verdicts",
	{
		id: text("id").primaryKey(), // ULID
		taskId: text("task_id"),
		subjectRunId: text("subject_run_id").notNull(),
		reviewerRunId: text("reviewer_run_id"),
		decisionId: integer("decision_id"),
		mode: text("mode").$type<"critic" | "agent" | "human">().notNull(),
		reviewerHarness: text("reviewer_harness"),
		reviewerModel: text("reviewer_model"),
		round: integer("round").notNull().default(0),
		verdict: text("verdict").$type<ReviewVerdictValue>().notNull(),
		findings: text("findings", { mode: "json" })
			.$type<unknown[]>()
			.notNull()
			.default(sql`'[]'`),
		criteria: text("criteria", { mode: "json" })
			.$type<unknown[]>()
			.notNull()
			.default(sql`'[]'`),
		independent: integer("independent", { mode: "boolean" }),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(t) => [
		index("ix_review_verdicts_task").on(t.taskId, t.createdAt),
		index("ix_review_verdicts_subject").on(t.subjectRunId),
	],
);
