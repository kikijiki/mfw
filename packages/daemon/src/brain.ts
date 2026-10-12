import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesOutsideOwns, writeFileAtomic } from "@mfw/board-core";
import type { ProjectDbHandle } from "@mfw/db/client";
import { appendEvent, type EventBus } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import {
	type DecisionRole,
	type DecisionStatus,
	decisions,
	type RunReasoningEffort,
	type RunState,
	reviewVerdicts,
} from "@mfw/db/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { ProviderConfig } from "./agents/adapter.ts";
import type {
	BrainCallCtx,
	BrainPort,
	CriticResult,
} from "./finalize/step-runner.ts";
import { affectedPaths, parseDiffPaths } from "./git-diff-paths.ts";
import type { Logger } from "./log.ts";
import type { DiagnoseCtx, DiagnoseResult } from "./maintenance.ts";
import { runProc } from "./proc.ts";
import {
	AGENT_REVIEW_LABEL,
	DEFAULT_REVIEW_POLICY,
	FindingSchema,
	floorVerdict,
	isIndependent,
	parseAgentReview,
	pickIndependentReviewer,
	REVIEW_VERDICTS,
	type ReviewFailureCause,
	type ReviewFinding,
	type ReviewMode,
	type ReviewPolicy,
	type ReviewVerdict,
	stricter,
} from "./review-verdict.ts";
import type { RunRegistry } from "./run-registry.ts";
import type { TaskService } from "./task-service.ts";

/**
 * Durable, stoppable, audited LLM decisions. Each is a registry run of kind
 * `brain` (run dir with `prompt.md` + `raw.log`, a `decisions` row, an
 * AbortController, a hard timeout).
 *
 * `BrainPort` methods never throw: every failure resolves `{ status: "failed" }`,
 * never a permissive payload. The machine's fail-closed transitions (T14, T24,
 * I5) turn that into a human gate.
 */

// --- Inference transport ---

export interface InferenceOpts {
	model: string;
	reasoningEffort?: RunReasoningEffort;
	/** Hard budget for THIS call. Transports must honour it. */
	timeoutMs: number;
	signal?: AbortSignal;
}

/** Token/cost counts for one call, in the run-usage vocabulary (`inputTokens`, `costUsd`, ...). */
export type InferenceUsage = Record<string, number>;

/** Model text plus whatever usage the transport could read. */
export interface InferenceReply {
	text: string;
	usage?: InferenceUsage;
}

/** One prompt in, raw model text (optionally with usage) out. Injectable so tests never touch a CLI. */
export interface InferenceClient {
	complete(
		prompt: string,
		opts: InferenceOpts,
	): Promise<string | InferenceReply>;
}

/** Usage from a `claude -p --output-format json` result envelope. */
export function claudeEnvelopeUsage(
	o: Record<string, unknown>,
): InferenceUsage {
	const u: InferenceUsage = {};
	const put = (key: string, v: unknown) => {
		if (typeof v === "number" && Number.isFinite(v)) u[key] = v;
	};
	const usage =
		typeof o.usage === "object" && o.usage !== null
			? (o.usage as Record<string, unknown>)
			: {};
	put("inputTokens", usage.input_tokens);
	put("outputTokens", usage.output_tokens);
	put("cachedInputTokens", usage.cache_read_input_tokens);
	put("cacheCreationInputTokens", usage.cache_creation_input_tokens);
	put("costUsd", o.total_cost_usd);
	put("turns", o.num_turns);
	return u;
}

/** Sum of two usage records, key by key. */
function addUsage(a: InferenceUsage, b: InferenceUsage): InferenceUsage {
	const out = { ...a };
	for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
	return out;
}

const CLI_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Headless `claude` CLI via `proc.ts` (budgeted, group-killed).
 *
 * Brain prompts are self-contained (the diff and facts are inlined), so the
 * model gets no tools, no MCP servers and no permission bypass, and runs in a
 * fresh empty directory that is removed afterwards: never the project root or
 * a run worktree, so it cannot read or write the code it is judging.
 */
export class ClaudeCliInference implements InferenceClient {
	constructor(private readonly opts: { bin?: string; tmpRoot?: string } = {}) {}

	async complete(prompt: string, opts: InferenceOpts): Promise<InferenceReply> {
		const cwd = await mkdtemp(
			join(this.opts.tmpRoot ?? tmpdir(), "mfw-brain-"),
		);
		try {
			return await this.run(prompt, opts, cwd);
		} finally {
			await rm(cwd, { recursive: true, force: true }).catch(() => {
				// best-effort: an empty temp dir left behind is harmless
			});
		}
	}

	private async run(
		prompt: string,
		opts: InferenceOpts,
		cwd: string,
	): Promise<InferenceReply> {
		const r = await runProc(
			[
				this.opts.bin ?? "claude",
				"-p",
				prompt,
				"--model",
				opts.model,
				"--output-format",
				"json",
				"--tools",
				"",
				"--strict-mcp-config",
				"--no-session-persistence",
			],
			{
				cwd,
				timeoutMs: opts.timeoutMs,
				maxOutputBytes: CLI_MAX_OUTPUT_BYTES,
				...(opts.signal ? { signal: opts.signal } : {}),
			},
		);
		if (r.timedOut) throw new Error("claude CLI timed out");
		if (opts.signal?.aborted) throw new Error("claude CLI aborted");
		if (r.exitCode !== 0) {
			throw new Error(
				`claude CLI failed (${r.exitCode ?? "signal"}): ${
					r.stderr.trim() || r.stdout.trim() || "no output"
				}`,
			);
		}
		try {
			const o = JSON.parse(r.stdout) as Record<string, unknown>;
			if (typeof o.result === "string") {
				const usage = claudeEnvelopeUsage(o);
				return Object.keys(usage).length > 0
					? { text: o.result, usage }
					: { text: o.result };
			}
		} catch {
			// best-effort: a non-JSON envelope is still usable raw text
		}
		return { text: r.stdout };
	}
}

/** Ephemeral Codex decision in a read-only sandbox (brain prompts only classify facts). */
export class CodexCliInference implements InferenceClient {
	constructor(private readonly opts: { cwd?: string; bin?: string } = {}) {}

