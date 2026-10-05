import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectDbHandle } from "@mfw/db/client";
import { appendEvent, type EventBus } from "@mfw/db/eventlog";
import { engineKv, type MergeJobState, mergeJobs, runs } from "@mfw/db/schema";
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { git } from "./git.ts";
import type { Logger } from "./log.ts";
import { ESCALATE_AFTER_SWEEPS } from "./maintenance.ts";

/**
 * One FIFO worker per project, one in-flight job, merging into the recorded
 * integration branch via a persistent worktree at `.mfw/integration/`; the
 * primary checkout is never touched. Job flow:
 *
 *   queued → merging → merged
 *               │(conflict)
 *               ▼
 *           rebasing → reverifying → merging(retry, once) → merged
 *               │(conflict)   │(fail)        │(conflict again)
 *               └──────────► parked ──requeued by retryParked()──► queued
 *                                │
 *                        (parkRetries ≥ MAX_PARK_RETRIES)
 *                                ▼
 *                        onParked (escalate to a human)
 *                                │  │
 *                        (retry) │  │ (abandon / sendToReady)
 *                                ▼  ▼
 *                            queued  abandoned
 *
 * Red-main pauses the queue: jobs stay queued instead of bouncing to review.
 * Each state change commits before the next action, so a crash resumes
 * deterministically (reconcile resets in-flight jobs to queued after
 * hard-resetting the integration worktree).
 *
 * A park is usually a stale conflict (target moved while the job queued), so
 * `park()` retries automatically, bounded by `MAX_PARK_RETRIES`, before calling
 * `onParked` to escalate. Retries reuse the same run, worktree and branch;
 * nothing is discarded. `retryParked()` runs off the maintenance cadence,
 * which is enough backoff.
 *
 * After escalation the operator can `retry`, `abandon` or `sendToReady`;
 * `abandoned` is the terminal state of the latter two. `retry` stays available
 * because a human may have merged the conflicting change since the last pass.
 */

/** Parks a job survives before `park()` stops retrying and escalates. */
const MAX_PARK_RETRIES = ESCALATE_AFTER_SWEEPS;

export interface MergeJobView {
	id: number;
	runId: string;
	taskId: string | null;
	branch: string;
	targetBranch: string;
	worktreePath: string | null;
	attempt: number;
	parkRetries: number;
}

export interface MergeQueueDeps {
	handle: ProjectDbHandle;
	bus: EventBus;
	projectRoot: string;
	log: Logger;
	/**
	 * Re-run the task's DoD in the run worktree after a rebase. `crashed`
	 * mirrors `VerificationResult.crashed`: a check process died to a signal,
	 * so `!passed` alone does not mean the rebase broke anything.
	 */
	reverify: (
		job: MergeJobView,
	) => Promise<{ passed: boolean; detail?: string; crashed?: boolean }>;
	/** Post-merge tail of the owning run's journal (release task → done, etc.). */
	onMerged: (job: MergeJobView, sha: string) => Promise<void>;
	/** Parked tail (task → blocked/review, run terminal, preserve worktree). */
	onParked: (
		job: MergeJobView,
		reason: string,
		kind: "conflict" | "reverify",
	) => Promise<void>;
	/**
	 * Restore the task's claim before `retry` re-queues a parked job:
	 * `onParked` released it, and `onMerged`/`onParked` only update status
	 * when the claim matches the runId.
	 */
	reclaimTask?: (job: MergeJobView) => Promise<void>;
	/** Move the task to `ready`; the job is abandoned as in `abandon`. */
	sendTaskToReady?: (job: MergeJobView) => Promise<void>;
	/** Publish the target branch after each merge lands. Absent or disabled
	 *  leaves the branch local, which is the default. */
	push?: { enabled: boolean; remote: string };
	/**
	 * Live self-repair setting. A callback because the queue is built before the
	 * scheduler and the setting can change without a restart. When enabled, a
	 * non-escalated `main_red` admits its repair run (or the cause task's job
	 * before a run is recorded); other jobs stay queued.
	 */
	selfRepairMainRed?: () => boolean;
}

const IN_FLIGHT = ["merging", "rebasing", "reverifying"] as const;

export class MergeQueue {
	/** Mutable so settings can flip publishing without a restart; affects only
	 *  what happens after a merge. */
	private push: { enabled: boolean; remote: string };

