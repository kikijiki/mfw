/**
 * Finalization state machine v2, PURE. No IO, no imports beyond types.
 * Two transition tables: task runs, and import / plan / action / brain runs.
 *
 * The StepRunner loop: `next(ctx)` → execute the directive's step (journaled)
 * → fold the result into ctx → call `next` again, until a Terminal. A crash
 * resumes by rebuilding ctx from the journal and re-calling `next`. Rows are
 * evaluated top-to-bottom; the first matching row wins.
 */

export type RunKind =
	| "task"
	| "repair"
	| "import"
	| "plan"
	| "action"
	| "brain";

export type RunOutcome =
	| "completed"
	| "rate_limited"
	| "killed_manual"
	| "killed_watchdog"
	| "interrupted"
	| "start_failed";

export type StepName =
	| "classify"
	| "reap_leftovers"
	| "decide_resume"
	| "hold_rate_limit"
	| "ingest_report"
	| "create_followups"
	| "verify"
	| "critic"
	| "replan_decide"
	| "import_review"
	| "parse_plan"
	| "create_tasks"
	| "create_specs"
	| "record_questions"
	| "spawn_repair"
	| "spawn_resume"
	| "enqueue_merge"
	| "release_task"
	| "bump_stall"
	| "clear_stall"
	| "gc_worktree"
	| "notify"
	| "finish_decision"
	| "draft_expand_failed";

export type TaskDisposition =
	| "draft"
	| "ready"
	| "blocked"
	| "review"
	| "backlog"
	| "archived"
	| "done"
	| "in_progress";

export type TerminalState =
	| "completed"
	| "failed"
	| "killed"
	| "interrupted"
	| "rate_limited"
	| "needs_review";

export type ReplanAction =
	| "resume"
	| "retry"
	| "replan"
	| "split"
	| "abandon"
	| "escalate";

export interface Directive {
	kind: "step";
	step: StepName;
	/** Step arguments; release_task carries the target disposition, notify a reason. */
	args?: { to?: TaskDisposition; reason?: string; force?: boolean };
	/** Which table row produced this, for logs, tests, and debugging. */
	row: string;
}

export interface Terminal {
	kind: "terminal";
	state: TerminalState;
	note?: string;
	row: string;
}

export interface FinalizeCtx {
	kind: RunKind;
	/** null until `classify` has run. */
	outcome: RunOutcome | null;
	/** Steps whose journal row is `done`. */
	done: ReadonlySet<StepName>;
	/**
	 * A `kind: "plan"` run with a `taskId`, expanding one `draft` task rather
	 * than proposing a fresh DAG. Gates `draft_expand_failed` in the plan rows.
	 */
	isDraftExpand: boolean;
	/** Task context; null for non-task kinds or when the task row vanished. */
	task: {
		exists: boolean;
		hasDod: boolean;
		/** Agent-declared escalation from MFW_REPORT. */
		escalation: "drop" | "needs-replan" | "blocked" | null;
		attempt: number;
		maxRepairs: number;
		stallCount: number;
		maxStalls: number;
		resumeCount: number;
		maxResumes: number;
		worktreeDirty: boolean;
		exitCode: number | null;
	} | null;
	gates: {
		mainRed: boolean;
		reviewGated: boolean;
		brainEnabled: boolean;
		criticEnabled?: boolean;
		replanEnabled?: boolean;
		importReviewEnabled?: boolean;
	};
	// step results observed so far
	/** `crashed` mirrors `VerificationResult.crashed`: a check process died to
	 *  a signal. Always `false` when `passed`. */
	verify: { passed: boolean; crashed: boolean } | null;
	critic: { status: "ok" | "failed"; flagged: boolean } | null;
	replan: { status: "ok" | "failed"; action: ReplanAction | null } | null;
	importReview: { status: "ok" | "failed"; approved: boolean } | null;
	planParsed: boolean | null;
	/** Whether the ingested report actually proposed subtasks (T22 guard). */
	reportHasSubtasks: boolean;
	/** Whether the ingested report carried at least one valid follow-up. */
	reportHasFollowUps: boolean;
	/**
	 * A run executed locally in a worktree. Code-running task, repair, plan,
	 * import and action sessions all require process cleanup before disposal.
	 */
	localWorktree: boolean;
	/** `reap_leftovers` found processes the agent left running. */
	leftBackground: boolean;
	/** Durable decision and ordinal: task counters may change after child handoff. */
	resumeDecision: { selected: boolean; ordinal: number } | null;
	/**
	 * Whether the parsed proposal carried specs / clarifying questions. Both
	 * gate their step so the journal never records a no-op, and so
	 * `notify(clarify)` fires only when a human must answer something.
	 */
	planHasSpecs: boolean;
	planHasQuestions: boolean;
}

