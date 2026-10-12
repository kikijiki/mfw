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
			worktreeDirty: false,
			exitCode: 0,
		},
		gates: { mainRed: false, reviewGated: false, brainEnabled: true },
		verify: null,
		critic: null,
		planParsed: null,
		reportHasFollowUps: false,
		localWorktree: false,
		leftBackground: false,
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
		planParsed?: boolean;
		/** Whether `reap_leftovers` finds processes. */
		leftovers?: boolean;
		/** Whether `classify` saw background jobs the turn never saw finish. */
		background?: boolean;
		/** `classify`'s kill reason for a killed run. */
		killReason?: string;
		/** What `scope_check` finds outside the task's owns. */
		scopeOutside?: number;
	} = {},
): { steps: string[]; terminal: Terminal } {
	const done = new Set<StepName>(ctx.done);
	let cur: FinalizeCtx = { ...ctx, done };
	const steps: string[] = [];
	for (let i = 0; i < 32; i++) {
		const d = next(cur);
		if (d.kind === "terminal") return { steps, terminal: d };
		const dir = d as Directive;
		steps.push(
			dir.args?.to
				? `${dir.step}(${dir.args.to})`
				: dir.args?.settle
					? `${dir.step}(${dir.args.settle})`
					: dir.step,
		);
		done.add(dir.step);
		// fold scripted step results, mimicking the StepRunner
		if (dir.step === "classify")
			cur = {
				...cur,
				outcome: script.outcome ?? "completed",
				backgroundOutstanding: script.background ?? false,
				...(script.killReason ? { killReason: script.killReason } : {}),
			};
		if (dir.step === "scope_check")
			cur = { ...cur, scope: { outside: script.scopeOutside ?? 0 } };
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
		if (dir.step === "reap_leftovers")
			cur = { ...cur, leftBackground: script.leftovers ?? false };
		if (dir.step === "parse_plan")
			cur = { ...cur, planParsed: script.planParsed ?? true };
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

	test("T4 watchdog kill settles watchdog_killed: no block, no ping, the brain decides", () => {
		const { steps, terminal } = drive(taskCtx(), {
			outcome: "killed_watchdog",
		});
		expect(steps).toEqual([
			"classify",
			"ingest_report",
			"settle(watchdog_killed)",
			"gc_worktree",
		]);
		expect(terminal).toMatchObject({ row: "T4", state: "killed" });
		expect(steps.join()).not.toContain("release_task(blocked)");
		expect(steps).not.toContain("notify");
	});

	for (const killReason of ["watchdog-scope", "watchdog-files"]) {
		test(`T4s ${killReason}: archive before a forced gc, then settle scope_violation`, () => {
			const { steps, terminal } = drive(taskCtx(), {
				outcome: "killed_watchdog",
				killReason,
			});
			expect(steps).toEqual([
				"classify",
				"ingest_report",
				"archive_wip",
				"settle(scope_violation)",
				"gc_worktree",
			]);
			expect(terminal).toMatchObject({ row: "T4s", state: "killed" });
			// The order is the safety property: the worktree is forced away only
			// once its snapshot is journaled.
			expect(steps.indexOf("archive_wip")).toBeLessThan(
				steps.indexOf("gc_worktree"),
			);
			expect(steps).not.toContain("notify");
		});
	}

	test("T4s directives: the gc after the settle is forced", () => {
		const done = new Set<StepName>([
			"classify",
			"ingest_report",
			"archive_wip",
			"settle",
		]);
		const ctx = taskCtx({
			outcome: "killed_watchdog",
			killReason: "watchdog-scope",
			done,
		});
		expect(next(ctx)).toMatchObject({
			step: "gc_worktree",
			args: { force: true },
		});
		// Without the archive journaled, nothing past it is reachable.
		const unarchived = taskCtx({
			outcome: "killed_watchdog",
			killReason: "watchdog-files",
			done: new Set<StepName>(["classify", "ingest_report"]),
		});
		expect(next(unarchived)).toMatchObject({ step: "archive_wip" });
	});

	test("other watchdog kills keep T4 (no archive, non-forced gc)", () => {
		const { steps, terminal } = drive(taskCtx(), {
			outcome: "killed_watchdog",
			killReason: "watchdog-idle",
		});
		expect(terminal.row).toBe("T4");
		expect(steps).not.toContain("archive_wip");
	});

	test("T12s/T14s: verified work with files outside its owns settles scope_outside, before the critic", () => {
		const ctx = taskCtx({
			gates: {
				mainRed: false,
				reviewGated: false,
				brainEnabled: true,
				scopeOnFinish: true,
			},
		});
		const { steps, terminal } = drive(ctx, { scopeOutside: 2 });
		expect(steps).toEqual([
			"classify",
			"ingest_report",
			"verify",
			"scope_check",
			"settle(scope_outside)",
		]);
		expect(terminal).toMatchObject({ row: "T14s", state: "needs_review" });
		expect(terminal.note).toContain("scope gate");
	});

	test("T12s: inside its owns, verified work goes on to the critic and merge", () => {
		const ctx = taskCtx({
			gates: {
				mainRed: false,
				reviewGated: false,
				brainEnabled: true,
				scopeOnFinish: true,
			},
		});
		const { steps, terminal } = drive(ctx, { scopeOutside: 0 });
		expect(steps).toContain("scope_check");
		expect(steps).toContain("critic");
		expect(terminal.row).toBe("T16");
	});

	test("order: scope check, then review, then the verdict's settle", () => {
		const ctx = taskCtx({
			gates: {
				mainRed: false,
				reviewGated: false,
				brainEnabled: true,
				scopeOnFinish: true,
			},
		});
		const { steps, terminal } = drive(ctx, {
			scopeOutside: 0,
			critic: { status: "ok", flagged: true, verdict: "fix", round: 1 },
		});
		expect(steps.indexOf("scope_check")).toBeLessThan(steps.indexOf("critic"));
		expect(steps.indexOf("critic")).toBeLessThan(
			steps.indexOf("settle(review_fix)"),
		);
		expect(terminal.row).toBe("T14f");
	});

	test("without the onFinish gate there is no scope_check step", () => {
		const { steps } = drive(taskCtx(), { scopeOutside: 5 });
		expect(steps).not.toContain("scope_check");
	});

	test("T5 interrupted settles interrupted and keeps a dirty worktree; no resume is decided here", () => {
		const ctx = taskCtx();
		if (ctx.task) ctx.task.worktreeDirty = true;
		const { steps, terminal } = drive(ctx, { outcome: "interrupted" });
		expect(steps).toEqual([
			"classify",
			"ingest_report",
			"settle(interrupted)",
			"gc_worktree",
		]);
		expect(terminal).toMatchObject({ row: "T5", state: "interrupted" });
	});

	test("T8/T9/T10 agent escalations settle report_drop/report_replan/report_blocked", () => {
		for (const [esc, cls, row] of [
			["drop", "report_drop", "T8"],
			["needs-replan", "report_replan", "T9"],
			["blocked", "report_blocked", "T10"],
		] as const) {
			const ctx = taskCtx();
			if (ctx.task) ctx.task.escalation = esc;
			const { steps, terminal } = drive(ctx);
			expect(steps).toContain(`settle(${cls})`);
			expect(steps).not.toContain("notify");
			expect(terminal.row).toBe(row);
			expect(terminal.state).toBe("failed");
		}
	});

	test("no checks: exit 0 still needs acceptance; nonzero settles verify_failed", () => {
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
		expect(r.steps).toContain("settle(verify_failed)");
		expect(r.terminal).toMatchObject({ row: "T11", state: "failed" });
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

	test("T16 happy path (the single-run fast path): verify → critic ok → clear stall → merge queue, no settle", () => {
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
		expect(steps.some((s) => s.startsWith("settle"))).toBe(false);
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
		expect(terminal.row).toBe("T12i");
		expect(terminal.state).toBe("failed");
	});

	test("T14 critic flagged AND critic failed both settle infra_failure (fail-closed: nothing merges)", () => {
		for (const critic of [
			{ status: "ok", flagged: true },
			{ status: "failed", flagged: false },
		] as const) {
			const { steps, terminal } = drive(taskCtx(), { critic });
			expect(steps).toContain("settle(infra_failure)");
			expect(steps).not.toContain("enqueue_merge");
			expect(terminal.row).toBe("T14");
			expect(terminal.state).toBe("needs_review");
		}
	});

	test("T14 carries a failed review's cause into the terminal note", () => {
		const { terminal } = drive(taskCtx(), {
			critic: {
				status: "failed",
				flagged: false,
				cause: "reviewer_not_independent",
			},
		});
		expect(terminal.row).toBe("T14");
		expect(terminal.note).toBe("review gate: reviewer_not_independent");
	});

	test("verdict merge merges; verdict reject settles review_reject; fix settles review_fix", () => {
		const merge = drive(taskCtx(), {
			critic: { status: "ok", flagged: false, verdict: "merge", round: 1 },
		});
		expect(merge.terminal.row).toBe("T16");
		const reject = drive(taskCtx(), {
			critic: { status: "ok", flagged: true, verdict: "reject", round: 1 },
		});
		expect(reject.terminal.row).toBe("T14r");
		expect(reject.steps.slice(-1)).toEqual(["settle(review_reject)"]);
		const fix = drive(taskCtx(), {
			critic: { status: "ok", flagged: true, verdict: "fix", round: 1 },
		});
		expect(fix.terminal.row).toBe("T14f");
		expect(fix.steps.slice(-1)).toEqual(["settle(review_fix)"]);
	});

	test("a fix verdict is never capped by the machine: any round settles review_fix", () => {
		// Rounds, repairs and stalls are no longer machine policy: the brain's
		// action caps and loop guard bound a task that keeps failing review.
		for (const round of [1, 2, 3, 9]) {
			const { terminal, steps } = drive(taskCtx(), {
				critic: { status: "ok", flagged: true, verdict: "fix", round },
			});
			expect(terminal.row).toBe("T14f");
			expect(steps.slice(-1)).toEqual(["settle(review_fix)"]);
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

	test("T17 verify fails: one settle verify_failed, whatever the attempt number or stall count", () => {
		for (const attempt of [1, 2, 3, 7]) {
			const base = taskCtx();
			const ctx = taskCtx({
				task: {
					...(base.task as NonNullable<FinalizeCtx["task"]>),
					attempt,
				},
			});
			const { steps, terminal } = drive(ctx, { verify: { passed: false } });
			expect(steps).toEqual([
				"classify",
				"ingest_report",
				"verify",
				"settle(verify_failed)",
			]);
			expect(terminal).toMatchObject({ row: "T17", state: "failed" });
		}
	});

	test("no row decides repair, replan, split, abandon or escalate any more", () => {
		const outcomes: RunOutcome[] = [
			"completed",
			"killed_watchdog",
			"interrupted",
		];
		const seen = new Set<string>();
		for (const outcome of outcomes) {
			for (const verify of [{ passed: false }, { passed: true }]) {
				for (const critic of [
					undefined,
					{ status: "ok", flagged: true, verdict: "fix", round: 1 },
					{ status: "ok", flagged: true, verdict: "reject", round: 1 },
				] as const) {
					const r = drive(taskCtx({ localWorktree: true }), {
						outcome,
						verify,
						...(critic ? { critic } : {}),
						leftovers: outcome === "completed",
					});
					for (const s of r.steps) seen.add(s.replace(/\(.*\)/, ""));
				}
			}
		}
		for (const gone of [
			"spawn_repair",
			"spawn_resume",
			"decide_resume",
			"bump_stall",
			"bump_review_round",
			"replan_decide",
		]) {
			expect(seen.has(gone), gone).toBe(false);
		}
	});

	test("orphaned task row: gc only, never a release on a ghost", () => {
		const ctx = taskCtx();
		if (ctx.task) ctx.task.exists = false;
		const { steps } = drive(ctx);
		expect(steps).toEqual(["classify", "ingest_report", "gc_worktree"]);
	});

	test("crash-resume: a mid-sequence resume executes only the remaining steps", () => {
		// Crashed after ingest_report+settle of the T4 path.
		const ctx = taskCtx({
			outcome: "killed_watchdog",
			done: new Set<StepName>(["classify", "ingest_report", "settle"]),
		});
		const { steps, terminal } = drive(ctx, { outcome: "killed_watchdog" });
		expect(steps).toEqual(["gc_worktree"]);
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
	});

	test("T10L: completed but left processes running: settles background_work instead of being verified", () => {
		const { steps, terminal } = drive(taskCtx({ localWorktree: true }), {
			leftovers: true,
		});
		expect(steps).toEqual([
			"classify",
			"reap_leftovers",
			"ingest_report",
			"settle(background_work)",
		]);
		expect(terminal).toMatchObject({ row: "T10L", state: "failed" });
	});

	test("T10L: an agent-declared escalation wins over the leftover processes", () => {
		const ctx = taskCtx({ localWorktree: true });
		if (ctx.task) ctx.task.escalation = "blocked";
		const { steps, terminal } = drive(ctx, { leftovers: true });
		expect(steps).not.toContain("settle(background_work)");
		expect(terminal.row).toBe("T10");
	});

	test("T10L: a killed run with leftovers settles by its kill row, not as background work", () => {
		const { steps } = drive(taskCtx({ localWorktree: true }), {
			outcome: "killed_manual",
			leftovers: true,
		});
		expect(steps).not.toContain("settle(background_work)");
	});

	test("T0-reap: clean reap goes on to verify", () => {
		const { steps } = drive(taskCtx({ localWorktree: true }));
		expect(steps).toContain("verify");
		expect(steps.some((s) => s.startsWith("settle"))).toBe(false);
	});

	test("T10L: a turn that ended on background jobs settles background_work without verify", () => {
		const { steps, terminal } = drive(taskCtx({ localWorktree: true }), {
			background: true,
		});
		expect(steps).toEqual([
			"classify",
			"reap_leftovers",
			"ingest_report",
			"settle(background_work)",
		]);
		expect(terminal).toMatchObject({ row: "T10L", state: "failed" });
	});

	test("T10L: background jobs on a remote run (no reap) settle too", () => {
		const { steps } = drive(taskCtx({ localWorktree: false }), {
			background: true,
		});
		expect(steps).toContain("settle(background_work)");
		expect(steps).not.toContain("verify");
	});
});

describe("finalize machine: a task run that asked a question", () => {
	const asked = () => {
		const ctx = taskCtx({ localWorktree: true });
		if (ctx.task) ctx.task.escalation = "question";
		return ctx;
	};

	test("T10Q: question recorded, then settled: no verify, no release to blocked, no ping, worktree kept", () => {
		const { steps, terminal } = drive(asked());
		expect(steps).toEqual([
			"classify",
			"reap_leftovers",
			"ingest_report",
			"record_question",
			"settle(question)",
		]);
		for (const burned of [
			"verify",
			"notify",
			"release_task(blocked)",
			"gc_worktree",
		])
			expect(steps).not.toContain(burned);
		expect(terminal).toMatchObject({ row: "T10Q", state: "completed" });
	});

	test("T10Q: a question wins over background work the turn ended on", () => {
		const { steps, terminal } = drive(asked(), { background: true });
		expect(steps).not.toContain("settle(background_work)");
		expect(terminal.row).toBe("T10Q");
	});

	test("T10Q: a killed run's question is not honoured (the kill row decides)", () => {
		const { terminal } = drive(asked(), { outcome: "killed_watchdog" });
		expect(terminal.row).toBe("T4");
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

	test("I7 happy path: parse, then settle plan_output: nothing is created, the brain applies the proposal", () => {
		// An importer proposes work; it writes no code and, since P3, no tasks.
		const { steps, terminal } = drive(importCtx());
		expect(steps).toEqual([
			"classify",
			"parse_plan",
			"settle(plan_output)",
			"gc_worktree",
		]);
		for (const gone of [
			"import_review",
			"create_tasks",
			"create_specs",
			"record_questions",
			"enqueue_merge",
			"notify",
		]) {
			expect(steps).not.toContain(gone);
		}
		expect(terminal).toMatchObject({ row: "I7", state: "completed" });
	});

	test("an unparseable proposal still settles plan_output (parsed: false) and ends failed", () => {
		const { steps, terminal } = drive(importCtx(), { planParsed: false });
		expect(steps).toContain("settle(plan_output)");
		expect(terminal.state).toBe("failed");
		expect(terminal.note).toContain("proposed nothing");
	});

	test("an import that did not complete settles by how it ended", () => {
		for (const [outcome, cls, state] of [
			["killed_manual", "stopped", "killed"],
			["killed_watchdog", "watchdog_killed", "killed"],
			["interrupted", "interrupted", "interrupted"],
			["rate_limited", "rate_limited", "rate_limited"],
			["start_failed", "infra_failure", "failed"],
		] as const) {
			const { steps, terminal } = drive(importCtx(), { outcome });
			expect(steps, outcome).toContain(`settle(${cls})`);
			expect(terminal.state, outcome).toBe(state);
		}
	});
});

describe("finalize machine: plan / action / brain rows", () => {
	test("P3 a finished plan settles plan_output; it creates nothing and notifies nobody", () => {
		const ctx = taskCtx({ kind: "plan", task: null });
		const { steps, terminal } = drive(ctx);
		expect(steps).toEqual([
			"classify",
			"parse_plan",
			"settle(plan_output)",
			"gc_worktree",
		]);
		for (const gone of ["create_tasks", "create_specs", "record_questions"]) {
			expect(steps).not.toContain(gone);
		}
		expect(steps).not.toContain("notify");
		expect(terminal).toMatchObject({ row: "P3", state: "completed" });
	});

	test("P2 an unparseable plan fails but still settles for the brain, with the run dir evidence kept", () => {
		const ctx = taskCtx({ kind: "plan", task: null });
		const { steps, terminal } = drive(ctx, { planParsed: false });
		expect(steps).toContain("settle(plan_output)");
		expect(terminal.note).toContain("no valid plan");
	});

	// A draft-expanding plan run records the failed attempt (retry bookkeeping)
	// before it settles; an ordinary goal-to-DAG plan never journals that step.
	test("P0 a draft-expansion plan that never completed records a failed attempt, then settles by its outcome", () => {
		const ctx = taskCtx({ kind: "plan", task: null, isDraftExpand: true });
		const { steps, terminal } = drive(ctx, { outcome: "killed_manual" });
		expect(steps).toEqual([
			"classify",
			"draft_expand_failed",
			"settle(stopped)",
			"gc_worktree",
		]);
		expect(terminal.state).toBe("killed");
	});

	test("P2 a draft-expansion plan that failed to parse records a failed attempt and settles plan_output", () => {
		const ctx = taskCtx({ kind: "plan", task: null, isDraftExpand: true });
		const { steps, terminal } = drive(ctx, { planParsed: false });
		expect(steps).toEqual([
			"classify",
			"parse_plan",
			"draft_expand_failed",
			"settle(plan_output)",
			"gc_worktree",
		]);
		expect(terminal.note).toContain("no valid plan");
	});

	test("a successful draft expansion settles plan_output without recording a failure", () => {
		const ctx = taskCtx({ kind: "plan", task: null, isDraftExpand: true });
		const { steps } = drive(ctx);
		expect(steps).toEqual([
			"classify",
			"parse_plan",
			"settle(plan_output)",
			"gc_worktree",
		]);
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
