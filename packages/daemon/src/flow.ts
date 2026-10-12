import type { ProjectDb } from "@mfw/db/client";
import { latestSeq } from "@mfw/db/eventlog";
import {
	brainActions,
	brainSessions,
	brainTurns,
	decisions,
	events,
	mergeJobs,
	reviewVerdicts,
	runGroups,
	runSpans,
	runs,
} from "@mfw/db/schema";
import {
	and,
	between,
	desc,
	eq,
	gte,
	inArray,
	isNull,
	lt,
	or,
	sql,
} from "drizzle-orm";
import { pipsFromRuns, type RunPip, runPipsByTask } from "./run-pips.ts";
import {
	listRunSubagents,
	type RunSubagentRow,
	subRef,
} from "./run-subagents.ts";

/**
 * The Flow lens: one tree of everything the project has done, folded from
 * the tables that exist (tasks from the board index, runs with their typed
 * lineage), plus the durable span timeline for the time axis.
 *
 * Shapes follow data-and-api §3.2/§3.3. Every query is one pass over a table,
 * never per node: a 900-task, 3,000-run board is a handful of round trips.
 */

export type NodeRef = string; // brain | task:<id> | group:<id> | run:<id> | sub:<runId>/<callId> | turn:<id> | decision:<n> | merge:<n>

export type AttentionReason =
	| "question"
	| "approval"
	| "stalled"
	| "escalated"
	| "inbox"
	/** The brain's circuit is open: it needs a person to reset it. */
	| "brain_stuck";

export interface FlowRunInfo {
	role: string;
	relation: string;
	state: string;
	activity: string | null;
	harness: string | null;
	model: string;
	effort: string | null;
	host: string | null;
	label: string;
	startedAt: Date;
	finishedAt: Date | null;
	costUsd: number | null;
	liveCostUsd: number | null;
	spawnedBy?: NodeRef;
	continues?: NodeRef;
	/** Set when the run is a member of a shown attempt group (U4-01). */
	attempt?: FlowAttemptInfo;
}

/** A run's place in a competing attempt group. */
export interface FlowAttemptInfo {
	groupRef: NodeRef;
	/** `runs.role`: `attempt` for a sibling of a competing group. */
	role: string | null;
	/** The group's selected winner is this run. */
	winner: boolean;
}

/** What a `group:<id>` node carries: the `run_groups` row, as the UI reads it. */
export interface FlowGroupInfo {
	kind: "single" | "competing" | "pipeline";
	/** Who selects: the brain, or the first verified attempt. */
	selection: "brain" | "first_verified";
	status: "open" | "selecting" | "merged" | "abandoned";
	/** The winning attempt's run ref, once one was selected. */
	winner: NodeRef | null;
	/** The decision that created the group, or `human` (a person started it). */
	createdBy: NodeRef | "human";
	/** Attempts in the group, shown or not. */
	attempts: number;
	closedAt: Date | null;
}

export interface FlowRollup {
	total: number;
	done: number;
	live: number;
	needsMe: number;
	costUsdToday: number;
}

/** A subagent of a run (`sub:<runId>/<toolUseId>`), from `run_subagents`. */
export interface FlowSubInfo {
	runId: string;
	toolUseId: string;
	agentType: string;
	description: string;
	status: "running" | "ok" | "error";
	startedAt: Date;
	endedAt: Date | null;
	/** Tool calls by tool name. */
	tools: Record<string, number>;
	/** The span of the parent transcript's `seq`s that holds its entries. */
	entryFromSeq: number;
	entryToSeq: number;
}

export interface FlowNode {
	ref: NodeRef;
	parent: NodeRef | null;
	kind:
		| "brain"
		| "epic"
		| "group_task"
		| "task"
		| "group"
		| "run"
		| "judge"
		| "decision"
		| "sub";
	title: string;
	status?: { value: string; role: string | null };
	run?: FlowRunInfo;
	sub?: FlowSubInfo;
	rollup?: FlowRollup;
	needsMe: AttentionReason | null;
	lastAt: Date;
	historyPips?: RunPip[];
	/** Only on the `brain` root node. */
	brain?: FlowBrainInfo;
	/** Only on real attempt-group nodes (`group:<ulid>`); folded groups carry none. */
	group?: FlowGroupInfo;
}

/** What the brain root node carries (U3-02). */
export interface FlowBrainInfo {
	sessionId: string;
	state: "idle" | "turn" | "paused" | "failed";
	generation: number;
	harness: string;
	model: string;
	effort: string | null;
	turnsLast24h: number;
	/** The live turn's run id (a `turn:<id>` ref), when a turn is running. */
	liveTurnRunId: string | null;
	consecutiveFailures: number;
	lastTurnAt: Date | null;
}

export interface FlowTaskInput {
	id: string;
	title: string;
	/** The task's canonical status (the daemon role). */
	status: string;
	type?: string | null;
	parentId: string | null;
	updatedAt: Date;
	/** When the task was created; the as-of tree hides a task before this. */
	createdAt?: Date;
}

/** A run as it stood at the scrub time. */
export interface AsOfRun {
	state: string;
	activity: string | null;
	finishedAt: Date | null;
}

