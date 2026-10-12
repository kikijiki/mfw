import { and, eq, gte, inArray, isNotNull } from "drizzle-orm";
import type { ProjectDb, ProjectDbTx } from "./client.ts";
import {
	type AttemptFinal,
	decisions,
	engineKv,
	mergeJobs,
	reviewVerdicts,
	runSteps,
	runs,
	taskAttemptOutcomes,
} from "./schema.ts";

/**
 * Task attempt outcomes: one `task_attempt_outcomes` row per attempt chain.
 *
 * A chain is a root `task` run plus every `task` run that continues it in the
 * same worktree through `parent_run_id` (repair, resume and merge-unblock
 * children). A human rejection or any fresh dispatch starts a new chain.
 * Regression-recovery runs (`kind: "repair"`) never belong to a task chain.
 *
 * The row is a derived cache: `rollupAttemptChain` recomputes it from `runs`,
 * `run_steps`, `merge_jobs` and `review_verdicts` from scratch, and writes only
 * when something changed. Recording twice, or backfilling over recorded rows,
 * therefore converges on the same table.
 */

/** A DB or a transaction: daemon callers run these inside `withTx`, since
 * libSQL cannot interleave bare statements with another interactive tx. */
export type OutcomeDb = ProjectDb | ProjectDbTx;
type RunRow = typeof runs.$inferSelect;
type StepRow = typeof runSteps.$inferSelect;
export type AttemptOutcomeRow = typeof taskAttemptOutcomes.$inferSelect;

/** Run states that can still change the chain's outcome. */
const OPEN_RUN_STATES = new Set([
	"starting",
	"running",
	"ended",
	"finalizing",
	"merging",
]);
/** Merge-job states that are still on their way to merged / parked. */
const OPEN_MERGE_STATES = new Set([
	"queued",
	"merging",
	"rebasing",
	"reverifying",
]);
const SCOPE_KILLS = new Set(["watchdog-scope", "watchdog-files"]);

/** Vendor serving the model for a harness id; null when the harness does not say. */
export function harnessVendor(harness: string | null): string | null {
	switch (harness) {
		case "claude-cli":
			return "anthropic";
		case "codex-cli":
			return "openai";
		default:
			return null;
	}
}

/** The chain root of a task run, or null for a run that is not a task attempt. */
export async function attemptChainRoot(
	db: OutcomeDb,
	runId: string,
): Promise<string | null> {
	const seen = new Set<string>();
	let [cur] = await db.select().from(runs).where(eq(runs.id, runId));
	if (cur?.kind !== "task" || !cur.taskId) return null;
	while (cur.parentRunId && !seen.has(cur.id)) {
		seen.add(cur.id);
		const [parent] = await db
			.select()
			.from(runs)
			.where(eq(runs.id, cur.parentRunId));
		// A pruned or foreign parent ends the lineage: this run is the root.
		if (parent?.kind !== "task" || parent.taskId !== cur.taskId) break;
		cur = parent;
	}
	return cur.id;
}

/** Chain members (root first, then by start time) from one task's runs. */
function chainMembers(root: RunRow, taskRuns: RunRow[]): RunRow[] {
	const children = new Map<string, RunRow[]>();
	for (const r of taskRuns) {
		if (r.kind !== "task" || !r.parentRunId) continue;
		const list = children.get(r.parentRunId) ?? [];
		list.push(r);
		children.set(r.parentRunId, list);
	}
	const out: RunRow[] = [];
	const seen = new Set<string>();
	const queue = [root];
	while (queue.length > 0) {
		const r = queue.shift() as RunRow;
		if (seen.has(r.id)) continue;
		seen.add(r.id);
		out.push(r);
		queue.push(...(children.get(r.id) ?? []));
	}
	return [
		root,
		...out
			.slice(1)
			.sort(
				(a, b) =>
					a.startedAt.getTime() - b.startedAt.getTime() ||
					a.id.localeCompare(b.id),
			),
	];
}

function childIdOf(step: StepRow | undefined): string | null {
	const r = step?.result as { childRunId?: unknown } | null | undefined;
	return typeof r?.childRunId === "string" ? r.childRunId : null;
}