	async complete(prompt: string, opts: InferenceOpts): Promise<string> {
		const reasoning = opts.reasoningEffort
			? ["-c", `model_reasoning_effort=${JSON.stringify(opts.reasoningEffort)}`]
			: [];
		const r = await runProc(
			[
				this.opts.bin ?? "codex",
				"exec",
				"--ephemeral",
				"--sandbox",
				"read-only",
				"--color",
				"never",
				"-m",
				opts.model,
				...reasoning,
				prompt,
			],
			{
				cwd: this.opts.cwd,
				timeoutMs: opts.timeoutMs,
				maxOutputBytes: CLI_MAX_OUTPUT_BYTES,
				...(opts.signal ? { signal: opts.signal } : {}),
			},
		);
		if (r.timedOut) throw new Error("codex CLI timed out");
		if (opts.signal?.aborted) throw new Error("codex CLI aborted");
		if (r.exitCode !== 0) {
			throw new Error(
				`codex CLI failed (${r.exitCode ?? "signal"}): ${
					r.stderr.trim() || r.stdout.trim() || "no output"
				}`,
			);
		}
		return r.stdout;
	}
}

/** Provider selection at the composition boundary. */
export function inferenceForProvider(
	provider: ProviderConfig,
	opts: { cwd?: string } = {},
): InferenceClient {
	switch (provider.type) {
		case "claude-cli":
			// Deliberately not `opts.cwd`: Claude brain calls run in a fresh temp dir.
			return new ClaudeCliInference();
		case "codex-cli":
			return new CodexCliInference(opts);
		default:
			// Deferred to call time so enabled:false stays a no-op.
			return {
				complete: async () => {
					throw new Error(
						`provider '${provider.id}' has no non-interactive brain transport`,
					);
				},
			};
	}
}

// --- Prompt inputs ---

export type DecisionPoint = "critic";

export const BRAIN_DEFAULT_TIMEOUT_MS = 120_000;

/** Max bytes of patch text fed per point (§6.3). */
export const DIFF_CAP_BYTES: Record<DecisionPoint, number> = {
	critic: 32 * 1024,
};
const REPORT_CAP_BYTES = 1024;
const STAT_CAP_BYTES = 4 * 1024;
const COMMITS_CAP_BYTES = 4 * 1024;
const DOD_CAP_BYTES = 2 * 1024;

/** Git facts a decision needs. Injectable so tests need no repo. */
export interface DiffFacts {
	patch: string;
	stat: string;
	commits: string;
	/** Paths the run changed; how the critic sees edits outside `owns`. */
	files: string[];
}

export interface DiffSource {
	collect(ctx: BrainCallCtx, point: DecisionPoint): Promise<DiffFacts>;
}

const EMPTY_FACTS: DiffFacts = { patch: "", stat: "", commits: "", files: [] };

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BYTES = 8 * 1024 * 1024;

/** Real git in the subject run's worktree. Missing worktree/baseSha yields empty facts. */
export class GitDiffSource implements DiffSource {
	async collect(ctx: BrainCallCtx): Promise<DiffFacts> {
		const cwd = ctx.worktreePath;
		if (!cwd || !ctx.baseSha) return EMPTY_FACTS;
		const range = `${ctx.baseSha}..HEAD`;
		const [patch, stat, commits, names] = await Promise.all([
			this.git(["diff", range], cwd),
			this.git(["diff", "--stat", range], cwd),
			this.git(["log", "--oneline", "--no-decorate", range], cwd),
			this.git(["diff", "--name-status", "-z", "-M", range], cwd),
		]);
		const files = affectedPaths(parseDiffPaths(names));
		return { patch, stat, commits, files };
	}

	private async git(args: string[], cwd: string): Promise<string> {
		const r = await runProc(["git", ...args], {
			cwd,
			timeoutMs: GIT_TIMEOUT_MS,
			maxOutputBytes: GIT_MAX_BYTES,
		});
		return r.exitCode === 0 ? r.stdout : "";
	}
}

/** Over budget, a patch degrades to `--stat` + the first N bytes (§6.3). */
export function capDiff(facts: DiffFacts, cap: number): string {
	const patch = facts.patch;
	if (!patch.trim()) return "(empty)";
	if (patch.length <= cap) return patch;
	return [
		`(diff is ${patch.length} bytes, truncated to ${cap}; summary first)`,
		facts.stat.slice(0, STAT_CAP_BYTES) || "(no stat)",
		"--- first bytes of the patch ---",
		patch.slice(0, cap),
		"…(truncated)",
	].join("\n");
}

interface SubjectFacts {
	taskId: string;
	title: string;
	body: string;
	criteria: string[];
	attempt: number;
	outcome: string;
	dodSummary: string;
	failedChecks: string;
	report: string;
	/** The task's declared scope; empty means unconstrained. */
	owns: string[];
	/** Changed files no `owns` pattern covers (empty when `owns` is). */
	outsideOwns: string[];
	/** Model the subject run used, when known. */
	implementerModel: string | null;
}

function summarizeVerify(ctx: BrainCallCtx): {
	dodSummary: string;
	failedChecks: string;
} {
	const checks = ctx.verify?.checks ?? [];
	const dodSummary = checks
		.map((c) => `- ${c.ok ? "PASS" : "FAIL"} ${c.check}`)
		.join("\n")
		.slice(0, DOD_CAP_BYTES);
	const failedChecks = checks
		.filter((c) => !c.ok)
		.map(
			(c) =>
				// `c.detail` is already the tail of the output (verifier's `lastLines`);
				// keep its tail, not its head, so the actual failure survives the cap.
				`- [${c.classification ?? "other"}] ${c.check}: ${
					c.detail?.slice(-400) ?? ""
				}`,
		)
		.join("\n");
	return { dodSummary, failedChecks };
}

function reportText(report: unknown): string {
	if (report == null) return "";
	const text =
		typeof report === "string" ? report : JSON.stringify(report, null, "\t");
	return text.slice(0, REPORT_CAP_BYTES);
}

