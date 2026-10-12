import type { ProjectDbHandle } from "@mfw/db/client";
import {
	listAttemptOutcomes,
	OUTCOME_GROUP_KEYS,
	type OutcomeGroupKey,
	outcomePrior,
	summarizeOutcomes,
} from "@mfw/db/outcomes";
import {
	type DecisionContextRefs,
	decisions,
	engineKv,
	reviewVerdicts,
} from "@mfw/db/schema";
import { spendTotals } from "@mfw/db/spend";
import { and, desc, eq, gte, or } from "drizzle-orm";
import { z } from "zod";
import { parseAgentEvents } from "../agents/events.ts";
import { git } from "../git.ts";
import type { Logger } from "../log.ts";
import type { ProviderHold } from "../routing.ts";
import type { RunRegistry, RunRow } from "../run-registry.ts";
import type { TaskService, TaskWithRefs } from "../task-service.ts";
import type { UsageSubscription } from "../usage-monitor.ts";

/**
 * The brain's read tools (design §2.2): no audit row, rate-limited. They are
 * the only way a turn sees more than its digest. `refsFor` hands the act
 * tools what a turn looked at, for `decisions.context_refs`.
 */

/** What the read and act tools need to know about the running daemon. */
export interface BrainWorld {
	maxConcurrent(): number;
	/** Most planning runs (`spawn` role `plan`) live at once; default 2. */
	maxPlanRuns?(): number;
	/** Provider holds currently in force, keyed by hold key. */
	providerHolds?(): Promise<Record<string, ProviderHold>>;
	/** Subscription usage windows (`UsageMonitor.snapshot`): report only, holds are in `providerHolds`. */
	subscriptionUsage?(): UsageSubscription[];
	/** Budgets with current spend (`BudgetService.list`), for `capacity`. */
	budgets?(): Promise<
		{
			id: string;
			key: string;
			kind: string;
			unit: string;
			used: number;
			limit: number;
			phase: string;
			windowResetsAt: number;
		}[]
	>;
	/** The exhausted resource budget a task depends on, or null (`BudgetService.holdFor`). */
	budgetHold?(task: {
		requiresResources?: readonly (string | { id: string })[] | null;
		executionTarget?: string | null;
	}): Promise<{ key: string; until: number; reason: string } | null>;
	/** `set_budget` validation against the configured ceiling (`BudgetService.checkBrainLimit`). */
	checkBudget?(input: {
		budget: string;
		limitUsd?: number;
		limitTokens?: number;
		window?: string;
	}): Promise<
		| { ok: true; id: string; limit: number; ceiling: number; unit: string }
		| { ok: false; code: string; message: string; fix: string }
	>;
	/** The route's hold for a task, when its account is held. */
	routeHeld?(
		task: TaskWithRefs,
		/** The brain's own harness / model pick, when the call names one. */
		pick?: { provider?: string; model?: string },
	): Promise<{ key: string; until: number; reason: string } | null>;
	/** Master stop and per-project pause, as a reason. */
	dispatchPaused?():
		| { reason: string }
		| null
		| Promise<{ reason: string } | null>;
}

export class BrainReadError extends Error {
	constructor(
		readonly code:
			| "unknown_tool"
			| "invalid_args"
			| "not_found"
			| "rate_limited",
		message: string,
	) {
		super(message);
		this.name = "BrainReadError";
	}
}

export interface BrainReadDeps {
	handle: ProjectDbHandle;
	tasks: TaskService;
	registry: RunRegistry;
	world: BrainWorld;
	projectRoot: string;
	log: Logger;
	now?: () => number;
	/** Reads per turn before `rate_limited`. */
	maxReadsPerTurn?: number;
}

const LIVE_STATES = ["starting", "running", "ended", "finalizing"] as const;

const BoardArgs = z
	.object({
		filter: z
			.object({
				status: z.string().optional(),
				parent: z.string().optional(),
				type: z.string().optional(),
				ids: z.array(z.string()).optional(),
			})
			.optional(),
		limit: z.number().int().positive().max(500).optional(),
	})
	.strict();
const IdArgs = z.object({ id: z.string().min(1) }).strict();
const FrontierArgs = z
	.object({ limit: z.number().int().positive().max(100).optional() })
	.strict();
