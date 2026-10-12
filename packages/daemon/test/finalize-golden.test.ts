import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Directive,
	type FinalizeCtx,
	next,
	type RunOutcome,
	type StepName,
} from "../src/finalize/machine.ts";

/**
 * Golden traces for the finalize machine's MECHANICAL rows: classify,
 * leftover reaping, verify, the finish-time scope gate, the review floor
 * (critic verdicts), and merge enqueue. Each recorded context is driven
 * through `next` the way the StepRunner does, and the full row-by-row trace
 * is compared byte for byte against `fixtures/finalize-golden.json`, which
 * was captured from the machine at 034befa.
 *
 * The brain-led rework (P3) replaced the rows that DECIDE what happens next
 * (T17+ repair and replan, stall escalation, resume, review fix to repair,
 * question to blocked, the scope kill's block) with the `settle` terminal. It
 * left these mechanical rows, and their order, untouched:
 * `fixtures/finalize-golden-legacy.json` is the trace set recorded at 034befa,
 * frozen, and the "legacy prefix" test below proves every new trace equals it
 * up to the point where the old trace first hit a policy row, and that from
 * there it ends in `settle` with the expected class.
 *
 * A deliberate change regenerates the current fixture with
 * `UPDATE_GOLDEN=1 bun test packages/daemon/test/finalize-golden.test.ts`
 * and the diff of the JSON is the review.
 */

const FIXTURE = join(import.meta.dir, "fixtures", "finalize-golden.json");
const LEGACY = join(import.meta.dir, "fixtures", "finalize-golden-legacy.json");

/** Steps and rows of the old pipeline that encoded policy rather than mechanics. */
const POLICY_STEPS = new Set([
	"bump_stall",
	"spawn_repair",
	"spawn_resume",
	"bump_review_round",
	"replan_decide",
	"decide_resume",
]);
const POLICY_ROWS = new Set([
	"T14",
	"T14f",
	"T14r",
	"T14s",
	"T14x",
	"T18",
	"T19",
	"T20",
	"T21",
	"T22",
	"T23",
	"T24",
]);

/** The settle class each recorded context that used to hit a policy row now ends in. */
const EXPECTED_SETTLE: Record<string, string> = {
	"04 critic floor says reject: blocked for a human, no repair":
		"review_reject",
	"05 critic failed (no verdict): fail closed to review": "infra_failure",
	"06 critic fix with rounds left: one repair": "review_fix",
	"07 critic fix with rounds exhausted: human review": "review_fix",
	"08 scope gate: files outside owns go to review before the critic":
		"scope_outside",
	"12 scope watchdog kill in a local worktree: reap, archive wip, block":
		"scope_violation",
};

interface Script {
	outcome?: RunOutcome;
	verify?: { passed: boolean; crashed?: boolean };
	critic?: FinalizeCtx["critic"];
	leftovers?: boolean;
	killReason?: string;
	scopeOutside?: number;
}

interface Recorded {
	name: string;
	ctx: Omit<FinalizeCtx, "done"> & { done: StepName[] };
	script: Script;
}