export function buildCriticPrompt(
	s: SubjectFacts,
	diff: string,
	commits: string,
): string {
	return [
		"You are the semantic acceptance reviewer for an autonomous coding orchestrator.",
		"Mechanical checks have already run. Decide whether the committed DIFF actually",
		"delivers the task goal and each acceptance criterion. Be skeptical: a diff that",
		"only edits tests/docs to make checks pass without real implementation is fakeDone;",
		"unrelated sprawling changes are scopeCreep. Missing evidence is uncertain, never met.",
		"",
		"Give every criterion an evidenceClass saying where your evidence comes from:",
		"- reproduced: a mechanical verification result or command output below shows it.",
		"- source-confirmed: you can see it in the DIFF itself.",
		"- claimed: only the agent's report or commit messages say so, or nothing does.",
		"A criterion met only by claimed evidence does not count as met.",
		"",
		`Task: ${s.taskId} - ${s.title}`,
		"",
		"TASK GOAL:",
		s.body || s.title,
		"",
		"ACCEPTANCE CRITERIA:",
		...acceptanceCriteria(s).map((criterion) => `- ${criterion}`),
		...scopeSection(s),
		...(commits
			? ["", "COMMIT MESSAGES:", commits.slice(0, COMMITS_CAP_BYTES)]
			: []),
		...(s.dodSummary
			? ["", "MECHANICAL VERIFICATION RESULTS:", s.dodSummary]
			: []),
		"",
		"DIFF:",
		diff,
		"",
		...VERDICT_RULES,
		"",
		'Respond with ONLY JSON: { "verdict": "merge|fix|reject", "accepted": true, "criteria": [{ "criterion": "exact criterion text", "verdict": "met|unmet|uncertain", "evidenceClass": "reproduced|source-confirmed|claimed", "evidence": "short concrete evidence" }], "findings": [{ "file": "path/in/repo", "line": 12, "severity": "blocker|major|minor|nit", "change": "what must change" }], "fakeDone": false, "scopeCreep": false, "concerns": ["…"] }',
	].join("\n");
}

/** Shared by both reviewer modes: what each verdict means. */
const VERDICT_RULES = [
	"VERDICT (one of):",
	"- merge: the change delivers the goal and every criterion; it can land as is.",
	"- fix: close, but specific changes are needed; list each one as a finding.",
	"  A repair run receives your findings and the change is reviewed again.",
	"- reject: the approach is wrong or the work is faked; a human decides.",
	"Findings: severity blocker = must change before merge; major = should;",
	"minor/nit = optional. A blocker finding means your verdict cannot be merge.",
];

/**
 * The agent reviewer's brief. It works in a read-only checkout of the
 * candidate (HEAD) and may read files and run commands, but any edit
 * discards its review.
 */
export function buildAgentReviewPrompt(
	s: SubjectFacts,
	baseSha: string | null,
	stat: string,
	commits: string,
): string {
	return [
		"You are the code reviewer for an autonomous coding orchestrator.",
		"Your working directory is a checkout of the candidate change at HEAD.",
		baseSha
			? `The change is \`git diff ${baseSha}..HEAD\`; its base is ${baseSha}.`
			: "Inspect the most recent commits for the change.",
		"Mechanical checks have already run. Judge correctness, fit with the",
		"surrounding architecture, scope against the declared paths, and whether",
		"every acceptance criterion is really met. Where it is cheap, prove a",
		"criterion by running a focused test or command.",
		"",
		"Do NOT modify anything: no edits, no new files, no commits, no checkouts.",
		"This checkout and the run's branch are verified after you finish, and any",
		"change discards your review.",
		"",
		`Task: ${s.taskId} - ${s.title}`,
		"",
		"TASK GOAL:",
		s.body || s.title,
		"",
		"ACCEPTANCE CRITERIA:",
		...acceptanceCriteria(s).map((criterion) => `- ${criterion}`),
		...scopeSection(s),
		...(commits
			? ["", "COMMIT MESSAGES:", commits.slice(0, COMMITS_CAP_BYTES)]
			: []),
		...(stat ? ["", "DIFF STAT:", stat.slice(0, STAT_CAP_BYTES)] : []),
		...(s.dodSummary
			? ["", "MECHANICAL VERIFICATION RESULTS:", s.dodSummary]
			: []),
		"",
		...VERDICT_RULES,
		"",
		"Give every criterion an evidenceClass: reproduced (you ran something that",
		"shows it), source-confirmed (you read it in the code), or claimed (only",
		"the agent says so). Claimed does not count as met.",
		"",
		"OUTPUT CONTRACT. Your final message must start with exactly one line:",
		"VERDICT: merge|fix|reject",
		"followed by one fenced ```json block:",
		'{ "summary": "…", "findings": [{ "file": "path/in/repo", "line": 12, "severity": "blocker|major|minor|nit", "change": "what must change" }], "criteria": [{ "criterion": "exact criterion text", "verdict": "met|unmet|uncertain", "evidenceClass": "reproduced|source-confirmed|claimed", "evidence": "…" }], "fakeDone": false, "scopeCreep": false }',
	].join("\n");
}

/** Declared scope and the files that escaped it; nothing for a task without `owns`. */
function scopeSection(s: SubjectFacts): string[] {
	if (s.owns.length === 0) return [];
	return [
		"",
		"DECLARED SCOPE (owns):",
		...s.owns.map((pattern) => `- ${pattern}`),
		...(s.outsideOwns.length > 0
			? [
					"",
					"CHANGED OUTSIDE THE DECLARED SCOPE:",
					...s.outsideOwns.map((file) => `- ${file}`),
					"Editing outside the declared scope is scopeCreep, unless the change is a",
					"necessary, minimal consequence of the task; then say so in concerns.",
				]
			: []),
	];
}

const LEGACY_ACCEPTANCE =
	"Deliver the task goal described above (legacy implicit criterion).";

function acceptanceCriteria(subject: SubjectFacts): string[] {
	return subject.criteria.length > 0 ? subject.criteria : [LEGACY_ACCEPTANCE];
}

/**
 * Only for sweep failures the deterministic classifiers (signal death,
 * green-sha corroboration) cannot place: a check that passed at the last green
 * commit, where a flaky check would look identical to a regression.
 */
export function buildDiagnosePrompt(ctx: DiagnoseCtx): string {
	const outputCap = 16 * 1024;
	const outputTail =
		ctx.outputTail.length <= outputCap
			? ctx.outputTail
			: `(earlier output truncated; showing final ${outputCap} bytes)\n${ctx.outputTail.slice(-outputCap)}`;
	return [
		"You are diagnosing a failed check for an autonomous orchestrator.",
		"A deterministic classifier could not place this failure on its own:",
		"it is not a signal death, and a re-run at the last known-green commit",
		"did not corroborate it as an infrastructure problem. Decide what kind",
		"of failure this actually is.",
		"",
		`Check: ${ctx.check}`,
		`Exit code: ${ctx.exitCode ?? "(unknown)"}`,
		`Environment: ${ctx.environment}`,
		`Same check at the last known-green commit: ${
			ctx.passesAtGreenSha === null
				? "(no green baseline to compare against)"
				: ctx.passesAtGreenSha
					? "passes"
					: "also fails"
		}`,
		...(ctx.taskId ? ["", `Task: ${ctx.taskId}`] : []),
		"",
		"Output tail:",
		outputTail || "(empty)",
		"",
		"Choose:",
		"- regression: a real bug in the code under test",
		"- environment: caused by the environment this check ran in (sandboxing,",
		"  a missing tool, network access), not by the code",
		"- flaky: the check is non-deterministic and this particular failure",
		"  does not reflect the code's real state",
		"",
		'Respond with ONLY JSON: { "verdict": "regression|environment|flaky", "reason": "…" }',
	].join("\n");
}