function sumKey(
	members: RunRow[],
	...keys: string[]
): { total: number | null; reported: number } {
	let total: number | null = null;
	let reported = 0;
	for (const r of members) {
		const u = r.usage ?? null;
		const v = u
			? keys.map((k) => u[k]).find((x) => typeof x === "number")
			: undefined;
		if (typeof v !== "number") continue;
		total = (total ?? 0) + v;
		reported++;
	}
	return { total, reported };
}

type OutcomeValues = Omit<AttemptOutcomeRow, "updatedAt">;

/** Pure fold of one chain's facts into its outcome row. Exported for tests. */
export function foldAttemptChain(input: {
	members: RunRow[];
	steps: StepRow[];
	merges: (typeof mergeJobs.$inferSelect)[];
	verdicts: (typeof reviewVerdicts.$inferSelect)[];
}): OutcomeValues {
	const { members, steps, merges, verdicts } = input;
	const root = members[0] as RunRow;
	const ids = new Set(members.map((m) => m.id));
	const stepsOf = new Map<string, Map<string, StepRow>>();
	for (const s of steps) {
		const m = stepsOf.get(s.runId) ?? new Map<string, StepRow>();
		m.set(s.step, s);
		stepsOf.set(s.runId, m);
	}

	// Repairs come from lineage: a child is a repair when its parent journaled
	// spawning it as one, or (older journals) its label says so. `attempt` is
	// the repair budget counter and is not lineage: unblock children copy it
	// and a recovered row can carry any value.
	let repairs = 0;
	for (const m of members.slice(1)) {
		const parentSpawn = m.parentRunId
			? stepsOf.get(m.parentRunId)?.get("spawn_repair")
			: undefined;
		// A `continue:<runId>` spawn (the brain's repair, resume and answer) is
		// the same lineage edge the finalize-spawned children used to be.
		if (
			childIdOf(parentSpawn) === m.id ||
			m.label.endsWith("#repair") ||
			m.relation === "continue"
		)
			repairs++;
	}

	const verdictMix: Record<string, number> = {};
	const bump = (k: string) => {
		verdictMix[k] = (verdictMix[k] ?? 0) + 1;
	};
	let reviewRounds = 0;
	for (const v of verdicts) {
		if (!ids.has(v.subjectRunId)) continue;
		bump(v.verdict);
		if (v.verdict === "fix") reviewRounds++;
	}
	for (const m of members) {
		const critic = stepsOf.get(m.id)?.get("critic");
		if (critic?.status !== "done") continue;
		const r = (critic.result ?? {}) as {
			status?: unknown;
			flagged?: unknown;
			verdict?: unknown;
		};
		// A critic step that produced a verdict also wrote a `review_verdicts`
		// row, counted above; only pre-verdict and failed reviews count here.
		if (typeof r.verdict === "string") continue;
		bump(
			r.status !== "ok"
				? "critic:failed"
				: r.flagged === true
					? "critic:flagged"
					: "critic:accepted",
		);
	}

	// Leaf: the newest member nothing in the chain continues.
	const parents = new Set(members.map((m) => m.parentRunId));
	const leaves = members.filter((m) => !parents.has(m.id));
	const leaf = (leaves.length > 0 ? leaves : members).reduce((a, b) =>
		b.startedAt.getTime() > a.startedAt.getTime() ||
		(b.startedAt.getTime() === a.startedAt.getTime() && b.id > a.id)
			? b
			: a,
	);
	const leafSteps = stepsOf.get(leaf.id);
	const pendingChild = ["spawn_repair", "spawn_resume"].some((s) => {
		const child = childIdOf(leafSteps?.get(s));
		return child !== null && !ids.has(child);
	});
	const chainMerges = merges.filter((j) => ids.has(j.runId));
	const merged = chainMerges.find((j) => j.state === "merged");
	const open =
		!merged &&
		(members.some((m) => OPEN_RUN_STATES.has(m.state)) ||
			pendingChild ||
			chainMerges.some((j) => OPEN_MERGE_STATES.has(j.state)));

	let final: AttemptFinal | null = null;
	if (merged) final = "merged";
	else if (!open) final = closedFinal(leaf, leafSteps, chainMerges);

	const billable = members.filter(
		(m) => m.outcome !== "start_failed" && m.state !== "starting",
	);
	const cost = sumKey(billable, "costUsd");
	const finishedAt =
		final === null
			? null
			: new Date(
					Math.max(
						...members.map((m) => m.finishedAt?.getTime() ?? 0),
						merged?.updatedAt.getTime() ?? 0,
						root.startedAt.getTime(),
					),
				);
	const harness = root.harness ?? root.providerId ?? null;

	return {
		rootRunId: root.id,
		taskId: root.taskId,
		harness,
		modelVendor: root.modelVendor ?? harnessVendor(harness),
		model: root.model,
		effort: root.reasoningEffort ?? null,
		tier: root.modelTier ?? null,
		size: root.taskSize ?? null,
		type: root.taskType ?? null,
		target: root.executionTarget,
		hostId: root.hostId ?? null,
		startedAt: root.startedAt,
		finishedAt,
		runs: members.length,
		repairs,
		reviewRounds,
		firstPass: final === "merged" && repairs === 0 && reviewRounds === 0,
		final,
		verdicts: verdictMix,
		tokensIn: sumKey(members, "inputTokens").total,
		tokensOut: sumKey(members, "outputTokens").total,
		tokensCached: sumKey(members, "cachedInputTokens", "cacheReadTokens").total,
		tokensReasoning: sumKey(members, "reasoningOutputTokens", "reasoningTokens")
			.total,
		costUsd: cost.total,
		costComplete: billable.length > 0 && cost.reported === billable.length,
		filesChanged: null,
	};
}