	/**
	 * Late-bound automatic conflict-resolution hook (`RunEngine` does not exist
	 * yet when the queue is constructed, see boot.ts). `park()` calls it once
	 * per job, after retries are exhausted and before `onParked`. Absent, or
	 * returning `null` (brain disabled or spawn failed), escalates straight to
	 * `onParked`.
	 */
	unblock?: (
		job: MergeJobView,
		reason: string,
	) => Promise<{ runId: string } | null>;

	constructor(private readonly deps: MergeQueueDeps) {
		this.push = deps.push ?? { enabled: false, remote: "origin" };
	}

	get pushOnMerge(): boolean {
		return this.push.enabled;
	}

	setPushOnMerge(on: boolean): void {
		this.push = { ...this.push, enabled: on };
	}

	private get integrationDir(): string {
		return join(this.deps.projectRoot, ".mfw", "integration");
	}

	/** Idempotent by runId (UNIQUE). */
	async enqueue(job: {
		runId: string;
		taskId?: string | null;
		branch: string;
		targetBranch: string;
	}): Promise<void> {
		await this.deps.handle.withTx(async (tx) => {
			await tx
				.insert(mergeJobs)
				.values({
					runId: job.runId,
					taskId: job.taskId ?? null,
					branch: job.branch,
					targetBranch: job.targetBranch,
					enqueuedAt: new Date(),
					updatedAt: new Date(),
				})
				.onConflictDoNothing();
		});
	}

	async paused(): Promise<boolean> {
		return (await this.mainRed()).red;
	}

	private async mainRed(): Promise<{
		red: boolean;
		causeTaskId?: string;
		escalated: boolean;
		repairRunId?: string;
	}> {
		const [row] = await this.deps.handle.db
			.select()
			.from(engineKv)
			.where(eq(engineKv.key, "main_red"));
		const value = row?.value as
			| {
					red?: boolean;
					causeTaskId?: string;
					escalated?: boolean;
					repairRunId?: string;
			  }
			| undefined;
		return {
			red: value?.red === true,
			causeTaskId: value?.causeTaskId,
			escalated: value?.escalated === true,
			repairRunId: value?.repairRunId,
		};
	}

	async depth(): Promise<number> {
		return (
			await this.deps.handle.db
				.select({ id: mergeJobs.id })
				.from(mergeJobs)
				.where(inArray(mergeJobs.state, ["queued", ...IN_FLIGHT]))
		).length;
	}

	/**
	 * The job for one run in any state (including `parked`); callers decide
	 * whether it is actionable.
	 */
	async byRun(
		runId: string,
	): Promise<{ state: MergeJobState; error: string | null } | null> {
		const [row] = await this.deps.handle.db
			.select({ state: mergeJobs.state, error: mergeJobs.error })
			.from(mergeJobs)
			.where(eq(mergeJobs.runId, runId));
		return row ?? null;
	}

	/**
	 * Tasks whose branch is queued or mid-merge; review and inbox must not offer
	 * them again. `parked` is excluded: it hands the task back for a new decision.
	 */
	async activeByTask(): Promise<{ taskId: string; state: MergeJobState }[]> {
		const rows = await this.deps.handle.db
			.select({ taskId: mergeJobs.taskId, state: mergeJobs.state })
			.from(mergeJobs)
			.where(inArray(mergeJobs.state, ["queued", ...IN_FLIGHT]));
		return rows.filter(
			(r): r is { taskId: string; state: MergeJobState } => r.taskId != null,
		);
	}

