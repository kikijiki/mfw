import { join } from "node:path";
import type { ProjectDbHandle } from "@mfw/db/client";
import { appendEvent, type EventBus } from "@mfw/db/eventlog";
import { git } from "./git.ts";
import type { Logger } from "./log.ts";
import type { RefusalFix } from "./refusal-fix.ts";
import type { RunRegistry, RunRow } from "./run-registry.ts";
import { runHoldsClaim, type TaskService } from "./task-service.ts";
import { type WipArchive, WorktreeManager } from "./worktree.ts";

/**
 * Lifecycle safety (backstage architecture.md, "Task lifecycle"): nothing a human does from the UI
 * destroys run work without first saving it to a `wip/` branch, and a task is
 * not closed while its branch holds work that never landed.
 */

/** Run states in which the run still owns its worktree and branch. */
const LIVE_RUN_STATES = new Set<string>([
	"starting",
	"running",
	"ended",
	"finalizing",
	"merging",
]);

/** The newest run of a task holds commits the integration branch lacks. */
export interface UnmergedBranch {
	runId: string;
	branch: string;
	baseSha: string;
	tip: string;
	worktreePath: string;
	/** Commits on the branch that are not on the integration branch. */
	ahead: number;
	integrationBranch: string;
}

export type { RefusalFix };

/**
 * A human tried to close (done/archived) a task whose newest branch has work
 * that never merged. Closing would leave that work stranded on a branch no
 * screen points at any more.
 */
export class TaskUnmergedError extends Error {
	readonly fix: RefusalFix;
	constructor(
		readonly taskId: string,
		readonly unmerged: UnmergedBranch,
	) {
		super(
			`${taskId} has ${unmerged.ahead} commit(s) on ${unmerged.branch} that are not on ${unmerged.integrationBranch}`,
		);
		this.name = "TaskUnmergedError";
		this.fix = {
			kind: "ui",
			text: `Merge the work first (send the task to Review and approve it), or close it again with "discard", which saves ${unmerged.branch} to wip/${taskId}-${unmerged.runId} and then deletes it.`,
		};
	}
}

/** Discarding a run that still owns its worktree would pull it from under the agent. */
export class RunLiveError extends Error {
	readonly fix: RefusalFix;
	constructor(
		readonly runId: string,
		readonly state: string,
	) {
		super(
			`run ${runId} is ${state}; a live run's worktree cannot be discarded`,
		);
		this.name = "RunLiveError";
		this.fix = {
			kind: "ui",
			text: `Stop run ${runId} (Agents → Stop) and wait for it to finish finalizing, then discard again.`,
		};
	}
}

export interface DiscardResult {
	runId: string;
	archive: WipArchive | null;
	removed: boolean;
}

export class LifecycleService {
	private readonly worktrees: WorktreeManager;

	constructor(
		private readonly deps: {
			handle: ProjectDbHandle;
			bus: EventBus;
			registry: RunRegistry;
			tasks: TaskService;
			projectRoot: string;
			integrationBranch: string;
			log: Logger;
		},
	) {
		this.worktrees = new WorktreeManager(deps.projectRoot);
	}