/** How a chain that will not change any more ended, read off its last run. */
function closedFinal(
	leaf: RunRow,
	leafSteps: Map<string, StepRow> | undefined,
	merges: (typeof mergeJobs.$inferSelect)[],
): AttemptFinal {
	if (leaf.state === "finalize_error") return "blocked"; // park releases to blocked
	const job = merges.find((j) => j.runId === leaf.id);
	if (job?.state === "parked") return "blocked";
	if (job?.state === "abandoned") return "abandoned";
	switch (leaf.outcome) {
		case "rate_limited":
			return "rate_limited";
		case "interrupted":
			return "interrupted";
		case "killed_watchdog":
			return leaf.killReason && SCOPE_KILLS.has(leaf.killReason)
				? "killed_scope"
				: "killed_watchdog";
		case "killed_manual":
		case "start_failed":
			return "abandoned";
	}
	if (leaf.state === "needs_review") return "review_human";
	// Settled for the brain and not continued: it is waiting on a decision.
	if (leafSteps?.get("settle")?.status === "done") return "blocked";
	const release = leafSteps?.get("release_task");
	const to =
		release?.status === "done"
			? (release.result as { to?: unknown } | null)?.to
			: undefined;
	if (to === "review") return "review_human";
	if (to === "blocked") return "blocked";
	return "abandoned";
}

function sameOutcome(a: OutcomeValues, b: AttemptOutcomeRow): boolean {
	for (const k of Object.keys(a) as (keyof OutcomeValues)[]) {
		const x = a[k];
		const y = b[k];
		if (x instanceof Date || y instanceof Date) {
			if ((x as Date | null)?.getTime() !== (y as Date | null)?.getTime())
				return false;
		} else if (JSON.stringify(x) !== JSON.stringify(y)) return false;
	}
	return true;
}

/**
 * Recompute and upsert one chain's row. Returns the row, or null when
 * `rootRunId` is not a task chain root. Writes nothing when unchanged.
 */
export async function rollupAttemptChain(
	db: OutcomeDb,
	rootRunId: string,
	now: () => Date = () => new Date(),
): Promise<AttemptOutcomeRow | null> {
	const [root] = await db.select().from(runs).where(eq(runs.id, rootRunId));
	if (root?.kind !== "task" || !root.taskId) return null;
	const taskRuns = await db
		.select()
		.from(runs)
		.where(and(eq(runs.taskId, root.taskId), eq(runs.kind, "task")));
	return writeChain(db, root, taskRuns, now);
}