/** The overlay that turns the live tree into the tree at `t`. */
export interface FlowAsOf {
	/** Runs that existed at t (absent = not started yet), with their state then. */
	runs: ReadonlyMap<string, AsOfRun>;
	/** The newest event seq at or before t. */
	seq: number;
	/** The scrub time (epoch ms): a subagent is running then when it ended after it. */
	t?: number;
}

export interface FlowTreeOptions {
	tasks: readonly FlowTaskInput[];
	/** Ended runs finished before this are folded into one group node per task. Default: 7 days before `now`. */
	since?: Date;
	/** `all` keeps every ended run as its own node. */
	ended?: "folded" | "all";
	now?: number;
	/** Build the tree as it was at a past time (see `flowAt`). */
	asOf?: FlowAsOf;
}

export interface FlowTree {
	nodes: FlowNode[];
	/** The newest event seq this snapshot reflects. */
	seq: number;
}

const DAY = 86_400_000;
const LIVE_STATES = new Set([
	"starting",
	"running",
	"ended",
	"finalizing",
	"merging",
]);
const CHAIN_RELATIONS = new Set([
	"continue",
	"repair",
	"resume",
	"answer",
	"unblock",
]);
const TERMINAL_TASK = new Set(["done", "archived"]);
const NO_TASK_GROUP = "-";

const runRef = (id: string): NodeRef => `run:${id}`;
const taskRef = (id: string): NodeRef => `task:${id}`;
/** The synthetic fold of a task's old ended runs (not a `run_groups` row). */
const groupRef = (taskId: string | null): NodeRef =>
	`group:ended:${taskId ?? NO_TASK_GROUP}`;
/** A real attempt group, addressed by its `run_groups.id`. */
const attemptGroupRef = (id: string): NodeRef => `group:${id}`;

function costOf(usage: Record<string, number> | null): number | null {
	const v = usage?.costUsd;
	return typeof v === "number" ? v : null;
}

/** What a live run needs from a person (the Agents page vocabulary). */
function attentionOf(
	state: string,
	activity: string | null,
): AttentionReason | null {
	if (!LIVE_STATES.has(state)) return null;
	switch (activity) {
		case "needs_answer":
			return "question";
		case "awaiting_approval":
			return "approval";
		case "stalled":
			return "stalled";
		default:
			return null;
	}
}

function roleOf(kind: string): string {
	switch (kind) {
		case "task":
			return "worker";
		case "brain":
			return "judge";
		case "repair":
			return "recovery";
		case "plan":
			return "planner";
		default:
			return kind;
	}
}

function emptyRollup(): FlowRollup {
	return { total: 0, done: 0, live: 0, needsMe: 0, costUsdToday: 0 };
}

