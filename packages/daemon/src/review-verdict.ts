import { z } from "zod";

/**
 * The review vocabulary: a closed verdict, structured findings, and the
 * deterministic floor that decides what a verdict is allowed to be.
 *
 * - `merge`: the change delivers the task; it may land.
 * - `fix`: the change is close; a repair run in the same worktree addresses
 *   the findings, then it is reviewed again (bounded by review rounds).
 * - `reject`: the approach is wrong or the work is faked; a human decides.
 *
 * The model proposes a verdict; `floorVerdict` raises it to at least what the
 * facts demand. A model may be stricter than the floor, never laxer.
 */

export const REVIEW_VERDICTS = ["merge", "fix", "reject"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const FINDING_SEVERITIES = ["blocker", "major", "minor", "nit"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FindingSchema = z.object({
	file: z.string().default(""),
	line: z.number().int().nonnegative().nullable().optional(),
	severity: z.enum(FINDING_SEVERITIES),
	/** What must change, concretely enough for a repair run to act on. */
	change: z.string().min(1),
});
export type ReviewFinding = z.infer<typeof FindingSchema>;

/** Reviewer modes: one-shot critic over the inlined diff, or a read-only agent in a checkout. */
export const REVIEW_MODES = ["critic", "agent"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

/** Why a review did not produce a usable verdict (the human-review cause). */
export type ReviewFailureCause =
	| "reviewer_not_independent"
	| "reviewer_modified_checkout";

const RANK: Record<ReviewVerdict, number> = { merge: 0, fix: 1, reject: 2 };

/** The stricter of two verdicts. */
export function stricter(a: ReviewVerdict, b: ReviewVerdict): ReviewVerdict {
	return RANK[a] >= RANK[b] ? a : b;
}

export interface FloorInput {
	/** What the reviewer said. */
	verdict: ReviewVerdict;
	findings: readonly ReviewFinding[];
	/** Per-criterion assessment, as the reviewer gave it. */
	criteria: readonly {
		verdict: "met" | "unmet" | "uncertain";
		evidenceClass?: "reproduced" | "source-confirmed" | "claimed";
	}[];
	/** Every expected criterion has an assessment. */
	criteriaComplete: boolean;
	fakeDone: boolean;
	scopeCreep: boolean;
	/** Mechanical checks that failed (none reach review today; kept as a floor). */
	failedChecks: number;
}

export interface FloorResult {
	verdict: ReviewVerdict;
	/** The model's own verdict, before the floor. */
	modelVerdict: ReviewVerdict;
	/** Why the floor raised the verdict; empty when it did not. */
	raisedBy: string[];
}

/**
 * Deterministic floor: fake work is `reject`; any blocker finding, failing
 * check, scope creep, or criterion not met on real evidence is at least `fix`.
 */
export function floorVerdict(input: FloorInput): FloorResult {
	const reasons: { floor: ReviewVerdict; why: string }[] = [];
	if (input.fakeDone)
		reasons.push({ floor: "reject", why: "the change fakes completion" });
	const blockers = input.findings.filter((f) => f.severity === "blocker");
	if (blockers.length > 0)
		reasons.push({
			floor: "fix",
			why: `${blockers.length} blocker finding(s)`,
		});
	if (input.failedChecks > 0)
		reasons.push({
			floor: "fix",
			why: `${input.failedChecks} failing check(s)`,
		});
	if (input.scopeCreep)
		reasons.push({ floor: "fix", why: "changes outside the task's scope" });
	if (!input.criteriaComplete)
		reasons.push({
			floor: "fix",
			why: "acceptance criteria were not assessed completely",
		});
	const notMet = input.criteria.filter(
		(c) => c.verdict !== "met" || c.evidenceClass === "claimed",
	);
	if (notMet.length > 0)
		reasons.push({
			floor: "fix",
			why: `${notMet.length} criterion/criteria not met on real evidence`,
		});
	let verdict = input.verdict;
	const raisedBy: string[] = [];
	for (const r of reasons) {
		if (RANK[r.floor] > RANK[input.verdict]) raisedBy.push(r.why);
		verdict = stricter(verdict, r.floor);
	}
	return { verdict, modelVerdict: input.verdict, raisedBy };
}

// ---------- agent reviewer output ----------

const VERDICT_LINE = /^\s*VERDICT:\s*(merge|fix|reject)\s*$/i;

export const AgentReviewBodySchema = z.object({
	summary: z.string().default(""),
	findings: z.array(FindingSchema).default([]),
	criteria: z
		.array(
			z.object({
				criterion: z.string().min(1),
				verdict: z.enum(["met", "unmet", "uncertain"]),
				evidenceClass: z.enum(["reproduced", "source-confirmed", "claimed"]),
				evidence: z.string().default(""),
			}),
		)
		.default([]),
	fakeDone: z.boolean().default(false),
	scopeCreep: z.boolean().default(false),
});
export type AgentReviewBody = z.infer<typeof AgentReviewBodySchema>;

/**
 * An agent reviewer's final message: the FIRST non-empty line is
 * `VERDICT: merge|fix|reject`, followed by one fenced JSON block (summary,
 * findings, criteria). The line is the machine contract; prose before it is
 * not accepted, so a reviewer cannot bury a verdict in narrative.
 */
export function parseAgentReview(text: string): {
	verdict: ReviewVerdict;
	body: AgentReviewBody;
} {
	const firstLine = text.split("\n").find((l) => l.trim() !== "") ?? "";
	const m = VERDICT_LINE.exec(firstLine);
	if (!m)
		throw new Error(
			"the first line must be exactly `VERDICT: merge|fix|reject`",
		);
	const verdict = (m[1] as string).toLowerCase() as ReviewVerdict;
	const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
	if (!fence) throw new Error("no fenced JSON block after the verdict line");
	const body = AgentReviewBodySchema.parse(JSON.parse(fence[1] as string));
	return { verdict, body };
}

// ---------- independence ----------

export interface ModelIdentity {
	/** Adapter / harness id (`claude-cli`, `codex-cli`, ...). */
	harness: string | null;
	model: string | null;
}

function norm(s: string | null): string {
	return (s ?? "").trim().toLowerCase();
}

/**
 * A reviewer is independent of the worker when it differs in model or in
 * harness. Unknown worker identity (no model recorded) is not independent:
 * fail closed.
 */
export function isIndependent(
	worker: ModelIdentity,
	reviewer: ModelIdentity,
): boolean {
	if (!worker.model || !reviewer.model) return false;
	return (
		norm(worker.model) !== norm(reviewer.model) ||
		norm(worker.harness) !== norm(reviewer.harness)
	);
}

/**
 * The reviewer model to use: the primary when independent, else the first
 * independent fallback, else null (the caller fails closed to a human with
 * cause `reviewer_not_independent`).
 */
export function pickIndependentReviewer(
	worker: ModelIdentity,
	reviewerHarness: string | null,
	candidates: readonly string[],
): string | null {
	for (const model of candidates) {
		if (isIndependent(worker, { harness: reviewerHarness, model }))
			return model;
	}
	return null;
}

/** Review policy as configured per project (`review` in config.json). */
export interface ReviewPolicy {
	mode: ReviewMode;
	requireIndependent: boolean;
	/** `fix` verdicts auto-repaired before a human decides. */
	maxRounds: number;
	/** Tried in order when the reviewer model equals the worker's. */
	fallbackModels: string[];
}

export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
	mode: "critic",
	requireIndependent: true,
	maxRounds: 2,
	fallbackModels: [],
};

/** Task label that opts one task into agent review. */
export const AGENT_REVIEW_LABEL = "review:agent";

/** A settings change refused because the reviewer would equal the worker. */
export class ReviewIndependenceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReviewIndependenceError";
	}
}

