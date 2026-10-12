import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeOwnsPattern, validateOwnsPattern } from "@mfw/board";
import { filesOutsideOwns } from "@mfw/board-core";
import type { BackgroundJob } from "@mfw/core/activity";
import type { SettleClass } from "@mfw/core/events";
import type { TaskStatus } from "@mfw/core/types";
import type { ProjectDbHandle } from "@mfw/db/client";
import { appendEvent, type EventBus } from "@mfw/db/eventlog";
import {
	engineKv,
	groupIdOf,
	type KillReason,
	type RunState,
	runs,
} from "@mfw/db/schema";
import { eq, sql } from "drizzle-orm";
import type { RunExit } from "../agent-host.ts";
import { finalActivity } from "../agents/activity.ts";
import { adapterFor } from "../agents/adapter.ts";
import { parseAgentEvents } from "../agents/events.ts";
import { git } from "../git.ts";
import {
	type CleanupResult,
	findLeftoverProcesses,
	type LeftoverProcess,
	stopProcesses,
} from "../leftover-processes.ts";
import type { Logger } from "../log.ts";
import { updateInfraState } from "../maintenance.ts";
import type { NotificationType } from "../notify.ts";
import { detectRateLimit } from "../rate-limit.ts";
import type {
	ReviewFailureCause,
	ReviewFinding,
	ReviewMode,
	ReviewVerdict,
} from "../review-verdict.ts";
import { parseRoutingRecord } from "../routing.ts";
import { RunEventTail } from "../run-event-tail.ts";
import type { BeginStepResult, RunRegistry, RunRow } from "../run-registry.ts";
import {
	changedFiles,
	SCOPE_KILL_REASONS,
	type ScopePolicy,
} from "../scope-watchdog.ts";
import type { TaskService, TaskWithRefs } from "../task-service.ts";
import {
	type DefinitionOfDone,
	MODEL_TIERS,
	type ModelTier,
} from "../tasks/types.ts";
import {
	type EnvPolicy,
	type VerificationResult,
	verify,
} from "../verifier.ts";
import { WorktreeManager, type WorktreeReportIdentity } from "../worktree.ts";
import {
	type Directive,
	type FinalizeCtx,
	next,
	type RunOutcome,
	type StepName,
	type Terminal,
} from "./machine.ts";
import { recordSettled } from "./settle-event.ts";

/**
 * IO half of finalization. The pure machine (`machine.ts`) decides what happens
 * next; this executes each directive as a journaled step and folds results back
 * into ctx until a Terminal. Crash resume rebuilds ctx from the journal; `done`
 * steps never re-run; guarded steps journal key material before the side effect.
 *
 * Failure policy: brain steps never throw (failure is a journaled status).
 * Any other throw marks the step `failed` and aborts (supervisor re-drives); a
 * second consecutive throw parks the run in `finalize_error`, task blocked.
 */

const TAIL_BYTES = 64 * 1024;
const PLAN_TAIL_BYTES = 256 * 1024;
const HOLD_FALLBACK_MS = 15 * 60_000;
const MAX_DIRECTIVES = 64;

/** States the runner must never touch: terminal, or owned by the MergeQueue. */
const SETTLED_STATES: ReadonlySet<RunState> = new Set([
	"merging",
	"completed",
	"failed",
	"killed",
	"interrupted",
	"rate_limited",
	"needs_review",
	"finalize_error",
]);

const KILL_REASONS: ReadonlySet<string> = new Set([
	"manual",
	"watchdog-idle",
	"watchdog-wall",
	"watchdog-turns",
	"watchdog-timebox",
	...SCOPE_KILL_REASONS,
]);

/**
 * Settle classes that count as a non-progressing run on the task's
 * informational stall counter (the brain reads it; nothing caps on it).
 */
const STALLING_CLASSES: ReadonlySet<SettleClass> = new Set([
	"verify_failed",
	"watchdog_killed",
	"scope_violation",
]);

/** Every numeric key of a driver `usage` event that is kept on the run row. */
const USAGE_KEYS = [
	"inputTokens",
	"outputTokens",
	"cachedInputTokens",
	"reasoningOutputTokens",
	"costUsd",
	"turns",
] as const;

/** Statuses a task holds while one of its runs is working on it. */
const RUN_HELD_STATUSES: ReadonlySet<TaskStatus> = new Set([
	"in_progress",
	"draft",
]);

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** Context handed to every brain call, the port trims it per point (§6.3). */
export interface BrainCallCtx {
	runId: string;
	taskId: string | null;
	worktreePath: string | null;
	branch: string | null;
	baseSha: string | null;
	verify: VerificationResult | null;
	report: unknown;
}

export interface CriticResult {
	status: "ok" | "failed";
	flagged?: boolean;
	accepted?: boolean;
	criteria?: {
		criterion: string;
		verdict: "met" | "unmet" | "uncertain";
		evidence: string;
		evidenceClass?: "reproduced" | "source-confirmed" | "claimed";
	}[];
	reason?: string;
	/** The floored verdict; absent on journals that predate verdicts. */
	verdict?: ReviewVerdict;
	/** What the reviewer said before the floor. */
	modelVerdict?: ReviewVerdict;
	findings?: ReviewFinding[];
	mode?: ReviewMode;
	/** Review round this verdict belongs to (1-based). */
	round?: number;
	reviewer?: { harness: string | null; model: string };
	independent?: boolean;
	/** Why a failed review produced no usable verdict. */
	cause?: ReviewFailureCause;
}

/** One-shot judges: every call resolves with a status, never throws. Fail-closed handling is in the machine's tables (T14/I5). What happens to a failed run is the project brain's, through `settle`. */
export interface BrainPort {
	/** Project-level gate: false = the project opted out of the brain. */
	enabled: boolean;
	readonly criticEnabled?: boolean;
	/** Semantic acceptance is decided by a human instead of an assisted review. */
	readonly humanReviewEnabled?: boolean;
	critic(ctx: BrainCallCtx): Promise<CriticResult>;
}

/** The one call finalization makes into the clarify gate. */
export interface ClarifyPort {
	raise(input: {
		runId: string;
		kind: string;
		goal?: string | null;
		questions: string[];
	}): Promise<unknown>;
}

export interface StepRunnerDeps {
	handle: ProjectDbHandle;
	bus: EventBus;
	registry: RunRegistry;
	tasks: TaskService;
	clarify: ClarifyPort;
	mergeQueue: {
		enqueue(job: {
			runId: string;
			taskId?: string | null;
			branch: string;
			targetBranch: string;
		}): Promise<void>;
	};
	host: { readExit(runDir: string): Promise<RunExit> };
	brain: BrainPort;
	notifier: {
		notify(
			kind: NotificationType,
			detail: Record<string, unknown>,
		): Promise<void>;
	};
	projectRoot: string;
	/** Wrapper command for DoD checks (e.g. a sandbox entrypoint, or the
	 *  project's own dev-environment entrypoint). */
	checkPrefix?: string;
	/** What a DoD check may read from the ambient environment. See
	 *  `verifier.ts`'s `EnvPolicy`. */
	envPolicy?: EnvPolicy;
	verification?: {
		foreground<T>(work: () => Promise<T>): Promise<T>;
	};
	/**
	 * Machine-wide per-provider rate-limit holds (`provider-holds.ts`). A
	 * rate-limited run holds only its own route's provider account. Absent =
	 * the legacy project-wide `dispatch_hold`.
	 */
	providerHolds?: {
		hold(
			key: string,
			hold: { until: number; reason: string; runId?: string; project?: string },
		): Promise<unknown>;
	};
	/** Project name recorded on a provider hold (which project hit the limit). */
	projectName?: string;
	log: Logger;
	config: {
		/** Failed expansion runs a `draft` task tolerates before the
		 *  bounded retry gives up and files it on `mergeChecks`. */
		draftExpandMaxAttempts: number;
		/** The DoD an expanded (or expansion-exhausted) draft gets when
		 *  nothing else supplied one. */
		mergeChecks: DefinitionOfDone;
	};
	/** Leftover-process scan and stop for `reap_leftovers`; defaults to the real /proc ones. */
	leftovers?: {
		find(run: RunRow): Promise<LeftoverProcess[]>;
		stop(processes: readonly LeftoverProcess[]): Promise<CleanupResult>;
	};
	/** Transcript fold shared with RunEngine/Supervisor; absent = a private one. */
	eventTail?: RunEventTail;
	/** The live scope watchdog policy (settings `watchdog.scope`). Absent = no
	 *  finish-time scope check. */
	scopePolicy?: () => Pick<ScopePolicy, "onFinish">;
}