/** Build the project's flow tree. */
export async function flowTree(
	db: ProjectDb,
	opts: FlowTreeOptions,
): Promise<FlowTree> {
	const now = opts.now ?? Date.now();
	const since = (opts.since ?? new Date(now - 7 * DAY)).getTime();
	const keepEnded = opts.ended === "all";
	const dayAgo = now - DAY;

	const liveRunRows = await db
		.select({
			id: runs.id,
			kind: runs.kind,
			taskId: runs.taskId,
			parentRunId: runs.parentRunId,
			label: runs.label,
			model: runs.model,
			effort: runs.reasoningEffort,
			harness: runs.harness,
			providerId: runs.providerId,
			hostId: runs.hostId,
			state: runs.state,
			activity: runs.activity,
			usage: runs.usage,
			usageLive: runs.usageLive,
			startedAt: runs.startedAt,
			finishedAt: runs.finishedAt,
			relation: runs.relation,
			spawnedByDecisionId: runs.spawnedByDecisionId,
			groupId: runs.groupId,
			role: runs.role,
		})
		.from(runs);
	const asOf = opts.asOf;
	const runRows = asOf
		? liveRunRows.flatMap((r) => {
				const then = asOf.runs.get(r.id);
				if (!then) return [];
				return [
					{
						...r,
						state: then.state as typeof r.state,
						activity: then.activity,
						finishedAt: then.finishedAt,
						usage: then.finishedAt ? r.usage : null,
						usageLive: null,
					},
				];
			})
		: liveRunRows;
	const runById = new Map(runRows.map((r) => [r.id, r]));
	const taskById = new Map(opts.tasks.map((t) => [t.id, t]));

	// --- per-task rollups over the task subtree (own runs + descendants') ---
	const childrenOf = new Map<string, string[]>();
	for (const t of opts.tasks) {
		if (t.parentId && taskById.has(t.parentId)) {
			const list = childrenOf.get(t.parentId) ?? [];
			list.push(t.id);
			childrenOf.set(t.parentId, list);
		}
	}
	const ownRollup = new Map<string, FlowRollup>();
	const ownLastRun = new Map<string, number>();
	for (const r of runRows) {
		if (!r.taskId) continue;
		const roll = ownRollup.get(r.taskId) ?? emptyRollup();
		roll.total++;
		const live = LIVE_STATES.has(r.state);
		if (live) roll.live++;
		else roll.done++;
		if (attentionOf(r.state, r.activity)) roll.needsMe++;
		const at = (r.finishedAt ?? r.startedAt).getTime();
		if (at >= dayAgo) roll.costUsdToday += costOf(r.usage) ?? 0;
		ownRollup.set(r.taskId, roll);
		ownLastRun.set(r.taskId, Math.max(ownLastRun.get(r.taskId) ?? 0, at));
	}
	const subtreeRollup = new Map<string, FlowRollup>();
	const subtreeLast = new Map<string, number>();
	const fold = (id: string, seen: Set<string>): void => {
		if (subtreeRollup.has(id) || seen.has(id)) return;
		seen.add(id);
		const own = ownRollup.get(id) ?? emptyRollup();
		const sum: FlowRollup = { ...own };
		let last = Math.max(
			ownLastRun.get(id) ?? 0,
			taskById.get(id)?.updatedAt.getTime() ?? 0,
		);
		for (const c of childrenOf.get(id) ?? []) {
			fold(c, seen);
			const sub = subtreeRollup.get(c);
			if (!sub) continue;
			sum.total += sub.total;
			sum.done += sub.done;
			sum.live += sub.live;
			sum.needsMe += sub.needsMe;
			sum.costUsdToday += sub.costUsdToday;
			last = Math.max(last, subtreeLast.get(c) ?? 0);
		}
		subtreeRollup.set(id, sum);
		subtreeLast.set(id, last);
	};
	for (const t of opts.tasks) fold(t.id, new Set());

	// --- which runs become nodes ---
	// A terminal task idle since before `since` is rollup-only: no run nodes.
	const rollupOnly = new Set<string>();
	for (const t of opts.tasks) {
		if (keepEnded || !TERMINAL_TASK.has(t.status)) continue;
		if ((subtreeLast.get(t.id) ?? 0) < since) rollupOnly.add(t.id);
	}
	const folded = new Map<string | null, FlowRollup & { lastAt: number }>();
	const shown: typeof runRows = [];
	// Brain turns are spans on the brain's row, not nodes of their own.
	const turnRunIds = await brainTurnRunIds(db);
	for (const r of runRows) {
		if (turnRunIds.has(r.id)) continue;
		if (r.taskId && rollupOnly.has(r.taskId)) continue;
		const ended = !LIVE_STATES.has(r.state);
		const at = (r.finishedAt ?? r.startedAt).getTime();
		if (!keepEnded && ended && at < since) {
			const g = folded.get(r.taskId) ?? { ...emptyRollup(), lastAt: 0 };
			g.total++;
			g.done++;
			g.costUsdToday += at >= dayAgo ? (costOf(r.usage) ?? 0) : 0;
			g.lastAt = Math.max(g.lastAt, at);
			folded.set(r.taskId, g);
			continue;
		}
		shown.push(r);
	}
	const shownIds = new Set(shown.map((r) => r.id));
	/** A parent run that was folded away is represented by its group. */
	const refOfRun = (id: string, taskId: string | null): NodeRef =>
		shownIds.has(id) ? runRef(id) : groupRef(taskId);

	// --- real attempt groups: one node per competing group with a shown member ---
	const groupRows = await db.select().from(runGroups);
	const groupNodes = new Map<string, (typeof groupRows)[number]>();
	for (const g of groupRows) {
		if (g.kind === "single") continue;
		groupNodes.set(g.id, g);
	}
	const members = new Map<string, typeof runRows>();
	for (const r of runRows) {
		if (!r.groupId || !groupNodes.has(r.groupId)) continue;
		if (turnRunIds.has(r.id)) continue;
		const list = members.get(r.groupId) ?? [];
		list.push(r);
		members.set(r.groupId, list);
	}
	const shownGroups = new Set<string>();
	for (const r of shown) {
		if (r.groupId && groupNodes.has(r.groupId)) shownGroups.add(r.groupId);
	}
	const creatingDecision = new Map<string, number>();
	const actionIds = [...shownGroups].flatMap((id) => {
		const a = groupNodes.get(id)?.createdByAction;
		return a ? [a] : [];
	});
	for (const part of chunks(actionIds)) {
		for (const a of await db
			.select({ id: brainActions.id, decisionId: brainActions.decisionId })
			.from(brainActions)
			.where(inArray(brainActions.id, part))) {
			if (a.decisionId !== null) creatingDecision.set(a.id, a.decisionId);
		}
	}

	const pips = asOf
		? pipsFromRuns(runRows)
		: await runPipsByTask(db, { taskIds: opts.tasks.map((t) => t.id) });

	const nodes: FlowNode[] = [];
	for (const t of opts.tasks) {
		const hasChildren = (childrenOf.get(t.id)?.length ?? 0) > 0;
		const needsMe: AttentionReason | null =
			t.status === "blocked" || t.status === "review" ? "inbox" : null;
		nodes.push({
			ref: taskRef(t.id),
			parent:
				t.parentId && taskById.has(t.parentId) ? taskRef(t.parentId) : null,
			kind: t.type === "epic" ? "epic" : hasChildren ? "group_task" : "task",
			title: t.title,
			status: { value: t.status, role: t.status },
			rollup: subtreeRollup.get(t.id) ?? emptyRollup(),
			needsMe,
			lastAt: new Date(
				Math.max(subtreeLast.get(t.id) ?? 0, t.updatedAt.getTime()),
			),
			...(pips[t.id] ? { historyPips: pips[t.id] } : {}),
		});
	}

	for (const [taskId, g] of folded) {
		nodes.push({
			ref: groupRef(taskId),
			parent: taskId && taskById.has(taskId) ? taskRef(taskId) : null,
			kind: "group",
			title: `${g.total} earlier run${g.total === 1 ? "" : "s"}`,
			rollup: {
				total: g.total,
				done: g.done,
				live: 0,
				needsMe: 0,
				costUsdToday: g.costUsdToday,
			},
			needsMe: null,
			lastAt: new Date(g.lastAt),
		});
	}

	for (const id of shownGroups) {
		const g = groupNodes.get(id) as (typeof groupRows)[number];
		const list = members.get(id) ?? [];
		const roll = emptyRollup();
		let lastAt = g.createdAt.getTime();
		for (const r of list) {
			roll.total++;
			if (LIVE_STATES.has(r.state)) roll.live++;
			else roll.done++;
			if (attentionOf(r.state, r.activity)) roll.needsMe++;
			const at = (r.finishedAt ?? r.startedAt).getTime();
			if (at >= dayAgo) roll.costUsdToday += costOf(r.usage) ?? 0;
			lastAt = Math.max(lastAt, at);
		}
		const decision = g.createdByAction
			? creatingDecision.get(g.createdByAction)
			: undefined;
		nodes.push({
			ref: attemptGroupRef(g.id),
			parent: taskById.has(g.taskId) ? taskRef(g.taskId) : null,
			kind: "group",
			title: `${list.length} ${g.kind === "competing" ? "competing attempt" : "run"}${list.length === 1 ? "" : "s"}`,
			rollup: roll,
			needsMe: null,
			lastAt: new Date(lastAt),
			group: {
				kind: g.kind,
				selection: g.selection,
				status: g.status,
				winner: g.winnerRunId ? runRef(g.winnerRunId) : null,
				createdBy:
					decision !== undefined ? `decision:${decision}` : ("human" as const),
				attempts: list.length,
				closedAt: g.closedAt,
			},
		});
	}

	for (const r of shown) {
		let parent: NodeRef | null = null;
		const parentRun = r.parentRunId ? runById.get(r.parentRunId) : undefined;
		const relation = r.relation ?? "fresh";
		if (
			parentRun &&
			(CHAIN_RELATIONS.has(relation) ||
				relation === "judge" ||
				relation === "replan" ||
				relation === "recovery")
		) {
			parent = refOfRun(parentRun.id, parentRun.taskId);
		} else if (r.groupId && groupNodes.has(r.groupId)) {
			parent = attemptGroupRef(r.groupId);
		} else if (r.taskId && taskById.has(r.taskId)) {
			parent = taskRef(r.taskId);
		}
		const groupRow = r.groupId ? groupNodes.get(r.groupId) : undefined;
		const run: FlowRunInfo = {
			role: roleOf(r.kind),
			relation,
			state: r.state,
			activity: r.activity,
			harness: r.harness ?? r.providerId,
			model: r.model,
			effort: r.effort,
			host: r.hostId,
			label: r.label,
			startedAt: r.startedAt,
			finishedAt: r.finishedAt,
			costUsd: costOf(r.usage),
			liveCostUsd: LIVE_STATES.has(r.state) ? costOf(r.usageLive) : null,
			...(r.spawnedByDecisionId !== null
				? { spawnedBy: `decision:${r.spawnedByDecisionId}` }
				: {}),
			...(parentRun && CHAIN_RELATIONS.has(relation)
				? { continues: runRef(parentRun.id) }
				: {}),
			...(groupRow
				? {
						attempt: {
							groupRef: attemptGroupRef(groupRow.id),
							role: r.role,
							winner: groupRow.winnerRunId === r.id,
						},
					}
				: {}),
		};
		nodes.push({
			ref: runRef(r.id),
			parent,
			kind: r.kind === "brain" ? "judge" : "run",
			title: r.label,
			run,
			needsMe: attentionOf(r.state, r.activity),
			lastAt: r.finishedAt ?? r.startedAt,
		});
	}

	// Subagents hang under the run (or the subagent) that started them. Only
	// runs that are nodes carry them; an older run's subagents stay in its row.
	const subRows = (await listRunSubagents(db)).filter((s) =>
		shownIds.has(s.runId),
	);
	const subKeys = new Set(subRows.map((s) => `${s.runId}/${s.toolUseId}`));
	for (const s of subRows) {
		const node = subNode(s, {
			parentExists:
				s.parentToolUseId !== null &&
				subKeys.has(`${s.runId}/${s.parentToolUseId}`),
			...(asOf?.t !== undefined ? { at: asOf.t } : {}),
		});
		if (node) nodes.push(node);
	}

	await attachBrainRoot(db, nodes, now);
	return { nodes, seq: asOf ? asOf.seq : await latestSeq(db) };
}

