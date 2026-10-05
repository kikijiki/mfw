import { describe, expect, test } from "bun:test";
import {
	type Directive,
	type FinalizeCtx,
	next,
	type RunOutcome,
	type StepName,
	type Terminal,
} from "../src/finalize/machine.ts";

/** Build a task-run ctx with sane defaults, overridable per test. */
function taskCtx(over: Partial<FinalizeCtx> = {}): FinalizeCtx {
	return {
		kind: "task",
		outcome: null,
		done: new Set<StepName>(),
		isDraftExpand: false,
		task: {
			exists: true,
			hasDod: true,
			escalation: null,
			attempt: 1,
			maxRepairs: 2,
			stallCount: 0,
			maxStalls: 3,
			resumeCount: 0,
			maxResumes: 2,
			worktreeDirty: false,
			exitCode: 0,
		},
		gates: { mainRed: false, reviewGated: false, brainEnabled: true },
		verify: null,
		critic: null,
		replan: null,
		importReview: null,
		planParsed: null,
		reportHasSubtasks: false,
		reportHasFollowUps: false,
		localWorktree: false,
		leftBackground: false,
		resumeDecision: null,
		planHasSpecs: false,
		planHasQuestions: false,
		...over,
	};
}

/**
 * Simulate the StepRunner: execute `next` repeatedly, marking each directed
 * step done and folding in scripted results, until a terminal. Returns the
 * executed step sequence (with args) and the terminal. Throws on runaway.
 */
function drive(
	ctx: FinalizeCtx,
	script: {
		outcome?: RunOutcome;
		verify?: { passed: boolean; crashed?: boolean };
		critic?: FinalizeCtx["critic"];
		replan?: FinalizeCtx["replan"];
		importReview?: FinalizeCtx["importReview"];
		planParsed?: boolean;
		stallAfterBump?: number;
		/** Whether `reap_leftovers` finds processes. */
		leftovers?: boolean;
	} = {},
): { steps: string[]; terminal: Terminal } {
	const done = new Set<StepName>(ctx.done);
	let cur: FinalizeCtx = { ...ctx, done };
	const steps: string[] = [];
	for (let i = 0; i < 32; i++) {
		const d = next(cur);
		if (d.kind === "terminal") return { steps, terminal: d };
		const dir = d as Directive;
		steps.push(dir.args?.to ? `${dir.step}(${dir.args.to})` : dir.step);
		done.add(dir.step);
		// fold scripted step results, mimicking the StepRunner
		if (dir.step === "decide_resume" && cur.task)
			cur = {
				...cur,
				resumeDecision: {
					selected:
						cur.task.resumeCount < cur.task.maxResumes &&
						(cur.outcome !== "interrupted" || cur.task.worktreeDirty),
					ordinal: cur.task.resumeCount + 1,
				},
			};
		if (dir.step === "spawn_resume" && cur.task)
			cur = {
				...cur,
				task: { ...cur.task, resumeCount: cur.task.resumeCount + 1 },
			};
		if (dir.step === "clear_stall" && cur.task)
			cur = { ...cur, task: { ...cur.task, stallCount: 0 } };
		if (dir.step === "classify")
			cur = { ...cur, outcome: script.outcome ?? "completed" };
		if (dir.step === "verify")
			cur = {
				...cur,
				verify: script.verify
					? { crashed: false, ...script.verify }
					: { passed: true, crashed: false },
			};
		if (dir.step === "critic")
			cur = {
				...cur,
				critic: script.critic ?? { status: "ok", flagged: false },
			};
		if (dir.step === "replan_decide")
			cur = {
				...cur,
				replan: script.replan ?? { status: "ok", action: "escalate" },
			};
		if (dir.step === "import_review")
			cur = {
				...cur,
				importReview: script.importReview ?? {
					status: "ok",
					approved: true,
				},
			};
		if (dir.step === "reap_leftovers")
			cur = { ...cur, leftBackground: script.leftovers ?? false };
		if (dir.step === "parse_plan")
			cur = { ...cur, planParsed: script.planParsed ?? true };
		if (dir.step === "bump_stall" && cur.task)
			cur = {
				...cur,
				task: {
					...cur.task,
					stallCount: script.stallAfterBump ?? cur.task.stallCount + 1,
				},
			};
		cur = { ...cur, done };
	}
	throw new Error(
		`machine did not terminate; steps so far: ${steps.join(" → ")}`,
	);
}

