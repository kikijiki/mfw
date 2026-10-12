import { describe, expect, test } from "bun:test";

import {
	actionStateOf,
	applyFilters,
	BRAIN_OFF_HINT,
	type BrainDecision,
	type BrainTurn,
	brainGlyph,
	brainLine,
	brainNeedsMe,
	decisionTarget,
	escalationOf,
	groupByTurn,
	lineDiff,
	openEscalations,
	outcomeChip,
} from "./brain";

const NOW = Date.UTC(2026, 9, 12, 12);

function d(over: Partial<BrainDecision> = {}): BrainDecision {
	return {
		id: 1,
		ts: new Date(NOW - 60_000),
		role: "brain",
		taskId: null,
		subjectRunId: null,
		brainRunId: null,
		model: "opus",
		status: "ok",
		action: "spawn",
		reason: "because",
		input: {},
		output: { status: "applied" },
		durationMs: 0,
		usage: null,
		supersededBy: null,
		finishedAt: null,
		brainSessionId: "S",
		turnRunId: "T1",
		kind: "action",
		alternatives: null,
		confidence: "high",
		contextRefs: null,
		harness: null,
		outcome: null,
		overriddenBy: null,
		...over,
	} as BrainDecision;
}

describe("action state and outcome", () => {
	test("reads output.status, ignoring anything else", () => {
		expect(actionStateOf({ status: "proposed" })).toBe("proposed");
		expect(actionStateOf({ status: "weird" })).toBeNull();
		expect(actionStateOf(null)).toBeNull();
	});

	test("the chip says what became of it, shadow first", () => {
		expect(outcomeChip(d({ output: { status: "proposed" } })).label).toBe(
			"proposed",
		);
		expect(outcomeChip(d({ output: { status: "rejected" } }))).toEqual({
			label: "rejected",
			tone: "critical",
		});
		expect(outcomeChip(d({ overriddenBy: 9 })).label).toBe("overridden");
		expect(
			outcomeChip(d({ outcome: { final: "merged", firstPass: true } })).label,
		).toBe("merged first pass");
		expect(
			outcomeChip(d({ outcome: { final: "merged", repairs: 2 } })).label,
		).toBe("repaired ×2");
		expect(outcomeChip(d({ outcome: { final: "abandoned" } })).label).toBe(
			"abandoned",
		);
		expect(outcomeChip(d()).label).toBe("pending");
	});
});

describe("escalations", () => {
	const notify = (kind: string, over: Partial<BrainDecision> = {}) =>
		d({
			action: "notify_human",
			input: { kind, title: "Need a key", body: "for X", blocking: ["T-1"] },
			...over,
		});

	test("everything but fyi asks for a person, and a rejected call does not", () => {
		expect(escalationOf(notify("credential"))?.title).toBe("Need a key");
		expect(escalationOf(notify("credential"))?.blocking).toEqual(["T-1"]);
		expect(escalationOf(notify("fyi"))).toBeNull();
		expect(
			escalationOf(notify("credential", { output: { status: "rejected" } })),
		).toBeNull();
		expect(escalationOf(d())).toBeNull();
	});

	test("open escalations are recent, not overridden, newest first", () => {
		const rows = [
			notify("credential", { id: 1 }),
			notify("brain_stuck", { id: 5 }),
			notify("credential", { id: 3, overriddenBy: 4 }),
			notify("product_decision", {
				id: 2,
				ts: new Date(NOW - 9 * 86_400_000),
			}),
		];
		expect(openEscalations(rows, NOW).map((e) => e.decision.id)).toEqual([
			5, 1,
		]);
	});
});

describe("filters and grouping", () => {
	const rows = [
		d({ id: 1, turnRunId: "T1", confidence: "low" }),
		d({ id: 2, turnRunId: "T2", output: { status: "proposed" } }),
		d({ id: 3, turnRunId: "T2", output: { status: "rejected" } }),
	];
	test("filters combine with and", () => {
		expect(applyFilters(rows, []).length).toBe(3);
		expect(applyFilters(rows, ["low"]).map((r) => r.id)).toEqual([1]);
		expect(applyFilters(rows, ["proposed"]).map((r) => r.id)).toEqual([2]);
		expect(applyFilters(rows, ["low", "proposed"])).toEqual([]);
	});

	test("groups by turn, newest turn first, with turn metadata", () => {
		const turns = [{ runId: "T2", seq: 2 }] as BrainTurn[];
		const g = groupByTurn(rows, turns);
		expect(g.map((x) => [x.turnRunId, x.decisions.map((r) => r.id)])).toEqual([
			["T2", [3, 2]],
			["T1", [1]],
		]);
		expect(g[0]?.turn?.seq).toBe(2);
		expect(g[1]?.turn).toBeNull();
	});
});

describe("targets", () => {
	test("a run beats a task; a plan has none", () => {
		expect(decisionTarget(d({ input: { runId: "R1" }, taskId: "T-1" }))).toBe(
			"run:R1",
		);
		expect(decisionTarget(d({ taskId: "T-1" }))).toBe("task:T-1");
		expect(decisionTarget(d({ input: { id: "T-9" } }))).toBe("task:T-9");
		expect(decisionTarget(d({ kind: "plan" }))).toBeNull();
	});
});

describe("glyph and line", () => {
	test("off has no glyph and says how to turn it on", () => {
		const off = {
			enabled: false,
			state: "off" as const,
			failures: 0,
			error: null,
		};
		expect(brainGlyph(off)).toBeNull();
		expect(brainLine(off)).toBe(BRAIN_OFF_HINT);
		expect(BRAIN_OFF_HINT).toContain("brain.routes");
		expect(brainNeedsMe(off)).toBe(false);
	});

	test("failed is the one that needs a person", () => {
		const failed = {
			enabled: true,
			state: "failed" as const,
			failures: 3,
			error: "boom",
		};
		expect(brainGlyph(failed)).toBe("failed");
		expect(brainNeedsMe(failed)).toBe(true);
		expect(brainLine(failed)).toContain("3 failed turns");
		expect(brainNeedsMe({ enabled: true, state: "turn" })).toBe(false);
		expect(brainGlyph({ enabled: true, state: "turn" })).toBe("turn");
	});
});

describe("lineDiff", () => {
	test("marks added and removed lines", () => {
		const out = lineDiff("a\nb\nc", "a\nc\nd");
		expect(out).toEqual([
			{ kind: "same", text: "a" },
			{ kind: "del", text: "b" },
			{ kind: "same", text: "c" },
			{ kind: "add", text: "d" },
		]);
	});
});