	/**
	 * Process at most one queued job to completion; callers loop until "idle".
	 */
	async tick(): Promise<"idle" | "paused" | "merged" | "parked" | "deferred"> {
		const red = await this.mainRed();
		const repairAllowed =
			red.red && !red.escalated && this.deps.selfRepairMainRed?.();
		const repairRunId = repairAllowed ? red.repairRunId : undefined;
		const repairTaskId =
			repairAllowed && !repairRunId ? red.causeTaskId : undefined;
		if (red.red && !repairRunId && !repairTaskId) return "paused";
		// The repair job is picked out of FIFO order so an older job cannot
		// deadlock main_red.
		const job = await this.nextJob(repairTaskId, repairRunId);
		// Red with no repair job ready is paused, not drained.
		if (red.red && !job) return "paused";
		if (!job) return "idle";
		try {
			return await this.process(job);
		} catch (e) {
			// Requeue so an in-flight job is not stuck until restart; the next attempt
			// hard-resets the integration worktree, so this is safe mid-merge.
			const detail = e instanceof Error ? e.message : String(e);
			await this.deps.handle.db
				.update(mergeJobs)
				.set({ state: "queued", error: detail, updatedAt: new Date() })
				.where(
					and(
						eq(mergeJobs.id, job.id),
						inArray(mergeJobs.state, [...IN_FLIGHT]),
					),
				);
			this.deps.log.error(
				{ err: e, job: job.id, runId: job.runId },
				"merge job failed unexpectedly; requeued",
			);
			return "deferred";
		}
	}

	private async nextJob(
		onlyTaskId?: string,
		onlyRunId?: string,
	): Promise<MergeJobView | null> {
		const rows = await this.deps.handle.db
			.select({
				id: mergeJobs.id,
				runId: mergeJobs.runId,
				taskId: mergeJobs.taskId,
				branch: mergeJobs.branch,
				targetBranch: mergeJobs.targetBranch,
				attempt: mergeJobs.attempt,
				parkRetries: mergeJobs.parkRetries,
				worktreePath: runs.worktreePath,
			})
			.from(mergeJobs)
			.leftJoin(runs, eq(runs.id, mergeJobs.runId))
			.where(
				onlyRunId
					? and(eq(mergeJobs.state, "queued"), eq(mergeJobs.runId, onlyRunId))
					: onlyTaskId
						? and(
								eq(mergeJobs.state, "queued"),
								eq(mergeJobs.taskId, onlyTaskId),
							)
						: eq(mergeJobs.state, "queued"),
			)
			.orderBy(asc(mergeJobs.enqueuedAt))
			.limit(1);
		return rows[0] ?? null;
	}

	private async setState(
		id: number,
		state: (typeof IN_FLIGHT)[number] | "queued" | "merged" | "parked",
		patch: Partial<{ attempt: number; error: string | null }> = {},
	): Promise<void> {
		await this.deps.handle.db
			.update(mergeJobs)
			.set({ state, updatedAt: new Date(), ...patch })
			.where(eq(mergeJobs.id, id));
	}

	/**
	 * Ensure `.mfw/integration/` exists as a detached worktree at the target's
	 * tip (git refuses a second checkout of the branch the primary has). The
	 * ref itself is moved by `finishMerged` via compare-and-swap `update-ref`.
	 */
	async prepareIntegration(target: string): Promise<string> {
		const dir = this.integrationDir;
		const there = await git(["rev-parse", "--is-inside-work-tree"], dir);
		if (there.exitCode !== 0) {
			await mkdir(join(this.deps.projectRoot, ".mfw"), { recursive: true });
			const add = await git(
				["worktree", "add", "--detach", "-q", dir, target],
				this.deps.projectRoot,
			);
			if (add.exitCode !== 0)
				throw new Error(`integration worktree add failed: ${add.stderr}`);
		}
		const base = await git(["rev-parse", `refs/heads/${target}`], dir);
		if (base.exitCode !== 0)
			throw new Error(`target branch ${target} missing: ${base.stderr}`);
		const sha = base.stdout.trim();
		const co = await git(["checkout", "-q", "--detach", sha], dir);
		if (co.exitCode !== 0)
			throw new Error(`integration detach ${sha} failed: ${co.stderr}`);
		await git(["reset", "--hard", "-q", sha], dir);
		return sha;
	}