describe("finalize machine: task rows", () => {
	test("T1 rate-limited: hold, task ready, no attempt consumed, worktree kept", () => {
		const { steps, terminal } = drive(taskCtx(), { outcome: "rate_limited" });
		expect(steps).toEqual([
			"classify",
			"ingest_report",
			"hold_rate_limit",
			"release_task(ready)",
		]);
		expect(terminal.state).toBe("rate_limited");
		expect(terminal.row).toBe("T1");
	});

	test("T2 start_failed: release ready + gc", () => {
		const { steps, terminal } = drive(taskCtx(), { outcome: "start_failed" });
		expect(steps).toEqual([
			"classify",
			"ingest_report",
			"release_task(ready)",
			"gc_worktree",
		]);
		expect(terminal.state).toBe("failed");
	});

	test("T3 manual kill: ingest, ready, gc: work never thrown away silently", () => {
		const { steps, terminal } = drive(taskCtx(), { outcome: "killed_manual" });
		expect(steps).toEqual([
			"classify",
			"ingest_report",
			"release_task(ready)",
			"gc_worktree",
		]);
		expect(terminal.state).toBe("killed");
	});

	test("T4 watchdog kill: counts as a stall, task blocked, human notified", () => {
		const { steps, terminal } = drive(taskCtx(), {
			outcome: "killed_watchdog",
		});
		expect(steps).toEqual([
			"classify",
			"ingest_report",
			"bump_stall",
			"release_task(blocked)",
			"notify",
			"gc_worktree",
		]);
		expect(terminal.state).toBe("killed");
	});

	test("T5 interrupted + dirty + resume budget: spawn resume, claim moves to child", () => {
		const ctx = taskCtx();
		if (ctx.task) ctx.task.worktreeDirty = true;
		const { steps, terminal } = drive(ctx, { outcome: "interrupted" });
		expect(steps).toEqual([
			"classify",
			"ingest_report",
			"decide_resume",
			"spawn_resume",
		]);
		expect(terminal.state).toBe("interrupted");
		expect(terminal.row).toBe("T5");
	});

	test("T6 interrupted, resume budget exhausted: back to ready", () => {
		const ctx = taskCtx();
		if (ctx.task) {
			ctx.task.worktreeDirty = true;
			ctx.task.resumeCount = 2;
		}
		const { steps, terminal } = drive(ctx, { outcome: "interrupted" });
		expect(steps).toEqual([
			"classify",
			"ingest_report",
			"decide_resume",
			"release_task(ready)",
			"gc_worktree",
		]);
		expect(terminal.row).toBe("T6");
	});

	test("T8/T9/T10 agent escalations route archived/backlog/blocked", () => {
		for (const [esc, to, row] of [
			["drop", "archived", "T8"],
			["needs-replan", "backlog", "T9"],
			["blocked", "blocked", "T10"],
		] as const) {
			const ctx = taskCtx();
			if (ctx.task) ctx.task.escalation = esc;
			const { steps, terminal } = drive(ctx);
			expect(steps).toContain(`release_task(${to})`);
			expect(terminal.row).toBe(row);
			expect(terminal.state).toBe("failed");
		}
	});

	test("no checks: exit 0 still needs acceptance; nonzero returns ready", () => {
		const ok = taskCtx();
		if (ok.task) ok.task.hasDod = false;
		expect(drive(ok).steps).toEqual([
			"classify",
			"ingest_report",
			"critic",
			"clear_stall",
			"enqueue_merge",
		]);
		const bad = taskCtx();
		if (bad.task) {
			bad.task.hasDod = false;
			bad.task.exitCode = 1;
		}
		const r = drive(bad);
		expect(r.steps).toContain("release_task(ready)");
		expect(r.terminal.state).toBe("failed");
	});

	test("no checks: assisted semantic acceptance can merge without a human", () => {
		const ctx = taskCtx();
		if (ctx.task) ctx.task.hasDod = false;
		const { steps, terminal } = drive(ctx);
		expect(steps).toEqual([
			"classify",
			"ingest_report",
			"critic",
			"clear_stall",
			"enqueue_merge",
		]);
		expect(terminal.note).toBe("merging");
		expect(terminal.row).toBe("T16");
	});

	test("human acceptance policy sends the candidate to review", () => {
		// `reviewGated`: explicit task request or the project's human-review policy.
		const viaRequireReview = taskCtx({
			gates: {
				mainRed: false,
				reviewGated: true,
				brainEnabled: true,
				criticEnabled: false,
			},
		});
		if (viaRequireReview.task) viaRequireReview.task.hasDod = false;
		const r1 = drive(viaRequireReview);
		expect(r1.steps).toContain("release_task(review)");
		expect(r1.steps).not.toContain("critic");
		expect(r1.terminal.row).toBe("T15");
	});

	test("T16 happy path: verify → critic ok → clear stall → merge queue", () => {
		const { steps, terminal } = drive(taskCtx());
		expect(steps).toEqual([
			"classify",
			"ingest_report",
			"verify",
			"critic",
			"clear_stall",
			"enqueue_merge",
		]);
		expect(terminal.note).toBe("merging");
		expect(terminal.row).toBe("T16");
	});

	test("T12i verify crashed: not blamed, no stall bumped, back to ready (MFW-47)", () => {
		const { steps, terminal } = drive(taskCtx(), {
			verify: { passed: false, crashed: true },
		});
		expect(steps).toEqual([
			"classify",
			"ingest_report",
			"verify",
			"release_task(ready)",
		]);
		expect(steps).not.toContain("bump_stall");
		expect(steps).not.toContain("spawn_repair");
		expect(terminal.row).toBe("T12i");
		expect(terminal.state).toBe("failed");
	});

	test("T14 critic flagged AND critic failed both park in review (fail-closed)", () => {
		for (const critic of [
			{ status: "ok", flagged: true },
			{ status: "failed", flagged: false },
		] as const) {
			const { steps, terminal } = drive(taskCtx(), { critic });
			expect(steps).toContain("release_task(review)");
			expect(terminal.row).toBe("T14");
			expect(terminal.state).toBe("completed");
		}
	});

	test("T15 review gate parks verified work for the human", () => {
		const ctx = taskCtx({
			gates: { mainRed: false, reviewGated: true, brainEnabled: true },
		});
		const { steps, terminal } = drive(ctx);
		expect(terminal.row).toBe("T15");
		expect(steps).toContain("release_task(review)");
	});

	test("brain disabled skips critic entirely and merges", () => {
		const ctx = taskCtx({
			gates: { mainRed: false, reviewGated: false, brainEnabled: false },
		});
		const { steps } = drive(ctx);
		expect(steps).not.toContain("critic");
		expect(steps).toContain("enqueue_merge");
	});

	test("T20 verify fails with repair budget: brain resume/retry spawns repair", () => {
		for (const action of ["resume", "retry"] as const) {
			const { steps, terminal } = drive(taskCtx(), {
				verify: { passed: false },
				replan: { status: "ok", action },
			});
			expect(steps).toEqual([
				"classify",
				"ingest_report",
				"verify",
				"bump_stall",
				"replan_decide",
				"spawn_repair",
			]);
			expect(terminal.row).toBe("T20");
		}
	});

	test("T20 brain disabled: repair spawns without a decision", () => {
		const ctx = taskCtx({
			gates: { mainRed: false, reviewGated: false, brainEnabled: false },
		});
		const { steps } = drive(ctx, { verify: { passed: false } });
		expect(steps).not.toContain("replan_decide");
		expect(steps).toContain("spawn_repair");
	});

	test("T18 stall cap crossed: blocked before any replan decision", () => {
		const ctx = taskCtx();
		if (ctx.task) ctx.task.stallCount = 2;
		const { steps, terminal } = drive(ctx, {
			verify: { passed: false },
			stallAfterBump: 3,
		});
		expect(steps).not.toContain("replan_decide");
		expect(steps).toContain("release_task(blocked)");
		expect(terminal.row).toBe("T18");
	});

	test("T21/T22/T23 replan decisions route backlog/split/archived", () => {
		const cases = [
			{ action: "replan", expectStep: "release_task(backlog)", row: "T21" },
			// split needs subtasks; the no-subtask case has its own test above
			{
				action: "split",
				expectStep: "create_tasks",
				row: "T22",
				reportHasSubtasks: true,
			},
			{ action: "abandon", expectStep: "release_task(archived)", row: "T23" },
		] as const;
		for (const c of cases) {
			const { steps, terminal } = drive(
				taskCtx({ reportHasSubtasks: "reportHasSubtasks" in c }),
				{
					verify: { passed: false },
					replan: { status: "ok", action: c.action },
				},
			);
			expect(steps).toContain(c.expectStep);
			expect(terminal.row).toBe(c.row);
		}
	});

	test("T22 split ONLY when the report actually proposed subtasks", () => {
		// Guarding on ingest_report-done (always true on this path) let an empty-report split archive the task and create nothing.
		const withSubtasks = drive(taskCtx({ reportHasSubtasks: true }), {
			verify: { passed: false },
			replan: { status: "ok", action: "split" },
		});
		expect(withSubtasks.terminal.row).toBe("T22");
		expect(withSubtasks.steps).toContain("create_tasks");
		expect(withSubtasks.steps).toContain("release_task(archived)");

		const withoutSubtasks = drive(taskCtx({ reportHasSubtasks: false }), {
			verify: { passed: false },
			replan: { status: "ok", action: "split" },
		});
		expect(withoutSubtasks.terminal.row).toBe("T24"); // escalate to a human
		expect(withoutSubtasks.steps).not.toContain("create_tasks");
		expect(withoutSubtasks.steps).toContain("release_task(blocked)");
	});

	test("T24 fail-closed: replan failure, escalate, and exhausted attempts all block", () => {
		// brain failure
		const failed = drive(taskCtx(), {
			verify: { passed: false },
			replan: { status: "failed", action: null },
		});
		expect(failed.terminal.row).toBe("T24");
		expect(failed.steps).toContain("release_task(blocked)");
		// explicit escalate
		const esc = drive(taskCtx(), {
			verify: { passed: false },
			replan: { status: "ok", action: "escalate" },
		});
		expect(esc.terminal.row).toBe("T24");
		// attempts exhausted: no replan_decide at all
		const ctx = taskCtx();
		if (ctx.task) ctx.task.attempt = 3;
		const spent = drive(ctx, { verify: { passed: false } });
		expect(spent.steps).not.toContain("replan_decide");
		expect(spent.terminal.row).toBe("T24");
	});

	test("orphaned task row: gc only, never a release on a ghost", () => {
		const ctx = taskCtx();
		if (ctx.task) ctx.task.exists = false;
		const { steps } = drive(ctx);
		expect(steps).toEqual(["classify", "ingest_report", "gc_worktree"]);
	});

	test("crash-resume: a mid-sequence resume executes only the remaining steps", () => {
		// Crashed after ingest_report+bump_stall of the T4 path.
		const ctx = taskCtx({
			outcome: "killed_watchdog",
			done: new Set<StepName>(["classify", "ingest_report", "bump_stall"]),
		});
		const { steps, terminal } = drive(ctx, { outcome: "killed_watchdog" });
		expect(steps).toEqual(["release_task(blocked)", "notify", "gc_worktree"]);
		expect(terminal.state).toBe("killed");
	});

	test("determinism: identical ctx always yields the identical directive", () => {
		const ctx = taskCtx();
		const a = next(ctx);
		const b = next(ctx);
		expect(a).toEqual(b);
	});
});

