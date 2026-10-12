import "./support/tmux-test-socket.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { SETTLE_CLASSES, type SettleClass } from "@mfw/core/events";
import {
	brainSessions,
	brainTurns,
	engineKv,
	events,
	mergeJobs,
} from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import {
	type Directive,
	type FinalizeCtx,
	next,
	type RunOutcome,
	type StepName,
} from "../src/finalize/machine.ts";
import { settleParkedMerge } from "../src/finalize/settle-event.ts";
import { silentLogger } from "../src/log.ts";
import type { MergeJobView } from "../src/merge-queue.ts";
import { type BrainUnit, brainUnit } from "./support/brain-unit.ts";
import { type GroupFixture, groupFixture } from "./support/group-fixture.ts";

/**
 * The `settle` terminal (P3): every run that did not simply verify and merge
 * ends finalize with a CLASS and the facts the brain decides from, and the
 * brain, not a fixed pipeline, chooses what happens next.
 *
 *   A. the machine produces each class (table over the 18 classes)
 *   B. each class wakes the brain within one tick after debounce, and the
 *      digest names the class and carries the run's report
 *   C. a parked merge settles `merge_parked`
 *   D. end to end on a real boot: a failed run settles, nothing repairs by
 *      itself, the brain continues it, and it merges
 *   E. the circuit breaker: brain failed => tasks stay awaiting_brain, the
 *      merge queue keeps draining, exactly one brain_stuck item
 */

// ---------------------------------------------------------------------------
// A. the machine
// ---------------------------------------------------------------------------

