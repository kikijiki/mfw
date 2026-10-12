import { createContext, useContext } from "react";

import type { Pip } from "../../components/agent/HistoryPips";
import type { PipGlyph } from "../../components/agent/look";
import { activityAttention } from "../agents/attention";
import { TASK_QUESTION_KIND } from "../clarify/AnswerBox";

/**
 * The agent side of a board card, from caches the live channel keeps fresh:
 * the live runs of a task (`runs.active`, keyed by TASK, so competing
 * attempts each get a chip), the task whose own run stopped to ask a question
 * (`clarify.open`, kind `task`) and the settled-run pips (`runs.pipsByTask`).
 * Computed once per board render and read by each card through context, so
 * cards add no query observers.
 */

export interface CardRun {
	runId: string;
	state: string;
	activity?: string | null;
	activityDetail?: unknown;
	scopeSample?: unknown;
	taskId?: string | null;
	/** The harness / provider id (`claude-cli`). */
	providerId?: string | null;
	model?: string | null;
	startedAt?: number | null;
	/** Running cost sampled while the run is live (`run.usage_sampled`). */
	liveCostUsd?: number | null;
}

/** What the brain intends for a task (`brain.intents`): its newest action, while no run has started since. */
export interface CardIntent {
	taskId: string;
	decisionId: number;
	tool: string;
	rationale: string;
	confidence: "low" | "medium" | "high" | null;
	/** `proposed` while the brain is in shadow mode. */
	state: string | null;
}

export interface BoardAgents {
	/** Live runs of this project by run id. */
	runs: ReadonlyMap<string, CardRun>;
	/** Task id → its live runs, oldest first (competing attempts are several). */
	byTask: ReadonlyMap<string, readonly CardRun[]>;
	/** Task id → the finished run whose question is waiting for an answer. */
	asking: ReadonlyMap<string, string>;
	/** Task id → settled-run pips, oldest first. */
	pips: Readonly<Record<string, readonly Pip[]>>;
	/** Task id → the brain's standing intent, only where it is newer than the latest run. */
	intents: ReadonlyMap<string, CardIntent>;
}

export const EMPTY_BOARD_AGENTS: BoardAgents = {
	runs: new Map(),
	byTask: new Map(),
	asking: new Map(),
	pips: {},
	intents: new Map(),
};

export function boardAgents(
	project: string,
	active: readonly ({ project: string } & CardRun)[] | undefined,
	questions:
		| readonly {
				project: string;
				runId: string;
				kind: string;
				taskId?: string | null;
		  }[]
		| undefined,
	pips?: Readonly<Record<string, readonly { ref: string; glyph: string }[]>>,
	intents?: readonly CardIntent[],
): BoardAgents {
	const runs = new Map<string, CardRun>();
	const byTask = new Map<string, CardRun[]>();
	for (const r of active ?? []) {
		if (r.project !== project) continue;
		runs.set(r.runId, r);
		if (r.taskId) {
			const list = byTask.get(r.taskId) ?? [];
			list.push(r);
			byTask.set(r.taskId, list);
		}
	}
	for (const list of byTask.values())
		list.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
	const asking = new Map<string, string>();
	for (const q of questions ?? []) {
		if (q.project === project && q.kind === TASK_QUESTION_KIND && q.taskId)
			asking.set(q.taskId, q.runId);
	}
	const outPips: Record<string, Pip[]> = {};
	for (const [taskId, list] of Object.entries(pips ?? {})) {
		outPips[taskId] = list.map((p) => ({
			ref: p.ref,
			glyph: p.glyph as PipGlyph,
		}));
	}
	return {
		runs,
		byTask,
		asking,
		pips: outPips,
		intents: new Map((intents ?? []).map((i) => [i.taskId, i])),
	};
}

/**
 * The live runs a card shows: the runs of this task, plus the run holding its
 * claim when `runs.active` has not attributed it by task (a draft's
 * expansion run, or a cache a beat behind).
 */
export function runsForTask(
	agents: BoardAgents,
	task: { id: string; claimedByRunId: string | null },
): readonly CardRun[] {
	const own = agents.byTask.get(task.id) ?? [];
	if (!task.claimedByRunId) return own;
	if (own.some((r) => r.runId === task.claimedByRunId)) return own;
	const claimed = agents.runs.get(task.claimedByRunId);
	return claimed ? [...own, claimed] : own;
}

/** A run that has not finished: the header's "live" count and the chips. */
export function isLiveRun(run: { state: string }): boolean {
	return run.state !== "ended";
}

/** A person is the next move on this card: its run asked, or a live run's activity asks. */
export function taskNeedsHuman(
	agents: BoardAgents,
	project: string,
	task: { id: string; claimedByRunId: string | null },
): boolean {
	if (agents.asking.has(task.id)) return true;
	return runsForTask(agents, task).some(
		(r) => activityAttention({ project, ...r }) !== null,
	);
}

/** How many runs of this task are live (the column header's count). */
export function taskLiveRuns(
	agents: BoardAgents,
	task: { id: string; claimedByRunId: string | null },
): number {
	return runsForTask(agents, task).filter(isLiveRun).length;
}

export const BoardAgentsContext =
	createContext<BoardAgents>(EMPTY_BOARD_AGENTS);

export function useBoardAgents(): BoardAgents {
	return useContext(BoardAgentsContext);
}