// ---------------------------------------------------------------------------
// Journaled result shapes
// ---------------------------------------------------------------------------

interface ClassifyResult {
	outcome: RunOutcome;
	exitCode?: number;
	killReason?: string;
	resetsAt?: number;
	/** Background jobs the transcript shows started and never seen to finish. */
	background?: BackgroundJob[];
}

/** `scope_check`: the finished run's changes outside its task's `owns`. */
interface ScopeCheckResult {
	files: number;
	outside: number;
	outsideFiles: string[];
}

/** `archive_wip`: where a scope-killed run's work was saved (null = nothing beyond base). */
interface ArchiveWipResult {
	ref: string | null;
	sha: string | null;
}

interface PlanEntry {
	title: string;
	body?: string;
	dependsOn: (string | number)[];
	verification: DefinitionOfDone | null;
	criteria: string[];
	/** Import runs only, see `IMPORT_STATUS_ALIASES`. Null = not stated. */
	status: TaskStatus | null;
	/** Valid, normalized `owns` patterns; invalid ones are dropped. */
	owns: string[];
	modelTier: ModelTier | null;
}

interface FollowUpEntry {
	title: string;
	body: string;
	criteria: string[];
}

interface SpecEntry {
	title: string;
	body: string;
	/** Positional indexes into the proposal's task list, or explicit task ids. */
	tasks: (string | number)[];
}

interface ParsedProposal {
	tasks: PlanEntry[];
	specs: SpecEntry[];
	questions: string[];
}

