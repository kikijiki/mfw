import type { SettleClass } from "@mfw/core/events";
import type { NotificationType } from "../notify.ts";

/**
 * Finalization state machine v3, PURE. No IO, no imports beyond types.
 * Two transition tables: task runs, and import / plan / action / brain runs.
 *
 * Mechanical rows (classify, reap, ingest, verify, scope check, the review
 * floor, merge enqueue, worktree gc) are decided here. Every row that used to
 * decide what happens NEXT to a failed or questioned run (repair, replan,
 * resume, stall escalation, blocked, human review) ends in the `settle` step
 * instead: it records the run's settle class and wakes the project brain,
 * which chooses (design §6.2). Nothing in this file counts attempts, stalls
 * or resumes as policy; the brain's action caps and loop guard do.
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
	| "hold_rate_limit"
	| "ingest_report"
	| "create_followups"
	| "verify"
	| "critic"
	| "parse_plan"
	| "record_question"
	| "settle"
	| "enqueue_merge"
	| "release_task"
	| "clear_stall"
	| "gc_worktree"
	| "archive_wip"
	| "scope_check"
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

export interface Directive {
	kind: "step";
	step: StepName;
	/** Step arguments; release_task carries the target disposition, notify a reason. */
	args?: {
		to?: TaskDisposition;
		reason?: NotificationType;
		force?: boolean;
		/** release_task to `blocked` without composing an escalation brief (the question is the brief). */
		quiet?: boolean;
		/** `settle`: how the run ended, the closed class the brain decides from. */
		settle?: SettleClass;
	};
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
	/**
	 * Set for a run that is one attempt of a competing group. Such a run never
	 * releases the task, repairs, resumes or merges on its own: it finishes
	 * (verify, scope, review floor) and waits for the brain's `select_winner`.
	 * Absent for every other run, so the single-run rows are untouched.
	 */
	group?: { competing: boolean };
	/** Task context; null for non-task kinds or when the task row vanished. */
	task: {
		exists: boolean;
		hasDod: boolean;
		/** Agent-declared escalation from MFW_REPORT. `question`: it asked the operator something and ended its turn. */
		escalation: "drop" | "needs-replan" | "blocked" | "question" | null;
		attempt: number;
		worktreeDirty: boolean;
		exitCode: number | null;
	} | null;
	gates: {
		mainRed: boolean;
		reviewGated: boolean;
		brainEnabled: boolean;
		criticEnabled?: boolean;
		/** Scope watchdog `onFinish: review`: files outside the task's own
		 *  `owns` send verified work to review (T12s/T14s). */
		scopeOnFinish?: boolean;
	};
	/** `classify`'s kill reason for a killed run; selects T4s for a scope kill. */
	killReason?: string | null;
	/** `scope_check` result: changed files outside the task's own `owns`. */
	scope?: { outside: number } | null;
	// step results observed so far
	/** `crashed` mirrors `VerificationResult.crashed`: a check process died to
	 *  a signal. Always `false` when `passed`. */
	verify: { passed: boolean; crashed: boolean } | null;
	critic: {
		status: "ok" | "failed";
		flagged: boolean;
		/** Floored verdict; null on journals that predate verdicts. */
		verdict?: "merge" | "fix" | "reject" | null;
		/** Review round this verdict belongs to (1-based). */
		round?: number | null;
		/** Why a failed review produced no verdict. */
		cause?: string | null;
	} | null;
	planParsed: boolean | null;
	/** Whether the ingested report carried at least one valid follow-up. */
	reportHasFollowUps: boolean;
	/**
	 * A run executed locally in a worktree. Code-running task, repair, plan,
	 * import and action sessions all require process cleanup before disposal.
	 */
	localWorktree: boolean;
	/** `reap_leftovers` found processes the agent left running. */
	leftBackground: boolean;
	/**
	 * The transcript shows background jobs (a `run_in_background` tool call)
	 * the agent started and never saw finish before its turn ended. Shell jobs
	 * die with the provider, so `reap_leftovers` cannot see them.
	 */
	backgroundOutstanding?: boolean;
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

/** The review floor's verdict for a run, as a settle class (null = it allows merge). */
function reviewClass(ctx: FinalizeCtx): SettleClass | null {
	const critic = ctx.critic;
	if (!critic) return null;
	if (critic.status === "failed" || (critic.flagged && !critic.verdict))
		return "infra_failure";
	if (critic.verdict === "reject") return "review_reject";
	if (critic.verdict === "fix") return "review_fix";
	return null;
}