/**
 * A subagent as a tree node. `at` shows it as it was then: not yet started
 * reads as absent (null), still going when it ended after `at`.
 */
export function subNode(
	s: RunSubagentRow,
	opts: { parentExists: boolean; at?: number },
): FlowNode | null {
	const at = opts.at;
	if (at !== undefined && s.startedAt.getTime() > at) return null;
	const stillRunning =
		at !== undefined
			? s.endedAt === null || s.endedAt.getTime() > at
			: s.status === "running";
	const status = stillRunning
		? "running"
		: s.status === "error"
			? "error"
			: "ok";
	const endedAt = stillRunning ? null : s.endedAt;
	return {
		ref: subRef(s.runId, s.toolUseId),
		parent:
			opts.parentExists && s.parentToolUseId
				? subRef(s.runId, s.parentToolUseId)
				: runRef(s.runId),
		kind: "sub",
		title: s.description,
		sub: {
			runId: s.runId,
			toolUseId: s.toolUseId,
			agentType: s.agentType,
			description: s.description,
			status,
			startedAt: s.startedAt,
			endedAt,
			tools: s.tools,
			entryFromSeq: s.entryFromSeq,
			entryToSeq: s.entryToSeq,
		},
		needsMe: null,
		lastAt: endedAt ?? s.startedAt,
	};
}

