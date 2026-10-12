import type { ProjectDb } from "@mfw/db/client";
import {
	brainActions,
	clarifications,
	decisions,
	events,
	mergeJobs,
	reviewVerdicts,
	runGroups,
	runSubagents,
	runs,
} from "@mfw/db/schema";
import { asc, eq, inArray, or, sql } from "drizzle-orm";
import { actionStateOf, type BrainActionState } from "./brain-view.ts";

/**
 * A task's Story (v0): everything that happened to one task, folded from the
 * tables that already exist, in time order. Runs are the spine; a repair,
 * resume, answer or unblock run nests under the first run of its worktree
 * chain; decisions, verdicts, status moves, merges, questions and holds are
 * siblings on the same timeline.
 *
 * Run lifecycle events (`run.state_changed`) carry no task id, so they are
 * found by joining through `runs.task_id`. The whole task is folded in memory
 * and then paged, which is fine for one task's history; a durable span table
 * replaces this fold later.
 */

export type StoryRef = string;

export interface StoryRunSummary {
	role: string;
	relation: StoryRelation;
	state: string;
	activity: string | null;
	harness: string | null;
	model: string;
	effort: string | null;
	host: string | null;
	label: string;
	attempt: number;
	startedAt: Date;
	finishedAt: Date | null;
	costUsd: number | null;
}

export type StoryRelation =
	| "fresh"
	| "repair"
	| "resume"
	| "answer"
	| "unblock";

export interface StoryCheck {
	check: string;
	passed: boolean;
	classification?: string;
	detail?: string;
}

export interface StoryVerdict {
	id: string;
	at: Date;
	verdict: string;
	mode: string;
	round: number;
	reviewerHarness: string | null;
	reviewerModel: string | null;
	decisionId: number | null;
}

export interface StoryRunState {
	at: Date;
	from: string;
	to: string;
	note?: string;
}

/** A subagent the run started (`run_subagents`), shown under the run's entry. */
export interface StorySubagent {
	ref: StoryRef;
	parentRef: StoryRef | null;
	agentType: string;
	description: string;
	status: "running" | "ok" | "error";
	startedAt: Date;
	endedAt: Date | null;
	toolCalls: number;
}

export interface StoryRunEntry {
	kind: "run";
	at: Date;
	ref: StoryRef;
	summary: StoryRunSummary;
	/** Present only when the run started subagents, in start order. */
	subagents?: StorySubagent[];
	/** `run.state_changed` events, oldest first. */
	states: StoryRunState[];
	verify: StoryCheck[];
	verdicts: StoryVerdict[];
	lastLine?: string;
	transcriptAvailable: boolean;
	/** Repair/resume/answer/unblock runs continuing this one's worktree. */
	children: StoryRunEntry[];
	/** Set when the run is an attempt of a competing group (it then nests under the group entry). */
	attempt?: { groupRef: StoryRef; role: string | null; winner: boolean };
}

/** An attempt group of the task: the `run_groups` row with its attempts nested. */
export interface StoryGroupEntry {
	kind: "group";
	at: Date;
	ref: StoryRef;
	group: {
		kind: string;
		selection: string;
		status: string;
		winnerRunId: string | null;
		/** `decision:<n>` that spawned it, or `human`. */
		createdBy: StoryRef;
		closedAt: Date | null;
	};
	/** The group's attempts, oldest first (continuations nest under each). */
	attempts: StoryRunEntry[];
}

export type StoryEntry =
	| StoryRunEntry
	| StoryGroupEntry
	| {
			kind: "decision";
			at: Date;
			id: number;
			role: string;
			tool: string;
			target: StoryRef;
			/** The run the decision judged, e.g. the critic's subject. */
			subjectRunId: string | null;
			rationale: string;
			outcome: string;
			effects: StoryRef[];
			/**
			 * The brain's own fields (absent on other roles). `actionState` is
			 * `proposed` while the brain runs in shadow mode: the pipeline
			 * decided and acted, this is what the brain would have done.
			 */
			brain?: StoryBrainDecision;
	  }
	| {
			kind: "status";
			at: Date;
			from: string;
			to: string;
			actor: string;
			reason?: string;
	  }
	| { kind: "edit"; at: Date; actor: string; fields: string[] }
	| {
			kind: "merge";
			at: Date;
			state: string;
			runRef: StoryRef;
			sha?: string;
			detail?: string;
	  }
	| {
			kind: "question";
			at: Date;
			runRef: StoryRef;
			question: string;
			answer?: string;
			answeredBy?: "human";
	  }
	| { kind: "hold"; at: Date; reason: string }
	| { kind: "created"; at: Date; by: string }
	| ({ kind: "verdict"; at: Date; runRef: StoryRef } & StoryVerdict);