const step = (
	row: string,
	s: StepName,
	args?: Directive["args"],
): Directive => ({ kind: "step", step: s, args, row });

const terminal = (
	row: string,
	state: TerminalState,
	note?: string,
): Terminal => ({
	kind: "terminal",
	state,
	note,
	row,
});

/** First not-done step from an ordered sequence, else the terminal. */
function seq(
	row: string,
	ctx: FinalizeCtx,
	steps: [StepName, Directive["args"]?][],
	end: { state: TerminalState; note?: string },
): Directive | Terminal {
	for (const [s, args] of steps) {
		if (!ctx.done.has(s)) return step(row, s, args);
	}
	return terminal(row, end.state, end.note);
}

export function next(ctx: FinalizeCtx): Directive | Terminal {
	if (
		ctx.done.has("classify") &&
		ctx.localWorktree &&
		!ctx.done.has("reap_leftovers")
	)
		return step("local-reap", "reap_leftovers");
	switch (ctx.kind) {
		case "task":
			return nextTask(ctx);
		case "repair":
			return nextRecovery(ctx);
		case "import":
			return nextImport(ctx);
		case "plan":
			return nextPlan(ctx);
		case "action":
			if (!ctx.done.has("classify")) return step("A0", "classify");
			if (!ctx.done.has("ingest_report")) return step("A0", "ingest_report");
			return seq("A0", ctx, [["gc_worktree", { force: false }]], {
				state: outcomeState(ctx.outcome),
			});
		case "brain":
			if (!ctx.done.has("classify")) return step("B0", "classify");
			return seq("B0", ctx, [["finish_decision"]], {
				state: outcomeState(ctx.outcome),
			});
	}
}

/** A regression repair references a historical task for its DoD and prompt,
 * but never owns that task's board state. It either verifies and queues its
 * branch, or terminates visibly; no release_task directive is permitted. */
function nextRecovery(ctx: FinalizeCtx): Directive | Terminal {
	if (!ctx.done.has("classify")) return step("R0", "classify");
	if (!ctx.done.has("ingest_report")) return step("R0", "ingest_report");
	if (ctx.reportHasFollowUps && !ctx.done.has("create_followups"))
		return step("R0-followups", "create_followups");
	if (ctx.leftBackground)
		return terminal(
			"R-background",
			"failed",
			"repair left unfinished background work",
		);
	if (ctx.outcome !== "completed") {
		return seq("R1", ctx, [["gc_worktree", { force: false }]], {
			state: outcomeState(ctx.outcome),
		});
	}
	if (!ctx.task?.exists || !ctx.task.hasDod) {
		return terminal("R3", "failed", "repair has no deterministic DoD");
	}
	if (!ctx.done.has("verify")) return step("R4", "verify");
	if (ctx.verify?.passed !== true) {
		return terminal(
			"R5",
			"failed",
			ctx.verify?.crashed
				? "repair verification infrastructure failure"
				: "repair did not pass verification",
		);
	}
	return seq("R6", ctx, [["enqueue_merge"]], {
		state: "completed",
		note: "merging",
	});
}

/** Map a run outcome to the matching terminal state for non-task kinds. */
function outcomeState(outcome: RunOutcome | null): TerminalState {
	switch (outcome) {
		case "completed":
			return "completed";
		case "rate_limited":
			return "rate_limited";
		case "killed_manual":
		case "killed_watchdog":
			return "killed";
		case "interrupted":
			return "interrupted";
		default:
			return "failed";
	}
}

// ---------- §2.3 task runs ----------