	/**
	 * The task's newest run with a branch, if that branch has commits beyond
	 * its base which the integration branch does not contain. Older runs are
	 * superseded attempts and never block a close.
	 */
	async unmergedBranch(taskId: string): Promise<UnmergedBranch | null> {
		// Only task runs produce the task's mergeable code: a draft's plan runs
		// and regression repairs do not decide whether the task can close.
		const runs = await this.deps.registry.list({ taskId, kinds: ["task"] });
		const newest = runs
			.filter((run) => run.branch && run.baseSha)
			.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
		if (!newest?.branch || !newest.baseSha) return null;
		const root = this.deps.projectRoot;
		const tip = await git(
			["rev-parse", "--verify", "-q", `refs/heads/${newest.branch}^{commit}`],
			root,
		);
		if (tip.exitCode !== 0) return null; // branch gone: nothing to strand
		const sha = tip.stdout.trim();
		if (sha === newest.baseSha) return null;
		const integration = newest.integrationBranch ?? this.deps.integrationBranch;
		const merged = await git(
			["merge-base", "--is-ancestor", sha, `refs/heads/${integration}`],
			root,
		);
		if (merged.exitCode === 0) return null;
		if (merged.exitCode !== 1) {
			// Fail closed: an unanswerable question is not proof the work landed.
			throw new Error(
				`could not tell whether ${newest.branch} is merged: ${merged.stderr || merged.stdout}`,
			);
		}
		const count = await git(
			["rev-list", "--count", `refs/heads/${integration}..${sha}`],
			root,
		);
		return {
			runId: newest.id,
			branch: newest.branch,
			baseSha: newest.baseSha,
			tip: sha,
			worktreePath: this.worktreePathOf(newest),
			ahead: Number.parseInt(count.stdout, 10) || 1,
			integrationBranch: integration,
		};
	}

	/**
	 * Save a non-live run's worktree and branch to `wip/<task>-<run>`, then
	 * remove both. Refuses a live run, and a run whose cleanup is still pending
	 * (it still owns its writers).
	 */
	async discardRun(
		runId: string,
		actor: "human" | "scheduler" = "human",
		reason = "discarded",
	): Promise<DiscardResult> {
		const run = await this.deps.registry.get(runId);
		if (!run) throw new Error(`unknown run ${runId}`);
		if (LIVE_RUN_STATES.has(run.state))
			throw new RunLiveError(runId, run.state);
		if (await this.deps.registry.hasPendingCleanup(runId)) {
			throw new RunLiveError(runId, "still cleaning up");
		}
		if (run.taskId) {
			const task = await this.deps.tasks.get(run.taskId);
			if (runHoldsClaim(task, run)) {
				throw new RunLiveError(runId, "still holding its task claim");
			}
		}
		if (!run.branch || !run.baseSha) {
			return { runId, archive: null, removed: false };
		}
		const { archive, removed } = await this.worktrees.discard(
			{
				path: this.worktreePathOf(run),
				branch: run.branch,
				baseSha: run.baseSha,
			},
			{ runId, taskId: run.taskId },
		);
		if (run.taskId) {
			const task = await this.deps.tasks.get(run.taskId);
			if (task?.preservedBranch === run.branch) {
				await this.deps.tasks.clearPreservedWorktree(run.taskId);
			}
		}
		const event = await this.deps.handle.withTx((tx) =>
			appendEvent(tx, {
				type: "run.wip_archived",
				runId,
				...(run.taskId ? { taskId: run.taskId } : {}),
				payload: {
					ref: archive?.ref ?? null,
					sha: archive?.sha ?? null,
					actor,
					reason,
				},
			}),
		);
		this.deps.bus.publish([event]);
		this.deps.log.info(
			{ runId, taskId: run.taskId, wip: archive?.ref ?? null, actor },
			"run worktree discarded",
		);
		return { runId, archive, removed };
	}

	/**
	 * Discard every non-live run of a task that still has a branch. Refuses
	 * (before touching anything) while any of its runs is live.
	 */
	async discardTask(taskId: string): Promise<DiscardResult[]> {
		const runs = (await this.deps.registry.list({ taskId })).filter(
			(run) => run.branch,
		);
		for (const run of runs) {
			if (LIVE_RUN_STATES.has(run.state)) {
				throw new RunLiveError(run.id, run.state);
			}
		}
		const results: DiscardResult[] = [];
		for (const run of runs) {
			const exists = await git(
				["rev-parse", "--verify", "-q", `refs/heads/${run.branch}`],
				this.deps.projectRoot,
			);
			const registered = (await this.worktrees.list()).includes(
				this.worktreePathOf(run),
			);
			if (exists.exitCode !== 0 && !registered) continue;
			results.push(await this.discardRun(run.id, "human", "task discarded"));
		}
		return results;
	}

	private worktreePathOf(run: RunRow): string {
		return run.worktreePath ?? join(this.worktrees.dir, run.id);
	}
}