const RunsArgs = z
	.object({
		filter: z
			.object({
				live: z.boolean().optional(),
				taskId: z.string().optional(),
				role: z.string().optional(),
				groupId: z.string().optional(),
			})
			.optional(),
		limit: z.number().int().positive().max(200).optional(),
	})
	.strict();
const RunArgs = z.object({ runId: z.string().min(1) }).strict();
const RunLogArgs = z
	.object({
		runId: z.string().min(1),
		tail: z.number().int().positive().max(200).optional(),
		grep: z.string().max(200).optional(),
	})
	.strict();
const DiffArgs = z
	.object({
		runId: z.string().min(1),
		path: z.string().optional(),
		maxBytes: z.number().int().positive().max(100_000).optional(),
	})
	.strict();
const OutcomesArgs = z
	.object({
		groupBy: z.array(z.enum(OUTCOME_GROUP_KEYS)).max(4).default([]),
		sinceDays: z.number().int().positive().max(365).optional(),
		filter: z
			.object({
				harness: z.string().optional(),
				model: z.string().optional(),
				tier: z.string().optional(),
				size: z.string().optional(),
			})
			.optional(),
	})
	.strict();
const DecisionsArgs = z
	.object({
		filter: z
			.object({
				taskId: z.string().optional(),
				kind: z.string().optional(),
				since: z.number().optional(),
			})
			.optional(),
		limit: z.number().int().positive().max(100).optional(),
	})
	.strict();

export const READ_TOOLS = [
	"board",
	"task",
	"frontier",
	"runs",
	"run_report",
	"run_log",
	"diff",
	"capacity",
	"outcomes",
	"decisions",
] as const;
export type ReadTool = (typeof READ_TOOLS)[number];

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function taskSummary(t: TaskWithRefs) {
	return {
		id: t.id,
		title: t.title,
		status: t.status,
		parent: t.parentId,
		depends_on: t.dependsOn,
		owns: t.owns,
		size: t.size,
		type: t.type,
		priority: t.priority,
		labels: t.labels,
		rev: t.contentRev,
		claimedByRunId: t.claimedByRunId,
	};
}

function runSummary(r: RunRow) {
	return {
		id: r.id,
		kind: r.kind,
		taskId: r.taskId,
		label: r.label,
		parentRunId: r.parentRunId,
		harness: r.harness ?? r.providerId,
		model: r.model,
		effort: r.reasoningEffort,
		target: r.executionTarget,
		state: r.state,
		outcome: r.outcome,
		activity: r.activity,
		attempt: r.attempt,
		startedAt: r.startedAt.getTime(),
		finishedAt: r.finishedAt?.getTime() ?? null,
		usage: r.usage,
		nativeSessionId: r.nativeSessionId,
	};
}

export class BrainReadService {
	private readonly now: () => number;
	private readonly reads = new Map<string, number>();
	private readonly refs = new Map<
		string,
		{ events: Set<number>; runs: Set<string>; tasks: Map<string, number> }
	>();

	constructor(private readonly deps: BrainReadDeps) {
		this.now = deps.now ?? (() => Date.now());
	}

	/** What a turn has read so far, for `decisions.context_refs`. */
	refsFor(turnRunId: string): DecisionContextRefs | null {
		const r = this.refs.get(turnRunId);
		if (!r) return null;
		return {
			events: [...r.events].sort((a, b) => a - b),
			runs: [...r.runs],
			tasks: [...r.tasks].map(([id, rev]) => ({ id, rev })),
		};
	}

	/** Free a finished turn's bookkeeping. */
	forget(turnRunId: string): void {
		this.reads.delete(turnRunId);
		this.refs.delete(turnRunId);
	}

	private track(turnRunId: string | undefined) {
		if (!turnRunId) return null;
		let r = this.refs.get(turnRunId);
		if (!r) {
			r = { events: new Set(), runs: new Set(), tasks: new Map() };
			this.refs.set(turnRunId, r);
		}
		return r;
	}