// --- Validation (zod at the boundary, one feedback retry) ---

/** First JSON object/array in a possibly-fenced, possibly-chatty blob. */
export function extractJson(text: string): unknown {
	const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
	const candidate = fence ? (fence[1] as string) : text;
	try {
		return JSON.parse(candidate.trim());
	} catch {
		const m = /[[{][\s\S]*[\]}]/.exec(candidate);
		if (m) return JSON.parse(m[0]);
		throw new Error("no JSON found in model output");
	}
}

export const EVIDENCE_CLASSES = [
	"reproduced",
	"source-confirmed",
	"claimed",
] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

const CriticSchema = z.object({
	accepted: z.boolean(),
	criteria: z.array(
		z.object({
			criterion: z.string().min(1),
			verdict: z.enum(["met", "unmet", "uncertain"]),
			// Required, so an answer without it takes the feedback retry.
			evidenceClass: z.enum(EVIDENCE_CLASSES),
			evidence: z.string().default(""),
		}),
	),
	fakeDone: z.boolean().default(false),
	scopeCreep: z.boolean().default(false),
	concerns: z.array(z.string()).default([]),
	/** Optional for older prompts: derived from `accepted` when absent. */
	verdict: z.enum(REVIEW_VERDICTS).optional(),
	findings: z.array(FindingSchema).default([]),
});

const DIAGNOSE_VERDICTS = ["regression", "environment", "flaky"] as const;

const DiagnoseSchema = z.object({
	verdict: z.enum(DIAGNOSE_VERDICTS),
	reason: z.string().default(""),
});

function zodMessage(e: unknown): string {
	if (e instanceof z.ZodError) {
		return e.issues
			.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
			.join("; ");
	}
	return e instanceof Error ? e.message : String(e);
}

// --- Service ---

export interface BrainCounters {
	calls: number;
	failures: number;
	timeouts: number;
	p95Ms: number;
}

export interface BrainServiceDeps {
	registry: RunRegistry;
	handle: ProjectDbHandle;
	bus: EventBus;
	inference: InferenceClient;
	log: Logger;
	model: string;
	/** Model for the critic (semantic change review); unset = `model`. */
	reviewModel?: string;
	providerId: string;
	reasoningEffort: RunReasoningEffort;
	/** Project gate for this explicit assisted decision point. */
	enabled: boolean;
	/** Hard budget per decision, §6.3 default 120 s. */
	timeoutMs?: number;
	/** Where brain runs are rooted when the subject has no worktree. */
	projectRoot?: string;
	diffs?: DiffSource;
	/** Task title/stall count for prompt context; a missing board only degrades the prompt. */
	tasks?: TaskService;
	/** Review mode, independence and fallbacks; absent = `DEFAULT_REVIEW_POLICY`. */
	review?: ReviewPolicy;
	/**
	 * Transport for agent review of one subject (a read-only reviewer in its
	 * own checkout). Absent, or null for this subject (the current harness
	 * has no agent transport) = the critic reviews.
	 */
	agentReview?: (subject: {
		branch: string;
		runWorktree: string | null;
	}) => InferenceClient | null;
	/** Budget for one agent review (it reads code and may run tests). */
	agentReviewTimeoutMs?: number;
}

/** Default budget for an agent review. */
export const AGENT_REVIEW_DEFAULT_TIMEOUT_MS = 15 * 60_000;

/** One reviewer's assessment, before the floor, in either mode. */
interface ReviewAssessment {
	modelVerdict: ReviewVerdict;
	findings: ReviewFinding[];
	criteria: NonNullable<CriticResult["criteria"]>;
	fakeDone: boolean;
	scopeCreep: boolean;
	concerns: string[];
}

/** Terminal registry state + outcome per decision status (§2.4 row B0). */
const RUN_TERMINAL: Record<
	Exclude<DecisionStatus, "running">,
	{
		state: RunState;
		outcome: "completed" | "killed_watchdog" | "killed_manual";
	}
> = {
	ok: { state: "completed", outcome: "completed" },
	failed: { state: "failed", outcome: "completed" },
	timeout: { state: "killed", outcome: "killed_watchdog" },
	aborted: { state: "interrupted", outcome: "killed_manual" },
};

interface Inflight {
	/** Model this decision was sent to. */
	model: string;
	inference: InferenceClient;
	controller: AbortController;
	decisionId: number;
	runId: string;
	timedOut: boolean;
	stopped: boolean;
	/** Summed over every attempt; settled into the decision and the brain run. */
	usage: InferenceUsage;
}

interface Outcome<R> {
	status: DecisionStatus;
	reason: string;
	value?: R;
	decisionId?: number;
	brainRunId?: string;
	cause?: ReviewFailureCause;
}

/** Per-decision overrides of the spine's defaults. */
interface DecisionOpts {
	/** Overrides the brain's model for this decision point. */
	model?: string;
	/** Overrides the brain's transport (agent review). */
	inference?: InferenceClient;
	timeoutMs?: number;
	/** Default: first try + one feedback retry. */
	maxAttempts?: number;
	/** Hand `parse` the raw model text instead of its extracted JSON. */
	rawText?: boolean;
}

const DISABLED_REASON = "brain disabled for this project";
const MAX_ATTEMPTS = 2; // first try + ONE feedback retry
const RAW_LOG_CAP = 256 * 1024;
const P95_WINDOW = 200;

export class BrainService implements BrainPort {
	/** Mutable: toggled live via `setEnabled`. */
	enabled: boolean;
	private readonly deps: BrainServiceDeps;
	private readonly log: Logger;
	private readonly timeoutMs: number;
	private readonly diffs: DiffSource;
	private readonly byRun = new Map<string, Inflight>();
	private readonly byDecision = new Map<number, Inflight>();
	private samples: number[] = [];
	private calls = 0;
	private failures = 0;
	private timeouts = 0;