	private async process(
		job: MergeJobView,
	): Promise<"merged" | "parked" | "deferred"> {
		const log = this.deps.log.child({ job: job.id, branch: job.branch });
		let baseSha: string;
		try {
			baseSha = await this.prepareIntegration(job.targetBranch);
		} catch (e) {
			// Integration worktree unusable: park loudly rather than spin.
			log.error({ err: e }, "integration worktree preparation failed");
			await this.park(
				job,
				`integration worktree: ${(e as Error).message}`,
				"conflict",
			);
			return "parked";
		}

		await this.setState(job.id, "merging");
		if (await this.tryMerge(job)) {
			await this.restoreBoard(job, baseSha);
			return this.finishMerged(job, baseSha);
		}

		// Conflict: rebase the RUN worktree onto the target, re-verify, retry once.
		if (!job.worktreePath) {
			await this.park(
				job,
				"merge conflict and no run worktree to rebase",
				"conflict",
			);
			return "parked";
		}
		await this.setState(job.id, "rebasing");
		const rebase = await git(["rebase", job.targetBranch], job.worktreePath);
		if (rebase.exitCode !== 0) {
			// Read conflicting paths before aborting; git's own advice is useless
			// to the operator.
			const paths = await this.conflictingPaths(job.worktreePath);
			await git(["rebase", "--abort"], job.worktreePath);
			await this.park(
				job,
				paths.length > 0
					? `rebase conflict in ${paths.join(", ")}`
					: `rebase conflict: ${tail(rebase.stderr)}`,
				"conflict",
			);
			return "parked";
		}

		await this.setState(job.id, "reverifying");
		const verdict = await this.deps.reverify(job);
		if (!verdict.passed) {
			// A crashed re-verify says nothing about the rebase; word it so a human
			// is not told the rebase broke something.
			await this.park(
				job,
				verdict.crashed
					? `a DoD check was killed by a signal twice in a row during re-verify; not evidence the rebase conflicts: ${verdict.detail ?? ""}`
					: `re-verify failed after rebase: ${verdict.detail ?? ""}`,
				"reverify",
				verdict.crashed === true,
			);
			return "parked";
		}

		await this.setState(job.id, "merging", { attempt: job.attempt + 1 });
		// The queue is the only mover of the target ref, so baseSha is still
		// current; reset the integration worktree onto it before retrying.
		await git(["reset", "--hard", "-q", baseSha], this.integrationDir);
		if (await this.tryMerge(job)) {
			await this.restoreBoard(job, baseSha);
			return this.finishMerged(job, baseSha);
		}
		await this.park(job, "merge conflict persisted after rebase", "conflict");
		return "parked";
	}

	/**
	 * The mfw firewall: a run branch may change trigger definitions and nothing
	 * else mfw owns.
	 *
	 * Sparse checkout (`worktree.ts`) keeps protected `.mfw/` paths out of run
	 * worktrees; this catches what it cannot (older worktrees, `sparse-checkout
	 * disable`, human edits on a feature branch). The danger is silent: git
	 * follows a task rename and applies the branch's edit at the new path with
	 * no conflict.
	 *
	 * Protected set: every tracked path under `.mfw/` except `.mfw/triggers/`,
	 * discovered from the union of base and merged trees (default-deny for new
	 * mfw paths). Untracked runtime state is unaffected since `git rm` only
	 * touches tracked files. `rm` runs before `checkout` because checkout
	 * leaves behind anything the branch added.
	 */
	private async restoreBoard(
		job: MergeJobView,
		baseSha: string,
	): Promise<void> {
		const dir = this.integrationDir;
		const treePaths = async (ref: string): Promise<string[]> => {
			const listed = await git(
				["ls-tree", "-r", "-z", "--name-only", ref, "--", ".mfw"],
				dir,
			);
			if (listed.exitCode !== 0) {
				throw new Error(
					`mfw firewall could not inspect ${ref}: ${listed.stderr || listed.stdout}`,
				);
			}
			return listed.stdout.split("\0").filter(Boolean);
		};
		const paths = [
			...new Set([...(await treePaths(baseSha)), ...(await treePaths("HEAD"))]),
		].filter((path) => !path.startsWith(".mfw/triggers/"));
		if (paths.length === 0) return;

		const removed = await git(
			["rm", "-r", "-q", "--ignore-unmatch", "--", ...paths],
			dir,
		);
		if (removed.exitCode !== 0) {
			throw new Error(
				`board firewall could not clear merged paths: ${removed.stderr || removed.stdout}`,
			);
		}
		const baseFiles = new Set(await treePaths(baseSha));
		const inBase = paths.filter((path) => baseFiles.has(path));
		if (inBase.length > 0) {
			const restored = await git(["checkout", baseSha, "--", ...inBase], dir);
			if (restored.exitCode !== 0) {
				throw new Error(
					`board firewall could not restore base paths: ${restored.stderr || restored.stdout}`,
				);
			}
		}

		// Versus HEAD (the merge commit): the board paths the merge changed.
		// Normally empty.
		const changed = await git(
			["diff", "--cached", "--name-only", "--", ...paths],
			dir,
		);
		if (changed.exitCode !== 0) {
			throw new Error(
				`board firewall could not verify staged paths: ${changed.stderr || changed.stdout}`,
			);
		}
		const reverted = changed.stdout.split("\n").filter(Boolean);
		if (reverted.length === 0) return;

		const amend = await git(
			[
				"-c",
				"user.name=mfw",
				"-c",
				"user.email=mfw@localhost",
				"commit",
				"--amend",
				"--no-edit",
				"-q",
				"--no-verify",
			],
			dir,
		);
		if (amend.exitCode !== 0) {
			throw new Error(`board firewall could not amend: ${amend.stderr}`);
		}

		this.deps.log.warn(
			{ job: job.id, runId: job.runId, paths: reverted },
			"the merging branch changed the board; those changes were discarded; " +
				"the board belongs to the daemon, not to a run",
		);
		const stored = await this.deps.handle.withTx(async (tx) =>
			appendEvent(tx, {
				type: "merge.board_reverted",
				taskId: job.taskId ?? undefined,
				runId: job.runId,
				payload: { target: job.targetBranch, paths: reverted },
			}),
		);
		this.deps.bus.publish([stored]);
	}