// ---------------------------------------------------------------------
// the tree at a time
// ---------------------------------------------------------------------

/** Scrub times are quantised to this so repeated drags hit the same answer. */
const AT_QUANTUM_MS = 1000;

export interface FlowAtOptions {
	tasks: readonly FlowTaskInput[];
	t: Date;
	ended?: "folded" | "all";
}

/** Quantise a scrub time (rounded up to the second that contains it). */
export function quantiseAt(t: Date): Date {
	return new Date(Math.ceil(t.getTime() / AT_QUANTUM_MS) * AT_QUANTUM_MS);
}

/**
 * The tree as it was at `t`, from `run_spans` (the status lane for tasks, the
 * state and activity lanes for runs) and the rows' own start times. Nothing is
 * replayed from the event log. A run exists once `started_at <= t` and is in
 * the state its lane held then; a task is in the status open at t, and absent
 * before it was created or after it was deleted. A run or task with no span
 * (it predates the span lanes) falls back to what its row says: a run that
 * finished by t keeps its final state, otherwise it reads as running.
 */
export async function flowAt(
	db: ProjectDb,
	opts: FlowAtOptions,
): Promise<FlowTree & { t: Date }> {
	const tDate = quantiseAt(opts.t);
	const t = tDate.getTime();

	// Spans that started by t; the last per subject and lane is the value then.
	const spanRows = await db
		.select({
			id: runSpans.id,
			subject: runSpans.subject,
			lane: runSpans.lane,
			value: runSpans.value,
			startTs: runSpans.startTs,
			endTs: runSpans.endTs,
			detail: runSpans.detail,
		})
		.from(runSpans)
		.where(
			or(
				and(
					lt(runSpans.startTs, new Date(t + 1)),
					inArray(runSpans.lane, ["state", "activity"]),
				),
				// Every status span, so a task with no change yet reads its first `from`.
				eq(runSpans.lane, "status"),
			),
		);
	type SpanRow = (typeof spanRows)[number];
	const newer = (a: SpanRow | undefined, b: SpanRow): boolean =>
		!a ||
		b.startTs.getTime() > a.startTs.getTime() ||
		(b.startTs.getTime() === a.startTs.getTime() && b.id > a.id);
	const lastState = new Map<string, SpanRow>();
	const lastActivity = new Map<string, SpanRow>();
	const lastStatus = new Map<string, SpanRow>();
	const firstLater = new Map<string, SpanRow>();
	for (const s of spanRows) {
		if (s.lane === "status" && s.startTs.getTime() > t) {
			const cur = firstLater.get(s.subject);
			if (
				!cur ||
				s.startTs.getTime() < cur.startTs.getTime() ||
				(s.startTs.getTime() === cur.startTs.getTime() && s.id < cur.id)
			)
				firstLater.set(s.subject, s);
			continue;
		}
		const into =
			s.lane === "state"
				? lastState
				: s.lane === "activity"
					? lastActivity
					: lastStatus;
		if (newer(into.get(s.subject), s)) into.set(s.subject, s);
	}

	// Runs: those started by t, in the state their lane held.
	const rows = await db
		.select({
			id: runs.id,
			state: runs.state,
			activity: runs.activity,
			startedAt: runs.startedAt,
			finishedAt: runs.finishedAt,
		})
		.from(runs);
	const asOfRuns = new Map<string, AsOfRun>();
	for (const r of rows) {
		if (r.startedAt.getTime() > t) continue;
		const subject = runRef(r.id);
		const st = lastState.get(subject);
		let state: string;
		let activity: string | null = null;
		if (st) {
			state = st.value;
			const act = lastActivity.get(subject);
			const open = act && (act.endTs === null || act.endTs.getTime() > t);
			if (LIVE_STATES.has(state) && open) activity = act.value;
		} else if (r.finishedAt && r.finishedAt.getTime() <= t) {
			state = r.state;
		} else {
			state = "running";
			activity = null;
		}
		const terminal = !LIVE_STATES.has(state);
		asOfRuns.set(r.id, {
			state,
			activity: terminal ? null : activity,
			finishedAt: terminal
				? r.finishedAt && r.finishedAt.getTime() <= t
					? r.finishedAt
					: (st?.startTs ?? r.finishedAt)
				: null,
		});
	}

	// Tasks: created by t, not deleted, in the status the lane held.
	const tasks: FlowTaskInput[] = [];
	for (const task of opts.tasks) {
		if (task.createdAt && task.createdAt.getTime() > t) continue;
		const sp = lastStatus.get(taskRef(task.id));
		if (sp) {
			// A closed last span with no successor is a deletion.
			if (sp.endTs !== null && sp.endTs.getTime() <= t) continue;
			tasks.push({ ...task, status: sp.value });
			continue;
		}
		// No change by t: the status before its first recorded change, else the row's.
		const from = firstLater.get(taskRef(task.id))?.detail?.from;
		tasks.push(typeof from === "string" ? { ...task, status: from } : task);
	}

	// seq: newest event at or before t.
	const [head] = await db
		.select({ seq: sql<number>`COALESCE(MAX(${events.seq}), 0)` })
		.from(events)
		.where(lt(events.ts, new Date(t + 1)));

	const tree = await flowTree(db, {
		tasks,
		now: t,
		...(opts.ended ? { ended: opts.ended } : {}),
		asOf: { runs: asOfRuns, seq: head?.seq ?? 0, t },
	});
	return { ...tree, t: tDate };
}