	constructor(deps: BrainServiceDeps) {
		this.deps = deps;
		this.enabled = deps.enabled;
		this.log = deps.log.child({ svc: "brain" });
		this.timeoutMs = deps.timeoutMs ?? BRAIN_DEFAULT_TIMEOUT_MS;
		this.diffs = deps.diffs ?? new GitDiffSource();
	}

	/** In-flight calls are left alone; the gate applies to the next `decide`. */
	setEnabled(on: boolean): void {
		this.enabled = on;
	}

	// ---------- BrainPort ----------

	/**
	 * Change review in either mode. Independence is decided before any model
	 * is called: a reviewer equal to the worker (same model on the same
	 * harness) is replaced by the first independent fallback, else the review
	 * fails closed with cause `reviewer_not_independent`. A usable verdict is
	 * floored (`floorVerdict`) and recorded in `review_verdicts`.
	 */
	async critic(ctx: BrainCallCtx): Promise<CriticResult> {
		const policy = this.deps.review ?? DEFAULT_REVIEW_POLICY;
		const subjectRun = await this.deps.registry
			.get(ctx.runId)
			.catch(() => null);
		const task = ctx.taskId
			? await Promise.resolve(this.deps.tasks?.get(ctx.taskId)).catch(
					() => null,
				)
			: null;
		const round = (task?.reviewRound ?? 0) + 1;
		const wantsAgent =
			policy.mode === "agent" ||
			(task?.labels ?? []).includes(AGENT_REVIEW_LABEL);
		const agentInference =
			wantsAgent && ctx.branch
				? (this.deps.agentReview?.({
						branch: ctx.branch,
						runWorktree: ctx.worktreePath,
					}) ?? null)
				: null;
		const mode: ReviewMode = agentInference ? "agent" : "critic";
		if (wantsAgent && mode !== "agent") {
			this.log.warn(
				{ runId: ctx.runId, taskId: ctx.taskId },
				"agent review unavailable for this run; the critic reviews instead",
			);
		}

		const reviewerHarness = this.deps.providerId;
		const worker = {
			harness: subjectRun?.harness ?? subjectRun?.providerId ?? null,
			model: subjectRun?.model ?? null,
		};
		const primary = this.deps.reviewModel ?? this.deps.model;
		const candidates = [primary, ...policy.fallbackModels];
		const reviewerModel = policy.requireIndependent
			? pickIndependentReviewer(worker, reviewerHarness, candidates)
			: primary;
		if (reviewerModel === null) {
			return {
				status: "failed",
				mode,
				cause: "reviewer_not_independent",
				reason: `reviewer not independent: the work was done by ${worker.model ?? "an unknown model"} on ${worker.harness ?? "an unknown harness"}, and no reviewer candidate (${candidates.join(", ")}) on ${reviewerHarness} differs from it`,
			};
		}
		const independent = isIndependent(worker, {
			harness: reviewerHarness,
			model: reviewerModel,
		});
		const failedChecks = (ctx.verify?.checks ?? []).filter((c) => !c.ok).length;

		const finish = (a: ReviewAssessment, subject: SubjectFacts) => {
			const expected = acceptanceCriteria(subject);
			const covered = new Set(a.criteria.map((item) => item.criterion));
			const complete = expected.every((criterion) => covered.has(criterion));
			// The agent's word alone is not evidence: met + claimed counts as not met.
			const onlyClaimed = a.criteria.filter(
				(item) => item.verdict === "met" && item.evidenceClass === "claimed",
			);
			const floor = floorVerdict({
				verdict: a.modelVerdict,
				findings: a.findings,
				criteria: a.criteria,
				criteriaComplete: complete,
				fakeDone: a.fakeDone,
				scopeCreep: a.scopeCreep,
				failedChecks,
			});
			const accepted = floor.verdict === "merge";
			const flagged = !accepted;
			const concerns = [
				...a.concerns,
				...onlyClaimed.map((item) => {
					const n = expected.indexOf(item.criterion);
					const label = n >= 0 ? `criterion ${n + 1}` : `"${item.criterion}"`;
					return `${label} is met only on the agent's word`;
				}),
				...(complete
					? []
					: ["acceptance criteria were not assessed completely"]),
				...(floor.raisedBy.length > 0
					? [
							`verdict raised from ${floor.modelVerdict} to ${floor.verdict}: ${floor.raisedBy.join(", ")}`,
						]
					: []),
			];
			return {
				action: flagged ? "flagged" : "accepted",
				reason: concerns.join("; "),
				output: {
					criteria: a.criteria,
					findings: a.findings,
					fakeDone: a.fakeDone,
					scopeCreep: a.scopeCreep,
					verdict: floor.verdict,
					modelVerdict: floor.modelVerdict,
					floorReasons: floor.raisedBy,
					mode,
					round,
					accepted,
					flagged,
					concerns,
					implementerModel: subject.implementerModel,
					reviewerModel,
					reviewerHarness,
					sameModel: subject.implementerModel === reviewerModel,
					independent,
				},
				value: {
					flagged,
					accepted,
					criteria: a.criteria,
					verdict: floor.verdict,
					modelVerdict: floor.modelVerdict,
					findings: a.findings,
				},
			};
		};

		const r = agentInference
			? await this.decide("critic", ctx, {
					role: "critic",
					model: reviewerModel,
					inference: agentInference,
					timeoutMs:
						this.deps.agentReviewTimeoutMs ?? AGENT_REVIEW_DEFAULT_TIMEOUT_MS,
					// One agent run is expensive; a broken contract goes to a human.
					maxAttempts: 1,
					rawText: true,
					build: (s, f) =>
						buildAgentReviewPrompt(s, ctx.baseSha, f.stat, f.commits),
					parse: (text, subject) => {
						const { verdict, body } = parseAgentReview(String(text));
						return finish(
							{
								modelVerdict: verdict,
								findings: body.findings,
								criteria: body.criteria,
								fakeDone: body.fakeDone,
								scopeCreep: body.scopeCreep,
								concerns: body.summary ? [body.summary] : [],
							},
							subject,
						);
					},
				})
			: await this.decide("critic", ctx, {
					role: "critic",
					model: reviewerModel,
					build: (s, f) =>
						buildCriticPrompt(s, capDiff(f, DIFF_CAP_BYTES.critic), f.commits),
					parse: (raw, subject) => {
						const c = CriticSchema.parse(raw);
						const said: ReviewVerdict =
							c.verdict ?? (c.accepted ? "merge" : "fix");
						return finish(
							{
								// `accepted: false` with `verdict: merge` is not a merge.
								modelVerdict: c.accepted ? said : stricter(said, "fix"),
								findings: c.findings,
								criteria: c.criteria,
								fakeDone: c.fakeDone,
								scopeCreep: c.scopeCreep,
								concerns: c.concerns,
							},
							subject,
						);
					},
				});

		if (r.status !== "ok" || !r.value) {
			return {
				status: "failed",
				mode,
				reason: r.reason,
				...(r.cause ? { cause: r.cause } : {}),
			};
		}
		const v = r.value;
		await this.recordVerdict({
			taskId: ctx.taskId,
			subjectRunId: ctx.runId,
			reviewerRunId: r.brainRunId ?? null,
			decisionId: r.decisionId ?? null,
			mode,
			reviewerHarness,
			reviewerModel,
			round,
			verdict: v.verdict,
			findings: v.findings,
			criteria: v.criteria,
			independent,
		}).catch((e) => {
			this.log.warn(
				{ runId: ctx.runId, err: String(e) },
				"could not record the review verdict",
			);
		});
		return {
			status: "ok",
			flagged: v.flagged,
			accepted: v.accepted,
			criteria: v.criteria,
			reason: r.reason,
			verdict: v.verdict,
			modelVerdict: v.modelVerdict,
			findings: v.findings,
			mode,
			round,
			reviewer: { harness: reviewerHarness, model: reviewerModel },
			independent,
		};
	}