function nextTask(ctx: FinalizeCtx): Directive | Terminal {
	// T0
	if (!ctx.done.has("classify")) return step("T0", "classify");
	// Ingest before every outcome so interrupted/start-failed/orphan cleanup
	// cannot bypass MFW_REPORT.json.
	if (!ctx.done.has("ingest_report")) return step("T0", "ingest_report");
	// T0-followups: discovered work is recorded whatever became of the run.
	if (ctx.reportHasFollowUps && !ctx.done.has("create_followups"))
		return step("T0-followups", "create_followups");
	// A persisted handoff dominates mutable task state, even task deletion.
	if (ctx.resumeDecision?.selected) {
		return seq(
			ctx.outcome === "interrupted" ? "T5" : "T10L",
			ctx,
			[["spawn_resume"]],
			{
				state: ctx.outcome === "interrupted" ? "interrupted" : "completed",
				note: "resumed in child run",
			},
		);
	}
	const t = ctx.task;

	// A task run whose task row vanished mid-run has nothing to release.
	if (!t?.exists) {
		return seq("T-orphan", ctx, [["gc_worktree"]], {
			state: outcomeState(ctx.outcome),
			note: "task no longer exists",
		});
	}

	// T1, rate limit: hold dispatch, no attempt consumed, worktree kept.
	if (ctx.outcome === "rate_limited") {
		return seq(
			"T1",
			ctx,
			[["hold_rate_limit"], ["release_task", { to: "ready" }]],
			{ state: "rate_limited" },
		);
	}
	// T2, never reached running.
	if (ctx.outcome === "start_failed") {
		return seq(
			"T2",
			ctx,
			[["release_task", { to: "ready" }], ["gc_worktree"]],
			{
				state: "failed",
				note: "start failed",
			},
		);
	}
	// T3, manual kill: work preserved via task_runtime pointers, task ready.
	if (ctx.outcome === "killed_manual") {
		return seq(
			"T3",
			ctx,
			[["ingest_report"], ["release_task", { to: "ready" }], ["gc_worktree"]],
			{ state: "killed" },
		);
	}
	// T4, watchdog kill: counts as a stall.
	if (ctx.outcome === "killed_watchdog") {
		return seq(
			"T4",
			ctx,
			[
				["ingest_report"],
				["bump_stall"],
				["release_task", { to: "blocked" }],
				["notify", { reason: "blocked" }],
				["gc_worktree"],
			],
			{ state: "killed" },
		);
	}
	// T5 / T6, interrupted (reboot/crash without exit record).
	if (ctx.outcome === "interrupted") {
		if (!ctx.resumeDecision) return step("T5-decision", "decide_resume");

		return seq(
			"T6",
			ctx,
			[["release_task", { to: "ready" }], ["gc_worktree"]],
			{
				state: "interrupted",
			},
		);
	}

	// outcome === completed from here on.
	// T8-T10, agent-declared escalations.
	if (t.escalation === "drop") {
		return seq(
			"T8",
			ctx,
			[["release_task", { to: "archived" }], ["gc_worktree"]],
			{
				state: "failed",
				note: "agent dropped the task",
			},
		);
	}
	if (t.escalation === "needs-replan") {
		return seq(
			"T9",
			ctx,
			[["release_task", { to: "backlog" }], ["gc_worktree"]],
			{
				state: "failed",
				note: "agent requested replan",
			},
		);
	}
	if (t.escalation === "blocked") {
		return seq(
			"T10",
			ctx,
			[
				["release_task", { to: "blocked" }],
				["notify", { reason: "blocked" }],
				["gc_worktree"],
			],
			{ state: "failed", note: "agent reported blocked" },
		);
	}
	// T10L, the agent ended its session with processes still running. They
	// were stopped, so whatever they were doing is unfinished: resume the
	// session (bounded) rather than judge the work. Past the bound, verification
	// decides as usual.
	if (ctx.leftBackground && !ctx.resumeDecision)
		return step("T10L-decision", "decide_resume");

	// T11, no mechanical checks. Exit success only lets the candidate reach the
	// gates below; it is not acceptance evidence.
	if (!t.hasDod) {
		if (t.exitCode !== 0) {
			return seq("T11", ctx, [["release_task", { to: "ready" }]], {
				state: "failed",
				note: "agent failed before acceptance; no mechanical checks configured",
			});
		}
	}
	// T12
	if (t.hasDod && !ctx.done.has("verify")) return step("T12", "verify");

	// T12i, verify crashed: a check process died to a signal, which says
	// nothing about the code. No stall, no repair attempt; back to ready with
	// the worktree preserved. Twin of the sweep's `infra` path (maintenance.ts);
	// StepRunner records the `verify_infra` alarm alongside.
	if (t.hasDod && ctx.verify?.crashed === true) {
		return seq("T12i", ctx, [["release_task", { to: "ready" }]], {
			state: "failed",
			note: "verify crashed: infrastructure, not a regression",
		});
	}
	const passed = !t.hasDod || ctx.verify?.passed === true;

	if (passed) {
		// T13
		if (
			(ctx.gates.criticEnabled ?? ctx.gates.brainEnabled) &&
			!ctx.done.has("critic")
		)
			return step("T13", "critic");
		// T14, critic flagged or failed: fail-closed to review.
		if (
			(ctx.gates.criticEnabled ?? ctx.gates.brainEnabled) &&
			(ctx.critic?.flagged || ctx.critic?.status === "failed")
		) {
			return seq(
				"T14",
				ctx,
				[
					["clear_stall"],
					["release_task", { to: "review" }],
					["notify", { reason: "review" }],
				],
				{ state: "completed", note: "critic gate → review" },
			);
		}
		// T15, human review gate.
		if (ctx.gates.reviewGated) {
			return seq(
				"T15",
				ctx,
				[
					["clear_stall"],
					["release_task", { to: "review" }],
					["notify", { reason: "review" }],
				],
				{ state: "completed", note: "review gate" },
			);
		}
		// T16, merge; MergeQueue owns the rest (release done post-merge).
		return seq("T16", ctx, [["clear_stall"], ["enqueue_merge"]], {
			state: "completed",
			note: "merging",
		});
	}

	// verify failed.
	// T17
	if (!ctx.done.has("bump_stall")) return step("T17", "bump_stall");
	// T18, stall cap crossed.
	if (t.stallCount >= t.maxStalls) {
		return seq(
			"T18",
			ctx,
			[
				["release_task", { to: "blocked" }],
				["notify", { reason: "blocked" }],
				["gc_worktree"],
			],
			// The note says how many times verify failed, not just which rule fired.
			{
				state: "failed",
				note: `verify failed ${t.stallCount} of ${t.maxStalls} allowed times: stall cap reached`,
			},
		);
	}
	// T19
	if (
		t.attempt <= t.maxRepairs &&
		(ctx.gates.replanEnabled ?? ctx.gates.brainEnabled) &&
		!ctx.done.has("replan_decide")
	)
		return step("T19", "replan_decide");
	const replan = ctx.replan;
	const replanOk = replan?.status === "ok" ? replan.action : null;
	// T20, repair (brain says resume/retry, or brain disabled).
	if (
		t.attempt <= t.maxRepairs &&
		(replanOk === "resume" ||
			replanOk === "retry" ||
			!(ctx.gates.replanEnabled ?? ctx.gates.brainEnabled))
	) {
		return seq("T20", ctx, [["spawn_repair"]], {
			state: "failed",
			note: "repair spawned",
		});
	}
	// T21
	if (replanOk === "replan") {
		return seq("T21", ctx, [["release_task", { to: "backlog" }]], {
			state: "failed",
			note: "replan",
		});
	}
	// T22, split, only with subtasks to split into (an empty report would
	// archive the task and create nothing). Otherwise falls through to T24.
	if (replanOk === "split" && ctx.reportHasSubtasks) {
		return seq(
			"T22",
			ctx,
			[["create_tasks"], ["release_task", { to: "archived" }]],
			{ state: "failed", note: "split into subtasks" },
		);
	}
	// T23
	if (replanOk === "abandon") {
		return seq("T23", ctx, [["release_task", { to: "archived" }]], {
			state: "failed",
			note: "abandoned",
		});
	}
	// T24, escalate / brain failure / attempts exhausted: fail-closed to human.
	// The note says why every earlier row fell through.
	const t24Why =
		replan?.status === "failed"
			? "brain replan call failed"
			: replanOk === "escalate"
				? "brain said escalate"
				: t.attempt > t.maxRepairs
					? `repairs exhausted (${t.attempt - 1} of ${t.maxRepairs} allowed attempts)`
					: "no repair path available";
	return seq(
		"T24",
		ctx,
		[
			["release_task", { to: "blocked" }],
			["notify", { reason: "blocked" }],
		],
		{ state: "failed", note: `escalated to human: ${t24Why}` },
	);
}