/** Is this run state one in which the run still owns work (not settled)? */
export function isLiveRunState(state: string): boolean {
	return LIVE_STATES.has(state);
}

/**
 * The tree restricted to what is running: every live run node, plus the
 * ancestors that give it position (its task, that task's epic, a parent run).
 * Home's live section reads this; it is the same `FlowNode`s as `flowTree`,
 * so a run draws identically there and in the project's Flow lens.
 */
export function liveSubset(nodes: readonly FlowNode[]): FlowNode[] {
	const byRef = new Map(nodes.map((n) => [n.ref, n]));
	const keep = new Set<NodeRef>();
	for (const n of nodes) {
		if (n.run && LIVE_STATES.has(n.run.state)) {
			let at: FlowNode | undefined = n;
			while (at && !keep.has(at.ref)) {
				keep.add(at.ref);
				at = at.parent ? byRef.get(at.parent) : undefined;
			}
		}
	}
	return nodes.filter((n) => keep.has(n.ref));
}

// ---------------------------------------------------------------------
// spans
// ---------------------------------------------------------------------

export interface FlowSpan {
	subject: NodeRef;
	lane: string;
	value: string;
	start: Date;
	end: Date | null;
	detail?: Record<string, unknown>;
}

export type MarkerKind =
	| "decision"
	| "human"
	| "merge"
	| "hold"
	| "verify_fail"
	| "verdict"
	| "spawn"
	/** The brain asked for a person (`notify_human`, not `fyi`). */
	| "notify";

export interface FlowMarker {
	subject: NodeRef;
	at: Date;
	kind: MarkerKind;
	ref: NodeRef;
	label: string;
}

export interface FlowSpansQuery {
	from: Date;
	to: Date;
	/** Restrict to these subjects; absent = the whole project. */
	subjects?: readonly NodeRef[];
}

/** Descendants of `root` (inclusive) by the tree's parent refs. */
export function subtreeRefs(
	nodes: readonly Pick<FlowNode, "ref" | "parent">[],
	root: NodeRef,
): NodeRef[] {
	const kids = new Map<NodeRef, NodeRef[]>();
	for (const n of nodes) {
		if (!n.parent) continue;
		const list = kids.get(n.parent) ?? [];
		list.push(n.ref);
		kids.set(n.parent, list);
	}
	const out: NodeRef[] = [];
	const seen = new Set<NodeRef>();
	const stack = [root];
	while (stack.length > 0) {
		const ref = stack.pop() as NodeRef;
		if (seen.has(ref)) continue;
		seen.add(ref);
		out.push(ref);
		stack.push(...(kids.get(ref) ?? []));
	}
	return out;
}

const IN_CHUNK = 400;
function chunks<T>(xs: readonly T[]): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < xs.length; i += IN_CHUNK)
		out.push(xs.slice(i, i + IN_CHUNK));
	return out;
}

/**
 * Spans overlapping `[from, to]` for the subjects, plus the point markers in
 * the window drawn from decisions, review verdicts, merge and verify events
 * and task holds. A span is in the window when it starts before `to` and has
 * not ended before `from` (an open span always overlaps).
 */