	private async recordVerdict(
		row: Omit<typeof reviewVerdicts.$inferInsert, "id" | "createdAt">,
	): Promise<void> {
		await this.deps.handle.db
			.insert(reviewVerdicts)
			.values({ ...row, id: ulid(), createdAt: new Date() });
	}

	/**
	 * Not part of `BrainPort`; only `Maintenance.regressionSweep` calls it (via
	 * `DiagnosePort`). No diff to gather and no subject run.
	 */
	async diagnose(ctx: DiagnoseCtx): Promise<DiagnoseResult> {
		const r = await this.runDecision<{
			verdict: NonNullable<DiagnoseResult["verdict"]>;
		}>(
			"diagnose",
			"diagnose",
			{ taskId: ctx.taskId, subjectRunId: null },
			async () => ({
				prompt: buildDiagnosePrompt(ctx),
				cwd: this.deps.projectRoot ?? process.cwd(),
				attachTaskId: ctx.taskId !== null,
				extraInput: { check: ctx.check },
			}),
			(raw) => {
				const d = DiagnoseSchema.parse(raw);
				return {
					action: d.verdict,
					reason: d.reason,
					output: { ...d },
					value: { verdict: d.verdict },
				};
			},
		);
		return r.status === "ok" && r.value
			? { status: "ok", verdict: r.value.verdict, reason: r.reason }
			: { status: "failed", reason: r.reason };
	}

	// ---------- control surface ----------

	/**
	 * Aborts the in-flight call for a decision id or brain run id (unwinds as
	 * `aborted`). With nothing in flight, parks a stranded `running` row.
	 */
	async stop(ref: string | number): Promise<boolean> {
		const entry =
			typeof ref === "number" ? this.byDecision.get(ref) : this.byRun.get(ref);
		if (entry) {
			entry.stopped = true;
			entry.controller.abort();
			return true;
		}
		const where =
			typeof ref === "number"
				? eq(decisions.id, ref)
				: eq(decisions.brainRunId, ref);
		const rows = await this.deps.handle.db
			.update(decisions)
			.set({ status: "aborted", finishedAt: new Date() })
			.where(and(where, eq(decisions.status, "running")))
			.returning({ id: decisions.id });
		return rows.length > 0;
	}

	/** A re-asked decision points at its replacement (§6.2 reconcile). */
	async markSuperseded(decisionId: number, bySeq: number): Promise<void> {
		await this.deps.handle.db
			.update(decisions)
			.set({ supersededBy: bySeq })
			.where(eq(decisions.id, decisionId));
	}

	/** Boot reconcile: mark `running` rows left by a dead daemon as aborted; finalize re-asks. */
	async reconcileOrphans(): Promise<number> {
		const rows = await this.deps.handle.db
			.update(decisions)
			.set({ status: "aborted", finishedAt: new Date() })
			.where(eq(decisions.status, "running"))
			.returning({ id: decisions.id });
		if (rows.length > 0) {
			this.log.warn(
				{ count: rows.length },
				"aborted orphaned decisions from a previous boot",
			);
		}
		return rows.length;
	}

	/** Health surface (§6.2): brain.calls / brain.failures / brain.p95_ms. */
	counters(): BrainCounters {
		const sorted = [...this.samples].sort((a, b) => a - b);
		const p95Ms =
			sorted.length === 0
				? 0
				: (sorted[
						Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
					] ?? 0);
		return {
			calls: this.calls,
			failures: this.failures,
			timeouts: this.timeouts,
			p95Ms,
		};
	}

	// ---------- the execution path (§6.2) ----------

	/** Gathers subject facts, builds the prompt, then runs the shared spine. */
	private async decide<R>(
		point: DecisionPoint,
		ctx: BrainCallCtx,
		spec: {
			role: DecisionRole;
			build: (s: SubjectFacts, f: DiffFacts) => string;
			parse: (
				raw: unknown,
				subject: SubjectFacts,
			) => {
				action: string;
				reason: string;
				output: Record<string, unknown>;
				value: R;
			};
		} & DecisionOpts,
	): Promise<Outcome<R>> {
		return this.runDecision<R>(
			point,
			spec.role,
			{ taskId: ctx.taskId, subjectRunId: ctx.runId },
			async () => {
				const { facts, subject } = await this.gather(ctx, point);
				return {
					prompt: spec.build(subject, facts),
					cwd: ctx.worktreePath ?? this.deps.projectRoot ?? process.cwd(),
					attachTaskId: subject.exists,
					extraInput: { diffChars: facts.patch.length },
					parseContext: subject,
				};
			},
			(raw, context) => spec.parse(raw, context as SubjectFacts),
			spec,
		);
	}