	async read(
		tool: string,
		args: unknown,
		opts: { turnRunId?: string } = {},
	): Promise<unknown> {
		if (!(READ_TOOLS as readonly string[]).includes(tool)) {
			throw new BrainReadError("unknown_tool", `unknown read tool '${tool}'`);
		}
		if (opts.turnRunId) {
			const n = (this.reads.get(opts.turnRunId) ?? 0) + 1;
			this.reads.set(opts.turnRunId, n);
			if (n > (this.deps.maxReadsPerTurn ?? 200)) {
				throw new BrainReadError(
					"rate_limited",
					"too many read calls in this turn: decide with what you have, or end the turn",
				);
			}
		}
		const refs = this.track(opts.turnRunId);
		const parse = <T extends z.ZodType>(schema: T): z.infer<T> => {
			const r = schema.safeParse(args ?? {});
			if (!r.success) {
				throw new BrainReadError(
					"invalid_args",
					r.error.issues
						.map((i) => `${i.path.join(".")}: ${i.message}`)
						.join("; "),
				);
			}
			return r.data;
		};
		switch (tool as ReadTool) {
			case "board": {
				const a = parse(BoardArgs);
				const all = await this.deps.tasks.list();
				const f = a.filter ?? {};
				const rows = all
					.filter(
						(t) =>
							(!f.status || t.status === f.status) &&
							(!f.parent || t.parentId === f.parent) &&
							(!f.type || t.type === f.type) &&
							(!f.ids || f.ids.includes(t.id)),
					)
					.slice(0, a.limit ?? 200);
				for (const t of rows) refs?.tasks.set(t.id, t.contentRev);
				return { tasks: rows.map(taskSummary), total: all.length };
			}
			case "task": {
				const { id } = parse(IdArgs);
				const t = await this.deps.tasks.get(id);
				if (!t) throw new BrainReadError("not_found", `unknown task ${id}`);
				refs?.tasks.set(t.id, t.contentRev);
				const spec = await this.deps.tasks.getSpec(id).catch(() => null);
				const runs = await this.deps.registry.list({ taskId: id });
				return {
					...taskSummary(t),
					body: clip(t.body, 20_000),
					spec: spec ? clip(JSON.stringify(spec), 20_000) : null,
					acceptance: t.criteria,
					verification: t.verification,
					claim: {
						claimedByRunId: t.claimedByRunId,
						leaseExpiresAt: t.leaseExpiresAt?.getTime() ?? null,
					},
					runState: {
						attempts: t.attemptCount,
						stalls: t.stallCount,
						resumes: t.resumeCount,
						reviewRound: t.reviewRound,
					},
					runs: runs.slice(-20).map(runSummary),
				};
			}
			case "frontier": {
				const { limit } = parse(FrontierArgs);
				return { tasks: await this.frontier(limit ?? 20, refs) };
			}
			case "runs": {
				const a = parse(RunsArgs);
				const f = a.filter ?? {};
				const rows = await this.deps.registry.list({
					...(f.live ? { states: [...LIVE_STATES] } : {}),
					...(f.taskId ? { taskId: f.taskId } : {}),
				});
				const out = rows
					.filter((r) => r.kind !== "brain")
					.slice(-(a.limit ?? 50))
					.reverse();
				for (const r of out) refs?.runs.add(r.id);
				return { runs: out.map(runSummary) };
			}
			case "run_report": {
				const { runId } = parse(RunArgs);
				refs?.runs.add(runId);
				return this.runReport(runId);
			}
			case "run_log": {
				const a = parse(RunLogArgs);
				refs?.runs.add(a.runId);
				return this.runLog(a.runId, a.tail ?? 40, a.grep);
			}
			case "diff": {
				const a = parse(DiffArgs);
				refs?.runs.add(a.runId);
				return this.diff(a.runId, a.path, a.maxBytes ?? 20_000);
			}
			case "capacity":
				return this.capacity();
			case "outcomes": {
				const a = parse(OutcomesArgs);
				const since = a.sinceDays
					? new Date(this.now() - a.sinceDays * 86_400_000)
					: undefined;
				const rows = await listAttemptOutcomes(
					this.deps.handle.db,
					since ? { since } : {},
				);
				return {
					summaries: summarizeOutcomes(rows, a.groupBy as OutcomeGroupKey[]),
					...(a.filter
						? { prior: outcomePrior(rows, a.filter as never, 10) }
						: {}),
				};
			}
			case "decisions": {
				const a = parse(DecisionsArgs);
				return {
					decisions: await this.decisionRows(a.filter ?? {}, a.limit ?? 30),
				};
			}
		}
	}

