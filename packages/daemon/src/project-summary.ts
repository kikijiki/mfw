import type { TaskStatus } from "@mfw/core/types";

/**
 * One cheap per-project digest for the sidebar: how much work is where, what
 * needs a person, what the brain is doing and what today cost. The counts are
 * by the board's status ROLE (the canonical `TaskStatus`), so a board with
 * custom status names reads the same. `projects.summary` calls
 * `collectProjectSummary` for every attached project in one request, so the
 * client never fans out per project.
 */

export interface ProjectSummary {
	project: string;
	/** Tasks per canonical role; every role is present (0 when empty). */
	tasks: Record<TaskStatus, number>;
	/** Worker runs (not brain turns) that are starting or running. */
	sessions: {
		live: number;
		/** Live runs an inbox item is waiting on (question, approval, ...). */
		waiting: number;
	};
	worktrees: {
		/** Worktrees of live runs. */
		active: number;
		/** Worktrees still on disk whose run has ended (parked work). */
		parked: number;
	};
	/** `inbox.list` length for this project. */
	needsYou: number;
	brain: {
		enabled: boolean;
		state: "off" | "idle" | "turn" | "paused" | "failed";
	};
	/** Spend since local midnight, USD. */
	spendTodayUsd: number;
	/** Epoch ms of the newest audit event; null for a project with no events. */
	lastActivityAt: number | null;
}

export const EMPTY_TASK_COUNTS: Record<TaskStatus, number> = {
	draft: 0,
	backlog: 0,
	ready: 0,
	in_progress: 0,
	blocked: 0,
	review: 0,
	done: 0,
	archived: 0,
};

const LIVE_RUN_STATES = new Set(["starting", "running"]);

export interface SummaryInputs {
	project: string;
	taskStatuses: readonly TaskStatus[];
	runs: readonly { id: string; kind: string; state: string }[];
	worktrees: readonly { runId: string; state: string }[];
	inboxItems: readonly { runId?: string }[];
	brain: { enabled: boolean; state: ProjectSummary["brain"]["state"] };
	spendTodayUsd: number;
	lastActivityAt: number | null;
}

/** Pure: shape the collected facts. */
export function buildProjectSummary(input: SummaryInputs): ProjectSummary {
	const tasks = { ...EMPTY_TASK_COUNTS };
	for (const status of input.taskStatuses) {
		if (status in tasks) tasks[status] += 1;
	}
	const live = input.runs.filter(
		(r) => r.kind !== "brain" && LIVE_RUN_STATES.has(r.state),
	);
	const liveIds = new Set(live.map((r) => r.id));
	const waitingIds = new Set(
		input.inboxItems
			.map((i) => i.runId)
			.filter((id): id is string => id !== undefined && liveIds.has(id)),
	);
	let active = 0;
	let parked = 0;
	for (const wt of input.worktrees) {
		if (LIVE_RUN_STATES.has(wt.state)) active += 1;
		else parked += 1;
	}
	return {
		project: input.project,
		tasks,
		sessions: { live: live.length, waiting: waitingIds.size },
		worktrees: { active, parked },
		needsYou: input.inboxItems.length,
		brain: input.brain,
		spendTodayUsd: input.spendTodayUsd,
		lastActivityAt: input.lastActivityAt,
	};
}

/** The slice of `ProjectServices` the collector reads (so a test can fake it). */
export interface SummarySource {
	name: string;
	tasks: { list(): Promise<readonly { status: TaskStatus }[]> };
	registry: {
		list(filter?: {
			states?: string[];
		}): Promise<readonly { id: string; kind: string; state: string }[]>;
	};
	workspace: {
		worktrees(): Promise<readonly { runId: string; state: string }[]>;
	};
	inbox: { list(): Promise<readonly { runId?: string }[]> };
	brainState(): Promise<ProjectSummary["brain"]>;
	spendSince(since: Date): Promise<number>;
	lastEventAt(): Promise<number | null>;
}

/** Local midnight of `now`. */
export function startOfLocalDay(now: number): Date {
	const d = new Date(now);
	d.setHours(0, 0, 0, 0);
	return d;
}

/** Read every fact for one project concurrently. Never throws on a missing worktree. */
export async function collectProjectSummary(
	src: SummarySource,
	now = Date.now(),
): Promise<ProjectSummary> {
	const [tasks, runs, worktrees, inbox, brain, spend, last] = await Promise.all(
		[
			src.tasks.list(),
			src.registry.list({
				states: ["starting", "running", "ended", "finalizing", "merging"],
			}),
			src.workspace.worktrees().catch(() => []),
			src.inbox.list().catch(() => []),
			src.brainState().catch((): ProjectSummary["brain"] => ({
				enabled: false,
				state: "off",
			})),
			src.spendSince(startOfLocalDay(now)).catch(() => 0),
			src.lastEventAt().catch(() => null),
		],
	);
	return buildProjectSummary({
		project: src.name,
		taskStatuses: tasks.map((t) => t.status),
		runs,
		worktrees,
		inboxItems: inbox,
		brain,
		spendTodayUsd: spend,
		lastActivityAt: last,
	});
}