	/**
	 * Shared spine (§6.2): registry run, `decisions` row, one feedback retry,
	 * timeout race, fail-closed settlement on every exit path. Prompt
	 * construction is `prepare()`'s job.
	 */
	private async runDecision<R>(
		point: string,
		role: DecisionRole,
		linkage: { taskId: string | null; subjectRunId: string | null },
		prepare: () => Promise<{
			prompt: string;
			cwd: string;
			attachTaskId: boolean;
			extraInput?: Record<string, unknown>;
			parseContext?: unknown;
		}>,
		parse: (
			raw: unknown,
			context?: unknown,
		) => {
			action: string;
			reason: string;
			output: Record<string, unknown>;
			value: R;
		},
		opts: DecisionOpts = {},
	): Promise<Outcome<R>> {
		const model = opts.model ?? this.deps.model;
		const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
		const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
		// Disabled: record nothing, return a non-permissive status.
		if (!this.enabled) return { status: "failed", reason: DISABLED_REASON };

		const startedAt = Date.now();
		this.calls++;
		let entry: Inflight | null = null;
		let timer: ReturnType<typeof setTimeout> | null = null;

		try {
			const {
				prompt: basePrompt,
				cwd,
				attachTaskId,
				extraInput,
				parseContext,
			} = await prepare();

			const run = await this.deps.registry.create({
				kind: "brain",
				label: `${point}:${linkage.subjectRunId ?? linkage.taskId ?? point}`,
				model,
				providerId: this.deps.providerId,
				reasoningEffort: this.deps.reasoningEffort,
				cwd,
				...(attachTaskId && linkage.taskId ? { taskId: linkage.taskId } : {}),
				...(linkage.subjectRunId ? { parentRunId: linkage.subjectRunId } : {}),
				initialPrompt: basePrompt,
			});
			const dir = this.deps.registry.runDir(run.id);
			const prompts = [basePrompt];
			await this.writePrompt(dir, point, model, linkage, prompts);

			const decisionId = await this.insertDecision(
				role,
				model,
				linkage,
				run.id,
				{
					point,
					promptChars: basePrompt.length,
					timeoutMs,
					...extraInput,
				},
			);

			entry = {
				model,
				inference: opts.inference ?? this.deps.inference,
				controller: new AbortController(),
				decisionId,
				runId: run.id,
				timedOut: false,
				stopped: false,
				usage: {},
			};
			this.byRun.set(run.id, entry);
			this.byDecision.set(decisionId, entry);
			await this.deps.registry.transition(run.id, "running", {
				from: "starting",
			});

			const live = entry;
			timer = setTimeout(() => {
				live.timedOut = true;
				live.controller.abort();
			}, timeoutMs);
			const deadline = startedAt + timeoutMs;

			const transcript: string[] = [];
			let lastErr = "";
			for (let attempt = 0; attempt < maxAttempts; attempt++) {
				const prompt =
					attempt === 0
						? basePrompt
						: `${basePrompt}\n\nYour previous response was invalid: ${lastErr}\nRespond with ONLY valid JSON.`;
				if (attempt > 0) {
					prompts.push(prompt);
					await this.writePrompt(dir, point, model, linkage, prompts);
				}
				const remaining = deadline - Date.now();
				if (remaining <= 0) {
					live.timedOut = true;
					throw new Error("brain call exceeded its budget");
				}
				const text = await this.infer(prompt, remaining, live);
				transcript.push(`### attempt ${attempt + 1}\n${text}`);
				await this.writeRaw(dir, transcript);
				try {
					const parsed = parse(
						opts.rawText ? text : extractJson(text),
						parseContext,
					);
					await this.settle(live, "ok", parsed.action, parsed.reason, {
						...parsed.output,
						attempts: attempt + 1,
					});
					this.sample(Date.now() - startedAt);
					return {
						status: "ok",
						reason: parsed.reason,
						value: parsed.value,
						decisionId,
						brainRunId: run.id,
					};
				} catch (e) {
					lastErr = zodMessage(e);
					this.log.warn(
						{
							point,
							runId: linkage.subjectRunId,
							attempt: attempt + 1,
							err: lastErr,
						},
						"brain response rejected",
					);
				}
			}

			const reason = `invalid response after ${maxAttempts} attempts: ${lastErr}`;
			this.failures++;
			await this.settle(live, "failed", null, reason, {
				attempts: maxAttempts,
			});
			this.sample(Date.now() - startedAt);
			return { status: "failed", reason };
		} catch (e) {
			// The port never throws: classify, record, fail closed.
			const status: DecisionStatus = entry?.timedOut
				? "timeout"
				: entry?.stopped
					? "aborted"
					: "failed";
			const reason =
				status === "timeout"
					? `brain call timed out after ${timeoutMs}ms`
					: status === "aborted"
						? "brain call aborted"
						: e instanceof Error
							? e.message
							: String(e);
			this.failures++;
			if (status === "timeout") this.timeouts++;
			this.log.error(
				{ point, runId: linkage.subjectRunId, status, err: reason },
				"brain call failed",
			);
			if (entry) {
				await this.settle(entry, status, null, reason, {}).catch((err) => {
					this.log.error({ err: String(err) }, "failed to settle decision");
				});
			}
			this.sample(Date.now() - startedAt);
			// A reviewer that changed what it judged: its verdict is discarded.
			const cause: ReviewFailureCause | undefined =
				e instanceof Error && e.name === "ReviewerModifiedError"
					? "reviewer_modified_checkout"
					: undefined;
			return { status, reason, ...(cause ? { cause } : {}) };
		} finally {
			if (timer) clearTimeout(timer);
			if (entry) {
				this.byRun.delete(entry.runId);
				this.byDecision.delete(entry.decisionId);
			}
		}
	}

	/** Races the transport against our abort signal so a transport ignoring it can't outlive the budget. */
	private async infer(
		prompt: string,
		timeoutMs: number,
		entry: Inflight,
	): Promise<string> {
		const signal = entry.controller.signal;
		const aborted = new Promise<never>((_, reject) => {
			const fire = () =>
				reject(new Error(entry.timedOut ? "timeout" : "aborted"));
			if (signal.aborted) fire();
			else signal.addEventListener("abort", fire, { once: true });
		});
		const reply = await Promise.race([
			entry.inference.complete(prompt, {
				model: entry.model,
				reasoningEffort: this.deps.reasoningEffort,
				timeoutMs,
				signal,
			}),
			aborted,
		]);
		if (typeof reply === "string") return reply;
		if (reply.usage) entry.usage = addUsage(entry.usage, reply.usage);
		return reply.text;
	}

	// ---------- persistence helpers ----------