async function writeChain(
	db: OutcomeDb,
	root: RunRow,
	taskRuns: RunRow[],
	now: () => Date,
): Promise<AttemptOutcomeRow> {
	const members = chainMembers(root, taskRuns);
	const ids = members.map((m) => m.id);
	// Sequential: statements inside one transaction must not interleave.
	const steps = await db
		.select()
		.from(runSteps)
		.where(inArray(runSteps.runId, ids));
	const merges = await db
		.select()
		.from(mergeJobs)
		.where(inArray(mergeJobs.runId, ids));
	const verdicts = await db
		.select()
		.from(reviewVerdicts)
		.where(inArray(reviewVerdicts.subjectRunId, ids));
	const existing = await db
		.select()
		.from(taskAttemptOutcomes)
		.where(eq(taskAttemptOutcomes.rootRunId, root.id));
	const values = foldAttemptChain({ members, steps, merges, verdicts });
	const prior = existing[0];
	if (prior && sameOutcome(values, prior)) return prior;
	const row = { ...values, updatedAt: now() };
	await db
		.insert(taskAttemptOutcomes)
		.values(row)
		.onConflictDoUpdate({ target: taskAttemptOutcomes.rootRunId, set: row });
	return row;
}

// ---------- the fold onto decisions ----------

/**
 * What became of a decision's effect, written to `decisions.outcome` once the
 * attempt chain(s) it spawned have closed (`final` is never null here).
 */
export interface DecisionOutcome {
	final: AttemptFinal;
	firstPass: boolean;
	repairs: number;
	reviewRounds: number;
	/** Runs in the chain that gave the outcome. */
	runs: number;
	/** Chains the decision spawned (more than one for competing attempts). */
	chains: number;
	costUsd: number | null;
	durationMs: number | null;
	rootRunId: string;
	closedAt: number;
}

/**
 * Fold the chains a decision spawned into its `outcome`: nothing while any
 * chain is open and none merged yet (a competing group's winner may merge
 * before its losers settle); else the merged chain, else the last to close.
 * Pure over the rows it is given.
 */
export function foldDecisionOutcome(
	chains: readonly AttemptOutcomeRow[],
): DecisionOutcome | null {
	if (chains.length === 0) return null;
	const merged = chains.filter((c) => c.final === "merged");
	let pick: AttemptOutcomeRow | undefined;
	if (merged.length > 0) {
		pick = merged.reduce((a, b) =>
			(b.finishedAt?.getTime() ?? 0) < (a.finishedAt?.getTime() ?? 0) ? b : a,
		);
	} else if (chains.every((c) => c.final !== null)) {
		pick = chains.reduce((a, b) =>
			(b.finishedAt?.getTime() ?? 0) > (a.finishedAt?.getTime() ?? 0) ? b : a,
		);
	}
	if (!pick?.final) return null;
	return {
		final: pick.final,
		firstPass: pick.firstPass,
		repairs: pick.repairs,
		reviewRounds: pick.reviewRounds,
		runs: pick.runs,
		chains: chains.length,
		costUsd: pick.costUsd,
		durationMs: pick.finishedAt
			? pick.finishedAt.getTime() - pick.startedAt.getTime()
			: null,
		rootRunId: pick.rootRunId,
		closedAt: (pick.finishedAt ?? pick.updatedAt).getTime(),
	};
}

/** Re-fold one decision from its chains' rows; writes only on change. Returns the outcome (null while open). */
export async function recordDecisionOutcome(
	db: OutcomeDb,
	decisionId: number,
): Promise<DecisionOutcome | null> {
	const spawned = await db
		.select({ id: runs.id })
		.from(runs)
		.where(eq(runs.spawnedByDecisionId, decisionId));
	const roots = new Set<string>();
	for (const r of spawned) {
		const root = await attemptChainRoot(db, r.id);
		if (root) roots.add(root);
	}
	if (roots.size === 0) return null;
	const rows = await db
		.select()
		.from(taskAttemptOutcomes)
		.where(inArray(taskAttemptOutcomes.rootRunId, [...roots]));
	const outcome = foldDecisionOutcome(rows);
	if (!outcome) return null;
	const [cur] = await db
		.select({ outcome: decisions.outcome })
		.from(decisions)
		.where(eq(decisions.id, decisionId));
	if (!cur) return null;
	if (JSON.stringify(cur.outcome) !== JSON.stringify(outcome)) {
		await db
			.update(decisions)
			.set({ outcome: outcome as unknown as Record<string, unknown> })
			.where(eq(decisions.id, decisionId));
	}
	return outcome;
}