function ctx(over: Partial<FinalizeCtx> = {}): FinalizeCtx {
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

function withTask(
	over: Partial<NonNullable<FinalizeCtx["task"]>>,
	rest: Partial<FinalizeCtx> = {},
): FinalizeCtx {
	const base = ctx(rest);
	return {
		...base,
		task: { ...(base.task as NonNullable<FinalizeCtx["task"]>), ...over },
	};
}

interface Script {
	outcome?: RunOutcome;
	verify?: { passed: boolean; crashed?: boolean };
	critic?: FinalizeCtx["critic"];
	killReason?: string;
	leftovers?: boolean;
	scopeOutside?: number;
}

/** Drive `next` as the StepRunner does; returns the settle class reached, if any. */
function settleOf(
	start: FinalizeCtx,
	script: Script = {},
): { settle: string | null; steps: string[]; state: string; row: string } {
	const done = new Set<StepName>(start.done);
	let cur: FinalizeCtx = { ...start, done };
	const steps: string[] = [];
	let settle: string | null = null;
	for (let i = 0; i < 32; i++) {
		const d = next(cur);
		if (d.kind === "terminal") {
			return { settle, steps, state: d.state, row: d.row };
		}
		const dir = d as Directive;
		steps.push(dir.step);
		if (dir.step === "settle") settle = dir.args?.settle ?? null;
		done.add(dir.step);
		if (dir.step === "classify")
			cur = {
				...cur,
				outcome: script.outcome ?? "completed",
				...(script.killReason ? { killReason: script.killReason } : {}),
			};
		if (dir.step === "verify")
			cur = {
				...cur,
				verify: script.verify
					? { crashed: false, ...script.verify }
					: { passed: true, crashed: false },
			};
		if (dir.step === "scope_check")
			cur = { ...cur, scope: { outside: script.scopeOutside ?? 0 } };
		if (dir.step === "critic")
			cur = {
				...cur,
				critic: script.critic ?? { status: "ok", flagged: false },
			};
		if (dir.step === "reap_leftovers")
			cur = { ...cur, leftBackground: script.leftovers ?? false };
		if (dir.step === "parse_plan") cur = { ...cur, planParsed: true };
		cur = { ...cur, done };
	}
	throw new Error("finalize did not terminate");
}

const ATTEMPT = { group: { competing: true } } as const;
const SCOPED = {
	gates: {
		mainRed: false,
		reviewGated: false,
		brainEnabled: true,
		scopeOnFinish: true,
	},
} as const;
const REVIEWED = {
	gates: {
		mainRed: false,
		reviewGated: false,
		brainEnabled: true,
		criticEnabled: true,
	},
} as const;

/**
 * One scenario per class the machine can end in. `merge_parked` is not a
 * finalize-machine terminal: the merge queue settles it (see C).
 */
const MACHINE: Record<
	SettleClass,
	{ ctx: FinalizeCtx; script?: Script; row: string } | "elsewhere"
> = {
	verified: { ctx: ctx(ATTEMPT), row: "TA12" },
	verify_failed: {
		ctx: ctx(),
		script: { verify: { passed: false } },
		row: "T17",
	},
	review_fix: {
		ctx: ctx(REVIEWED),
		script: {
			critic: { status: "ok", flagged: true, verdict: "fix", round: 1 },
		},
		row: "T14f",
	},
	review_reject: {
		ctx: ctx(REVIEWED),
		script: {
			critic: { status: "ok", flagged: true, verdict: "reject", round: 1 },
		},
		row: "T14r",
	},
	scope_violation: {
		ctx: ctx(),
		script: { outcome: "killed_watchdog", killReason: "watchdog-scope" },
		row: "T4s",
	},
	scope_outside: { ctx: ctx(SCOPED), script: { scopeOutside: 2 }, row: "T14s" },
	question: {
		ctx: withTask({ escalation: "question" }),
		row: "T10Q",
	},
	background_work: {
		ctx: ctx({ localWorktree: true }),
		script: { leftovers: true },
		row: "T10L",
	},
	interrupted: { ctx: ctx(), script: { outcome: "interrupted" }, row: "T5" },
	watchdog_killed: {
		ctx: ctx(),
		script: { outcome: "killed_watchdog", killReason: "watchdog-idle" },
		row: "T4",
	},
	rate_limited: {
		ctx: ctx(ATTEMPT),
		script: { outcome: "rate_limited" },
		row: "TA1",
	},
	stopped: {
		ctx: ctx(ATTEMPT),
		script: { outcome: "killed_manual" },
		row: "TA3",
	},
	infra_failure: {
		ctx: ctx(REVIEWED),
		script: { critic: { status: "failed", flagged: false, cause: "x" } },
		row: "T14",
	},
	report_blocked: { ctx: withTask({ escalation: "blocked" }), row: "T10" },
	report_replan: { ctx: withTask({ escalation: "needs-replan" }), row: "T9" },
	report_drop: { ctx: withTask({ escalation: "drop" }), row: "T8" },
	plan_output: {
		ctx: ctx({ kind: "plan", task: null }),
		row: "P3",
	},
	merge_parked: "elsewhere",
};

describe("A. the machine ends in each settle class", () => {
	test("the table covers exactly the 18 classes", () => {
		expect(Object.keys(MACHINE).sort()).toEqual([...SETTLE_CLASSES].sort());
		expect(SETTLE_CLASSES).toHaveLength(18);
	});

	for (const cls of SETTLE_CLASSES) {
		const scenario = MACHINE[cls];
		if (scenario === "elsewhere") continue;
		test(`${cls}: row ${scenario.row} ends in settle, with no repair, block or page`, () => {
			const r = settleOf(scenario.ctx, scenario.script);
			expect(r.settle).toBe(cls);
			expect(r.row).toBe(scenario.row);
			expect(r.steps.filter((s) => s === "settle")).toHaveLength(1);
			for (const policy of [
				"spawn_repair",
				"spawn_resume",
				"decide_resume",
				"bump_stall",
				"replan_decide",
				"notify",
			]) {
				expect(r.steps).not.toContain(policy);
			}
		});
	}

	test("a verified single run never settles: the fast path merges without the brain", () => {
		const r = settleOf(ctx());
		expect(r.settle).toBeNull();
		expect(r.steps).toContain("enqueue_merge");
	});
});

// ---------------------------------------------------------------------------
// B. wake and digest
// ---------------------------------------------------------------------------

describe("B. each settle class wakes the brain within one tick after debounce", () => {
	let u: BrainUnit | undefined;
	afterEach(async () => {
		await u?.cleanup();
		u = undefined;
	});

	for (const cls of SETTLE_CLASSES) {
		test(`${cls}: one tick starts a settled turn; the digest names the class and carries the report`, async () => {
			u = await brainUnit();
			u.clock.t = Date.now();
			await u.runtime.tick(); // the session exists, its cursor at the head
			const task = await u.tasks.create({ title: "settled work" });
			const run = await u.registry.create({
				kind: "task",
				taskId: task.id,
				label: `${task.id}#implement`,
				model: "sonnet",
				cwd: u.root,
			});
			await u.registry.beginStep(run.id, "ingest_report");
			await u.registry.finishStep(run.id, "ingest_report", {
				report: { status: "blocked", summary: `the report for ${cls}` },
			});
			await u.registry.transition(run.id, "failed", {
				outcome: "completed",
				exitCode: 0,
				finishedAt: new Date(u.clock.t),
			});
			await u.emit({
				type: "run.settled",
				runId: run.id,
				taskId: task.id,
				payload: { groupId: run.id, class: cls, facts: {} },
			});
			// Debounce: `settled` waits for 10 s of quiet.
			expect((await u.runtime.tick()).state).toBe("idle");
			u.advance(10_000);

			const out = await u.runtime.tick();

			expect(out).toMatchObject({ state: "started", wakeClass: "settled" });
			const prompt = u.launched[0]?.prompt ?? "";
			expect(prompt).toContain(`settled: ${cls}`);
			expect(prompt).toContain(`the report for ${cls}`);
			expect(prompt).toContain(run.id);
		});
	}

	test("a run that only changed state wakes nothing: finalize says when it settled", async () => {
		u = await brainUnit();
		u.clock.t = Date.now();
		await u.runtime.tick();
		await u.emit({
			type: "run.state_changed",
			runId: "r-1",
			payload: { from: "finalizing", to: "merging" },
		});
		u.advance(60_000);
		expect((await u.runtime.tick()).state).toBe("idle");
	});

	test("the digest lists tasks awaiting the brain", async () => {
		u = await brainUnit();
		u.clock.t = Date.now();
		await u.runtime.tick();
		const task = await u.tasks.create({ title: "stuck work", status: "ready" });
		const run = await u.registry.create({
			kind: "task",
			taskId: task.id,
			label: "t",
			model: "sonnet",
			cwd: u.root,
		});
		await u.registry.transition(run.id, "failed", { finishedAt: new Date() });
		await u.handle.db.insert(engineKv).values({
			key: "brain_awaiting",
			value: {
				awaiting: {
					[task.id]: {
						runId: run.id,
						class: "verify_failed",
						groupId: run.id,
						at: u.clock.t - 120_000,
					},
				},
			},
			updatedAt: new Date(),
		});
		await u.human("look");
		const out = await u.runtime.tick();
		expect(out.state).toBe("started");
		const prompt = u.launched[0]?.prompt ?? "";
		expect(prompt).toContain("Waiting on you (awaiting_brain)");
		expect(prompt).toContain(`${task.id} stuck work: settled verify_failed`);
	});
});

describe("awaiting_brain bookkeeping", () => {
	let u: BrainUnit | undefined;
	afterEach(async () => {
		await u?.cleanup();
		u = undefined;
	});

	test("an entry is dropped when the task moved on without the brain, kept otherwise", async () => {
		u = await brainUnit();
		const { pruneAwaiting, markAwaiting } = await import(
			"../src/brain-runtime/awaiting.ts"
		);
		const mk = async (title: string) => {
			const t = await u?.tasks.create({ title, status: "ready" });
			const run = await u?.registry.create({
				kind: "task",
				taskId: t?.id,
				label: "t",
				model: "sonnet",
				cwd: u.root,
			});
			if (!t || !run || !u) throw new Error("setup");
			await markAwaiting(u.handle, t.id, {
				runId: run.id,
				class: "verify_failed",
				groupId: run.id,
				at: Date.now(),
			});
			return { t, run };
		};
		const kept = await mk("kept");
		const moved = await mk("a person moved it");
		const spawned = await mk("the brain's spawn landed");
		await u.tasks.move(moved.t.id, "backlog", "human", "not now");
		await Bun.sleep(5);
		await u.registry.create({
			kind: "task",
			taskId: spawned.t.id,
			label: "next",
			model: "sonnet",
			cwd: u.root,
		});

		const live = await pruneAwaiting(u.handle, {
			tasks: u.tasks,
			registry: u.registry,
		});

		expect(Object.keys(live)).toEqual([kept.t.id]);
	});
});

describe("the circuit breaker's session state", () => {
	let u: BrainUnit | undefined;
	afterEach(async () => {
		await u?.cleanup();
		u = undefined;
	});

	test("a stand-in turn closing late (aborted) leaves a failed session failed", async () => {
		u = await brainUnit();
		await u.runtime.tick();
		const session = await u.runtime.currentSession();
		if (!session) throw new Error("no session");
		await u.handle.db
			.update(brainSessions)
			.set({ status: "failed", consecutiveFailures: 3 })
			.where(eq(brainSessions.id, session.id));
		// A turn row whose run never existed: reconciliation aborts it.
		await u.handle.db.insert(brainTurns).values({
			runId: "never-created",
			sessionId: session.id,
			seq: 1,
			generation: 0,
			wakeClass: "human",
			eventsFrom: 0,
			eventsTo: 0,
			resumed: false,
			status: "running",
			startedAt: new Date(),
		});

		expect((await u.runtime.tick()).state).toBe("failed");
		expect((await u.runtime.currentSession())?.status).toBe("failed");
		expect((await u.turns())[0]?.status).toBe("aborted");
		// And still failed on the next pass: only a person's retry closes it.
		expect((await u.runtime.tick()).state).toBe("failed");
	});
});

// ---------------------------------------------------------------------------
// C. a parked merge
// ---------------------------------------------------------------------------

describe("C. a parked merge settles merge_parked", () => {
	let u: BrainUnit | undefined;
	afterEach(async () => {
		await u?.cleanup();
		u = undefined;
	});

	test("the task goes back to ready with its worktree kept, the job closes, the brain is woken; nobody is paged", async () => {
		u = await brainUnit();
		u.clock.t = Date.now();
		await u.runtime.tick();
		const t = await u.tasks.create({ title: "conflicting", status: "ready" });
		expect(await u.tasks.tryClaim(t.id, "run-parked", 60_000)).toBe(true);
		const run = await u.registry.create({
			id: "run-parked",
			kind: "task",
			taskId: t.id,
			label: t.id,
			model: "sonnet",
			cwd: u.root,
			worktreePath: u.root,
			branch: "mfw/parked",
			baseSha: "a".repeat(40),
		});
		await u.registry.transition(run.id, "merging");
		const abandoned: number[] = [];
		const job: MergeJobView = {
			id: 7,
			runId: run.id,
			taskId: t.id,
			branch: "mfw/parked",
			targetBranch: "main",
			worktreePath: u.root,
			attempt: 1,
			parkRetries: 3,
		};

		await settleParkedMerge(
			{
				handle: u.handle,
				bus: u.bus,
				registry: u.registry,
				tasks: u.tasks,
				mergeQueue: {
					abandon: async (id) => {
						abandoned.push(id);
					},
				},
				log: silentLogger(),
			},
			job,
			"merge conflict persisted after rebase",
			"conflict",
		);

		expect(abandoned).toEqual([7]);
		const task = await u.tasks.get(t.id);
		expect(task?.status).toBe("ready");
		expect(task?.claimedByRunId).toBeNull();
		expect(task?.preservedWorktree).toBe(u.root);
		expect((await u.registry.get(run.id))?.state).toBe("failed");
		// The wake: one tick after the debounce.
		u.advance(11_000);
		expect(await u.runtime.tick()).toMatchObject({
			state: "started",
			wakeClass: "settled",
		});
		expect(u.launched[0]?.prompt).toContain("settled: merge_parked");
		const [awaiting] = await u.handle.db
			.select()
			.from(engineKv)
			.where(eq(engineKv.key, "brain_awaiting"));
		expect(
			(awaiting?.value as { awaiting: Record<string, { class: string }> })
				.awaiting[t.id]?.class,
		).toBe("merge_parked");
	});
});

// ---------------------------------------------------------------------------
// D + E. real boot
// ---------------------------------------------------------------------------

let fx: GroupFixture | undefined;
afterEach(async () => {
	await fx?.cleanup();
	fx = undefined;
});

async function awaitingOf(f: GroupFixture) {
	const [row] = await f.svc.handle.db
		.select()
		.from(engineKv)
		.where(eq(engineKv.key, "brain_awaiting"));
	return (
		(
			row?.value as {
				awaiting?: Record<string, { runId: string; class: string }>;
			}
		)?.awaiting ?? {}
	);
}

async function terminal(f: GroupFixture, runId: string) {
	await f.until(
		async () => {
			const r = await f.svc.registry.get(runId);
			return (
				!!r &&
				["completed", "failed", "killed", "finalize_error"].includes(r.state)
			);
		},
		{ what: `run ${runId} to settle`, timeoutMs: 60_000 },
	);
}

describe("D. a failed run waits for the brain, which continues it", () => {
	test("settles verify_failed, repairs nothing by itself, then a continue: spawn verifies and merges", async () => {
		fx = await groupFixture();
		const f = fx;
		const taskId = await f.task("flaky work");
		const first = await f.act("spawn", { taskId, role: "implement" });
		const [runId] = (first.result?.runIds ?? []) as string[];
		if (!runId) throw new Error("no run id");
		await f.control({ dirty: [runId] });
		await f.svc.scheduler.tick();
		await terminal(f, runId);

		// Settled: verify_failed, the task back to ready and awaiting the brain.
		const settledRows = (await f.svc.handle.db.select().from(events)).filter(
			(e) => e.type === "run.settled" && e.runId === runId,
		);
		expect(settledRows).toHaveLength(1);
		expect(settledRows[0]?.payload).toMatchObject({
			class: "verify_failed",
			groupId: runId,
		});
		const task = await f.svc.tasks.get(taskId);
		expect(task?.status).toBe("ready");
		expect(task?.claimedByRunId).toBeNull();
		expect((await awaitingOf(f))[taskId]).toMatchObject({
			runId,
			class: "verify_failed",
		});
		expect((await f.svc.registry.get(runId))?.state).toBe("failed");

		// Nothing repairs by itself: several passes later there is still one run.
		for (let i = 0; i < 4; i++) {
			await f.svc.supervisor.pass();
			await f.svc.scheduler.tick();
		}
		const runs = (await f.svc.registry.list({ taskId })).filter(
			(r) => r.kind === "task",
		);
		expect(runs.map((r) => r.id)).toEqual([runId]);

		// The brain decides: continue it in the same worktree.
		await f.control({});
		const cont = await f.act("spawn", {
			taskId,
			role: "implement",
			worktree: `continue:${runId}`,
			brief: "Create feature.txt.",
		});
		expect(cont.status).toBe("accepted");
		const [childId] = (cont.result?.runIds ?? []) as string[];
		if (!childId) throw new Error("no child id");
		await f.svc.scheduler.tick();
		await f.until(
			async () => {
				const job = (await f.svc.handle.db.select().from(mergeJobs))[0];
				return job?.runId === childId && job.state === "merged";
			},
			{ what: "the continuation to merge", timeoutMs: 60_000 },
		);

		const child = await f.svc.registry.get(childId);
		expect(child).toMatchObject({
			parentRunId: runId,
			relation: "continue",
			worktreePath: (await f.svc.registry.get(runId))?.worktreePath,
		});
		expect(child?.initialPrompt).toContain("did not pass verification");
		expect(child?.initialPrompt).toContain("Create feature.txt.");
		expect((await f.svc.tasks.get(taskId))?.status).toBe("done");
		// The brain acted: the task no longer awaits it.
		expect((await awaitingOf(f))[taskId]).toBeUndefined();
	});

	test("the verified fast path merges with no settle and no brain wake", async () => {
		fx = await groupFixture();
		const f = fx;
		const taskId = await f.task("simple work");
		const spawned = await f.act("spawn", { taskId, role: "implement" });
		const [runId] = (spawned.result?.runIds ?? []) as string[];
		await f.svc.scheduler.tick();
		await f.until(
			async () => {
				const job = (await f.svc.handle.db.select().from(mergeJobs))[0];
				return job?.state === "merged";
			},
			{ what: "the merge", timeoutMs: 60_000 },
		);
		const settled = (await f.svc.handle.db.select().from(events)).filter(
			(e) => e.type === "run.settled",
		);
		expect(settled).toEqual([]);
		expect(await awaitingOf(f)).toEqual({});
		expect((await f.svc.tasks.get(taskId))?.status).toBe("done");
		expect(runId).toBeTruthy();
	});
});

describe("E. the brain's circuit breaker", () => {
	test("failed brain: tasks stay awaiting_brain, the merge queue keeps draining, exactly one brain_stuck item", async () => {
		fx = await groupFixture();
		const f = fx;
		// Open the circuit (what three failed turns do).
		const failing = await f.task("will fail verify");
		const passing = await f.task("will pass verify");
		const a = await f.act("spawn", { taskId: failing, role: "implement" });
		const b = await f.act("spawn", { taskId: passing, role: "implement" });
		expect(b.status).toBe("accepted");
		const [failingRun] = (a.result?.runIds ?? []) as string[];
		if (!failingRun) throw new Error("no run id");
		// Let the runtime close the helper's stand-in turn first, as any pass would.
		await f.svc.brainRuntime.tick();
		const session = await f.svc.brainRuntime.currentSession();
		if (!session) throw new Error("no brain session");
		await f.svc.handle.db
			.update(brainSessions)
			.set({ status: "failed", consecutiveFailures: 3 })
			.where(eq(brainSessions.id, session.id));
		await f.control({ fail: [failingRun] });
		// A spawn accepted before the circuit opened still launches and merges.
		await f.svc.scheduler.tick();
		await terminal(f, failingRun);
		await f.until(
			async () => {
				const done = await f.svc.tasks.get(passing);
				return done?.status === "done";
			},
			{
				what: "the verified task to merge with the brain down",
				timeoutMs: 60_000,
			},
		);

		// The failed task waits; nothing escalated by itself.
		expect((await awaitingOf(f))[failing]).toMatchObject({
			runId: failingRun,
			class: "verify_failed",
		});
		expect((await f.svc.tasks.get(failing))?.status).toBe("ready");
		// The brain does not wake while the circuit is open.
		expect((await f.svc.brainRuntime.tick()).state).toBe("failed");

		const items = await f.svc.inbox.list();
		const stuck = items.filter((i) => i.kind === "brain_stuck");
		expect(stuck).toHaveLength(1);
		expect(stuck[0]?.detail).toContain("1 task waits on it");
		// No automatic escalation for the failed task.
		expect(items.filter((i) => i.taskId === failing)).toEqual([]);

		// More settles do not add items: still exactly one.
		await f.svc.supervisor.pass();
		expect(
			(await f.svc.inbox.list()).filter((i) => i.kind === "brain_stuck"),
		).toHaveLength(1);

		// A person presses retry: the circuit closes; the settle is still there
		// for the brain to act on.
		await f.svc.brainRuntime.resetCircuit();
		expect((await f.svc.brainRuntime.currentSession())?.status).toBe("idle");
		expect((await awaitingOf(f))[failing]).toBeDefined();
	});
});