	private async gather(
		ctx: BrainCallCtx,
		point: DecisionPoint,
	): Promise<{
		facts: DiffFacts;
		subject: SubjectFacts & { exists: boolean };
	}> {
		const facts = await this.diffs
			.collect(ctx, point)
			.catch((e: unknown): DiffFacts => {
				this.log.warn(
					{ runId: ctx.runId, err: String(e) },
					"diff collection failed; deciding without it",
				);
				return EMPTY_FACTS;
			});

		const row = ctx.taskId ? await this.taskRow(ctx.taskId) : null;
		const subjectRun = await this.deps.registry
			.get(ctx.runId)
			.catch(() => null);
		const { dodSummary, failedChecks } = summarizeVerify(ctx);
		const owns = row?.owns ?? [];
		return {
			facts,
			subject: {
				exists: row !== null,
				taskId: ctx.taskId ?? "",
				title: row?.title ?? "(unknown task)",
				body: row?.body ?? "",
				criteria: row?.criteria ?? [],
				attempt: subjectRun?.attempt ?? 1,
				outcome: subjectRun?.outcome ?? "unknown",
				dodSummary,
				failedChecks,
				report: reportText(ctx.report),
				owns,
				outsideOwns: filesOutsideOwns(owns, facts.files),
				implementerModel: subjectRun?.model ?? null,
			},
		};
	}

	private async taskRow(taskId: string): Promise<{
		title: string;
		body: string;
		criteria: string[];
		owns: string[];
	} | null> {
		try {
			const task = await this.deps.tasks?.get(taskId);
			return task
				? {
						title: task.title,
						body: task.body,
						criteria: task.criteria.map((criterion) => criterion.text),
						owns: task.owns,
					}
				: null;
		} catch {
			// best-effort: prompt context degrades, the decision still runs
			return null;
		}
	}

	/** Audit trail: every prompt the model saw, in order. */
	private async writePrompt(
		dir: string,
		point: string,
		model: string,
		linkage: { taskId: string | null; subjectRunId: string | null },
		prompts: string[],
	): Promise<void> {
		const header = [
			`# brain decision: ${point}`,
			"",
			`- subject run: ${linkage.subjectRunId ?? "(none)"}`,
			`- task: ${linkage.taskId ?? "(none)"}`,
			`- model: ${model}`,
			`- timeout: ${this.timeoutMs}ms`,
			"",
		].join("\n");
		const body = prompts
			.map((p, i) => `## attempt ${i + 1}\n\n${p}\n`)
			.join("\n");
		await writeFileAtomic(join(dir, "prompt.md"), `${header}${body}`);
	}

	private async writeRaw(dir: string, transcript: string[]): Promise<void> {
		const text = transcript.join("\n\n");
		await writeFileAtomic(
			join(dir, "raw.log"),
			`${text.length > RAW_LOG_CAP ? `${text.slice(0, RAW_LOG_CAP)}\n…(truncated)` : text}\n`,
		);
	}

	private async insertDecision(
		role: DecisionRole,
		model: string,
		linkage: { taskId: string | null; subjectRunId: string | null },
		brainRunId: string,
		input: Record<string, unknown>,
	): Promise<number> {
		// The `decision.recorded` event commits with the row.
		const stored = await this.deps.handle.withTx(async (tx) => {
			const [row] = await tx
				.insert(decisions)
				.values({
					ts: new Date(),
					role,
					taskId: linkage.taskId,
					subjectRunId: linkage.subjectRunId,
					brainRunId,
					model,
					status: "running",
					input,
					output: {},
				})
				.returning({ id: decisions.id });
			if (!row) throw new Error("decision insert returned no row");
			const event = await appendEvent(tx, {
				type: "decision.recorded",
				...(linkage.taskId ? { taskId: linkage.taskId } : {}),
				...(linkage.subjectRunId ? { runId: linkage.subjectRunId } : {}),
				payload: {
					id: row.id,
					role,
					phase: "inserted",
					status: "running",
					taskId: linkage.taskId,
					subjectRunId: linkage.subjectRunId,
				},
			});
			return { id: row.id, event };
		});
		this.deps.bus.publish([stored.event]);
		return stored.id;
	}

	/** Decision row + registry run reach their terminal state together (§6.2). */
	private async settle(
		entry: Inflight,
		status: Exclude<DecisionStatus, "running">,
		action: string | null,
		reason: string,
		output: Record<string, unknown>,
	): Promise<void> {
		const finishedAt = new Date();
		const startedTs = await this.decisionStartedAt(entry.decisionId);
		const usage = Object.keys(entry.usage).length > 0 ? entry.usage : null;
		const settledEvent = await this.deps.handle.withTx(async (tx) => {
			const [row] = await tx
				.update(decisions)
				.set({
					status,
					action,
					reason: reason || null,
					output,
					usage,
					durationMs:
						startedTs === null ? null : finishedAt.getTime() - startedTs,
					finishedAt,
				})
				.where(eq(decisions.id, entry.decisionId))
				.returning({
					role: decisions.role,
					taskId: decisions.taskId,
					subjectRunId: decisions.subjectRunId,
					kind: decisions.kind,
				});
			if (!row) return null;
			return appendEvent(tx, {
				type: "decision.recorded",
				...(row.taskId ? { taskId: row.taskId } : {}),
				...(row.subjectRunId ? { runId: row.subjectRunId } : {}),
				payload: {
					id: entry.decisionId,
					role: row.role,
					phase: "settled",
					status,
					kind: row.kind,
					action,
					taskId: row.taskId,
					subjectRunId: row.subjectRunId,
				},
			});
		});
		if (settledEvent) this.deps.bus.publish([settledEvent]);

		const term = RUN_TERMINAL[status];
		await this.deps.registry.transition(entry.runId, term.state, {
			outcome: term.outcome,
			...(status === "timeout" ? { killReason: "watchdog-wall" as const } : {}),
			...(status === "aborted" ? { killReason: "manual" as const } : {}),
			note: reason.slice(0, 400) || status,
			finishedAt,
			...(usage ? { usage } : {}),
		});
	}

	private async decisionStartedAt(id: number): Promise<number | null> {
		const [row] = await this.deps.handle.db
			.select({ ts: decisions.ts })
			.from(decisions)
			.where(eq(decisions.id, id));
		return row?.ts ? row.ts.getTime() : null;
	}

	private sample(ms: number): void {
		this.samples.push(ms);
		if (this.samples.length > P95_WINDOW)
			this.samples = this.samples.slice(-P95_WINDOW);
	}
}