describe("finalize machine: follow-ups and leftover processes", () => {
	const outcomes: RunOutcome[] = [
		"completed",
		"killed_manual",
		"killed_watchdog",
		"interrupted",
		"start_failed",
		"rate_limited",
	];

	test.each(
		outcomes,
	)("T0-followups: a report with follow-ups files them right after ingest (%s)", (outcome) => {
		const { steps } = drive(taskCtx({ reportHasFollowUps: true }), {
			outcome,
		});
		expect(steps.slice(0, 3)).toEqual([
			"classify",
			"ingest_report",
			"create_followups",
		]);
	});

	test("T0-followups: a failed verification still files the follow-ups", () => {
		const { steps, terminal } = drive(taskCtx({ reportHasFollowUps: true }), {
			verify: { passed: false },
		});
		expect(steps).toContain("create_followups");
		expect(terminal.state).toBe("failed");
	});

	test("T0-followups: no follow-ups, no step", () => {
		const { steps } = drive(taskCtx());
		expect(steps).not.toContain("create_followups");
	});

	test.each(
		outcomes,
	)("T0-reap: a local worktree run reaps right after classify (%s)", (outcome) => {
		const { steps } = drive(taskCtx({ localWorktree: true }), { outcome });
		expect(steps.slice(0, 3)).toEqual([
			"classify",
			"reap_leftovers",
			"ingest_report",
		]);
	});

	test("T0-reap: a run without a local worktree is not reaped", () => {
		const { steps } = drive(taskCtx({ localWorktree: false }), {
			leftovers: true,
		});
		expect(steps).not.toContain("reap_leftovers");
		expect(steps).not.toContain("spawn_resume");
	});

	test("T10L: completed but left processes running: resumed instead of verified", () => {
		const { steps, terminal } = drive(taskCtx({ localWorktree: true }), {
			leftovers: true,
		});
		expect(steps).toEqual([
			"classify",
			"reap_leftovers",
			"ingest_report",
			"decide_resume",
			"spawn_resume",
		]);
		expect(terminal.row).toBe("T10L");
		expect(terminal.state).toBe("completed");
	});

	test("T10L: resumes exhausted: verification decides as usual", () => {
		const ctx = taskCtx({ localWorktree: true });
		if (ctx.task) ctx.task.resumeCount = ctx.task.maxResumes;
		const { steps, terminal } = drive(ctx, { leftovers: true });
		expect(steps).not.toContain("spawn_resume");
		expect(steps).toContain("verify");
		expect(terminal.note).toBe("merging");
	});

	test("T10L: an agent-declared escalation wins over the resume", () => {
		const ctx = taskCtx({ localWorktree: true });
		if (ctx.task) ctx.task.escalation = "blocked";
		const { steps, terminal } = drive(ctx, { leftovers: true });
		expect(steps).not.toContain("spawn_resume");
		expect(terminal.row).toBe("T10");
	});

	test("T10L: a killed run with leftovers is not resumed", () => {
		const { steps } = drive(taskCtx({ localWorktree: true }), {
			outcome: "killed_manual",
			leftovers: true,
		});
		expect(steps).not.toContain("spawn_resume");
	});

	test("T0-reap: clean reap goes on to verify", () => {
		const { steps } = drive(taskCtx({ localWorktree: true }));
		expect(steps).toContain("verify");
		expect(steps).not.toContain("spawn_resume");
	});
});