export interface StoryBrainDecision {
	/** `action`, `plan`, `note`, `escalation`, ... */
	kind: string | null;
	actionState: BrainActionState | null;
	confidence: "low" | "medium" | "high" | null;
	alternatives: { option: string; why_not: string }[];
	/** The brain turn (a run) that made it. */
	turnRunId: string | null;
	/** How the effect's attempt chain ended, once it closed. */
	settled: Record<string, unknown> | null;
	/** The human override decision that reversed it. */
	overriddenBy: number | null;
	/** `notify_human` only: what it asked a person for. */
	notify?: { kind: string; title: string };
}

export interface StoryPage {
	/** Chronological (oldest first) within the page. */
	entries: StoryEntry[];
	/** Pass back as `before` for the next older page; null at the start of history. */
	cursor: string | null;
}

export interface StoryQuery {
	taskId: string;
	/** An opaque cursor from a previous page. */
	before?: string;
	/** 1..100, default 50. */
	limit?: number;
	/** Keep only these top-level entry kinds. */
	kinds?: readonly StoryEntry["kind"][];
	/** Whether `<run dir>/events.jsonl` still exists (gc prunes old runs). */
	transcriptAvailable?: (runId: string) => boolean;
}

const SUFFIX: Record<string, StoryRelation> = {
	"#repair": "repair",
	"#resume": "resume",
	"#answer": "answer",
	"#unblock": "unblock",
};

function relationOf(label: string): StoryRelation {
	const at = label.lastIndexOf("#");
	return (at >= 0 ? SUFFIX[label.slice(at)] : undefined) ?? "fresh";
}

/** Tie-break order for entries sharing a millisecond. */
const RANK: Record<StoryEntry["kind"], number> = {
	created: 0,
	status: 1,
	edit: 2,
	run: 3,
	group: 3,
	question: 4,
	verdict: 5,
	decision: 6,
	hold: 7,
	merge: 8,
};

interface Keyed {
	at: number;
	rank: number;
	id: string;
	entry: StoryEntry;
}

const cmp = (
	a: { at: number; rank: number; id: string },
	b: { at: number; rank: number; id: string },
): number =>
	a.at - b.at || a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const encodeCursor = (k: { at: number; rank: number; id: string }): string =>
	Buffer.from(JSON.stringify([k.at, k.rank, k.id])).toString("base64url");

function decodeCursor(
	cursor: string,
): { at: number; rank: number; id: string } | null {
	try {
		const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (
			Array.isArray(v) &&
			typeof v[0] === "number" &&
			typeof v[1] === "number" &&
			typeof v[2] === "string"
		) {
			return { at: v[0], rank: v[1], id: v[2] };
		}
	} catch {
		// fall through
	}
	return null;
}

const str = (v: unknown): string | undefined =>
	typeof v === "string" ? v : undefined;