// ---------- §2.4 import runs ----------

function nextImport(ctx: FinalizeCtx): Directive | Terminal {
	if (!ctx.done.has("classify")) return step("I0", "classify");
	if (ctx.outcome !== "completed") {
		return seq(
			"I1",
			ctx,
			[["ingest_report"], ["gc_worktree", { force: false }]],
			{ state: outcomeState(ctx.outcome) },
		);
	}
	if (!ctx.done.has("parse_plan")) return step("I2", "parse_plan");
	if (ctx.planParsed !== true) {
		return seq("I3", ctx, [["ingest_report"], ["gc_worktree"]], {
			state: "failed",
			note: "importer proposed nothing",
		});
	}
	if (
		(ctx.gates.importReviewEnabled ?? ctx.gates.brainEnabled) &&
		!ctx.done.has("import_review")
	)
		return step("I4", "import_review");
	if (ctx.gates.importReviewEnabled ?? ctx.gates.brainEnabled) {
		const review = ctx.importReview;
		// I5, review failed/timed out: NEVER auto-approve.
		if (!review || review.status === "failed") {
			return seq("I5", ctx, [["notify", { reason: "review" }]], {
				state: "needs_review",
				note: "import review unavailable: human approval required",
			});
		}
		// I6, rejected.
		if (!review.approved) {
			return seq("I6", ctx, [["gc_worktree", { force: true }]], {
				state: "failed",
				note: "import rejected",
			});
		}
	}
	// I7, approved (or brain off). Tasks and specs go straight onto the board;
	// there is no code to merge.
	return seq("I7", ctx, proposalSteps(ctx), { state: "completed" });
}