/**
 * Settings-time independence check for a project whose change review is
 * assisted: the reviewer model must differ from the worker model and from
 * every configured tier model (all share the project's harness). Returns
 * the refusal text with the fix, or null when the pair is acceptable.
 */
export function independenceProblem(input: {
	changeReview: "off" | "assisted" | "human";
	policy: ReviewPolicy;
	model: string;
	reviewModel: string | null;
	modelTiers: Partial<Record<string, string>> | null;
	harness: string;
}): string | null {
	if (input.changeReview !== "assisted" || !input.policy.requireIndependent)
		return null;
	const reviewer = input.reviewModel ?? input.model;
	const workers = [
		["model", input.model],
		...Object.entries(input.modelTiers ?? {}).map(([tier, m]) => [
			`modelTiers.${tier}`,
			m,
		]),
	].filter((pair): pair is [string, string] => typeof pair[1] === "string");
	// A clash is acceptable when a configured fallback covers it at runtime.
	const clash = workers.find(
		([, m]) =>
			pickIndependentReviewer(
				{ harness: input.harness, model: m },
				input.harness,
				[reviewer, ...input.policy.fallbackModels],
			) === null,
	);
	if (!clash) return null;
	return [
		`review.requireIndependent: the reviewer model '${reviewer}' is the same as the worker model (${clash[0]} = '${clash[1]}') on harness '${input.harness}'.`,
		"Set reviewModel to a model of a different tier (for example a stronger or a lighter one) or served by a different harness,",
		"or turn off review.requireIndependent.",
	].join(" ");
}