export async function flowSpans(
	db: ProjectDb,
	q: FlowSpansQuery,
): Promise<{ spans: FlowSpan[]; markers: FlowMarker[] }> {
	const subjects = q.subjects ? new Set(q.subjects) : null;
	const spanRows: (typeof runSpans.$inferSelect)[] = [];
	const window = and(
		lt(runSpans.startTs, q.to),
		or(isNull(runSpans.endTs), gte(runSpans.endTs, q.from)),
	);
	if (subjects) {
		for (const part of chunks([...subjects])) {
			spanRows.push(
				...(await db
					.select()
					.from(runSpans)
					.where(and(inArray(runSpans.subject, part), window))),
			);
		}
	} else {
		spanRows.push(...(await db.select().from(runSpans).where(window)));
	}
	spanRows.sort(
		(a, b) => a.startTs.getTime() - b.startTs.getTime() || a.id - b.id,
	);
	const spans: FlowSpan[] = spanRows.map((s) => ({
		subject: s.subject,
		lane: s.lane,
		value: s.value,
		start: s.startTs,
		end: s.endTs,
		...(s.detail ? { detail: s.detail } : {}),
	}));
	// A subagent is one span on its own subject: running until it ends, then ok / error.
	for (const s of await listRunSubagents(db)) {
		const subject = subRef(s.runId, s.toolUseId);
		if (subjects && !subjects.has(subject)) continue;
		if (s.startedAt.getTime() >= q.to.getTime()) continue;
		if (s.endedAt && s.endedAt.getTime() < q.from.getTime()) continue;
		spans.push({
			subject,
			lane: "state",
			value: s.status === "running" ? "running" : s.status,
			start: s.startedAt,
			end: s.endedAt,
			detail: { agentType: s.agentType, description: s.description },
		});
	}
	spans.sort((a, b) => a.start.getTime() - b.start.getTime());

	const markers: FlowMarker[] = [];
	const keep = (subject: NodeRef) => !subjects || subjects.has(subject);
	const subjectOf = (
		taskId: string | null,
		runId: string | null,
	): NodeRef | null =>
		runId ? runRef(runId) : taskId ? taskRef(taskId) : null;

	for (const d of await db
		.select({
			id: decisions.id,
			ts: decisions.ts,
			role: decisions.role,
			taskId: decisions.taskId,
			subjectRunId: decisions.subjectRunId,
			action: decisions.action,
			status: decisions.status,
		})
		.from(decisions)
		.where(between(decisions.ts, q.from, q.to))) {
		const subject = subjectOf(d.taskId, d.subjectRunId);
		if (!subject || !keep(subject)) continue;
		markers.push({
			subject,
			at: d.ts,
			kind: (d.role as string) === "human" ? "human" : "decision",
			ref: `decision:${d.id}`,
			label: `${d.role}: ${d.action ?? d.status}`,
		});
	}

	for (const v of await db
		.select({
			id: reviewVerdicts.id,
			at: reviewVerdicts.createdAt,
			subjectRunId: reviewVerdicts.subjectRunId,
			reviewerRunId: reviewVerdicts.reviewerRunId,
			mode: reviewVerdicts.mode,
			verdict: reviewVerdicts.verdict,
		})
		.from(reviewVerdicts)
		.where(between(reviewVerdicts.createdAt, q.from, q.to))) {
		const subject = runRef(v.subjectRunId);
		if (!keep(subject)) continue;
		markers.push({
			subject,
			at: v.at,
			kind: "verdict",
			ref: v.reviewerRunId ? runRef(v.reviewerRunId) : subject,
			label: `${v.mode} review: ${v.verdict}`,
		});
	}

	const eventRows = await db
		.select({
			seq: events.seq,
			ts: events.ts,
			type: events.type,
			taskId: events.taskId,
			runId: events.runId,
			payload: events.payload,
		})
		.from(events)
		.where(
			and(
				between(events.ts, q.from, q.to),
				inArray(events.type, [
					"merge.completed",
					"merge.abandoned",
					"merge.parked",
					"verify.check",
					"task.held_for_resource",
				]),
			),
		);
	const mergeRunIds = [
		...new Set(
			eventRows
				.filter((e) => e.type.startsWith("merge.") && e.runId)
				.map((e) => e.runId as string),
		),
	];
	const jobByRun = new Map<string, number>();
	for (const part of chunks(mergeRunIds)) {
		for (const j of await db
			.select({ id: mergeJobs.id, runId: mergeJobs.runId })
			.from(mergeJobs)
			.where(inArray(mergeJobs.runId, part))) {
			jobByRun.set(j.runId, j.id);
		}
	}
	for (const e of eventRows) {
		const payload = (e.payload ?? {}) as Record<string, unknown>;
		const at = e.ts;
		if (e.type.startsWith("merge.") && e.runId) {
			const subject = runRef(e.runId);
			if (!keep(subject)) continue;
			const job = jobByRun.get(e.runId);
			markers.push({
				subject,
				at,
				kind: "merge",
				ref: job !== undefined ? `merge:${job}` : subject,
				label: e.type.slice("merge.".length),
			});
		} else if (e.type === "verify.check") {
			if (payload.passed !== false || !e.runId) continue;
			const subject = runRef(e.runId);
			if (!keep(subject)) continue;
			markers.push({
				subject,
				at,
				kind: "verify_fail",
				ref: subject,
				label: `check failed: ${String(payload.check ?? "")}`,
			});
		} else if (e.type === "task.held_for_resource" && e.taskId) {
			const subject = taskRef(e.taskId);
			if (!keep(subject)) continue;
			markers.push({
				subject,
				at,
				kind: "hold",
				ref: subject,
				label: String(payload.reason ?? "held for resource"),
			});
		}
	}
	const brain = await brainSpansAndMarkers(db, q, subjects);
	spans.push(...brain.spans);
	markers.push(...brain.markers);
	markers.sort((a, b) => a.at.getTime() - b.at.getTime());
	return { spans, markers };
}

// ---------------------------------------------------------------------
// brain (U3-02): the root node, turn spans, decision markers
// ---------------------------------------------------------------------

export const BRAIN_REF: NodeRef = "brain";

async function brainTurnRunIds(db: ProjectDb): Promise<Set<string>> {
	const rows = await db.select({ runId: brainTurns.runId }).from(brainTurns);
	return new Set(rows.map((r) => r.runId));
}

