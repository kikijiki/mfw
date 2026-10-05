import type { ProjectDbHandle } from "@mfw/db/client";
import { decisions, events, mergeJobs, runs } from "@mfw/db/schema";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { TaskService } from "./task-service.ts";

/** Health and metrics, derived entirely from tables the engine already writes (no separate bookkeeping to drift). */

export interface LoopStats {
	lastPassAt: number;
	lastPassMs: number;
	passErrors: number;
	kills?: Record<string, number>;
}

export interface HealthDeps {
	handle: ProjectDbHandle;
	tasks: TaskService;
	bootId: string;
	startedAt: number;
	supervisor?: { stats: LoopStats };
	scheduler?: { status(): unknown | Promise<unknown> };
	brain?: { counters(): unknown };
	admission?: { health(): unknown | Promise<unknown> };
	now?: () => number;
}

export interface HealthSnapshot {
	bootId: string;
	startedAt: number;
	uptimeMs: number;
	/** Liveness: time since each loop last completed a pass; a stalled loop means wedged. */
	supervisor: LoopStats & { staleMs: number | null };
	scheduler: unknown | null;
	runs: { byState: Record<string, number>; active: number };
	tasks: { byStatus: Record<string, number> };
	mergeQueue: { depth: number; parked: number };
	brain: unknown | null;
	admission: unknown | null;
	errors: { recent: number };
	events: { total: number; lastSeq: number };
}

export class Health {
	private readonly now: () => number;

	constructor(private readonly deps: HealthDeps) {
		this.now = deps.now ?? (() => Date.now());
	}

	async snapshot(): Promise<HealthSnapshot> {
		const db = this.deps.handle.db;
		const now = this.now();

		const [runRows, boardTasks, mergeRows, eventAgg] = await Promise.all([
			db
				.select({ state: runs.state, n: sql<number>`count(*)` })
				.from(runs)
				.groupBy(runs.state),
			this.deps.tasks.list(),
			db
				.select({ state: mergeJobs.state, n: sql<number>`count(*)` })
				.from(mergeJobs)
				.groupBy(mergeJobs.state),
			db
				.select({
					total: sql<number>`count(*)`,
					lastSeq: sql<number>`COALESCE(MAX(${events.seq}), 0)`,
				})
				.from(events),
		]);

		const byState: Record<string, number> = {};
		for (const r of runRows) byState[r.state] = Number(r.n);
		const byStatus: Record<string, number> = {};
		for (const t of boardTasks)
			byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
		const merge: Record<string, number> = {};
		for (const m of mergeRows) merge[m.state] = Number(m.n);

		const supStats = this.deps.supervisor?.stats ?? {
			lastPassAt: 0,
			lastPassMs: 0,
			passErrors: 0,
		};

		return {
			bootId: this.deps.bootId,
			startedAt: this.deps.startedAt,
			uptimeMs: now - this.deps.startedAt,
			supervisor: {
				...supStats,
				staleMs: supStats.lastPassAt ? now - supStats.lastPassAt : null,
			},
			scheduler: (await this.deps.scheduler?.status()) ?? null,
			runs: {
				byState,
				active:
					(byState.starting ?? 0) +
					(byState.running ?? 0) +
					(byState.ended ?? 0) +
					(byState.finalizing ?? 0) +
					(byState.merging ?? 0),
			},
			tasks: { byStatus },
			mergeQueue: {
				depth:
					(merge.queued ?? 0) +
					(merge.merging ?? 0) +
					(merge.rebasing ?? 0) +
					(merge.reverifying ?? 0),
				parked: merge.parked ?? 0,
			},
			brain: this.deps.brain?.counters() ?? null,
			admission: (await this.deps.admission?.health()) ?? null,
			errors: { recent: supStats.passErrors },
			events: {
				total: Number(eventAgg[0]?.total ?? 0),
				lastSeq: Number(eventAgg[0]?.lastSeq ?? 0),
			},
		};
	}