	/** Ready tasks, most unblocking first (the number of tasks that depend on each). */
	async frontier(
		limit: number,
		refs?: ReturnType<BrainReadService["track"]>,
	): Promise<
		(ReturnType<typeof taskSummary> & {
			unblocks: number;
			held: { key: string; until: number; reason: string } | null;
		})[]
	> {
		const ready = await this.deps.tasks.readySet();
		const graph = await this.deps.tasks.graph();
		const unblocks = new Map<string, number>();
		for (const e of graph.edges) {
			unblocks.set(e.to, (unblocks.get(e.to) ?? 0) + 1);
		}
		const ranked = ready
			.map((t) => ({ t, n: unblocks.get(t.id) ?? 0 }))
			.sort((a, b) => b.n - a.n || a.t.num - b.t.num)
			.slice(0, limit);
		const out = [];
		for (const { t, n } of ranked) {
			refs?.tasks.set(t.id, t.contentRev);
			out.push({
				...taskSummary(t),
				unblocks: n,
				held: (await this.deps.world.routeHeld?.(t).catch(() => null)) ?? null,
			});
		}
		return out;
	}

	private async runReport(runId: string) {
		const run = await this.deps.registry.get(runId);
		if (!run) throw new BrainReadError("not_found", `unknown run ${runId}`);
		const steps = await this.deps.registry.steps(runId);
		const stepOf = (name: string) =>
			steps.find((s) => s.step === name && s.status === "done")?.result;
		const verdicts = await this.deps.handle.db
			.select()
			.from(reviewVerdicts)
			.where(eq(reviewVerdicts.subjectRunId, runId));
		let diffStat: string | null = null;
		if (run.worktreePath && run.baseSha && run.kind !== "brain") {
			const r = await git(
				["diff", "--stat", run.baseSha, "HEAD"],
				run.worktreePath,
			).catch(() => null);
			diffStat = r && r.exitCode === 0 ? clip(r.stdout, 4000) : null;
		}
		return {
			run: runSummary(run),
			verify: stepOf("verify") ?? null,
			scope: stepOf("scope_check") ?? run.scopeSample ?? null,
			report: clip(JSON.stringify(stepOf("ingest_report") ?? null), 6000),
			critic: stepOf("critic") ?? null,
			verdicts: verdicts.map((v) => ({
				mode: v.mode,
				verdict: v.verdict,
				round: v.round,
				reviewer: `${v.reviewerHarness ?? "?"}:${v.reviewerModel ?? "?"}`,
				findings: v.findings,
				independent: v.independent,
			})),
			steps: steps.map((s) => ({ step: s.step, status: s.status })),
			diffStat,
			costUsd: run.usage?.costUsd ?? null,
			nativeSessionId: run.nativeSessionId,
		};
	}