	/** `git merge --no-ff` in the integration worktree; abort on failure. */
	private async tryMerge(job: MergeJobView): Promise<boolean> {
		const dir = this.integrationDir;
		const r = await git(["merge", "--no-ff", "--no-edit", job.branch], dir);
		if (r.exitCode === 0) return true;
		await git(["merge", "--abort"], dir);
		return false;
	}

	/** Unmerged paths in `dir`. Read before the `--abort` of a failed merge or
	 *  rebase. Empty on git failure: it is only detail for a park reason. */
	private async conflictingPaths(dir: string): Promise<string[]> {
		const r = await git(["diff", "--name-only", "--diff-filter=U"], dir);
		if (r.exitCode !== 0) return [];
		return r.stdout.split("\n").filter(Boolean);
	}

	/**
	 * A stale `baseSha` cannot rewind the branch: both landing paths re-check
	 * the live ref. `merge --ff-only` refuses unless the primary's HEAD is an
	 * ancestor of the merge commit, and `casMoveRef` refuses unless the ref
	 * still equals `baseSha`. Either turns a stale base into `deferred` or a
	 * thrown error, retried from a fresh `prepareIntegration()`. Keep both
	 * checks against live state.
	 */
	private async finishMerged(
		job: MergeJobView,
		baseSha: string,
	): Promise<"merged" | "deferred"> {
		const sha = (
			await git(["rev-parse", "HEAD"], this.integrationDir)
		).stdout.trim();
		// Not checked out in the primary: compare-and-swap the ref.
		// Checked out: `merge --ff-only` in the primary, which moves ref, index
		// and worktree together and refuses rather than clobbering. A refusal
		// defers; unrelated local edits do not.
		const checkedOut = await this.primaryHasCheckedOut(job.targetBranch);
		if (!checkedOut) {
			await this.casMoveRef(job.targetBranch, sha, baseSha);
		} else {
			// Let git decide; a whole-tree `git status` pre-screen deferred every
			// job over one unrelated dirty file.
			const ff = await git(
				["merge", "--ff-only", "-q", sha],
				this.deps.projectRoot,
			);
			if (ff.exitCode !== 0) {
				await this.defer(
					job,
					`the primary checkout is on ${job.targetBranch} and cannot fast-forward: ` +
						`${tail(ff.stderr || ff.stdout, 200)}`,
				);
				return "deferred";
			}
		}
		const stored = await this.deps.handle.withTx(async (tx) => {
			await tx
				.update(mergeJobs)
				.set({ state: "merged", updatedAt: new Date() })
				.where(eq(mergeJobs.id, job.id));
			return appendEvent(tx, {
				type: "merge.completed",
				taskId: job.taskId ?? undefined,
				runId: job.runId,
				payload: { sha, target: job.targetBranch },
			});
		});
		this.deps.bus.publish([stored]);
		// `onMerged` runs before the push: it moves the task to `done`, itself a
		// board commit, and pushing first left the remote one commit behind. If it
		// throws, the next merge or `publishBranch` sweep carries both commits.
		await this.deps.onMerged(job, sha);
		await this.publish(job);
		return "merged";
	}

