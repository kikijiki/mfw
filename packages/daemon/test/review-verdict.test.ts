import { describe, expect, test } from "bun:test";
import {
	DEFAULT_REVIEW_POLICY,
	floorVerdict,
	independenceProblem,
	isIndependent,
	parseAgentReview,
	pickIndependentReviewer,
} from "../src/review-verdict.ts";

const MET = { verdict: "met" as const, evidenceClass: "reproduced" as const };

function floor(over: Partial<Parameters<typeof floorVerdict>[0]>) {
	return floorVerdict({
		verdict: "merge",
		findings: [],
		criteria: [MET],
		criteriaComplete: true,
		fakeDone: false,
		scopeCreep: false,
		failedChecks: 0,
		...over,
	});
}

describe("floorVerdict", () => {
	test("never laxer than the facts, never overrides a stricter model", () => {
		expect(floor({}).verdict).toBe("merge");
		expect(
			floor({
				findings: [{ file: "a", severity: "blocker", change: "x" }],
			}),
		).toMatchObject({ verdict: "fix", modelVerdict: "merge" });
		// minor findings alone do not block
		expect(
			floor({ findings: [{ file: "a", severity: "minor", change: "x" }] })
				.verdict,
		).toBe("merge");
		expect(floor({ failedChecks: 1 }).verdict).toBe("fix");
		expect(floor({ scopeCreep: true }).verdict).toBe("fix");
		expect(floor({ criteriaComplete: false }).verdict).toBe("fix");
		expect(
			floor({ criteria: [{ verdict: "met", evidenceClass: "claimed" }] })
				.verdict,
		).toBe("fix");
		expect(floor({ criteria: [{ verdict: "uncertain" }] }).verdict).toBe("fix");
		expect(floor({ fakeDone: true }).verdict).toBe("reject");
		expect(floor({ verdict: "reject" })).toMatchObject({
			verdict: "reject",
			raisedBy: [],
		});
	});
});

describe("parseAgentReview", () => {
	const body = '```json\n{"summary":"ok","findings":[]}\n```';

	test("the first non-empty line is the verdict", () => {
		expect(parseAgentReview(`\nVERDICT: fix\n${body}`).verdict).toBe("fix");
		expect(parseAgentReview(`verdict: MERGE\n${body}`).verdict).toBe("merge");
	});

	test("prose before the verdict line, or no JSON block, is refused", () => {
		expect(() =>
			parseAgentReview(`I think it is fine.\nVERDICT: merge\n${body}`),
		).toThrow("first line");
		expect(() => parseAgentReview("VERDICT: merge\nall good")).toThrow(
			"fenced JSON",
		);
		expect(() => parseAgentReview(`VERDICT: ship\n${body}`)).toThrow(
			"first line",
		);
	});
});

describe("independence", () => {
	test("differs in model or harness; unknown worker is not independent", () => {
		const w = { harness: "claude-cli", model: "sonnet" };
		expect(isIndependent(w, { harness: "claude-cli", model: "Sonnet" })).toBe(
			false,
		);
		expect(isIndependent(w, { harness: "claude-cli", model: "opus" })).toBe(
			true,
		);
		expect(isIndependent(w, { harness: "codex-cli", model: "sonnet" })).toBe(
			true,
		);
		expect(
			isIndependent(
				{ harness: null, model: null },
				{ harness: "claude-cli", model: "opus" },
			),
		).toBe(false);
		expect(
			pickIndependentReviewer(w, "claude-cli", ["sonnet", "opus", "haiku"]),
		).toBe("opus");
		expect(pickIndependentReviewer(w, "claude-cli", ["sonnet"])).toBeNull();
	});

	test("settings check: only for assisted review with the switch on", () => {
		const base = {
			changeReview: "assisted" as const,
			policy: DEFAULT_REVIEW_POLICY,
			model: "sonnet",
			reviewModel: null,
			modelTiers: null,
			harness: "claude-cli",
		};
		expect(independenceProblem(base)).toContain("different tier");
		expect(independenceProblem({ ...base, changeReview: "off" })).toBeNull();
		expect(
			independenceProblem({
				...base,
				policy: { ...DEFAULT_REVIEW_POLICY, requireIndependent: false },
			}),
		).toBeNull();
		expect(independenceProblem({ ...base, reviewModel: "opus" })).toBeNull();
		expect(
			independenceProblem({
				...base,
				policy: { ...DEFAULT_REVIEW_POLICY, fallbackModels: ["opus"] },
			}),
		).toBeNull();
	});
});