/**
 * Add the `brain` root when the project has (or had) a brain session, and hang
 * every parentless node under it. With no session there is no node and the
 * tree is exactly what it was: a project that never turned the brain on sees
 * nothing of it.
 */
async function attachBrainRoot(
	db: ProjectDb,
	nodes: FlowNode[],
	now: number,
): Promise<void> {
	const sessions = await db
		.select()
		.from(brainSessions)
		.orderBy(desc(brainSessions.createdAt));
	const session =
		sessions.find((s) => s.status !== "retired") ?? sessions[0] ?? null;
	// A tree drawn at an earlier time has no brain from before its session.
	if (!session || session.createdAt.getTime() > now) return;
	const turns = await db
		.select({
			runId: brainTurns.runId,
			status: brainTurns.status,
			startedAt: brainTurns.startedAt,
			endedAt: brainTurns.endedAt,
		})
		.from(brainTurns)
		.where(
			and(
				eq(brainTurns.sessionId, session.id),
				gte(brainTurns.startedAt, new Date(now - DAY)),
			),
		)
		.orderBy(desc(brainTurns.startedAt));
	const live = turns.find((t) => t.status === "running");
	const last = turns[0];
	const state: FlowBrainInfo["state"] =
		session.status === "retired" ? "idle" : session.status;

	const rollup = emptyRollup();
	let lastAt = session.createdAt.getTime();
	for (const n of nodes) {
		if (n.parent !== null) continue;
		n.parent = BRAIN_REF;
		if (n.rollup) {
			rollup.total += n.rollup.total;
			rollup.done += n.rollup.done;
			rollup.live += n.rollup.live;
			rollup.needsMe += n.rollup.needsMe;
			rollup.costUsdToday += n.rollup.costUsdToday;
		}
		lastAt = Math.max(lastAt, n.lastAt.getTime());
	}
	if (last) {
		lastAt = Math.max(lastAt, (last.endedAt ?? last.startedAt).getTime());
	}
	const failed = state === "failed";
	nodes.unshift({
		ref: BRAIN_REF,
		parent: null,
		kind: "brain",
		title: `Brain \u00b7 gen ${session.generation}`,
		rollup: failed ? { ...rollup, needsMe: rollup.needsMe + 1 } : rollup,
		needsMe: failed ? "brain_stuck" : null,
		lastAt: new Date(lastAt),
		brain: {
			sessionId: session.id,
			state,
			generation: session.generation,
			harness: session.harness,
			model: session.model,
			effort: session.effort,
			turnsLast24h: turns.length,
			liveTurnRunId: live?.runId ?? null,
			consecutiveFailures: session.consecutiveFailures,
			lastTurnAt: last ? (last.endedAt ?? last.startedAt) : null,
		},
	});
}

/**
 * Turn spans (lane `turn`, subject `brain`) and the brain row's decision
 * markers for the window. Decisions that target a task or run also keep the
 * marker the generic pass puts on that row; the brain row gets its own copy,
 * and the decisions with no target (plans, notes, `notify_human`) appear only
 * here.
 */
async function brainSpansAndMarkers(
	db: ProjectDb,
	q: FlowSpansQuery,
	subjects: ReadonlySet<NodeRef> | null,
): Promise<{ spans: FlowSpan[]; markers: FlowMarker[] }> {
	if (subjects && !subjects.has(BRAIN_REF)) return { spans: [], markers: [] };
	const turnRows = await db
		.select()
		.from(brainTurns)
		.where(
			and(
				lt(brainTurns.startedAt, q.to),
				or(isNull(brainTurns.endedAt), gte(brainTurns.endedAt, q.from)),
			),
		);
	const spans: FlowSpan[] = turnRows
		.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
		.map((t) => ({
			subject: BRAIN_REF,
			lane: "turn",
			value: t.status,
			start: t.startedAt,
			end: t.endedAt,
			detail: {
				ref: `turn:${t.runId}`,
				runId: t.runId,
				seq: t.seq,
				generation: t.generation,
				wakeClass: t.wakeClass,
				actions: t.actionsCount,
				...(typeof t.usage?.costUsd === "number"
					? { costUsd: t.usage.costUsd }
					: {}),
				...(t.error ? { error: t.error } : {}),
			},
		}));

	const rows = await db
		.select({
			id: decisions.id,
			ts: decisions.ts,
			kind: decisions.kind,
			action: decisions.action,
			input: decisions.input,
			output: decisions.output,
		})
		.from(decisions)
		.where(
			and(eq(decisions.role, "brain"), between(decisions.ts, q.from, q.to)),
		);
	const markers: FlowMarker[] = rows.map((d) => {
		const status = (d.output as { status?: string } | null)?.status;
		const escalation =
			d.action === "notify_human" &&
			(d.input as { kind?: string } | null)?.kind !== "fyi";
		const what = d.action ?? d.kind ?? "decision";
		return {
			subject: BRAIN_REF,
			at: d.ts,
			kind: escalation ? "notify" : "decision",
			ref: `decision:${d.id}`,
			label: status && status !== "applied" ? `${what} (${status})` : what,
		};
	});
	return { spans, markers };
}