	/**
	 * Push the target branch, if enabled. Runs after the job is recorded
	 * `merged` and must not change that outcome: parking a landed job would
	 * retry an already-merged branch. Failures emit an event (the only signal
	 * of divergence) and a warning, then are swallowed.
	 */
	private async publish(job: MergeJobView): Promise<void> {
		if (!this.push.enabled) return;
		const result = await this.pushBranch(job.targetBranch);
		if (result.status !== "error") return;
		this.deps.log.warn(
			{
				job: job.id,
				remote: this.push.remote,
				target: job.targetBranch,
				reason: result.reason,
			},
			"merge landed but push failed; local and remote have diverged",
		);
		const stored = await this.deps.handle.withTx(async (tx) =>
			appendEvent(tx, {
				type: "merge.push_failed",
				taskId: job.taskId ?? undefined,
				runId: job.runId,
				payload: {
					target: job.targetBranch,
					remote: this.push.remote,
					reason: result.reason,
				},
			}),
		);
		this.deps.bus.publish([stored]);
	}

	/**
	 * Push `branch` outside a merge: the maintenance sweep's catch-up for
	 * board-only commits. Failures only log, since there is no job to attach a
	 * `merge.push_failed` event to.
	 */
	async publishBranch(branch: string): Promise<void> {
		if (!this.push.enabled) return;
		const result = await this.pushBranch(branch);
		if (result.status !== "error") return;
		this.deps.log.warn(
			{ remote: this.push.remote, branch, reason: result.reason },
			"periodic push failed; local and remote have diverged",
		);
	}

	/**
	 * Push `branch` to the configured remote and classify the outcome.
	 *
	 * "No such remote" is checked explicitly because it and "push rejected"
	 * share an exit code, and only rejection means divergence. No remote is a
	 * normal setup, reported as `no-remote`. A failing `git remote` is `error`.
	 */
	private async pushBranch(
		branch: string,
	): Promise<
		{ status: "pushed" | "no-remote" } | { status: "error"; reason: string }
	> {
		const remotes = await git(["remote"], this.deps.projectRoot);
		if (remotes.exitCode !== 0) {
			return {
				status: "error",
				reason: `git remote: ${tail(remotes.stderr || remotes.stdout, 300)}`,
			};
		}
		if (!remotes.stdout.split("\n").includes(this.push.remote)) {
			return { status: "no-remote" };
		}
		const r = await git(
			["push", this.push.remote, branch],
			this.deps.projectRoot,
		);
		if (r.exitCode === 0) return { status: "pushed" };
		return { status: "error", reason: tail(r.stderr || r.stdout, 300) };
	}

	/** Compare-and-swap the branch ref on the merged base; throws rather than
	 *  clobber if something else moved it. The primary is left alone. */
	private async casMoveRef(
		target: string,
		sha: string,
		baseSha: string,
	): Promise<void> {
		const cas = await git(
			["update-ref", `refs/heads/${target}`, sha, baseSha],
			this.integrationDir,
		);
		if (cas.exitCode !== 0)
			throw new Error(`update-ref CAS failed: ${cas.stderr}`);
	}

	private async primaryHasCheckedOut(target: string): Promise<boolean> {
		const head = await git(
			["symbolic-ref", "-q", "HEAD"],
			this.deps.projectRoot,
		);
		return head.exitCode === 0 && head.stdout.trim() === `refs/heads/${target}`;
	}

	/**
	 * Put the job back in the queue and say why. The merge commit on the
	 * detached HEAD is unreferenced; the next attempt redoes it.
	 */
	private async defer(job: MergeJobView, reason: string): Promise<void> {
		await this.setState(job.id, "queued", { error: reason });
		this.deps.log.warn({ job: job.id, reason }, "merge deferred");
		if (job.taskId) {
			const stored = await this.deps.handle.withTx(async (tx) =>
				appendEvent(tx, {
					type: "merge.deferred",
					taskId: job.taskId as string,
					payload: { reason },
				}),
			);
			this.deps.bus.publish([stored]);
		}
	}