/** Re-fold the decisions whose spawned runs belong to this run's chain. Returns the decision ids that carry an outcome. */
export async function recordDecisionOutcomesOfRun(
	db: OutcomeDb,
	runId: string,
): Promise<number[]> {
	const root = await attemptChainRoot(db, runId);
	if (!root) return [];
	const [rootRun] = await db.select().from(runs).where(eq(runs.id, root));
	if (!rootRun?.taskId) return [];
	const taskRuns = await db
		.select()
		.from(runs)
		.where(and(eq(runs.taskId, rootRun.taskId), eq(runs.kind, "task")));
	const ids = new Set<number>();
	for (const m of chainMembers(rootRun, taskRuns)) {
		if (m.spawnedByDecisionId != null) ids.add(m.spawnedByDecisionId);
	}
	const done: number[] = [];
	for (const id of ids) {
		if (await recordDecisionOutcome(db, id)) done.push(id);
	}
	return done;
}

/** Fold every decision that spawned a run. Idempotent; returns how many carry an outcome. */
export async function backfillDecisionOutcomes(db: OutcomeDb): Promise<number> {
	const spawners = await db
		.selectDistinct({ id: runs.spawnedByDecisionId })
		.from(runs)
		.where(isNotNull(runs.spawnedByDecisionId));
	let n = 0;
	for (const s of spawners) {
		if (s.id != null && (await recordDecisionOutcome(db, s.id))) n++;
	}
	return n;
}

/** Record the chain a run belongs to (a no-op for non-task runs). */
export async function recordAttemptOutcome(
	db: OutcomeDb,
	runId: string,
	now?: () => Date,
): Promise<AttemptOutcomeRow | null> {
	const root = await attemptChainRoot(db, runId);
	return root ? rollupAttemptChain(db, root, now) : null;
}

/** Fold every task chain in the DB. Idempotent; returns the chain count. */
export async function backfillAttemptOutcomes(
	db: OutcomeDb,
	now: () => Date = () => new Date(),
): Promise<number> {
	const all = await db.select().from(runs).where(eq(runs.kind, "task"));
	const byTask = new Map<string, RunRow[]>();
	for (const r of all) {
		if (!r.taskId) continue;
		const list = byTask.get(r.taskId) ?? [];
		list.push(r);
		byTask.set(r.taskId, list);
	}
	let chains = 0;
	for (const taskRuns of byTask.values()) {
		const byId = new Map(taskRuns.map((r) => [r.id, r]));
		for (const r of taskRuns) {
			// Root: no parent among this task's task runs (pruned parents included).
			if (r.parentRunId && byId.has(r.parentRunId)) continue;
			await writeChain(db, r, taskRuns, now);
			chains++;
		}
	}
	return chains;
}

/** engine_kv marker gating the boot-time backfill; bump the version to refold. */
export const OUTCOMES_BACKFILL_KEY = "outcomes_backfill";
export const OUTCOMES_BACKFILL_VERSION = 2;

/** Backfill once per DB (per marker version). Returns null when already done. */
export async function backfillAttemptOutcomesOnce(
	db: OutcomeDb,
	now: () => Date = () => new Date(),
): Promise<number | null> {
	const [marker] = await db
		.select()
		.from(engineKv)
		.where(eq(engineKv.key, OUTCOMES_BACKFILL_KEY));
	if (
		(marker?.value as { version?: number } | undefined)?.version ===
		OUTCOMES_BACKFILL_VERSION
	)
		return null;
	const chains = await backfillAttemptOutcomes(db, now);
	await backfillDecisionOutcomes(db);
	const value = { version: OUTCOMES_BACKFILL_VERSION, chains };
	await db
		.insert(engineKv)
		.values({ key: OUTCOMES_BACKFILL_KEY, value, updatedAt: now() })
		.onConflictDoUpdate({
			target: engineKv.key,
			set: { value, updatedAt: now() },
		});
	return chains;
}

/** A chain row with who decided it: the grouping the audit UX needs. */
export type OutcomeRow = AttemptOutcomeRow & {
	/** `brain`, `human` (a decision row or a `human:` origin), or `pipeline` (no decision). */
	decidedBy?: string | null;
	/** The root run's role in its group (`implement`, `attempt`). */
	role?: string | null;
	/** `<harness>:<model>` of the brain session that decided; null when not a brain decision. */
	brainRoute?: string | null;
};