function base(over: Partial<FinalizeCtx> = {}): FinalizeCtx {
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
		gates: {
			mainRed: false,
			reviewGated: false,
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

function withTask(
	over: Partial<NonNullable<FinalizeCtx["task"]>>,
	rest: Partial<FinalizeCtx> = {},
): FinalizeCtx {
	const b = base(rest);
	return {
		...b,
		task: { ...(b.task as NonNullable<FinalizeCtx["task"]>), ...over },
	};
}

function record(name: string, ctx: FinalizeCtx, script: Script = {}): Recorded {
	return {
		name,
		ctx: { ...ctx, done: [...ctx.done].sort() } as Recorded["ctx"],
		script,
	};
}

/** The 12 recorded contexts. */
const CONTEXTS: Recorded[] = [
	record(
		"01 success, no checks configured: straight to merge",
		withTask({ hasDod: false }),
	),
	record("02 success, verify passes: merge", base()),
	record(
		"03 success, verify passes, critic floor says merge",
		base({ gates: { ...base().gates, criticEnabled: true } }),
		{ critic: { status: "ok", flagged: false, verdict: "merge", round: 1 } },
	),
	record(
		"04 critic floor says reject: blocked for a human, no repair",
		base({ gates: { ...base().gates, criticEnabled: true } }),
		{ critic: { status: "ok", flagged: true, verdict: "reject", round: 1 } },
	),
	record(
		"05 critic failed (no verdict): fail closed to review",
		base({ gates: { ...base().gates, criticEnabled: true } }),
		{ critic: { status: "failed", flagged: false, cause: "not_independent" } },
	),
	record(
		"06 critic fix with rounds left: one repair",
		base({ gates: { ...base().gates, criticEnabled: true } }),
		{ critic: { status: "ok", flagged: true, verdict: "fix", round: 1 } },
	),
	record(
		"07 critic fix with rounds exhausted: human review",
		base({ gates: { ...base().gates, criticEnabled: true } }),
		{ critic: { status: "ok", flagged: true, verdict: "fix", round: 3 } },
	),
	record(
		"08 scope gate: files outside owns go to review before the critic",
		base({
			gates: { ...base().gates, scopeOnFinish: true, criticEnabled: true },
		}),
		{
			scopeOutside: 3,
			critic: { status: "ok", flagged: false, verdict: "merge", round: 1 },
		},
	),
	record(
		"09 scope gate clean: scope check, critic, then merge",
		base({
			gates: { ...base().gates, scopeOnFinish: true, criticEnabled: true },
		}),
		{
			scopeOutside: 0,
			critic: { status: "ok", flagged: false, verdict: "merge", round: 1 },
		},
	),
	record(
		"10 human review gate: review, not merge",
		base({ gates: { ...base().gates, reviewGated: true } }),
	),
	record("11 verify crashed: infrastructure, back to ready, no stall", base(), {
		verify: { passed: false, crashed: true },
	}),
	record(
		"12 scope watchdog kill in a local worktree: reap, archive wip, block",
		base({ localWorktree: true }),
		{
			outcome: "killed_watchdog",
			killReason: "watchdog-scope",
			leftovers: false,
		},
	),
];

interface TraceEntry {
	row: string;
	step: string;
	args: Directive["args"] | null;
}
interface Trace {
	steps: TraceEntry[];
	terminal: { row: string; state: string; note: string | null };
}

/** Drive `next` like the StepRunner: run each directed step, fold its scripted result. */
function run(rec: Recorded): Trace {
	const done = new Set<StepName>(rec.ctx.done);
	let cur: FinalizeCtx = { ...rec.ctx, done };
	const steps: TraceEntry[] = [];
	for (let i = 0; i < 40; i++) {
		const d = next(cur);
		if (d.kind === "terminal") {
			return {
				steps,
				terminal: { row: d.row, state: d.state, note: d.note ?? null },
			};
		}
		steps.push({ row: d.row, step: d.step, args: d.args ?? null });
		done.add(d.step);
		const s = rec.script;
		if (d.step === "classify")
			cur = {
				...cur,
				outcome: s.outcome ?? "completed",
				...(s.killReason ? { killReason: s.killReason } : {}),
			};
		if (d.step === "reap_leftovers")
			cur = { ...cur, leftBackground: s.leftovers ?? false };
		if (d.step === "verify")
			cur = {
				...cur,
				verify: s.verify
					? { crashed: false, ...s.verify }
					: { passed: true, crashed: false },
			};
		if (d.step === "scope_check")
			cur = { ...cur, scope: { outside: s.scopeOutside ?? 0 } };
		if (d.step === "critic")
			cur = {
				...cur,
				critic: s.critic ?? { status: "ok", flagged: false },
			};
	}
	throw new Error(`runaway finalize trace for ${rec.name}`);
}

function serialize(): string {
	const out = CONTEXTS.map((rec) => ({
		name: rec.name,
		ctx: rec.ctx,
		script: rec.script,
		trace: run(rec),
	}));
	return `${JSON.stringify(out, null, "\t")}\n`;
}

describe("finalize golden traces (mechanical rows)", () => {
	test("twelve contexts are recorded", () => {
		expect(CONTEXTS).toHaveLength(12);
	});

	test("the traces are byte-identical to the recorded fixture", () => {
		const actual = serialize();
		if (process.env.UPDATE_GOLDEN === "1") writeFileSync(FIXTURE, actual);
		expect(actual).toBe(readFileSync(FIXTURE, "utf8"));
	});

	test("legacy prefix: identical to the 034befa traces up to the old policy row, then settle with the expected class", () => {
		const legacy = JSON.parse(readFileSync(LEGACY, "utf8")) as {
			name: string;
			trace: Trace;
		}[];
		expect(legacy).toHaveLength(CONTEXTS.length);
		for (const [i, rec] of CONTEXTS.entries()) {
			const old = legacy[i] as { name: string; trace: Trace };
			expect(old.name).toBe(rec.name);
			const now = run(rec);
			const k = old.trace.steps.findIndex(
				(e) => POLICY_STEPS.has(e.step) || POLICY_ROWS.has(e.row),
			);
			if (k === -1) {
				// A mechanical context: nothing about it may have moved.
				expect(now, rec.name).toEqual(old.trace);
				expect(EXPECTED_SETTLE[rec.name], rec.name).toBeUndefined();
				continue;
			}
			expect(now.steps.slice(0, k), rec.name).toEqual(
				old.trace.steps.slice(0, k),
			);
			const at = now.steps[k];
			expect(at?.step, rec.name).toBe("settle");
			expect(String(at?.args?.settle), rec.name).toBe(
				EXPECTED_SETTLE[rec.name] ?? "",
			);
		}
	});

	test("the fixture covers the success path rows it is meant to pin", () => {
		const rows = new Set<string>();
		for (const rec of CONTEXTS) {
			const t = run(rec);
			for (const s of t.steps) rows.add(s.row);
			rows.add(t.terminal.row);
		}
		for (const row of [
			"T0",
			"T12",
			"T12i",
			"T12s",
			"T13",
			"T14",
			"T14f",
			"T14r",
			"T14s",
			"T15",
			"T16",
			"T4s",
			"local-reap",
		]) {
			expect(rows.has(row), `row ${row}`).toBe(true);
		}
	});
});