	/**
	 * Appends `merge.parked` in the same transaction as the state change.
	 * Below `MAX_PARK_RETRIES` the job just sits `parked` until `retryParked()`
	 * requeues it. Once the budget is spent, calls `onParked` once, with how
	 * many automatic attempts failed.
	 */
	private async park(
		job: MergeJobView,
		reason: string,
		kind: "conflict" | "reverify",
		crashed = false,
	): Promise<void> {
		const retries = job.parkRetries + 1;
		const exhausted = retries >= MAX_PARK_RETRIES;

		// One automatic unblock attempt before escalating; absent, `null` or a
		// failed spawn falls through to escalation.
		if (exhausted && this.unblock) {
			const started = await this.unblock(job, reason).catch((e) => {
				this.deps.log.error(
					{ job: job.id, err: e },
					"automatic unblock attempt failed to start",
				);
				return null;
			});
			if (started) {
				await this.markUnblocked(job, reason, kind, retries, started.runId);
				return;
			}
		}

		const finalReason = exhausted
			? `${reason}; mfw retried this automatically ${retries} time${retries === 1 ? "" : "s"} and could not resolve it; it needs a human`
			: reason;
		const stored = await this.deps.handle.withTx(async (tx) => {
			await tx
				.update(mergeJobs)
				.set({
					state: "parked",
					updatedAt: new Date(),
					error: finalReason,
					parkRetries: retries,
				})
				.where(eq(mergeJobs.id, job.id));
			return appendEvent(tx, {
				type: "merge.parked",
				taskId: job.taskId ?? undefined,
				runId: job.runId,
				payload: {
					target: job.targetBranch,
					kind,
					reason,
					retries,
					exhausted,
					...(crashed ? { crashed: true } : {}),
				},
			});
		});
		this.deps.bus.publish([stored]);
		if (!exhausted) {
			this.deps.log.warn(
				{ job: job.id, reason, retries },
				"merge job parked; will retry automatically",
			);
			return;
		}
		this.deps.log.warn(
			{ job: job.id, reason: finalReason },
			"merge job parked: automatic retries exhausted",
		);
		await this.deps.onParked(job, finalReason, kind);
	}

	/**
	 * Hand the job's branch to an automatic unblock run instead of a human.
	 * Marked `abandoned` (not `parked`) so it drops out of the inbox's
	 * `state = "parked"` query. The run state and task claim belong to the
	 * unblock hook (`RunEngine.startUnblock`, boot.ts); this owns only the job
	 * row and timeline event.
	 */
	private async markUnblocked(
		job: MergeJobView,
		reason: string,
		kind: "conflict" | "reverify",
		retries: number,
		childRunId: string,
	): Promise<void> {
		const stored = await this.deps.handle.withTx(async (tx) => {
			await tx
				.update(mergeJobs)
				.set({
					state: "abandoned",
					updatedAt: new Date(),
					error: reason,
					parkRetries: retries,
				})
				.where(eq(mergeJobs.id, job.id));
			return appendEvent(tx, {
				type: "merge.unblock_started",
				taskId: job.taskId ?? undefined,
				runId: job.runId,
				payload: {
					target: job.targetBranch,
					kind,
					reason,
					retries,
					childRunId,
				},
			});
		});
		this.deps.bus.publish([stored]);
		this.deps.log.warn(
			{ job: job.id, childRunId },
			"merge conflict exhausted automatic retries; spawned an unblock run before escalating to a human",
		);
	}

	/**
	 * Requeue parked jobs still within their retry budget; the next `tick()`
	 * re-reads the current target tip, which turns a stale conflict into a
	 * clean merge. Driven from the maintenance loop.
	 */
	async retryParked(): Promise<number> {
		const rows = await this.deps.handle.db
			.select({ id: mergeJobs.id })
			.from(mergeJobs)
			.where(
				and(
					eq(mergeJobs.state, "parked"),
					lt(mergeJobs.parkRetries, MAX_PARK_RETRIES),
				),
			);
		if (rows.length === 0) return 0;
		for (const row of rows) {
			await this.deps.handle.db
				.update(mergeJobs)
				.set({ state: "queued", updatedAt: new Date(), error: null })
				.where(eq(mergeJobs.id, row.id));
		}
		this.deps.log.info(
			{ count: rows.length },
			"requeued parked merge jobs for automatic retry",
		);
		return rows.length;
	}