	/** Rollups over a window for the dashboard. Derived from run rows, so repair/resume attempts and their costs are included. */
	async metrics(windowMs = 7 * 86_400_000): Promise<RunMetrics> {
		const since = new Date(this.now() - windowMs);
		const rows = await this.deps.handle.db
			.select({
				kind: runs.kind,
				state: runs.state,
				startedAt: runs.startedAt,
				finishedAt: runs.finishedAt,
				usage: runs.usage,
			})
			.from(runs)
			.where(gte(runs.startedAt, since));

		let costUsd = 0;
		let inputTokens = 0;
		let outputTokens = 0;
		const durations: number[] = [];
		const byOutcome: Record<string, number> = {};
		const byKind: Record<string, number> = {};

		for (const r of rows) {
			byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
			byOutcome[r.state] = (byOutcome[r.state] ?? 0) + 1;
			if (r.finishedAt)
				durations.push(r.finishedAt.getTime() - r.startedAt.getTime());
			const u = r.usage ?? {};
			costUsd += u.costUsd ?? 0;
			inputTokens += u.inputTokens ?? 0;
			outputTokens += u.outputTokens ?? 0;
		}

		const terminalFail =
			(byOutcome.failed ?? 0) +
			(byOutcome.killed ?? 0) +
			(byOutcome.finalize_error ?? 0);
		const terminalOk = byOutcome.completed ?? 0;
		const decided = terminalOk + terminalFail;

		return {
			windowMs,
			runs: rows.length,
			byKind,
			byOutcome,
			failureRate: decided > 0 ? terminalFail / decided : 0,
			durationMs: percentiles(durations),
			spend: { costUsd, inputTokens, outputTokens },
		};
	}

	/** "Why is this task here?": the task's runs, decisions and events in one query. */
	async taskTrace(taskId: string): Promise<TaskTrace> {
		const db = this.deps.handle.db;
		const [runRows, decisionRows, eventRows] = await Promise.all([
			db
				.select()
				.from(runs)
				.where(eq(runs.taskId, taskId))
				.orderBy(desc(runs.startedAt)),
			db
				.select()
				.from(decisions)
				.where(eq(decisions.taskId, taskId))
				.orderBy(desc(decisions.ts)),
			db
				.select()
				.from(events)
				.where(eq(events.taskId, taskId))
				.orderBy(desc(events.seq))
				.limit(200),
		]);
		return {
			taskId,
			runs: runRows.map((r) => ({
				runId: r.id,
				kind: r.kind,
				state: r.state,
				outcome: r.outcome,
				note: r.note,
				attempt: r.attempt,
				startedAt: r.startedAt.getTime(),
				finishedAt: r.finishedAt?.getTime() ?? null,
			})),
			decisions: decisionRows.map((d) => ({
				id: d.id,
				role: d.role,
				status: d.status,
				action: d.action,
				reason: d.reason,
				ts: d.ts.getTime(),
			})),
			events: eventRows.map((e) => ({
				seq: e.seq,
				type: e.type,
				ts: e.ts.getTime(),
				payload: e.payload,
			})),
		};
	}

	/** Runs that ended but never reached a terminal state. */
	async stuckRuns(olderThanMs = 10 * 60_000): Promise<string[]> {
		const cutoff = new Date(this.now() - olderThanMs);
		const rows = await this.deps.handle.db
			.select({ id: runs.id })
			.from(runs)
			.where(
				and(
					inArray(runs.state, ["ended", "finalizing", "merging"]),
					lte(runs.startedAt, cutoff),
				),
			);
		return rows.map((r) => r.id);
	}
}

export interface RunMetrics {
	windowMs: number;
	runs: number;
	byKind: Record<string, number>;
	byOutcome: Record<string, number>;
	failureRate: number;
	durationMs: { p50: number; p95: number; max: number };
	spend: { costUsd: number; inputTokens: number; outputTokens: number };
}

export interface TaskTrace {
	taskId: string;
	runs: {
		runId: string;
		kind: string;
		state: string;
		outcome: string | null;
		note: string | null;
		attempt: number;
		startedAt: number;
		finishedAt: number | null;
	}[];
	decisions: {
		id: number;
		role: string;
		status: string;
		action: string | null;
		reason: string | null;
		ts: number;
	}[];
	events: { seq: number; type: string; ts: number; payload: unknown }[];
}

function percentiles(values: number[]): {
	p50: number;
	p95: number;
	max: number;
} {
	if (values.length === 0) return { p50: 0, p95: 0, max: 0 };
	const sorted = [...values].sort((a, b) => a - b);
	const at = (q: number) =>
		sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
	return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] ?? 0 };
}