/** Everything one loop iteration needs: the machine ctx plus the raw rows. */
interface Built {
	run: RunRow;
	task: TaskWithRefs | null;
	ctx: FinalizeCtx;
	results: ReadonlyMap<string, unknown>;
	statuses: ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------
// Lenient parsers (agent-produced JSON is untrusted)
// ---------------------------------------------------------------------------

function toMs(n: number): number {
	return n < 1e12 ? n * 1000 : n;
}

function extractJsonObject(text: string): unknown {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		return JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
}

function looksLikeDod(v: unknown): v is DefinitionOfDone {
	return (
		typeof v === "object" &&
		v !== null &&
		Array.isArray((v as { checks?: unknown }).checks)
	);
}

/**
 * What an importer may say a task's state already is.
 *
 * `in_progress` is not importable; it lands as `ready`. A task in in-progress
 * with no claiming run is invisible to the scheduler and skipped by the
 * groomer's stale-claim sweep, so nothing would ever pick it up.
 */
const IMPORT_STATUS_ALIASES: Record<string, TaskStatus> = {
	backlog: "backlog",
	planned: "backlog",
	todo: "backlog",
	ready: "ready",
	next: "ready",
	in_progress: "ready",
	doing: "ready",
	wip: "ready",
	blocked: "blocked",
	review: "review",
	done: "done",
	complete: "done",
	completed: "done",
	shipped: "done",
	archived: "archived",
	abandoned: "archived",
	dropped: "archived",
};

/** Lenient because the value comes from an agent: "In Progress" must land. */
function normalizeImportedStatus(v: unknown): TaskStatus | null {
	if (typeof v !== "string") return null;
	const key = v
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
	return IMPORT_STATUS_ALIASES[key] ?? null;
}

function normalizePlanEntries(v: unknown): PlanEntry[] {
	if (!Array.isArray(v)) return [];
	const out: PlanEntry[] = [];
	for (const item of v) {
		if (typeof item !== "object" || item === null) continue;
		const o = item as Record<string, unknown>;
		const title = typeof o.title === "string" ? o.title.trim() : "";
		if (!title) continue;
		const depsRaw = Array.isArray(o.depends_on)
			? o.depends_on
			: Array.isArray(o.dependsOn)
				? o.dependsOn
				: [];
		out.push({
			title,
			body: typeof o.body === "string" ? o.body : undefined,
			dependsOn: depsRaw.filter(
				(d): d is string | number =>
					typeof d === "string" || typeof d === "number",
			),
			verification: looksLikeDod(o.verification)
				? o.verification
				: looksLikeDod(o.dod)
					? o.dod
					: null,
			criteria: Array.isArray(o.criteria)
				? o.criteria.filter((c): c is string => typeof c === "string")
				: [],
			status: normalizeImportedStatus(o.status),
			owns: normalizeOwns(o.owns),
			modelTier: normalizeModelTier(o.model_tier ?? o.modelTier),
		});
	}
	return out;
}

/** An agent-written pattern that would escape the repo, or never match, is dropped rather than failing the whole entry. */
function normalizeOwns(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	const out: string[] = [];
	for (const raw of v) {
		if (typeof raw !== "string" || validateOwnsPattern(raw) !== null) continue;
		const p = normalizeOwnsPattern(raw);
		if (!out.includes(p)) out.push(p);
	}
	return out;
}

function normalizeModelTier(v: unknown): ModelTier | null {
	return typeof v === "string" && (MODEL_TIERS as readonly string[]).includes(v)
		? (v as ModelTier)
		: null;
}

/** `follow_ups` from a report: entries without a title are dropped. */
function normalizeFollowUps(v: unknown): FollowUpEntry[] {
	if (!Array.isArray(v)) return [];
	const out: FollowUpEntry[] = [];
	for (const item of v) {
		if (typeof item !== "object" || item === null) continue;
		const o = item as Record<string, unknown>;
		const title = typeof o.title === "string" ? o.title.trim() : "";
		if (!title) continue;
		out.push({
			title,
			body: typeof o.body === "string" ? o.body : "",
			criteria: Array.isArray(o.criteria)
				? o.criteria.filter(
						(c): c is string => typeof c === "string" && c.trim() !== "",
					)
				: [],
		});
	}
	return out;
}

function normalizeSpecEntries(v: unknown): SpecEntry[] {
	if (!Array.isArray(v)) return [];
	const out: SpecEntry[] = [];
	for (const item of v) {
		if (typeof item !== "object" || item === null) continue;
		const o = item as Record<string, unknown>;
		const title = typeof o.title === "string" ? o.title.trim() : "";
		if (!title) continue;
		const refs = Array.isArray(o.tasks) ? o.tasks : [];
		out.push({
			title,
			body: typeof o.body === "string" ? o.body : "",
			tasks: refs.filter(
				(t): t is string | number =>
					typeof t === "string" || typeof t === "number",
			),
		});
	}
	return out;
}

function normalizeQuestions(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	const out: string[] = [];
	for (const item of v) {
		// Both shapes are seen in the wild: a bare string, and `{question: "…"}`
		// left over from the answered shape the table stores.
		const q =
			typeof item === "string"
				? item
				: typeof (item as { question?: unknown })?.question === "string"
					? ((item as { question: string }).question as string)
					: "";
		const trimmed = q.trim();
		if (trimmed) out.push(trimmed);
	}
	return out;
}

interface FoldedReport {
	escalation: "drop" | "needs-replan" | "blocked" | "question" | null;
	/** `escalation: "question"` only: what the agent asked, and its suggested answers. */
	question: { text: string; options: string[] } | null;
	subtasks: unknown;
	followUps: FollowUpEntry[];
	raw: unknown;
}

const ESCALATIONS = new Set(["drop", "needs-replan", "blocked", "question"]);

/**
 * Pull the report out of the journaled `ingest_report` result. The agent's
 * declaration is `escalation` (or `status`, the key the scope prompt names);
 * a question needs its text, or it is no question at all.
 */
export function foldReport(result: unknown): FoldedReport | null {
	const report = (result as { report?: unknown } | undefined)?.report;
	if (typeof report !== "object" || report === null) return null;
	const o = report as Record<string, unknown>;
	const declared = [o.escalation, o.status].find(
		(v): v is string => typeof v === "string" && ESCALATIONS.has(v),
	);
	const questionText =
		typeof o.question === "string" && o.question.trim()
			? o.question.trim()
			: null;
	const options = Array.isArray(o.options)
		? o.options.filter(
				(v): v is string => typeof v === "string" && v.trim() !== "",
			)
		: [];
	const escalation =
		declared === "question"
			? questionText
				? "question"
				: null
			: ((declared as FoldedReport["escalation"]) ?? null);
	return {
		escalation,
		question:
			escalation === "question" && questionText
				? { text: questionText, options }
				: null,
		subtasks: o.subtasks,
		followUps: normalizeFollowUps(o.follow_ups),
		raw: report,
	};
}

/** The `run.finalize_step` detail for steps whose result a human wants to see in the feed. */
function auditDetail(step: StepName, result: unknown): string | undefined {
	if (step === "reap_leftovers") {
		const r = result as { processes: unknown[]; stopped: number[] };
		if (r.processes.length === 0) return undefined;
		return `stopped ${r.stopped.length} of ${r.processes.length} leftover processes`;
	}
	if (step === "create_followups") {
		const r = result as { created: string[]; reused: string[] };
		return `created ${r.created.length} follow-up tasks${r.reused.length ? `, ${r.reused.length} already existed` : ""}`;
	}
	return undefined;
}

function foldReportIdentity(
	result: unknown,
): WorktreeReportIdentity | undefined {
	const identity = (result as { worktreeReport?: unknown } | undefined)
		?.worktreeReport;
	if (
		typeof identity === "object" &&
		identity !== null &&
		(identity as { state?: unknown }).state === "absent"
	) {
		return { state: "absent" };
	}
	const candidate = identity as { state?: unknown; sha256?: unknown } | null;
	if (
		candidate?.state === "present" &&
		typeof candidate.sha256 === "string" &&
		/^[a-f0-9]{64}$/.test(candidate.sha256)
	) {
		return { state: "present", sha256: candidate.sha256 };
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// StepRunner
// ---------------------------------------------------------------------------

export class StepRunner {
	private readonly deps: StepRunnerDeps;
	private readonly log: Logger;
	private readonly tail: RunEventTail;
	/** In-process single-flight. */
	private readonly inflight = new Map<string, Promise<void>>();

	constructor(deps: StepRunnerDeps) {
		this.deps = deps;
		this.log = deps.log.child({ svc: "step-runner" });
		this.tail =
			deps.eventTail ??
			new RunEventTail((runId, offset) =>
				deps.registry.readOutput(runId, "events.jsonl", offset),
			);
	}

	/** Drive the run's finalization to a Terminal (or a parked step failure).
	 *  A second concurrent entrant awaits the in-flight finalization. */
	finalize(runId: string): Promise<void> {
		const existing = this.inflight.get(runId);
		if (existing) return existing;
		const p = this.drive(runId).finally(() => {
			this.inflight.delete(runId);
		});
		this.inflight.set(runId, p);
		return p;
	}

	private async drive(runId: string): Promise<void> {
		const log = this.log.child({ runId });
		const first = await this.deps.registry.get(runId);
		if (!first) {
			log.warn("finalize called for unknown run");
			return;
		}
		if (SETTLED_STATES.has(first.state)) return;
		// classify needs the pre-finalization state to tell start_failed from
		// interrupted; capture it before any transition.
		const initialState = first.state;

		for (let i = 0; i < MAX_DIRECTIVES; i++) {
			const built = await this.buildCtx(runId);
			const d = next(built.ctx);
			if (d.kind === "terminal") {
				if (d.note === "merging") {
					// T16 / I7: the MergeQueue owns the rest. Guard on `merging` so a
					// run the worker already finished is not dragged out of terminal.
					await this.deps.registry.transition(runId, "merging", {
						from: "merging",
						note: d.note,
					});
				} else {
					await this.deps.registry.finish(runId, d.state, d.note);
				}
				return;
			}
			log.debug({ step: d.step, row: d.row }, "finalize step");
			const ok = await this.executeStep(built, d, initialState, log);
			if (!ok) return;
		}
		const msg = `finalize exceeded ${MAX_DIRECTIVES} directives (machine/journal disagreement)`;
		log.error(msg);
		await this.park(first, "loop", msg);
	}

	/** Execute one directive. Returns false when this finalization must stop
	 *  (step failed once → supervisor retries; failed twice → parked). */
	private async executeStep(
		built: Built,
		d: Directive,
		initialState: RunState,
		log: Logger,
	): Promise<boolean> {
		const { run } = built;
		// Journal status BEFORE beginStep resets it: a prior `failed` row means
		// this execution is already the retry.
		const priorFailed = built.statuses.get(d.step) === "failed";
		const begin = await this.deps.registry.beginStep(run.id, d.step);
		if (begin.resumed === "done") {
			// Side effect already completed, fold the stored result on rebuild.
			return true;
		}
		try {
			const result = await this.perform(built, d, begin, initialState);
			await this.deps.registry.finishStep(run.id, d.step, result);
			await this.audit(run.id, d.step, true, auditDetail(d.step, result));
			return true;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			log.warn({ step: d.step, err: msg }, "finalize step failed");
			await this.deps.registry.failStep(run.id, d.step, msg).catch(() => {
				// best-effort: the abort below already stops this finalization; a
				// lost failStep only delays the twice-consecutive parking by one pass
			});
			await this.audit(run.id, d.step, false, msg);
			if (priorFailed) await this.park(run, d.step, msg);
			return false;
		}
	}

	/** Twice-consecutive step failure: park the run and hand the task to a human (no silent retry loop). */
	private async park(run: RunRow, step: string, msg: string): Promise<void> {
		const note = `finalize_error at ${step}: ${msg}`.slice(0, 500);
		await this.deps.registry.transition(run.id, "finalize_error", {
			note,
			finishedAt: new Date(),
		});
		if (run.taskId && run.kind !== "repair" && step !== "reap_leftovers") {
			await this.deps.tasks
				.release(run.taskId, run.id, "blocked", "scheduler", note)
				.catch((e) => {
					this.log.error(
						{ runId: run.id, taskId: run.taskId, err: e },
						"failed to release task after finalize_error",
					);
				});
		}
		await this.deps.notifier
			.notify("finalize_error", {
				runId: run.id,
				...(run.taskId ? { taskId: run.taskId } : {}),
			})
			.catch(() => {
				// best-effort: notification loss never blocks parking
			});
	}

	// -------------------------------------------------------------------
	// ctx building, DB rows + journal → FinalizeCtx
	// -------------------------------------------------------------------

	private async buildCtx(runId: string): Promise<Built> {
		const run = await this.deps.registry.get(runId);
		if (!run) throw new Error(`run ${runId} vanished during finalization`);
		const stepRows = await this.deps.registry.steps(runId);
		const done = new Set<StepName>();
		const results = new Map<string, unknown>();
		const statuses = new Map<string, string>();
		for (const s of stepRows) {
			statuses.set(s.step, s.status);
			if (s.status === "done") {
				done.add(s.step as StepName);
				results.set(s.step, s.result);
			}
		}

		const classify = results.get("classify") as ClassifyResult | undefined;
		const report = foldReport(results.get("ingest_report"));
		const verifyRes = results.get("verify") as
			| { passed?: boolean; crashed?: boolean }
			| undefined;
		const criticRes = results.get("critic") as CriticResult | undefined;
		const reapRes = results.get("reap_leftovers") as
			| { processes?: unknown[] }
			| undefined;
		const planRes = results.get("parse_plan") as
			| { parsed?: boolean; plan?: ParsedProposal }
			| undefined;
		const scopeRes = results.get("scope_check") as ScopeCheckResult | undefined;

		const task = run.taskId ? await this.deps.tasks.get(run.taskId) : null;
		const worktreeDirty =
			run.kind === "task" && run.worktreePath
				? await this.isDirty(
						run,
						foldReportIdentity(results.get("ingest_report")),
					)
				: false;

		const group =
			run.role === "attempt" && run.groupId
				? await this.deps.registry.getGroup(run.groupId)
				: null;
		const ctx: FinalizeCtx = {
			kind: run.kind,
			outcome: classify?.outcome ?? run.outcome ?? null,
			done,
			...(group?.kind === "competing" ? { group: { competing: true } } : {}),
			isDraftExpand: run.kind === "plan" && run.taskId != null,
			task:
				run.kind === "task" || run.kind === "repair"
					? {
							exists: task !== null,
							// Project merge checks always apply; focused task checks augment
							// them. This boolean means "has mechanical verification", not
							// "the task is semantically done".
							hasDod:
								this.deps.tasks.effectiveVerification(
									task?.verification ?? task?.dod ?? null,
								) != null,
							escalation: report?.escalation ?? null,
							attempt: run.attempt,
							worktreeDirty,
							exitCode: classify?.exitCode ?? run.exitCode ?? null,
						}
					: null,
			gates: {
				mainRed: await this.mainRed(),
				// A task can request review itself; the project's explicit human
				// policy can require it for every task.
				reviewGated:
					(task?.requireReview ?? false) ||
					(this.deps.brain.humanReviewEnabled ?? false),
				brainEnabled: this.deps.brain.enabled,
				criticEnabled: this.deps.brain.criticEnabled ?? this.deps.brain.enabled,
				// Only a task that declared a scope can leave it.
				scopeOnFinish:
					run.kind === "task" &&
					(task?.owns.length ?? 0) > 0 &&
					this.deps.scopePolicy?.().onFinish === "review",
			},
			killReason: classify?.killReason ?? run.killReason ?? null,
			scope: scopeRes ? { outside: scopeRes.outside } : null,
			verify: verifyRes
				? {
						passed: verifyRes.passed === true,
						crashed: verifyRes.crashed === true,
					}
				: null,
			critic: criticRes
				? {
						status: criticRes.status === "ok" ? "ok" : "failed",
						flagged: criticRes.flagged === true,
						verdict: criticRes.verdict ?? null,
						round: criticRes.round ?? null,
						cause: criticRes.cause ?? null,
					}
				: null,
			planParsed: planRes ? planRes.parsed === true : null,
			reportHasFollowUps: (report?.followUps.length ?? 0) > 0,
			localWorktree:
				run.kind !== "brain" &&
				run.executionTarget === "local" &&
				run.worktreePath !== null,
			leftBackground: (reapRes?.processes?.length ?? 0) > 0,
			backgroundOutstanding: (classify?.background?.length ?? 0) > 0,
		};

		return { run, task, ctx, results, statuses };
	}

	private async mainRed(): Promise<boolean> {
		const [row] = await this.deps.handle.db
			.select()
			.from(engineKv)
			.where(eq(engineKv.key, "main_red"));
		return row ? (row.value as { red?: boolean }).red === true : false;
	}

	/** Dirty = uncommitted changes OR commits beyond the run's base. */
	private async isDirty(
		run: RunRow,
		reportIdentity?: WorktreeReportIdentity,
	): Promise<boolean> {
		const wt = run.worktreePath;
		if (!wt) return false;
		try {
			await access(wt);
		} catch {
			return false;
		}
		// Same ownership-aware policy as maintenance. MFW_REPORT.json is exempt
		// only while it matches the identity recorded by ingest_report.
		if (
			await new WorktreeManager(this.deps.projectRoot).hasLocalChanges(
				{ path: wt },
				{ reportIdentity },
			)
		)
			return true;
		if (!run.baseSha) return false;
		const head = await git(["rev-parse", "HEAD"], wt);
		if (head.exitCode !== 0)
			throw new Error(
				`could not inspect worktree HEAD: ${head.stderr || head.stdout}`,
			);
		return head.stdout !== run.baseSha;
	}

	/** The Terminal this row is heading toward, its note becomes the release
	 *  reason. Pure simulation over the machine; never executes anything. */
	private simulateTerminal(ctx: FinalizeCtx): Terminal | null {
		const done = new Set<StepName>(ctx.done);
		const sim: FinalizeCtx = { ...ctx, done };
		for (let i = 0; i < 16; i++) {
			const d = next(sim);
			if (d.kind === "terminal") return d;
			done.add(d.step);
		}
		return null;
	}

	private async readTail(
		runId: string,
		file: "events.jsonl" | "raw.log",
		bytes: number,
	): Promise<string> {
		const probe = await this.deps.registry.readOutput(
			runId,
			file,
			Number.MAX_SAFE_INTEGER,
		);
		if (probe.size === 0) return "";
		const { chunk } = await this.deps.registry.readOutput(
			runId,
			file,
			Math.max(0, probe.size - bytes),
		);
		return chunk;
	}

	/** `run.finalize_step` audit row in its own tx; loss never blocks a step. */
	private async audit(
		runId: string,
		step: string,
		ok: boolean,
		detail?: string,
	): Promise<void> {
		try {
			const stored = await this.deps.handle.withTx(async (tx) => {
				// Task-indexed so a task's activity feed finds its run steps.
				const [run] = await tx
					.select({ taskId: runs.taskId })
					.from(runs)
					.where(eq(runs.id, runId));
				return appendEvent(tx, {
					type: "run.finalize_step",
					runId,
					...(run?.taskId ? { taskId: run.taskId } : {}),
					payload: {
						step,
						ok,
						...(detail ? { detail: detail.slice(0, 500) } : {}),
					},
				});
			});
			this.deps.bus.publish([stored]);
		} catch (e) {
			this.log.warn({ runId, step, err: e }, "finalize_step audit failed");
		}
	}

	// -------------------------------------------------------------------
	// Step implementations
	// -------------------------------------------------------------------

	private perform(
		built: Built,
		d: Directive,
		begin: BeginStepResult,
		initialState: RunState,
	): Promise<unknown> {
		switch (d.step) {
			case "classify":
				return this.classify(built, initialState);
			case "reap_leftovers":
				return this.reapLeftovers(built, begin);
			case "hold_rate_limit":
				return this.holdRateLimit(built);
			case "ingest_report":
				return this.ingestReport(built);
			case "create_followups":
				return this.createFollowUps(built);
			case "verify":
				return this.verifyStep(built);
			case "critic":
				return this.brainCall(built, "critic");
			case "parse_plan":
				return this.parsePlan(built);
			case "record_question":
				return this.recordQuestion(built);
			case "settle":
				return this.settle(built, d, begin);
			case "enqueue_merge":
				return this.enqueueMerge(built);
			case "release_task":
				return this.releaseTask(built, d);
			case "clear_stall":
				return this.clearStall(built);
			case "gc_worktree":
				return this.gcWorktree(built, d.args?.force === true);
			case "archive_wip":
				return this.archiveWip(built);
			case "scope_check":
				return this.scopeCheck(built);
			case "notify":
				return this.notifyStep(built, d);
			case "finish_decision":
				// BrainService owns decision rows; the step only journals done.
				return Promise.resolve({});
			case "draft_expand_failed":
				return this.draftExpandFailed(built);
		}
	}

	/**
	 * A plan run expanding a `draft` task ended without a usable proposal.
	 * Bounded-retry bookkeeping is in `TaskService.recordDraftExpandFailure`.
	 *
	 * It returns null when the task is no longer a draft (deleted or archived
	 * mid-run); `release` is skipped then to avoid a pointless call and a
	 * misleading audit line.
	 */
	private async draftExpandFailed(built: Built): Promise<unknown> {
		const { run } = built;
		if (!run.taskId) return { noop: true };
		const result = await this.deps.tasks.recordDraftExpandFailure(
			run.taskId,
			this.deps.config.draftExpandMaxAttempts,
			this.deps.config.mergeChecks,
		);
		if (!result) return { noop: true };
		await this.deps.tasks.release(
			run.taskId,
			run.id,
			"draft",
			"brain",
			result.exhausted
				? "draft expansion exhausted"
				: "draft expansion will retry",
		);
		// Nobody is paged: a draft whose expansion keeps failing shows as
		// `draftPhase: failed` in the brain's digest and the inbox.
		return result;
	}

	/** Outcome from exit file + event tail. Pure-reread, safe to re-execute. */
	private async classify(
		built: Built,
		initialState: RunState,
	): Promise<ClassifyResult> {
		const { run } = built;
		let limited = false;
		let resetsAt: number | null = null;
		let approachingUtilization: number | null = null;

		// Structured events first: `limited` is resolved by the driver, never by
		// re-reading a provider status string (an "allowed_warning" misread once
		// paused dispatch for 66 hours).
		const eventsTail = await this.readTail(run.id, "events.jsonl", TAIL_BYTES);
		// Cost/token accounting: the last usage event wins (the CLI reports
		// cumulative totals in its final result).
		let usage: Record<string, number> | null = null;
		let nativeSessionId: string | null = null;
		for (const e of parseAgentEvents(eventsTail)) {
			if (e.type === "session") {
				nativeSessionId = e.sessionId;
				continue;
			}
			if (e.type === "usage") {
				const u: Record<string, number> = {};
				for (const key of USAGE_KEYS) {
					const v = e[key];
					if (typeof v === "number") u[key] = v;
				}
				if (Object.keys(u).length > 0) usage = u;
				continue;
			}
			if (e.type !== "rate_limit") continue;
			if (e.limited) {
				limited = true;
				if (e.resetsAt !== null) resetsAt = toMs(e.resetsAt);
			} else if (typeof e.utilization === "number") {
				// Approaching a quota but the request went through: surface, never hold.
				approachingUtilization = e.utilization;
			}
		}
		if (usage) {
			await this.deps.registry.transition(run.id, run.state, { usage });
		}
		// A run that ended between supervisor passes never had its session id
		// recorded live; the transcript still has it.
		if (nativeSessionId && nativeSessionId !== run.nativeSessionId) {
			await this.deps.registry.recordNativeSession(run.id, nativeSessionId);
		}
		if (approachingUtilization !== null && !limited) {
			await this.deps.notifier
				.notify("rate_limit_warning", {
					runId: run.id,
					utilization: approachingUtilization,
				})
				.catch(() => {
					// best-effort: a lost notification never blocks finalization
				});
		}
		// Tail-text fallback on the raw pane output, for a provider whose adapter
		// declines to interpret its own output (or resolves nothing from it).
		if (!limited) {
			const rawTail = await this.readTail(run.id, "raw.log", TAIL_BYTES);
			const det = detectRateLimit(
				rawTail,
				adapterFor(run.providerId)?.parseRateLimit,
			);
			if (det.limited) {
				limited = true;
				resetsAt = det.resetsAt;
			}
		}

		const exit = await this.deps.host.readExit(
			this.deps.registry.runDir(run.id),
		);
		const targetJournal = await this.deps.registry.targetJournal(run.id);
		const lastCollectionFailure = targetJournal.findLast(
			(entry) => entry.phase === "collect" && entry.status === "failed",
		);
		const lastCollectionSuccess = targetJournal.findLast(
			(entry) => entry.phase === "collect" && entry.status === "completed",
		);
		const collectionFailed =
			lastCollectionFailure !== undefined &&
			(lastCollectionSuccess?.seq ?? -1) < lastCollectionFailure.seq;
		const exitCode = exit.kind === "exit" ? exit.code : null;
		const killReason = exit.kind === "killed" ? exit.reason : null;
		let outcome: RunOutcome;
		if (collectionFailed) outcome = "interrupted";
		else if (limited) outcome = "rate_limited";
		else if (exit.kind === "killed")
			outcome = exit.reason.startsWith("watchdog")
				? "killed_watchdog"
				: "killed_manual";
		else if (exit.kind === "exit") outcome = "completed";
		else outcome = initialState === "starting" ? "start_failed" : "interrupted";

		await this.deps.registry.recordExit(run.id, {
			exitCode,
			...(killReason && KILL_REASONS.has(killReason)
				? { killReason: killReason as KillReason }
				: {}),
			outcome,
		});
		await this.deps.registry.transition(run.id, "finalizing");
		const background = await this.labelActivity(run, null);
		return {
			outcome,
			...(exitCode !== null ? { exitCode } : {}),
			...(killReason ? { killReason } : {}),
			...(resetsAt !== null ? { resetsAt } : {}),
			...(background.length ? { background } : {}),
		};
	}

	/**
	 * Label the finished run's activity from its whole transcript (and the
	 * report's question, once ingested). Returns the background jobs it ended
	 * on. A label only: the machine reads the journal, never this column.
	 */
	private async labelActivity(
		run: RunRow,
		question: { text: string; options: string[] } | null,
	): Promise<BackgroundJob[]> {
		if (run.kind === "brain") return [];
		try {
			const fold = await this.tail.fold(run.id);
			// The whole transcript is read: settle the subagent rows with it.
			if (fold.subagents.size > 0) {
				await this.deps.registry.recordSubagents(run.id, [
					...fold.subagents.values(),
				]);
			}
			const label = finalActivity(
				fold,
				question
					? { question: question.text, options: question.options }
					: null,
			);
			await this.deps.registry.setActivity(
				run.id,
				label.activity,
				label.detail,
			);
			return [...fold.background.values()];
		} catch (e) {
			this.log.warn({ err: e, runId: run.id }, "could not label run activity");
			return [];
		}
	}

	/**
	 * Hold the provider account the run was routed to (machine-wide, so every
	 * project's tasks on that account wait and nothing else does), keeping the
	 * furthest `until`. Without a provider hold store: the legacy
	 * engine_kv["dispatch_hold"], which holds every provider of this project.
	 */
	private async holdRateLimit(built: Built): Promise<unknown> {
		const classify = built.results.get("classify") as
			| ClassifyResult
			| undefined;
		const until = classify?.resetsAt ?? Date.now() + HOLD_FALLBACK_MS;
		const value = { until, reason: `rate-limited run ${built.run.id}` };
		if (this.deps.providerHolds) {
			const key =
				parseRoutingRecord(built.run.routing)?.holdKey ??
				built.run.providerId ??
				"unknown";
			await this.deps.providerHolds.hold(key, {
				...value,
				runId: built.run.id,
				...(this.deps.projectName ? { project: this.deps.projectName } : {}),
			});
			return { ...value, key };
		}
		await this.deps.handle.db
			.insert(engineKv)
			.values({ key: "dispatch_hold", value, updatedAt: new Date() })
			.onConflictDoUpdate({
				target: engineKv.key,
				set: {
					value: sql`CASE
						WHEN json_extract(excluded.value,'$.until') > json_extract(${engineKv.value},'$.until')
						THEN excluded.value ELSE ${engineKv.value} END`,
					updatedAt: new Date(),
				},
			});
		return value;
	}

	/** Read MFW_REPORT.json from the run dir; absent/corrupt = no report. The
	 *  report lives in the journal, nothing else is mutated here. */
	private async ingestReport(built: Built): Promise<unknown> {
		// The agent writes MFW_REPORT_PATH = <worktree>/MFW_REPORT.json; the run
		// dir is only a fallback for runs without a worktree.
		const worktreeReportPath = built.run.worktreePath
			? join(built.run.worktreePath, "MFW_REPORT.json")
			: null;
		const candidates = [
			worktreeReportPath,
			join(this.deps.registry.runDir(built.run.id), "MFW_REPORT.json"),
		].filter((p): p is string => p !== null);

		let report: Record<string, unknown> | null = null;
		let worktreeReport: WorktreeReportIdentity = { state: "absent" };
		for (const path of candidates) {
			let content: Buffer;
			try {
				content = await readFile(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				// A transient/permission failure is not "no report"; fail the step so
				// cleanup never erases bytes we could not read.
				throw error;
			}
			if (path === worktreeReportPath) {
				worktreeReport = {
					state: "present",
					sha256: createHash("sha256").update(content).digest("hex"),
				};
			}
			try {
				const parsed: unknown = JSON.parse(content.toString("utf8"));
				if (typeof parsed === "object" && parsed !== null) {
					report = parsed as Record<string, unknown>;
					break;
				}
			} catch {
				// Corrupt: journaled as no usable report (bytes were observed, unlike a read failure).
			}
		}
		const question = foldReport({ report })?.question ?? null;
		if (question) await this.labelActivity(built.run, question);
		return { report, worktreeReport };
	}

	/** Run project merge checks plus focused task checks in the worktree. */
	private async verifyStep(built: Built): Promise<unknown> {
		const { run, task } = built;
		const dod = this.deps.tasks.effectiveVerification(
			task?.verification ?? task?.dod ?? null,
		);
		if (!run.worktreePath || !dod) {
			return {
				passed: false,
				checks: [
					{
						check: "precondition",
						ok: false,
						detail: "run has no worktree or no verification checks apply",
					},
				],
			};
		}
		// Hardened verifier: scrubbed env, per-check timeouts, declared
		// checkPrefix/envPolicy, no guessing at the project (see verifier.ts).
		const runVerification = () =>
			verify(run.worktreePath as string, dod, run.baseSha ?? "", {
				checkPrefix: this.deps.checkPrefix,
				envPolicy: this.deps.envPolicy,
			});
		const result = this.deps.verification
			? await this.deps.verification.foreground(runVerification)
			: await runVerification();
		if (run.taskId) {
			const taskId = run.taskId;
			const stored = await this.deps.handle.withTx(async (tx) => {
				const out = [];
				for (const c of result.checks) {
					out.push(
						await appendEvent(tx, {
							type: "verify.check",
							taskId,
							runId: run.id,
							payload: {
								check: c.check,
								passed: c.ok,
								...(c.classification
									? { classification: c.classification }
									: {}),
								// Keep the tail: test runners print the failure and summary last.
								...(c.detail ? { detail: c.detail.slice(-400) } : {}),
							},
						}),
					);
				}
				return out;
			});
			this.deps.bus.publish(stored);

			// Persist signal deaths (twin of the sweep's `sweep_infra` alarm in
			// maintenance.ts, same threshold). Recorded on every verify so the alarm
			// clears once a check completes.
			await updateInfraState(
				{ handle: this.deps.handle, bus: this.deps.bus, now: () => Date.now() },
				"verify_infra",
				result.crashed ? [taskId] : [],
				"a DoD check was killed by a signal twice in a row: this looks " +
					"like a toolchain or infrastructure problem, not a regression in " +
					"the task's own work",
				(value) => ({
					type: "verify.infra_crash",
					taskId,
					runId: run.id,
					payload: { attempts: value.attempts },
				}),
			);
		}
		return result;
	}

	/** Judge steps never throw; failure is a journaled `failed` status the machine turns into a settle (T14) or a human gate (I5). */
	private async brainCall(built: Built, point: "critic"): Promise<unknown> {
		const { run } = built;
		const ctx: BrainCallCtx = {
			runId: run.id,
			taskId: run.taskId,
			worktreePath: run.worktreePath,
			branch: run.branch,
			baseSha: run.baseSha,
			verify:
				(built.results.get("verify") as VerificationResult | undefined) ?? null,
			report: foldReport(built.results.get("ingest_report"))?.raw ?? null,
		};
		try {
			switch (point) {
				case "critic": {
					const result = await this.deps.brain.critic(ctx);
					await this.tickMetCriteria(built, result).catch((e) => {
						// best-effort: a missed tick never changes the verdict
						this.log.warn(
							{ runId: run.id, err: String(e) },
							"criteria ticking failed",
						);
					});
					return result;
				}
			}
		} catch (e) {
			const reason = e instanceof Error ? e.message : String(e);
			this.log.warn({ runId: run.id, point, err: reason }, "brain call threw");
			return { status: "failed", reason };
		}
	}

	/**
	 * A reviewer that found a criterion met on real evidence (reproduced or
	 * source-confirmed) ticks it on the task's acceptance checklist. Never
	 * unticks; idempotent, so a re-executed critic step is harmless. A board
	 * rule refusing the write only costs the tick.
	 */
	private async tickMetCriteria(
		built: Built,
		result: CriticResult,
	): Promise<void> {
		const taskId = built.run.taskId;
		if (!taskId || result.status !== "ok" || !result.criteria) return;
		const task = await this.deps.tasks.get(taskId);
		if (!task) return;
		const met = new Set(
			result.criteria
				.filter(
					(c) =>
						c.verdict === "met" &&
						c.evidenceClass !== undefined &&
						c.evidenceClass !== "claimed",
				)
				.map((c) => c.criterion.trim()),
		);
		for (const item of task.criteria) {
			if (item.checked || !met.has(item.text.trim())) continue;
			try {
				await this.deps.tasks.editCriteria(
					taskId,
					{ op: "set", selector: item.id ?? item.text, checked: true },
					{ source: "brain" },
				);
			} catch (e) {
				this.log.warn(
					{ taskId, criterion: item.text, err: String(e) },
					"could not tick a criterion the reviewer found met",
				);
			}
		}
	}

	/** Last done.resultText from events.jsonl → lenient JSON plan extraction. */
	private async parsePlan(built: Built): Promise<unknown> {
		const tail = await this.readTail(
			built.run.id,
			"events.jsonl",
			PLAN_TAIL_BYTES,
		);
		let text: string | null = null;
		for (const e of parseAgentEvents(tail)) {
			if (e.type === "done" && e.resultText) text = e.resultText;
		}
		if (!text) return { parsed: false };
		const obj = extractJsonObject(text) as Record<string, unknown> | null;
		const entries = normalizePlanEntries(obj?.tasks);
		if (entries.length === 0) return { parsed: false };
		const plan: ParsedProposal = {
			tasks: entries,
			specs: normalizeSpecEntries(obj?.specs),
			questions: normalizeQuestions(obj?.questions),
		};
		return { parsed: true, plan };
	}

	/**
	 * Work the agent discovered but did not do, filed as manual backlog tasks.
	 * The immutable discovery fingerprint is persisted with the task, so a crash
	 * retry or an identical report from a later repair survives human edits.
	 */
	private async createFollowUps(built: Built): Promise<unknown> {
		const { run } = built;
		const entries =
			foldReport(built.results.get("ingest_report"))?.followUps ?? [];
		const existing = new Map<string, string>();
		for (const t of await this.deps.tasks.list()) {
			if (t.discoveredFrom === run.taskId && t.source === "followup") {
				if (t.discoveryKey) existing.set(t.discoveryKey, t.id);
			}
		}
		const created: string[] = [];
		const reused: string[] = [];
		for (const e of entries) {
			// Hash the immutable ingested discovery, never the editable task title.
			const discoveryKey = createHash("sha256")
				.update(JSON.stringify([run.taskId ?? run.id, e]))
				.digest("hex");
			const prior = existing.get(discoveryKey);
			if (prior) {
				if (!reused.includes(prior)) reused.push(prior);
				continue;
			}
			const row = await this.deps.tasks.create({
				title: e.title,
				body: e.body,
				criteria: e.criteria.map((text) => ({ text })),
				status: "backlog",
				readyMode: "manual",
				source: "followup",
				discoveredFrom: run.taskId,
				discoveryKey,
				parentId: null,
			});
			existing.set(discoveryKey, row.id);
			created.push(row.id);
		}
		return { created, reused };
	}

	/**
	 * Stop what the agent left running when its session ended. Journaled with
	 * the commands so the resume prompt can name them.
	 */
	private async reapLeftovers(
		built: Built,
		begin: BeginStepResult,
	): Promise<unknown> {
		const leftovers = this.deps.leftovers ?? {
			find: (run: RunRow) => findLeftoverProcesses(run),
			stop: (list: readonly LeftoverProcess[]) => stopProcesses(list),
		};
		const prior = begin.result as { processes?: LeftoverProcess[] } | null;
		const processes = [...(prior?.processes ?? [])];
		const stopped = new Set<number>();
		const killed = new Set<number>();
		// A shutdown handler can spawn children. Discover and journal each new
		// identity before signalling it, and require a fresh empty scan to finish.
		for (let attempt = 0; attempt < 8; attempt++) {
			const found = await leftovers.find(built.run);
			for (const p of found) {
				if (
					!processes.some(
						(known) =>
							known.pid === p.pid &&
							known.bootId === p.bootId &&
							known.startTimeTicks === p.startTimeTicks,
					)
				)
					processes.push(p);
			}
			await this.deps.registry.saveStepGuard(built.run.id, "reap_leftovers", {
				processes,
			});
			const targets = attempt === 0 ? processes : found;
			const result: CleanupResult = targets.length
				? await leftovers.stop(targets)
				: { stopped: [], killed: [], absent: [], live: [], unknown: [] };
			for (const pid of result.stopped) stopped.add(pid);
			for (const pid of result.killed) killed.add(pid);
			if (result.live.length || result.unknown.length) {
				throw new Error(
					`Leftover cleanup unconfirmed: live=${result.live.join(",")} unknown=${result.unknown.join(",")}`,
				);
			}
			if ((await leftovers.find(built.run)).length === 0) {
				return { processes, stopped: [...stopped], killed: [...killed] };
			}
		}
		throw new Error(
			"Leftover cleanup did not reach quiescence; keeping run ownership",
		);
	}

	/** The journaled `parse_plan` proposal, or null if it never parsed. */
	private proposal(built: Built): ParsedProposal | null {
		const res = built.results.get("parse_plan") as
			| { plan?: ParsedProposal }
			| undefined;
		return res?.plan ?? null;
	}

	/**
	 * T10Q: the agent's question becomes a clarification on its run (answering
	 * it resumes a child in the same worktree), and the worktree pointer is kept
	 * so housekeeping never collects the work the answer continues. Idempotent
	 * by runId.
	 */
	private async recordQuestion(built: Built): Promise<unknown> {
		const { run } = built;
		const question = foldReport(built.results.get("ingest_report"))?.question;
		if (!question) return { count: 0 };
		const text = question.options.length
			? `${question.text}\n\nSuggested answers: ${question.options.join(" | ")}`
			: question.text;
		await this.deps.clarify.raise({
			runId: run.id,
			kind: "task",
			goal: null,
			questions: [text],
		});
		if (run.taskId && run.worktreePath && run.branch) {
			await this.deps.tasks.recordPreservedWorktree(
				run.taskId,
				run.worktreePath,
				run.branch,
			);
		}
		return { count: 1 };
	}

	/**
	 * The terminal that replaces every policy row (design §6.2): the run's
	 * finalize ends here with a CLASS and the facts the brain decides from.
	 *
	 *  - the task's claim is released to `ready` (a dirty worktree keeps its
	 *    pointer so a `continue:` spawn can reuse it); a competing attempt
	 *    leaves the group's claim alone;
	 *  - the task is parked `awaiting_brain` (a hold, not a board status);
	 *  - `run.settled{runId, taskId, groupId, class, facts}` is appended once
	 *    (a replay finds it), which is what wakes the brain.
	 *
	 * Nothing here decides repair, resume, split or escalation. The informational
	 * stall counter and the review round number are bookkeeping, not policy.
	 */
	private async settle(
		built: Built,
		d: Directive,
		begin: BeginStepResult,
	): Promise<unknown> {
		const cls = d.args?.settle;
		if (!cls) throw new Error("settle: directive carries no class");
		const { run, ctx } = built;
		const competing = ctx.group?.competing === true;
		const groupId = groupIdOf(run);
		const taskId = run.taskId;

		if (taskId && run.kind === "plan") {
			// A plan run expanding a draft holds the draft's claim; the draft stays
			// a draft and the brain applies the proposal with the board tools.
			const held = await this.deps.tasks.get(taskId);
			if (held && held.claimedByRunId === run.id) {
				await this.deps.tasks.release(
					taskId,
					run.id,
					"draft",
					"scheduler",
					`settled: ${cls}`,
				);
			}
		} else if (taskId && !competing) {
			const prior = begin.result as { counted?: boolean } | null;
			if (!prior?.counted) {
				await this.deps.registry.saveStepGuard(run.id, "settle", {
					counted: true,
				});
				if (STALLING_CLASSES.has(cls)) await this.deps.tasks.bumpStall(taskId);
				else await this.deps.tasks.clearStall(taskId);
				if (cls === "review_fix") await this.deps.tasks.bumpReviewRound(taskId);
			}
			await this.releaseTask(built, {
				kind: "step",
				step: "release_task",
				args: { to: "ready" },
				row: d.row,
			});
		}

		const facts = await this.settleFacts(built, cls);
		await recordSettled(this.deps, {
			runId: run.id,
			taskId,
			groupId,
			class: cls,
			facts,
		});
		return { class: cls, groupId, competing, counted: true };
	}

	/** The parsed proposal of a plan, import or draft-expansion run, capped. */
	private proposalFacts(built: Built): Record<string, unknown> {
		const plan = this.proposal(built);
		if (!plan) return { parsed: false };
		const MAX_TASKS = 40;
		const cut = (v: string | undefined, n: number) =>
			v ? v.slice(0, n) : undefined;
		return {
			parsed: true,
			tasks: plan.tasks.slice(0, MAX_TASKS).map((t, i) => ({
				index: i,
				title: t.title.slice(0, 200),
				...(cut(t.body, 600) ? { body: cut(t.body, 600) } : {}),
				dependsOn: t.dependsOn,
				criteria: t.criteria.slice(0, 10).map((c) => c.slice(0, 200)),
				owns: t.owns,
				...(t.status ? { status: t.status } : {}),
				...(t.modelTier ? { modelTier: t.modelTier } : {}),
				...(t.verification ? { verification: t.verification } : {}),
			})),
			...(plan.tasks.length > MAX_TASKS
				? { truncatedTasks: plan.tasks.length - MAX_TASKS }
				: {}),
			specs: plan.specs.slice(0, 10).map((sp) => ({
				title: sp.title.slice(0, 200),
				body: sp.body.slice(0, 1200),
				tasks: sp.tasks,
			})),
			questions: plan.questions.slice(0, 20).map((q) => q.slice(0, 300)),
		};
	}

	/** What a settled run's journal says, trimmed to what a decision needs. */
	private async settleFacts(
		built: Built,
		cls: SettleClass,
	): Promise<Record<string, unknown>> {
		const { run, results, ctx } = built;
		const classify = results.get("classify") as ClassifyResult | undefined;
		const verifyRes = results.get("verify") as
			| {
					passed?: boolean;
					crashed?: boolean;
					checks?: {
						check: string;
						ok: boolean;
						detail?: string;
						classification?: string;
					}[];
			  }
			| undefined;
		const scope = results.get("scope_check") as ScopeCheckResult | undefined;
		const critic = results.get("critic") as CriticResult | undefined;
		const archive = results.get("archive_wip") as ArchiveWipResult | undefined;
		const report = foldReport(results.get("ingest_report"));
		const raw =
			typeof report?.raw === "object" && report.raw !== null
				? (report.raw as Record<string, unknown>)
				: null;
		const str = (v: unknown, n: number) =>
			typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined;
		const failing = (verifyRes?.checks ?? []).filter((c) => !c.ok).slice(0, 5);
		return {
			class: cls,
			attempt: run.attempt,
			outcome: classify?.outcome ?? run.outcome ?? null,
			exitCode: classify?.exitCode ?? run.exitCode ?? null,
			...(classify?.killReason ? { killReason: classify.killReason } : {}),
			branch: run.branch,
			worktree: run.worktreePath,
			...(ctx.task && !verifyRes && ctx.task.exitCode !== 0
				? { noChecks: true }
				: {}),
			...(verifyRes
				? {
						verify: {
							passed: verifyRes.passed === true,
							crashed: verifyRes.crashed === true,
							failing: failing.map((c) => ({
								check: c.check,
								...(c.classification
									? { classification: c.classification }
									: {}),
								tail: (c.detail ?? "").slice(-300),
							})),
						},
					}
				: {}),
			...(scope
				? {
						scope: {
							files: scope.files,
							outside: scope.outside,
							outsideFiles: scope.outsideFiles.slice(0, 10),
						},
					}
				: {}),
			...(critic
				? {
						review: {
							status: critic.status,
							verdict: critic.verdict ?? null,
							round: critic.round ?? null,
							...(critic.cause ? { cause: critic.cause } : {}),
							...(critic.reason ? { reason: critic.reason.slice(0, 300) } : {}),
							findings: (critic.findings ?? []).slice(0, 8).map((f) => ({
								severity: f.severity,
								file: f.file,
								change: f.change.slice(0, 200),
							})),
						},
					}
				: {}),
			...(archive?.ref ? { archivedRef: archive.ref } : {}),
			...(cls === "plan_output" ? { proposal: this.proposalFacts(built) } : {}),
			...(report
				? {
						report: {
							escalation: report.escalation,
							...(str(raw?.status, 80) ? { status: str(raw?.status, 80) } : {}),
							...(str(raw?.summary, 400)
								? { summary: str(raw?.summary, 400) }
								: {}),
							...(report.question
								? { question: report.question.text.slice(0, 400) }
								: {}),
						},
					}
				: {}),
		};
	}

	/** Idempotent by runId (merge_jobs UNIQUE), the queue upserts. */
	private async enqueueMerge(built: Built): Promise<unknown> {
		const { run } = built;
		if (!run.branch) throw new Error("enqueue_merge: run has no branch");
		const targetBranch = run.integrationBranch ?? "main";
		// Mark `merging` BEFORE the job is visible: otherwise the worker could
		// finish the run first and this would drag a terminal run back to
		// `merging`, where nothing revisits it and it holds a slot forever.
		await this.deps.registry.transition(run.id, "merging");
		await this.deps.mergeQueue.enqueue({
			runId: run.id,
			taskId: run.taskId,
			branch: run.branch,
			targetBranch,
		});
		return { enqueued: true, targetBranch };
	}

	private async releaseTask(built: Built, d: Directive): Promise<unknown> {
		const { run } = built;
		const to = (d.args?.to ?? "ready") as TaskStatus;
		if (!run.taskId) return { released: false, detail: "run has no task" };
		// A human who stopped this run and moved its task (`tasks.move` with
		// `cancelRun`) already released the claim: their destination wins. An
		// unclaimed task still in a run-held status, or already at `to` (a
		// replayed step), is released as usual.
		const current = await this.deps.tasks.get(run.taskId);
		if (
			current &&
			current.claimedByRunId === null &&
			current.status !== to &&
			!RUN_HELD_STATUSES.has(current.status)
		) {
			return {
				released: false,
				to: current.status,
				detail:
					"claim already released; the task keeps the status it was moved to",
			};
		}
		const terminal = this.simulateTerminal(built.ctx);
		const reason = terminal?.note ?? terminal?.state ?? `finalize ${d.row}`;
		// Resume-not-restart: a dirty worktree going back to ready keeps its
		// pointer so the next attempt reuses the work.
		if (
			to === "ready" &&
			run.worktreePath &&
			run.branch &&
			(await this.isDirty(
				run,
				foldReportIdentity(built.results.get("ingest_report")),
			))
		) {
			await this.deps.tasks.recordPreservedWorktree(
				run.taskId,
				run.worktreePath,
				run.branch,
			);
		}
		await this.deps.tasks.release(run.taskId, run.id, to, "scheduler", reason);
		return { released: true, to, reason };
	}

	/**
	 * Save a scope-killed run's work to `wip/<task>-<run>` before T4s
	 * force-removes the worktree. A throw fails the step, so nothing removes
	 * the worktree until the snapshot is journaled.
	 */
	private async archiveWip(built: Built): Promise<ArchiveWipResult> {
		const { run } = built;
		if (!run.branch || !run.baseSha) return { ref: null, sha: null };
		const archive = await new WorktreeManager(this.deps.projectRoot).archiveWip(
			{
				// No worktree: archiveWip saves the branch tip instead.
				path: run.worktreePath ?? join(this.deps.projectRoot, ".mfw", "none"),
				branch: run.branch,
				baseSha: run.baseSha,
			},
			{ runId: run.id, taskId: run.taskId },
		);
		const stored = await this.deps.handle.withTx((tx) =>
			appendEvent(tx, {
				type: "run.wip_archived",
				runId: run.id,
				...(run.taskId ? { taskId: run.taskId } : {}),
				payload: {
					ref: archive?.ref ?? null,
					sha: archive?.sha ?? null,
					actor: "scheduler",
					reason: built.ctx.killReason ?? "scope watchdog",
				},
			}),
		);
		this.deps.bus.publish([stored]);
		return { ref: archive?.ref ?? null, sha: archive?.sha ?? null };
	}

	/**
	 * Finish-time scope fact (T12s): what the run changed since its base,
	 * against its task's own `owns`. Reads the worktree when it is still here,
	 * else the branch.
	 */
	private async scopeCheck(built: Built): Promise<ScopeCheckResult> {
		const { run, task } = built;
		const owns = task?.owns ?? [];
		let files: string[] = [];
		const wt = run.worktreePath;
		const present =
			wt !== null &&
			(await access(wt).then(
				() => true,
				() => false,
			));
		if (present && wt && run.baseSha) {
			files = (await changedFiles(wt, run.baseSha)).files;
		} else if (run.branch && run.baseSha) {
			const diff = await git(
				[
					"diff",
					"--name-only",
					"--no-renames",
					"-z",
					`${run.baseSha}..${run.branch}`,
				],
				this.deps.projectRoot,
			);
			if (diff.exitCode !== 0)
				throw new Error(`could not list the run's changes: ${diff.stderr}`);
			files = diff.stdout.split("\0").filter(Boolean);
		}
		const outside = filesOutsideOwns(owns, files);
		return {
			files: files.length,
			outside: outside.length,
			outsideFiles: outside.slice(0, 20),
		};
	}

	private async clearStall(built: Built): Promise<unknown> {
		if (!built.run.taskId) return { skipped: true };
		await this.deps.tasks.clearStall(built.run.taskId);
		return {};
	}

	/** Remove the worktree + branch when clean (or forced); preserve dirty
	 *  work with a task pointer otherwise. Absent worktree = already done. */
	private async gcWorktree(built: Built, force: boolean): Promise<unknown> {
		const { run } = built;
		if (!force && !built.ctx.done.has("ingest_report")) {
			throw new Error(
				"refusing non-forced worktree cleanup before report ingestion is journaled",
			);
		}
		const wt = run.worktreePath;
		if (!wt) return { removed: false, missing: true };
		const exists = await access(wt).then(
			() => true,
			() => false,
		);
		if (!exists) {
			if (run.taskId) await this.deps.tasks.clearPreservedWorktree(run.taskId);
			return { removed: false, missing: true };
		}
		const reportIdentity = foldReportIdentity(
			built.results.get("ingest_report"),
		);
		if (!force && !reportIdentity) {
			throw new Error(
				"refusing non-forced worktree cleanup without journaled report identity",
			);
		}
		if (!force && (await this.isDirty(run, reportIdentity))) {
			if (run.taskId && run.branch) {
				await this.deps.tasks.recordPreservedWorktree(
					run.taskId,
					wt,
					run.branch,
				);
			}
			return { removed: false, preserved: true };
		}
		if (!run.branch || !run.baseSha) {
			if (run.taskId && run.branch) {
				await this.deps.tasks.recordPreservedWorktree(
					run.taskId,
					wt,
					run.branch,
				);
			}
			return {
				removed: false,
				preserved: true,
				reason: "durable worktree ownership is incomplete",
			};
		}
		await new WorktreeManager(this.deps.projectRoot).remove(
			{ path: wt, branch: run.branch, baseSha: run.baseSha },
			{ force, reportIdentity },
		);
		if (run.taskId) await this.deps.tasks.clearPreservedWorktree(run.taskId);
		return { removed: true };
	}

	private async notifyStep(built: Built, d: Directive): Promise<unknown> {
		const reason = d.args?.reason ?? "blocked";
		const scopeNote =
			reason === "scope_violation"
				? this.simulateTerminal(built.ctx)?.note
				: undefined;
		try {
			await this.deps.notifier.notify(reason, {
				runId: built.run.id,
				...(built.run.taskId ? { taskId: built.run.taskId } : {}),
				...(scopeNote ? { message: scopeNote } : {}),
			});
		} catch (e) {
			// best-effort: notify is re-send-acceptable; losing a ping must not
			// park a finalization
			this.log.warn({ runId: built.run.id, err: e }, "notify failed");
		}
		return { reason };
	}
}