	/*
	 * Operator actions on a `parked` job. All three throw for a job that is
	 * not (or no longer) parked, so a stale click cannot repeat a decision.
	 */

	/** Re-queue a parked job; reuses the same run worktree and branch. */
	async retry(jobId: number): Promise<void> {
		const job = await this.requireParked(jobId);
		if (job.taskId) await this.deps.reclaimTask?.(job);
		await this.setState(jobId, "queued", { error: null });
		const stored = await this.deps.handle.withTx(async (tx) =>
			appendEvent(tx, {
				type: "merge.retried",
				taskId: job.taskId ?? undefined,
				runId: job.runId,
				payload: { target: job.targetBranch },
			}),
		);
		this.deps.bus.publish([stored]);
		this.deps.log.warn({ job: jobId }, "merge job retry requested");
	}

	/** End the job so the inbox row (derived from `state = "parked"`) clears.
	 *  The task status is left where `onParked` put it. */
	async abandon(jobId: number): Promise<void> {
		const job = await this.requireParked(jobId);
		await this.markAbandoned(job);
	}

	/** Abandon the job, then send the task back to `ready` to redo the work
	 *  from the current tip. */
	async sendToReady(jobId: number): Promise<void> {
		const job = await this.requireParked(jobId);
		await this.markAbandoned(job);
		if (job.taskId) await this.deps.sendTaskToReady?.(job);
	}

	/** Load a job by id; throws unless it is `parked`. */
	private async requireParked(jobId: number): Promise<MergeJobView> {
		const rows = await this.deps.handle.db
			.select({
				id: mergeJobs.id,
				runId: mergeJobs.runId,
				taskId: mergeJobs.taskId,
				branch: mergeJobs.branch,
				targetBranch: mergeJobs.targetBranch,
				attempt: mergeJobs.attempt,
				parkRetries: mergeJobs.parkRetries,
				state: mergeJobs.state,
				worktreePath: runs.worktreePath,
			})
			.from(mergeJobs)
			.leftJoin(runs, eq(runs.id, mergeJobs.runId))
			.where(eq(mergeJobs.id, jobId))
			.limit(1);
		const job = rows[0];
		if (!job) throw new Error(`unknown merge job ${jobId}`);
		if (job.state !== "parked")
			throw new Error(`merge job ${jobId} is not parked (state: ${job.state})`);
		return {
			id: job.id,
			runId: job.runId,
			taskId: job.taskId,
			branch: job.branch,
			targetBranch: job.targetBranch,
			worktreePath: job.worktreePath,
			attempt: job.attempt,
			parkRetries: job.parkRetries,
		};
	}

	private async markAbandoned(job: MergeJobView): Promise<void> {
		const stored = await this.deps.handle.withTx(async (tx) => {
			await tx
				.update(mergeJobs)
				.set({ state: "abandoned", updatedAt: new Date() })
				.where(eq(mergeJobs.id, job.id));
			return appendEvent(tx, {
				type: "merge.abandoned",
				taskId: job.taskId ?? undefined,
				runId: job.runId,
				payload: { target: job.targetBranch },
			});
		});
		this.deps.bus.publish([stored]);
		this.deps.log.warn({ job: job.id }, "merge job abandoned");
	}

	/** Boot reconciliation: hard-reset the integration worktree, then requeue in-flight jobs. */
	async resetInFlight(): Promise<number> {
		const rows = await this.deps.handle.db
			.select({ id: mergeJobs.id, target: mergeJobs.targetBranch })
			.from(mergeJobs)
			.where(inArray(mergeJobs.state, [...IN_FLIGHT]));
		if (rows.length === 0) return 0;
		const target = rows[0]?.target;
		if (target) {
			await this.prepareIntegration(target).catch((e) => {
				this.deps.log.error({ err: e }, "reconcile: integration reset failed");
			});
		}
		await this.deps.handle.db
			.update(mergeJobs)
			.set({ state: "queued", updatedAt: new Date() })
			.where(and(inArray(mergeJobs.state, [...IN_FLIGHT])));
		return rows.length;
	}
}

function tail(s: string, n = 400): string {
	return s.length > n ? s.slice(-n) : s;
}