/** Rows started at or after `since` (all rows when omitted), with who decided each chain. */
export async function listAttemptOutcomes(
	db: OutcomeDb,
	opts: { since?: Date } = {},
): Promise<OutcomeRow[]> {
	const rows = opts.since
		? await db
				.select()
				.from(taskAttemptOutcomes)
				.where(gte(taskAttemptOutcomes.startedAt, opts.since))
		: await db.select().from(taskAttemptOutcomes);
	if (rows.length === 0) return [];
	const rootRuns = await db
		.select({
			id: runs.id,
			role: runs.role,
			decisionId: runs.spawnedByDecisionId,
			originRef: runs.originRef,
		})
		.from(runs)
		.where(
			inArray(
				runs.id,
				rows.map((r) => r.rootRunId),
			),
		);
	const byRun = new Map(rootRuns.map((r) => [r.id, r]));
	const decisionIds = [
		...new Set(
			rootRuns.map((r) => r.decisionId).filter((d): d is number => d != null),
		),
	];
	const ds =
		decisionIds.length > 0
			? await db
					.select({
						id: decisions.id,
						role: decisions.role,
						harness: decisions.harness,
						model: decisions.model,
					})
					.from(decisions)
					.where(inArray(decisions.id, decisionIds))
			: [];
	const byDecision = new Map(ds.map((d) => [d.id, d]));
	return rows.map((r) => {
		const run = byRun.get(r.rootRunId);
		const d = run?.decisionId != null ? byDecision.get(run.decisionId) : null;
		const decidedBy = d
			? d.role === "human"
				? "human"
				: "brain"
			: run?.originRef?.startsWith("human:")
				? "human"
				: "pipeline";
		return {
			...r,
			decidedBy,
			role: run?.role ?? null,
			brainRoute:
				d?.role === "brain" && d.harness ? `${d.harness}:${d.model}` : null,
		};
	});
}

// ---------- aggregation (the shape the stats API and the router consume) ----------

export const OUTCOME_GROUP_KEYS = [
	"harness",
	"modelVendor",
	"model",
	"effort",
	"tier",
	"size",
	"type",
	"target",
	"decidedBy",
	"role",
	"brainRoute",
] as const;
export type OutcomeGroupKey = (typeof OUTCOME_GROUP_KEYS)[number];

export interface OutcomeSummary {
	key: Partial<Record<OutcomeGroupKey, string | null>>;
	/** Closed chains (final set); every rate below is over these. */
	attempts: number;
	/** Chains still running; never counted in rates. */
	open: number;
	merged: number;
	firstPass: number;
	firstPassRate: number | null;
	mergeRate: number | null;
	repairs: number;
	meanRepairs: number | null;
	reviewRounds: number;
	meanRounds: number | null;
	/** Summed verdict counts, e.g. `{ merge: 3, "critic:flagged": 1 }`. */
	verdictMix: Record<string, number>;
	finals: Partial<Record<AttemptFinal, number>>;
	/** Median `cost_usd` over merged chains with complete cost; null if none. */
	medianCostPerMerge: number | null;
	medianDurationMs: number | null;
	tokensIn: number;
	tokensOut: number;
}

