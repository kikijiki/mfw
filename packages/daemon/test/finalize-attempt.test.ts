import { describe, expect, test } from "bun:test";
import {
	type Directive,
	type FinalizeCtx,
	next,
	type RunOutcome,
	type StepName,
} from "../src/finalize/machine.ts";

/**
 * The rows an attempt of a competing group runs (`TA*`): the mechanical gates
 * and nothing that decides the task's fate. The same context without
 * `group` is the single-run machine, untouched (finalize-golden pins that).
 */

function ctx(
	over: Partial<FinalizeCtx> = {},
	done: StepName[] = [],
): FinalizeCtx {
	return {
		kind: "task",
		outcome: "completed",
		done: new Set<StepName>(["classify", "ingest_report", ...done]),
		isDraftExpand: false,
		group: { competing: true },
		task: {
			exists: true,
			hasDod: true,
			escalation: null,
			attempt: 1,
			worktreeDirty: false,
			exitCode: 0,
		},
		gates: {
			mainRed: false,
			reviewGated: true,
			brainEnabled: false,
			criticEnabled: false,
			scopeOnFinish: false,
		},
		verify: null,
		critic: null,
		planParsed: null,
		reportHasFollowUps: false,
		localWorktree: false,
		leftBackground: false,
		...over,
	};
}

/** Drive `next` the way the StepRunner does and return the rows and the end. */
function run(c: FinalizeCtx) {
	const rows: string[] = [];
	const steps: StepName[] = [];
	/** The class of the `settle` step, when the attempt reached it. */
	let settled: string | null = null;
	for (let i = 0; i < 20; i++) {
		const d = next(c);
		rows.push(d.row);
		if (d.kind === "terminal") return { rows, steps, end: d, settled };
		steps.push((d as Directive).step);
		if ((d as Directive).step === "settle") {
			settled = (d as Directive).args?.settle ?? null;
		}
		c.done = new Set([...c.done, (d as Directive).step]);
		if ((d as Directive).step === "verify") {
			c.verify = c.verify ?? { passed: true, crashed: false };
		}
		if ((d as Directive).step === "scope_check")
			c.scope = c.scope ?? { outside: 0 };
		if ((d as Directive).step === "critic") {
			c.critic = c.critic ?? {
				status: "ok",
				flagged: false,
				verdict: "merge",
				round: 1,
			};
		}
	}
	throw new Error("did not terminate");
}

/** What an attempt never does by itself: the claim and the fate are the group's and the brain's. */
const NEVER: StepName[] = [
	"release_task",
	"clear_stall",
	"enqueue_merge",
	"notify",
];

describe("attempt finalize rows", () => {
	test("a verified attempt stops at the gates, settles verified and waits for selection", () => {
		const r = run(ctx());
		expect(r.steps).toEqual(["verify", "settle"]);
		expect(r.settled).toBe("verified");
		expect(r.end).toMatchObject({
			kind: "terminal",
			state: "completed",
			row: "TA12",
		});
		expect(r.end.note).toContain("awaiting selection");
	});

	test("a failed verification settles verify_failed, with no stall, release or merge", () => {
		const r = run(
			ctx({ verify: { passed: false, crashed: false } }, ["verify"]),
		);
		expect(r.end).toMatchObject({ state: "failed", row: "TA9" });
		expect(r.settled).toBe("verify_failed");
		for (const s of NEVER) expect(r.steps).not.toContain(s);
	});

	test("scope and the review floor still run when they apply, and a passing floor settles verified", () => {
		const r = run(
			ctx({
				gates: {
					mainRed: false,
					reviewGated: true,
					brainEnabled: true,
					criticEnabled: true,
					scopeOnFinish: true,
				},
			}),
		);
		expect(r.steps).toEqual(["verify", "scope_check", "critic", "settle"]);
		expect(r.end.state).toBe("completed");
		expect(r.settled).toBe("verified");
		for (const s of NEVER) expect(r.steps).not.toContain(s);
	});

	test("a verified attempt the floor sends back settles review_fix, not verified", () => {
		const r = run(
			ctx({
				gates: {
					mainRed: false,
					reviewGated: false,
					brainEnabled: true,
					criticEnabled: true,
				},
				critic: { status: "ok", flagged: true, verdict: "fix", round: 1 },
			}),
		);
		expect(r.settled).toBe("review_fix");
		expect(r.end.state).toBe("needs_review");
	});

	test("a verified attempt with files outside owns settles scope_outside", () => {
		const r = run(
			ctx({
				gates: {
					mainRed: false,
					reviewGated: false,
					brainEnabled: false,
					scopeOnFinish: true,
				},
				scope: { outside: 3 },
			}),
		);
		expect(r.settled).toBe("scope_outside");
	});

	const outcomes: [RunOutcome, string, string][] = [
		["killed_manual", "TA3", "stopped"],
		["interrupted", "TA5", "interrupted"],
		["killed_watchdog", "TA4", "watchdog_killed"],
		["rate_limited", "TA1", "rate_limited"],
		["start_failed", "TA2", "infra_failure"],
	];
	for (const [outcome, row, cls] of outcomes) {
		test(`${outcome} ends the attempt in place and settles ${cls}: no release, no resume`, () => {
			const r = run(ctx({ outcome }));
			expect(r.end.row).toBe(row);
			expect(r.settled).toBe(cls);
			for (const s of NEVER) expect(r.steps).not.toContain(s);
		});
	}

	test("a scope kill archives the work first, mechanically, then settles scope_violation", () => {
		const r = run(
			ctx({ outcome: "killed_watchdog", killReason: "watchdog-scope" }),
		);
		expect(r.steps).toEqual(["archive_wip", "settle", "gc_worktree"]);
		expect(r.settled).toBe("scope_violation");
		expect(r.end).toMatchObject({ state: "killed", row: "TA4s" });
	});

	test("a question or a report from an attempt settles its class; a question is recorded first", () => {
		for (const [esc, cls] of [
			["question", "question"],
			["blocked", "report_blocked"],
			["needs-replan", "report_replan"],
			["drop", "report_drop"],
		] as const) {
			const base = ctx();
			const r = run(
				ctx({
					task: {
						...(base.task as NonNullable<FinalizeCtx["task"]>),
						escalation: esc,
					},
				}),
			);
			expect(r.settled).toBe(cls);
			if (esc === "question") expect(r.steps[0]).toBe("record_question");
		}
	});

	test("without `group` the very same context is the single-run machine (verify failure settles on the single-run row)", () => {
		const c = ctx({ verify: { passed: false, crashed: false } }, ["verify"]);
		delete c.group;
		const r = run(c);
		expect(r.end.row).toBe("T17");
		expect(r.settled).toBe("verify_failed");
	});
});