function nextTask(ctx: FinalizeCtx): Directive | Terminal {
	// T0
	if (!ctx.done.has("classify")) return step("T0", "classify");
	// Ingest before every outcome so interrupted/start-failed/orphan cleanup
	// cannot bypass MFW_REPORT.json.
	if (!ctx.done.has("ingest_report")) return step("T0", "ingest_report");
	// T0-followups: discovered work is recorded whatever became of the run.
	if (ctx.reportHasFollowUps && !ctx.done.has("create_followups"))
		return step("T0-followups", "create_followups");
	const t = ctx.task;

	// A task run whose task row vanished mid-run has nothing to release.
	if (!t?.exists) {
		return seq("T-orphan", ctx, [["gc_worktree"]], {
			state: outcomeState(ctx.outcome),
			note: "task no longer exists",
		});
	}
	if (ctx.group?.competing) return nextAttempt(ctx, t);

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
	// T4s, scope watchdog kill (another claimed task's files, or too many
	// files). The work is saved to a `wip/` branch BEFORE the worktree is
	// force-removed; the order is the safety property. What happens to the task
	// is the brain's: the settle names the class and the archived ref.
	if (
		ctx.outcome === "killed_watchdog" &&
		(ctx.killReason === "watchdog-scope" || ctx.killReason === "watchdog-files")
	) {
		return seq(
			"T4s",
			ctx,
			[
				["ingest_report"],
				["archive_wip"],
				["settle", { settle: "scope_violation" }],
				["gc_worktree", { force: true }],
			],
			{
				state: "killed",
				note:
					ctx.killReason === "watchdog-scope"
						? "scope watchdog: the run changed files another claimed task owns"
						: "scope watchdog: the run changed more files than allowed",
			},
		);
	}
	// T4, watchdog kill.
	if (ctx.outcome === "killed_watchdog") {
		return seq(
			"T4",
			ctx,
			[
				["ingest_report"],
				["settle", { settle: "watchdog_killed" }],
				["gc_worktree"],
			],
			{ state: "killed" },
		);
	}
	// T5, interrupted (reboot/crash without exit record). The worktree is kept
	// when it holds work; the brain chooses to continue it or start over.
	if (ctx.outcome === "interrupted") {
		return seq(
			"T5",
			ctx,
			[["settle", { settle: "interrupted" }], ["gc_worktree"]],
			{ state: "interrupted" },
		);
	}

	// outcome === completed from here on.
	// T8-T10, agent-declared escalations.
	if (t.escalation === "drop") {
		return seq(
			"T8",
			ctx,
			[["settle", { settle: "report_drop" }], ["gc_worktree"]],
			{ state: "failed", note: "agent dropped the task" },
		);
	}
	if (t.escalation === "needs-replan") {
		return seq(
			"T9",
			ctx,
			[["settle", { settle: "report_replan" }], ["gc_worktree"]],
			{ state: "failed", note: "agent requested replan" },
		);
	}
	if (t.escalation === "blocked") {
		return seq(
			"T10",
			ctx,
			[["settle", { settle: "report_blocked" }], ["gc_worktree"]],
			{ state: "failed", note: "agent reported blocked" },
		);
	}
	// T10Q, the agent asked a question (MFW_REPORT `question`) and ended its
	// turn. Not a failure. The question is recorded as a clarification the
	// brain can answer (`answer_question`) or take to a person; the worktree is
	// kept so a `continue:` spawn carries the answer.
	if (t.escalation === "question") {
		return seq(
			"T10Q",
			ctx,
			[["record_question"], ["settle", { settle: "question" }]],
			{
				state: "completed",
				note: "agent asked a question: waiting for the brain to answer",
			},
		);
	}
	// T10L, the agent ended its session with processes still running, or with
	// background jobs it never saw finish. They were stopped, so whatever they
	// were doing is unfinished: the brain decides whether to continue the work.
	if (ctx.leftBackground || ctx.backgroundOutstanding === true) {
		return seq("T10L", ctx, [["settle", { settle: "background_work" }]], {
			state: "failed",
			note: "agent left unfinished background work",
		});
	}

	// T11, no mechanical checks. Exit success only lets the candidate reach the
	// gates below; it is not acceptance evidence.
	if (!t.hasDod) {
		if (t.exitCode !== 0) {
			return seq("T11", ctx, [["settle", { settle: "verify_failed" }]], {
				state: "failed",
				note: "agent failed before acceptance; no mechanical checks configured",
			});
		}
	}
	// T12
	if (t.hasDod && !ctx.done.has("verify")) return step("T12", "verify");

	// T12i, verify crashed: a check process died to a signal, which says
	// nothing about the code. Back to ready with the worktree preserved. Twin
	// of the sweep's `infra` path (maintenance.ts); StepRunner records the
	// `verify_infra` alarm alongside.
	if (t.hasDod && ctx.verify?.crashed === true) {
		return seq("T12i", ctx, [["release_task", { to: "ready" }]], {
			state: "failed",
			note: "verify crashed: infrastructure, not a regression",
		});
	}
	const passed = !t.hasDod || ctx.verify?.passed === true;

	if (passed) {
		// T12s, finish-time scope check: deterministic, before (and whatever)
		// the critic. Files outside the task's own `owns` never merge silently.
		if (ctx.gates.scopeOnFinish && !ctx.done.has("scope_check"))
			return step("T12s", "scope_check");
		// T14s
		if (ctx.gates.scopeOnFinish && (ctx.scope?.outside ?? 0) > 0) {
			return seq("T14s", ctx, [["settle", { settle: "scope_outside" }]], {
				state: "needs_review",
				note: "scope gate: files changed outside the task's owns",
			});
		}
		const criticOn = ctx.gates.criticEnabled ?? ctx.gates.brainEnabled;
		// T13
		if (criticOn && !ctx.done.has("critic")) return step("T13", "critic");
		// T14, no usable verdict (review failed, reviewer not independent, a
		// verdict discarded) or a pre-verdict flag; T14r reject; T14f fix. The
		// floor stays: none of these merge. What follows is the brain's.
		const review = criticOn ? reviewClass(ctx) : null;
		if (review) {
			const critic = ctx.critic;
			const note =
				review === "infra_failure"
					? critic?.cause
						? `review gate: ${critic.cause}`
						: "review gate: no usable verdict"
					: review === "review_reject"
						? "review verdict reject: the approach is wrong or faked"
						: "review verdict fix: findings to address";
			return seq(
				review === "review_reject"
					? "T14r"
					: review === "review_fix"
						? "T14f"
						: "T14",
				ctx,
				[["settle", { settle: review }]],
				{ state: "needs_review", note },
			);
		}
		// T15, human review gate: an explicit policy of the project or the task.
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

	// verify failed: the brain chooses repair, a different model, a split or
	// an escalation. The facts (failing checks and their tails) ride the settle.
	return seq("T17", ctx, [["settle", { settle: "verify_failed" }]], {
		state: "failed",
		note: "verify failed",
	});
}

// ---------- attempts of a competing group ----------

/**
 * One attempt among siblings that share the task's claim. The mechanical
 * gates run (verify, finish-time scope check, the review floor) and the
 * result is recorded, but nothing that decides the task's fate: the claim
 * stays with the group, the worktree stays for `select_winner` or a
 * `continue:` spawn, and the settle says how the attempt ended. The brain
 * is woken by it and chooses (design §4.1: competing groups always wait for
 * `select_winner`).
 */
function nextAttempt(
	ctx: FinalizeCtx,
	t: NonNullable<FinalizeCtx["task"]>,
): Directive | Terminal {
	if (ctx.outcome === "rate_limited") {
		return seq(
			"TA1",
			ctx,
			[["hold_rate_limit"], ["settle", { settle: "rate_limited" }]],
			{ state: "rate_limited" },
		);
	}
	if (ctx.outcome === "start_failed") {
		return seq(
			"TA2",
			ctx,
			[["settle", { settle: "infra_failure" }], ["gc_worktree"]],
			{ state: "failed", note: "attempt failed to start" },
		);
	}
	if (ctx.outcome === "killed_manual") {
		return seq("TA3", ctx, [["settle", { settle: "stopped" }]], {
			state: "killed",
			note: "attempt stopped",
		});
	}
	if (
		ctx.outcome === "killed_watchdog" &&
		(ctx.killReason === "watchdog-scope" || ctx.killReason === "watchdog-files")
	) {
		return seq(
			"TA4s",
			ctx,
			[
				["archive_wip"],
				["settle", { settle: "scope_violation" }],
				["gc_worktree", { force: true }],
			],
			{
				state: "killed",
				note: "scope watchdog: the attempt left the task's scope",
			},
		);
	}
	if (ctx.outcome === "killed_watchdog") {
		return seq("TA4", ctx, [["settle", { settle: "watchdog_killed" }]], {
			state: "killed",
			note: "watchdog killed the attempt",
		});
	}
	if (ctx.outcome === "interrupted") {
		return seq("TA5", ctx, [["settle", { settle: "interrupted" }]], {
			state: "interrupted",
			note: "attempt interrupted",
		});
	}
	// completed
	if (t.escalation !== null) {
		const cls: SettleClass =
			t.escalation === "drop"
				? "report_drop"
				: t.escalation === "needs-replan"
					? "report_replan"
					: t.escalation === "blocked"
						? "report_blocked"
						: "question";
		return seq(
			"TA6",
			ctx,
			[
				...(t.escalation === "question"
					? ([["record_question"]] as [StepName][])
					: []),
				["settle", { settle: cls }],
			],
			{
				state: "completed",
				note: `attempt reported ${t.escalation}: the brain decides`,
			},
		);
	}
	if (ctx.leftBackground || ctx.backgroundOutstanding === true) {
		return seq("TA7", ctx, [["settle", { settle: "background_work" }]], {
			state: "failed",
			note: "attempt left unfinished background work",
		});
	}
	if (t.hasDod && !ctx.done.has("verify")) return step("TA8", "verify");
	if (t.hasDod && ctx.verify?.crashed === true) {
		return seq("TA8i", ctx, [["settle", { settle: "infra_failure" }]], {
			state: "failed",
			note: "verify crashed: infrastructure, not a regression",
		});
	}
	const passed = !t.hasDod ? t.exitCode === 0 : ctx.verify?.passed === true;
	if (!passed) {
		return seq("TA9", ctx, [["settle", { settle: "verify_failed" }]], {
			state: "failed",
			note: "attempt failed verification",
		});
	}
	if (ctx.gates.scopeOnFinish && !ctx.done.has("scope_check")) {
		return step("TA10", "scope_check");
	}
	const criticOn = ctx.gates.criticEnabled ?? ctx.gates.brainEnabled;
	if (criticOn && !ctx.done.has("critic")) return step("TA11", "critic");
	const outside = ctx.gates.scopeOnFinish && (ctx.scope?.outside ?? 0) > 0;
	const cls: SettleClass = outside
		? "scope_outside"
		: ((criticOn ? reviewClass(ctx) : null) ?? "verified");
	return seq("TA12", ctx, [["settle", { settle: cls }]], {
		state: cls === "verified" ? "completed" : "needs_review",
		note:
			cls === "verified"
				? "attempt verified: awaiting selection"
				: `attempt settled ${cls}: the brain decides`,
	});
}

// ---------- §2.4 import runs ----------

/** How a plan or import run that did not complete ended, as a settle class. */
function outcomeClass(ctx: FinalizeCtx): SettleClass {
	switch (ctx.outcome) {
		case "rate_limited":
			return "rate_limited";
		case "killed_manual":
			return "stopped";
		case "killed_watchdog":
			return "watchdog_killed";
		case "interrupted":
			return "interrupted";
		default:
			return "infra_failure";
	}
}

function nextImport(ctx: FinalizeCtx): Directive | Terminal {
	if (!ctx.done.has("classify")) return step("I0", "classify");
	if (ctx.outcome !== "completed") {
		return seq(
			"I1",
			ctx,
			[
				["ingest_report"],
				["settle", { settle: outcomeClass(ctx) }],
				["gc_worktree", { force: false }],
			],
			{ state: outcomeState(ctx.outcome) },
		);
	}
	if (!ctx.done.has("parse_plan")) return step("I2", "parse_plan");
	// I7: the proposal is the run's output, not an effect. It rides the settle
	// (class `plan_output`) and the brain applies it with the board tools.
	return seq(
		"I7",
		ctx,
		[
			["settle", { settle: "plan_output" }],
			["gc_worktree", { force: true }],
		],
		ctx.planParsed === true
			? { state: "completed" }
			: { state: "failed", note: "importer proposed nothing" },
	);
}

// ---------- §2.4 plan runs ----------

/** Prefix `draft_expand_failed` (the retry bookkeeping) when expanding a draft. */
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
			draftFailureSteps(ctx, [
				["settle", { settle: outcomeClass(ctx) }],
				["gc_worktree", { force: true }],
			]),
			{ state: outcomeState(ctx.outcome) },
		);
	}
	if (!ctx.done.has("parse_plan")) return step("P1", "parse_plan");
	if (ctx.planParsed !== true) {
		return seq(
			"P2",
			ctx,
			draftFailureSteps(ctx, [
				["settle", { settle: "plan_output" }],
				["gc_worktree", { force: true }],
			]),
			{ state: "failed", note: "no valid plan JSON" },
		);
	}
	// P3: a finished plan (or a draft's expansion) settles `plan_output`; the
	// brain applies it with create_tasks / update_task.
	return seq(
		"P3",
		ctx,
		[
			["settle", { settle: "plan_output" }],
			["gc_worktree", { force: true }],
		],
		{ state: "completed" },
	);
}