function median(xs: number[]): number | null {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2
		? (s[mid] as number)
		: ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Group rows by `groupBy` and summarise each group; sorted by attempts desc. */
export function summarizeOutcomes(
	rows: readonly OutcomeRow[],
	groupBy: readonly OutcomeGroupKey[],
): OutcomeSummary[] {
	const groups = new Map<string, OutcomeRow[]>();
	for (const r of rows) {
		const id = JSON.stringify(groupBy.map((k) => r[k] ?? null));
		const list = groups.get(id) ?? [];
		list.push(r);
		groups.set(id, list);
	}
	const out: OutcomeSummary[] = [];
	for (const list of groups.values()) {
		const first = list[0] as OutcomeRow;
		const key: OutcomeSummary["key"] = {};
		for (const k of groupBy) key[k] = first[k] ?? null;
		const closed = list.filter((r) => r.final !== null);
		const merged = closed.filter((r) => r.final === "merged");
		const firstPass = closed.filter((r) => r.firstPass).length;
		const repairs = closed.reduce((n, r) => n + r.repairs, 0);
		const rounds = closed.reduce((n, r) => n + r.reviewRounds, 0);
		const verdictMix: Record<string, number> = {};
		const finals: OutcomeSummary["finals"] = {};
		for (const r of closed) {
			for (const [v, n] of Object.entries(r.verdicts))
				verdictMix[v] = (verdictMix[v] ?? 0) + n;
			const f = r.final as AttemptFinal;
			finals[f] = (finals[f] ?? 0) + 1;
		}
		const n = closed.length;
		out.push({
			key,
			attempts: n,
			open: list.length - n,
			merged: merged.length,
			firstPass,
			firstPassRate: n ? firstPass / n : null,
			mergeRate: n ? merged.length / n : null,
			repairs,
			meanRepairs: n ? repairs / n : null,
			reviewRounds: rounds,
			meanRounds: n ? rounds / n : null,
			verdictMix,
			finals,
			medianCostPerMerge: median(
				merged
					.filter((r) => r.costComplete && r.costUsd !== null)
					.map((r) => r.costUsd as number),
			),
			medianDurationMs: median(
				closed
					.filter((r) => r.finishedAt)
					.map((r) => (r.finishedAt as Date).getTime() - r.startedAt.getTime()),
			),
			tokensIn: closed.reduce((s, r) => s + (r.tokensIn ?? 0), 0),
			tokensOut: closed.reduce((s, r) => s + (r.tokensOut ?? 0), 0),
		});
	}
	return out.sort((a, b) => b.attempts - a.attempts || b.open - a.open);
}

export type ReviewVerdictRow = typeof reviewVerdicts.$inferSelect;

/** Verdicts recorded at or after `since` (all when omitted), oldest first. */
export async function listReviewVerdicts(
	db: OutcomeDb,
	opts: { since?: Date; taskId?: string } = {},
): Promise<ReviewVerdictRow[]> {
	const conds = [
		...(opts.since ? [gte(reviewVerdicts.createdAt, opts.since)] : []),
		...(opts.taskId ? [eq(reviewVerdicts.taskId, opts.taskId)] : []),
	];
	const q = db.select().from(reviewVerdicts);
	const rows = conds.length > 0 ? await q.where(and(...conds)) : await q;
	return rows.sort(
		(a, b) =>
			a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
	);
}

export interface ReviewerSummary {
	mode: string;
	harness: string | null;
	model: string | null;
	verdicts: number;
	verdictMix: Record<string, number>;
	/** Verdicts given by a reviewer independent of the worker. */
	independent: number;
}

/** Per reviewer (mode, harness, model): how many verdicts and of which kind. */
export function summarizeReviewers(
	rows: readonly ReviewVerdictRow[],
): ReviewerSummary[] {
	const byKey = new Map<string, ReviewerSummary>();
	for (const r of rows) {
		const key = JSON.stringify([r.mode, r.reviewerHarness, r.reviewerModel]);
		const s = byKey.get(key) ?? {
			mode: r.mode,
			harness: r.reviewerHarness ?? null,
			model: r.reviewerModel ?? null,
			verdicts: 0,
			verdictMix: {},
			independent: 0,
		};
		s.verdicts++;
		s.verdictMix[r.verdict] = (s.verdictMix[r.verdict] ?? 0) + 1;
		if (r.independent === true) s.independent++;
		byKey.set(key, s);
	}
	return [...byKey.values()].sort((a, b) => b.verdicts - a.verdicts);
}

export interface OutcomePrior {
	n: number;
	firstPassRate: number | null;
	costPerMerge: number | null;
	/** `n >= minN`: below it a router must not let the prior change anything. */
	usable: boolean;
}

/** Prior for one candidate `{harness, model, tier, size}`; unset fields match any value. */
export function outcomePrior(
	rows: readonly AttemptOutcomeRow[],
	candidate: Partial<
		Pick<AttemptOutcomeRow, "harness" | "model" | "tier" | "size">
	>,
	minN = 10,
): OutcomePrior {
	const keys = Object.keys(candidate) as (keyof typeof candidate)[];
	const matching = rows.filter((r) =>
		keys.every((k) => candidate[k] === undefined || r[k] === candidate[k]),
	);
	const [s] = summarizeOutcomes(matching, []);
	const n = s?.attempts ?? 0;
	return {
		n,
		firstPassRate: s?.firstPassRate ?? null,
		costPerMerge: s?.medianCostPerMerge ?? null,
		usable: n >= minN,
	};
}