/**
 * The tail every proposal-producing run shares: tasks, specs, questions,
 * then the throwaway worktree.
 *
 * `create_specs` must follow `create_tasks`: a spec links to tasks only via its
 * own `tasks:` list, and the ids do not exist until tasks are created.
 */
function proposalSteps(ctx: FinalizeCtx): [StepName, Directive["args"]?][] {
	// Questions make the proposal provisional; creating tasks before the answers
	// would leave a stale DAG. An expanding draft is released back to Draft.
	if (ctx.planHasQuestions) {
		return [
			["record_questions"],
			["notify", { reason: "clarify" }],
			...(ctx.isDraftExpand
				? ([["release_task", { to: "draft" }]] as [
						StepName,
						Directive["args"],
					][])
				: []),
			["gc_worktree", { force: true }],
		];
	}
	return [
		["create_tasks"],
		...(ctx.planHasSpecs ? ([["create_specs"]] as [StepName][]) : []),
		["gc_worktree", { force: true }],
	];
}

// ---------- §2.4 plan runs ----------

/** Prefix `draft_expand_failed` onto a failure sequence when expanding a draft. */
function draftFailureSteps(
	ctx: FinalizeCtx,
	tail: [StepName, Directive["args"]?][],
): [StepName, Directive["args"]?][] {
	return ctx.isDraftExpand ? [["draft_expand_failed"], ...tail] : tail;
}

function nextPlan(ctx: FinalizeCtx): Directive | Terminal {
	if (!ctx.done.has("classify")) return step("P-classify", "classify");
	if (ctx.outcome !== "completed") {
		return seq(
			"P0",
			ctx,
			draftFailureSteps(ctx, [["gc_worktree", { force: true }]]),
			{ state: outcomeState(ctx.outcome) },
		);
	}
	if (!ctx.done.has("parse_plan")) return step("P1", "parse_plan");
	if (ctx.planParsed !== true) {
		return seq(
			"P2",
			ctx,
			draftFailureSteps(ctx, [["gc_worktree", { force: true }]]),
			{ state: "failed", note: "no valid plan JSON" },
		);
	}
	return seq("P3", ctx, proposalSteps(ctx), { state: "completed" });
}