	private async runLog(runId: string, tail: number, grep?: string) {
		const run = await this.deps.registry.get(runId);
		if (!run) throw new BrainReadError("not_found", `unknown run ${runId}`);
		const { chunk } = await this.deps.registry.readOutput(
			runId,
			"events.jsonl",
		);
		let entries = parseAgentEvents(chunk)
			.filter((e) => e.type !== "hello" && e.type !== "session")
			.map((e) => {
				const o = e as unknown as Record<string, unknown>;
				const text =
					typeof o.text === "string"
						? o.text
						: typeof o.output === "string"
							? o.output
							: typeof o.message === "string"
								? o.message
								: JSON.stringify(o.input ?? o);
				return { seq: o.seq, type: e.type, text: clip(String(text), 600) };
			});
		if (grep) {
			const re = new RegExp(grep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
			entries = entries.filter((e) => re.test(e.text));
		}
		return { runId, total: entries.length, entries: entries.slice(-tail) };
	}

	private async diff(
		runId: string,
		path: string | undefined,
		maxBytes: number,
	) {
		const run = await this.deps.registry.get(runId);
		if (!run) throw new BrainReadError("not_found", `unknown run ${runId}`);
		if (!run.worktreePath || !run.baseSha || run.kind === "brain") {
			throw new BrainReadError(
				"not_found",
				`run ${runId} has no worktree diff`,
			);
		}
		const r = await git(
			["diff", run.baseSha, "HEAD", ...(path ? ["--", path] : [])],
			run.worktreePath,
		);
		if (r.exitCode !== 0) {
			throw new BrainReadError("not_found", `diff unavailable: ${r.stderr}`);
		}
		return {
			runId,
			bytes: r.stdout.length,
			truncated: r.stdout.length > maxBytes,
			diff: clip(r.stdout, maxBytes),
		};
	}

	async capacity() {
		const live = (
			await this.deps.registry.list({ states: [...LIVE_STATES] })
		).filter((r) => r.kind !== "brain");
		const kv = async (key: string) =>
			(
				await this.deps.handle.db
					.select()
					.from(engineKv)
					.where(eq(engineKv.key, key))
			)[0]?.value ?? null;
		const day = new Date(this.now() - 86_400_000);
		const [agent, brain] = await Promise.all([
			spendTotals(this.deps.handle.db, { since: day, kind: "agent" }),
			spendTotals(this.deps.handle.db, { since: day, kind: "brain" }),
		]);
		return {
			maxConcurrent: this.deps.world.maxConcurrent(),
			liveWorkerRuns: live.length,
			providerHolds: (await this.deps.world.providerHolds?.()) ?? {},
			subscriptionUsage: capacityUsage(
				this.deps.world.subscriptionUsage?.() ?? [],
				this.now(),
			),
			budgets: (await this.deps.world.budgets?.()) ?? [],
			mainRed: (await kv("main_red")) as { red?: boolean } | null,
			dispatchHold: await kv("dispatch_hold"),
			dispatchPaused: this.deps.world.dispatchPaused?.() ?? null,
			spendLast24h: {
				agent: { usd: agent.usd, tokensIn: agent.tokensIn },
				brain: { usd: brain.usd, tokensIn: brain.tokensIn },
			},
		};
	}

	private async decisionRows(
		f: { taskId?: string; kind?: string; since?: number },
		limit: number,
	) {
		const conds = [
			or(eq(decisions.role, "brain"), eq(decisions.kind, "rollover")),
			f.taskId ? eq(decisions.taskId, f.taskId) : undefined,
			f.kind ? eq(decisions.kind, f.kind as never) : undefined,
			f.since ? gte(decisions.ts, new Date(f.since)) : undefined,
		].filter((c) => c !== undefined);
		const rows = await this.deps.handle.db
			.select()
			.from(decisions)
			.where(and(...conds))
			.orderBy(desc(decisions.id))
			.limit(limit);
		return rows.map((d) => ({
			id: d.id,
			ts: d.ts.getTime(),
			kind: d.kind,
			action: d.action,
			taskId: d.taskId,
			reason: d.reason,
			confidence: d.confidence,
			status: d.output?.status ?? d.status,
			outcome: d.outcome,
			overriddenBy: d.overriddenBy,
		}));
	}
}

/** What the brain sees of a subscription: windows only, the numbers it can route on. */
export interface CapacityUsage {
	provider: string;
	status: string;
	windows: {
		label: string;
		usedPercent: number;
		resetsInMinutes: number | null;
	}[];
}

export function capacityUsage(
	subs: readonly UsageSubscription[],
	now: number,
): CapacityUsage[] {
	return subs.map((s) => ({
		provider: s.provider,
		status: s.status,
		windows: s.windows.map((w) => ({
			label: w.label,
			usedPercent: Math.round(w.usedPercent),
			resetsInMinutes:
				w.resetsAt === null
					? null
					: Math.max(0, Math.round((w.resetsAt - now) / 60_000)),
		})),
	}));
}

/** Digest lines for windows worth a routing decision (80% and up) and for providers whose usage is unknown. */
export function usageDigestLines(usage: readonly CapacityUsage[]): string[] {
	const hot: string[] = [];
	const unknown: string[] = [];
	for (const u of usage) {
		if (u.status === "unavailable") unknown.push(u.provider);
		for (const w of u.windows) {
			if (w.usedPercent < 80) continue;
			const reset =
				w.resetsInMinutes === null ? "" : `, resets in ${w.resetsInMinutes}m`;
			hot.push(
				`${u.provider} ${w.label} ${w.usedPercent}%${reset}${u.status === "stale" ? " (stale)" : ""}`,
			);
		}
	}
	const out: string[] = [];
	if (hot.length)
		out.push(`Subscription windows nearly used: ${hot.join("; ")}.`);
	if (unknown.length)
		out.push(`Subscription usage unknown for: ${unknown.join(", ")}.`);
	return out;
}