describe("finalize machine: recovery rows", () => {
	test("a verified repair merges without a board release step", () => {
		const { steps, terminal } = drive(
			taskCtx({ kind: "repair", outcome: "completed" }),
			{ verify: { passed: true, crashed: false } },
		);
		expect(steps).toEqual([
			"classify",
			"ingest_report",
			"verify",
			"enqueue_merge",
		]);
		expect(steps.some((entry) => entry.startsWith("release_task"))).toBe(false);
		expect(terminal.note).toBe("merging");
	});

	test("a failed repair terminates without moving the historical task", () => {
		const { steps, terminal } = drive(
			taskCtx({ kind: "repair", outcome: "completed" }),
			{ verify: { passed: false, crashed: false } },
		);
		expect(steps).toEqual(["classify", "ingest_report", "verify"]);
		expect(terminal.state).toBe("failed");
		expect(steps.some((entry) => entry.startsWith("release_task"))).toBe(false);
	});
});

describe("finalize machine: import rows", () => {
	const importCtx = (over: Partial<FinalizeCtx> = {}): FinalizeCtx =>
		taskCtx({ kind: "import", task: null, ...over });

	test("I7 happy path: parse → review approved → tasks on the board", () => {
		// An importer proposes work; it writes no code, so nothing is merged.
		const { steps, terminal } = drive(importCtx());
		expect(steps).toEqual([
			"classify",
			"parse_plan",
			"import_review",
			"create_tasks",
			"gc_worktree",
		]);
		expect(steps).not.toContain("enqueue_merge");
		expect(terminal.state).toBe("completed");
	});

	test("I7 an import that proposed specs writes them after the tasks", () => {
		const { steps } = drive(importCtx({ planHasSpecs: true }));
		expect(steps).toEqual([
			"classify",
			"parse_plan",
			"import_review",
			"create_tasks",
			"create_specs",
			"gc_worktree",
		]);
	});

	test("I7 an importer's questions land in the clarify gate too", () => {
		const { steps } = drive(importCtx({ planHasQuestions: true }));
		expect(steps).toContain("record_questions");
		expect(steps).not.toContain("create_tasks");
		expect(steps).not.toContain("create_specs");
	});

	test("I3 an unparseable proposal fails without review", () => {
		const { steps, terminal } = drive(importCtx(), { planParsed: false });
		expect(steps).not.toContain("import_review");
		expect(steps).not.toContain("create_tasks");
		expect(terminal.note).toContain("proposed nothing");
	});

	test("I5 review failure NEVER auto-approves: parks as needs_review", () => {
		const { steps, terminal } = drive(importCtx(), {
			importReview: { status: "failed", approved: false },
		});
		expect(steps).toContain("notify");
		expect(steps).not.toContain("enqueue_merge");
		expect(terminal.state).toBe("needs_review");
	});

	test("I6 rejected import is force-GC'd", () => {
		const { steps, terminal } = drive(importCtx(), {
			importReview: { status: "ok", approved: false },
		});
		expect(steps).toContain("gc_worktree");
		expect(terminal.state).toBe("failed");
	});

	test("brain disabled = explicit opt-out: creates tasks without review", () => {
		const ctx = importCtx({
			gates: { mainRed: false, reviewGated: false, brainEnabled: false },
		});
		const { steps } = drive(ctx);
		expect(steps).not.toContain("import_review");
		expect(steps).toContain("create_tasks");
	});

	test("I1 killed import preserves evidence and terminates per outcome", () => {
		const { terminal } = drive(importCtx(), { outcome: "killed_manual" });
		expect(terminal.state).toBe("killed");
	});
});