export async function taskStory(
	db: ProjectDb,
	query: StoryQuery,
): Promise<StoryPage> {
	const taskId = query.taskId;
	const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
	const taskRuns = await db
		.select()
		.from(runs)
		.where(eq(runs.taskId, taskId))
		.orderBy(asc(runs.startedAt), asc(runs.id));
	const runIds = taskRuns.map((r) => r.id);
	const byId = new Map(taskRuns.map((r) => [r.id, r]));

	// Run lifecycle events have no task id, so they join through `runs.task_id`.
	const eventRows = await db
		.select()
		.from(events)
		.where(
			or(
				eq(events.taskId, taskId),
				inArray(
					events.runId,
					sql`(SELECT id FROM runs WHERE task_id = ${taskId})`,
				),
			),
		)
		.orderBy(asc(events.seq));
	const decisionRows = await db
		.select()
		.from(decisions)
		.where(eq(decisions.taskId, taskId))
		.orderBy(asc(decisions.ts), asc(decisions.id));
	const verdictRows = await db
		.select()
		.from(reviewVerdicts)
		.where(eq(reviewVerdicts.taskId, taskId))
		.orderBy(asc(reviewVerdicts.createdAt));
	const jobs = await db
		.select()
		.from(mergeJobs)
		.where(eq(mergeJobs.taskId, taskId));
	const clarifyRows =
		runIds.length > 0
			? await db
					.select()
					.from(clarifications)
					.where(inArray(clarifications.runId, runIds))
			: [];

	const subagentRows =
		runIds.length > 0
			? await db
					.select()
					.from(runSubagents)
					.where(inArray(runSubagents.runId, runIds))
					.orderBy(asc(runSubagents.startedAt), asc(runSubagents.entryFromSeq))
			: [];
	const subagentsByRun = new Map<string, StorySubagent[]>();
	for (const s of subagentRows) {
		const list = subagentsByRun.get(s.runId) ?? [];
		list.push({
			ref: `sub:${s.runId}/${s.toolUseId}`,
			parentRef: s.parentToolUseId
				? `sub:${s.runId}/${s.parentToolUseId}`
				: null,
			agentType: s.agentType,
			description: s.description,
			status: s.status as StorySubagent["status"],
			startedAt: s.startedAt,
			endedAt: s.endedAt,
			toolCalls: Object.values(s.tools).reduce((a, b) => a + b, 0),
		});
		subagentsByRun.set(s.runId, list);
	}

	// ---- runs -------------------------------------------------------------
	const runEntries = new Map<string, StoryRunEntry>();
	for (const r of taskRuns) {
		const subagents = subagentsByRun.get(r.id);
		const usage = r.usage as Record<string, number> | null;
		const detail = (r.activityDetail ?? {}) as { question?: string };
		runEntries.set(r.id, {
			kind: "run",
			at: r.startedAt,
			ref: `run:${r.id}`,
			summary: {
				role: r.kind,
				relation: relationOf(r.label),
				state: r.state,
				activity: r.activity,
				harness: r.harness ?? r.providerId,
				model: r.model,
				effort: r.reasoningEffort,
				host: r.hostId,
				label: r.label,
				attempt: r.attempt,
				startedAt: r.startedAt,
				finishedAt: r.finishedAt,
				costUsd: typeof usage?.costUsd === "number" ? usage.costUsd : null,
			},
			...(subagents ? { subagents } : {}),
			states: [],
			verify: [],
			verdicts: [],
			...((r.note ?? detail.question)
				? { lastLine: (r.note ?? detail.question) as string }
				: {}),
			transcriptAvailable: query.transcriptAvailable?.(r.id) ?? false,
			children: [],
		});
	}

	const out: Keyed[] = [];
	const push = (at: Date, entry: StoryEntry, id: string): void => {
		out.push({ at: at.getTime(), rank: RANK[entry.kind], id, entry });
	};

	// Nest continuations under the chain root: the parent must be one of this
	// task's runs AND the label must say it continues the worktree (`parent_run_id`
	// is also "source plan" or "subject run" on other kinds of run).
	const rootOf = (id: string): string => {
		const seen = new Set<string>();
		let cur = byId.get(id);
		while (
			cur?.parentRunId &&
			!seen.has(cur.id) &&
			relationOf(cur.label) !== "fresh" &&
			byId.has(cur.parentRunId)
		) {
			seen.add(cur.id);
			cur = byId.get(cur.parentRunId);
		}
		return cur?.id ?? id;
	};
	// Real attempt groups (`run_groups`): a competing group's attempts nest
	// under one group entry; a group of one stays a plain run.
	const groupRows = (
		await db.select().from(runGroups).where(eq(runGroups.taskId, taskId))
	).filter((g) => g.kind !== "single");
	const groupById = new Map(groupRows.map((g) => [g.id, g]));
	const creators = new Map<string, number>();
	const actionIds = groupRows.flatMap((g) =>
		g.createdByAction ? [g.createdByAction] : [],
	);
	if (actionIds.length > 0) {
		for (const a of await db
			.select({ id: brainActions.id, decisionId: brainActions.decisionId })
			.from(brainActions)
			.where(inArray(brainActions.id, actionIds))) {
			if (a.decisionId !== null) creators.set(a.id, a.decisionId);
		}
	}
	const groupEntries = new Map<string, StoryGroupEntry>();
	for (const r of taskRuns) {
		const entry = runEntries.get(r.id) as StoryRunEntry;
		const g = r.groupId ? groupById.get(r.groupId) : undefined;
		if (g) {
			entry.attempt = {
				groupRef: `group:${g.id}`,
				role: r.role,
				winner: g.winnerRunId === r.id,
			};
		}
		const root = rootOf(r.id);
		if (root !== r.id) {
			(runEntries.get(root) as StoryRunEntry).children.push(entry);
			continue;
		}
		if (!g) {
			push(r.startedAt, entry, r.id);
			continue;
		}
		let ge = groupEntries.get(g.id);
		if (!ge) {
			const decisionId = g.createdByAction
				? creators.get(g.createdByAction)
				: undefined;
			ge = {
				kind: "group",
				at: g.createdAt,
				ref: `group:${g.id}`,
				group: {
					kind: g.kind,
					selection: g.selection,
					status: g.status,
					winnerRunId: g.winnerRunId,
					createdBy:
						decisionId !== undefined ? `decision:${decisionId}` : "human",
					closedAt: g.closedAt,
				},
				attempts: [],
			};
			groupEntries.set(g.id, ge);
			push(g.createdAt, ge, `group:${g.id}`);
		}
		ge.attempts.push(entry);
	}
	for (const ge of groupEntries.values()) {
		ge.attempts.sort(
			(a, b) => a.at.getTime() - b.at.getTime() || (a.ref < b.ref ? -1 : 1),
		);
	}

	// ---- events -----------------------------------------------------------
	const mergeRuns = new Set<string>();
	const mergeEvents: {
		at: Date;
		seq: number;
		runId: string | undefined;
		state: string;
		sha?: string;
		detail?: string;
	}[] = [];
	for (const e of eventRows) {
		const p = e.payload as Record<string, unknown>;
		const run = e.runId ? runEntries.get(e.runId) : undefined;
		switch (e.type) {
			case "run.state_changed":
				run?.states.push({
					at: e.ts,
					from: str(p.from) ?? "",
					to: str(p.to) ?? "",
					...(str(p.note) ? { note: str(p.note) as string } : {}),
				});
				break;
			case "verify.check":
				run?.verify.push({
					check: str(p.check) ?? "",
					passed: p.passed === true,
					...(str(p.classification)
						? { classification: str(p.classification) as string }
						: {}),
					...(str(p.detail) ? { detail: str(p.detail) as string } : {}),
				});
				break;
			case "task.status_changed":
				push(
					e.ts,
					{
						kind: "status",
						at: e.ts,
						from: str(p.from) ?? "",
						to: str(p.to) ?? "",
						actor: str(p.actor) ?? "",
						...(str(p.reason) ? { reason: str(p.reason) as string } : {}),
					},
					`ev:${e.seq}`,
				);
				break;
			case "task.edited":
				push(
					e.ts,
					{
						kind: "edit",
						at: e.ts,
						actor: str(p.source) ?? "",
						fields: Array.isArray(p.fields) ? (p.fields as string[]) : [],
					},
					`ev:${e.seq}`,
				);
				break;
			case "task.created":
				push(
					e.ts,
					{ kind: "created", at: e.ts, by: str(p.source) ?? "human" },
					`ev:${e.seq}`,
				);
				break;
			case "task.held_for_resource": {
				const waiting = Array.isArray(p.waitingFor)
					? (p.waitingFor as string[]).join(", ")
					: "";
				push(
					e.ts,
					{
						kind: "hold",
						at: e.ts,
						reason: str(p.reason) ?? (waiting || "held for a resource"),
					},
					`ev:${e.seq}`,
				);
				break;
			}
			default:
				if (e.type.startsWith("merge.") && e.type !== "merge.board_reverted") {
					if (e.runId) mergeRuns.add(e.runId);
					mergeEvents.push({
						at: e.ts,
						seq: e.seq,
						runId: e.runId ?? undefined,
						state: e.type.slice("merge.".length),
						...(str(p.sha) ? { sha: str(p.sha) as string } : {}),
						...(str(p.reason) ? { detail: str(p.reason) as string } : {}),
					});
				}
		}
	}
	for (const m of mergeEvents) {
		push(
			m.at,
			{
				kind: "merge",
				at: m.at,
				state: m.state,
				runRef: m.runId ? `run:${m.runId}` : `task:${taskId}`,
				...(m.sha ? { sha: m.sha } : {}),
				...(m.detail ? { detail: m.detail } : {}),
			},
			`ev:${m.seq}`,
		);
	}
	// A job with no merge events (pre-event rows, or rows seeded without them)
	// still shows its current state.
	for (const j of jobs) {
		if (mergeRuns.has(j.runId)) continue;
		push(
			j.updatedAt,
			{
				kind: "merge",
				at: j.updatedAt,
				state: j.state,
				runRef: `run:${j.runId}`,
				...(j.error ? { detail: j.error } : {}),
			},
			`job:${j.id}`,
		);
	}

	// ---- decisions, verdicts, questions -----------------------------------
	for (const d of decisionRows) {
		const isBrain = d.role === "brain";
		const actionState = isBrain ? actionStateOf(d.output) : null;
		const result = (d.output?.result ?? null) as Record<string, unknown> | null;
		const effects: StoryRef[] = [];
		if (isBrain && typeof result?.runId === "string") {
			effects.push(`run:${result.runId}`);
		}
		const input = d.input as Record<string, unknown>;
		push(
			d.ts,
			{
				kind: "decision",
				at: d.ts,
				id: d.id,
				role: d.role,
				tool: d.action ?? d.role,
				target: `task:${taskId}`,
				subjectRunId: d.subjectRunId,
				rationale: d.reason ?? "",
				outcome: actionState ?? d.status,
				effects,
				...(isBrain
					? {
							brain: {
								kind: d.kind,
								actionState,
								confidence: d.confidence,
								alternatives: d.alternatives ?? [],
								turnRunId: d.turnRunId,
								settled: d.outcome,
								overriddenBy: d.overriddenBy,
								...(d.action === "notify_human"
									? {
											notify: {
												kind: str(input.kind) ?? "fyi",
												title: str(input.title) ?? "",
											},
										}
									: {}),
							},
						}
					: {}),
			},
			`decision:${d.id}`,
		);
	}
	for (const v of verdictRows) {
		const verdict: StoryVerdict = {
			id: v.id,
			at: v.createdAt,
			verdict: v.verdict,
			mode: v.mode,
			round: v.round,
			reviewerHarness: v.reviewerHarness,
			reviewerModel: v.reviewerModel,
			decisionId: v.decisionId,
		};
		const run = runEntries.get(v.subjectRunId);
		if (run) run.verdicts.push(verdict);
		else
			push(
				v.createdAt,
				{
					kind: "verdict",
					runRef: `run:${v.subjectRunId}`,
					...verdict,
				},
				`verdict:${v.id}`,
			);
	}
	for (const c of clarifyRows) {
		c.items.forEach((item, i) => {
			push(
				c.createdAt,
				{
					kind: "question",
					at: c.createdAt,
					runRef: `run:${c.runId}`,
					question: item.question,
					...(item.answer !== null
						? { answer: item.answer, answeredBy: "human" as const }
						: {}),
				},
				`clarify:${c.runId}:${i}`,
			);
		});
	}

	// ---- order, filter, page ----------------------------------------------
	for (const run of runEntries.values()) {
		run.children.sort(
			(a, b) => a.at.getTime() - b.at.getTime() || (a.ref < b.ref ? -1 : 1),
		);
	}
	let keyed = out;
	if (query.kinds && query.kinds.length > 0) {
		const kinds = new Set<string>(query.kinds);
		keyed = keyed.filter((k) => kinds.has(k.entry.kind));
	}
	keyed.sort(cmp);
	const before = query.before ? decodeCursor(query.before) : null;
	const upTo = before ? keyed.filter((k) => cmp(k, before) < 0) : keyed;
	const page = upTo.slice(Math.max(0, upTo.length - limit));
	const first = page[0];
	return {
		entries: page.map((k) => k.entry),
		cursor: first && upTo.length > page.length ? encodeCursor(first) : null,
	};
}

// Re-exported for the router's input validation.
export const STORY_KINDS = [
	"run",
	"group",
	"decision",
	"status",
	"edit",
	"merge",
	"question",
	"hold",
	"created",
	"verdict",
] as const satisfies readonly StoryEntry["kind"][];