describe("finalize machine: plan / action / brain rows", () => {
	test("P3 a plan with no questions creates tasks and does NOT notify clarify", () => {
		const ctx = taskCtx({ kind: "plan", task: null });
		const { steps, terminal } = drive(ctx);
		expect(steps).toEqual([
			"classify",
			"parse_plan",
			"create_tasks",
			"gc_worktree",
		]);
		// `notify(clarify)` must not fire on every successful plan run.
		expect(steps).not.toContain("notify");
		expect(steps).not.toContain("record_questions");
		expect(terminal.state).toBe("completed");
	});

	test("P3 a plan WITH questions records them and then notifies clarify", () => {
		const ctx = taskCtx({
			kind: "plan",
			task: null,
			planHasQuestions: true,
		});
		const { steps, terminal } = drive(ctx);
		expect(steps).toEqual([
			"classify",
			"parse_plan",
			"record_questions",
			"notify",
			"gc_worktree",
		]);
		expect(terminal.state).toBe("completed");
	});

	test("P3 a plan with specs writes them AFTER the tasks they link to", () => {
		const ctx = taskCtx({ kind: "plan", task: null, planHasSpecs: true });
		const { steps } = drive(ctx);
		expect(steps).toEqual([
			"classify",
			"parse_plan",
			"create_tasks",
			"create_specs",
			"gc_worktree",
		]);
		expect(steps.indexOf("create_specs")).toBeGreaterThan(
			steps.indexOf("create_tasks"),
		);
	});

	test("P2 unparseable plan fails but keeps the run dir evidence", () => {
		const ctx = taskCtx({ kind: "plan", task: null });
		const { terminal } = drive(ctx, { planParsed: false });
		expect(terminal.note).toContain("no valid plan");
	});

	// A draft-expanding plan run records a failed attempt on its way to gc; an ordinary
	// goal-to-DAG plan (isDraftExpand false) must never journal that step.
	test("P0 a draft-expansion plan that never completed records a failed attempt", () => {
		const ctx = taskCtx({ kind: "plan", task: null, isDraftExpand: true });
		const { steps, terminal } = drive(ctx, { outcome: "killed_manual" });
		expect(steps).toEqual(["classify", "draft_expand_failed", "gc_worktree"]);
		expect(terminal.state).toBe("killed");
	});

	test("P2 a draft-expansion plan that failed to parse records a failed attempt", () => {
		const ctx = taskCtx({ kind: "plan", task: null, isDraftExpand: true });
		const { steps, terminal } = drive(ctx, { planParsed: false });
		expect(steps).toEqual([
			"classify",
			"parse_plan",
			"draft_expand_failed",
			"gc_worktree",
		]);
		expect(terminal.note).toContain("no valid plan");
	});

	test("an ordinary plan (not expanding a draft) never journals draft_expand_failed", () => {
		const ctx = taskCtx({ kind: "plan", task: null, isDraftExpand: false });
		const failed = drive(ctx, { outcome: "killed_manual" });
		expect(failed.steps).not.toContain("draft_expand_failed");
		const unparsed = drive(ctx, { planParsed: false });
		expect(unparsed.steps).not.toContain("draft_expand_failed");
	});

	test("A0 action: gc (dirty preserved) and per-outcome terminal", () => {
		const ctx = taskCtx({ kind: "action", task: null });
		const { steps, terminal } = drive(ctx, { outcome: "completed" });
		expect(steps).toEqual(["classify", "ingest_report", "gc_worktree"]);
		expect(terminal.state).toBe("completed");
	});

	test("B0 brain: finish the decision record with the outcome", () => {
		const ctx = taskCtx({ kind: "brain", task: null });
		const { steps } = drive(ctx, { outcome: "completed" });
		expect(steps).toEqual(["classify", "finish_decision"]);
	});
});
