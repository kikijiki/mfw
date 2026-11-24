import type { ProjectDbHandle } from "@mfw/db/client";
import { appendEvent, type EventBus } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import {
	brainActions,
	engineKv,
	type MergeJobState,
	mergeJobs,
	runs,
} from "@mfw/db/schema";
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { readProtectedBoardPaths } from "./board-layout.ts";
import { git } from "./git.ts";
import { quarantineRef } from "./host-git/fetch.ts";
import {
	ensureLandingRepo,
	type LandingIdentity,
	type LandingRepo,
	landingMerge,
	landingRestorePaths,
} from "./host-git/landing.ts";
import { hardenedPush } from "./host-git/push.ts";
import { repoConfigRefusal } from "./host-git/repo-config.ts";
import type { Logger } from "./log.ts";
import { ESCALATE_AFTER_SWEEPS } from "./maintenance.ts";
import {
	HOST_MERGE_TOOL,
	type HostExecutedChange,
	type HostMergeHold,
	hostExecutedChange,
	hostMergeApprovalKey,
	landedDependencyPaths,
	recordDependencyChange,
	recordHostMergeApproval,
} from "./merge-gate.ts";

/**
 * One FIFO worker per project, one in-flight job, merging into the recorded
 * integration branch in the host-owned landing repository (`host-git/landing.ts`):
 * no work tree, no repository config, so no hook, filter or merge driver can
 * run. The ref then moves by compare-and-swap. Job flow:
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
 *                        onParked (settle merge_parked: the brain decides)
 *                                │  │
 *                        (retry) │  │ (abandon / sendToReady)
 *                                ▼  ▼
 *                            queued  abandoned
 *
 * A merge commit that changes host-executed files stops at `held` on an
 * ask-first card (`merge-gate.ts`), on both the first and the rebased attempt.
 * Approval requeues it; the retry lands only the content that was approved.
 *
 * Red-main pauses the queue: jobs stay queued instead of bouncing to review.
 * Each state change commits before the next action, so a crash resumes
 * deterministically (reconcile resets in-flight jobs to queued).
 *
 * A park is usually a stale conflict (target moved while the job queued), so
 * `park()` retries automatically, bounded by `MAX_PARK_RETRIES`, before calling
 * `onParked` to escalate. Retries reuse the same run, workspace and branch;
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
	workspacePath: string | null;
	attempt: number;
	parkRetries: number;
}

export interface MergeQueueDeps {
	handle: ProjectDbHandle;
	bus: EventBus;
	projectRoot: string;
	log: Logger;
	/**
	 * The paths this project's approved dev environment covers, read when a
	 * merge is judged: changing one is ask-first, and invalidates the approval.
	 */
	envProtectedPaths?: () => readonly string[] | ((path: string) => boolean);
	/**
	 * Re-run the task's DoD on the rebased branch (a disposable clone on clone
	 * projects, the run workspace otherwise). `crashed`
	 * mirrors `VerificationResult.crashed`: a check process died to a signal,
	 * so `!passed` alone does not mean the rebase broke anything.
	 */
	reverify: (
		job: MergeJobView,
		/** The target's tip as a commit id: a ref could move before the gate reads it. */
		baseSha: string,
		/** The exact rebased commit to check; a pass pins the job to it. */
		tipSha: string,
	) => Promise<{ passed: boolean; detail?: string; crashed?: boolean }>;
	/**
	 * Whether `reverify` would run any check for this job. Absent or failing
	 * counts as no: a moved tip with nothing to check it is never landed.
	 */
	hasChecks?: (job: MergeJobView) => Promise<boolean>;
	/**
	 * Verify the merge commit itself (after the board restore) before it lands, in a disposable host-owned clone.
	 * Absent (workspace projects) means no pre-landing verification. A failure
	 * parks the job as `reverify`.
	 */
	verifyMerge?: (
		job: MergeJobView,
		mergeSha: string,
	) => Promise<{ passed: boolean; detail?: string; crashed?: boolean }>;
	/**
	 * Rebase a clone run's quarantine ref onto `onto` in a host-owned scratch
	 * clone, moving the ref to the result on success. Absent (workspace
	 * projects) means a clone run's conflict parks without a rebase.
	 */
	rebaseClone?: (
		job: MergeJobView,
		onto: string,
	) => Promise<
		| { ok: true }
		| { ok: false; kind: "conflict"; paths: string[]; detail: string }
		| { ok: false; kind: "error"; detail: string }
	>;
	/** Post-merge tail of the owning run's journal (release task → done, etc.). */
	onMerged: (job: MergeJobView, sha: string) => Promise<void>;
	/** Parked tail: settle `merge_parked` for the brain (task back to ready, run terminal, workspace preserved, job abandoned). */
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
	/**
	 * The paths a landed merge changed, before `merge.completed` is recorded;
	 * null when they could not be listed. Armed triggers touching them disarm.
	 */
	onLandedPaths?: (paths: readonly string[] | null) => Promise<unknown>;
	/** Publish the target branch after each merge lands. Absent or disabled
	 *  leaves the branch local, which is the default. */
	push?: PushSettings;
	/** Where the host-owned landing repositories live. Default: the daemon home. */
	landingRoot?: string;
	/**
	 * Live self-repair setting. A callback because the queue is built before the
	 * scheduler and the setting can change without a restart. When enabled, a
	 * non-escalated `main_red` admits its repair run (or the cause task's job
	 * before a run is recorded); other jobs stay queued.
	 */
	selfRepairMainRed?: () => boolean;
}

export interface PushSettings {
	enabled: boolean;
	remote: string;
	/** The owner-approved destination, from the daemon home. Never read from the repository. */
	url?: string;
	/** Allow `url` to be a local path, whose receive hooks then run on this host. */
	allowLocalUrl?: boolean;
}

const IN_FLIGHT = ["merging", "rebasing", "reverifying"] as const;

/** `engine_kv` row behind the `push_refused` inbox item; gone once a push succeeds. */
export const PUSH_REFUSED_KEY = "push_refused";

export class MergeQueue {
	/** Mutable so settings can flip publishing without a restart; affects only
	 *  what happens after a merge. */
	private push: PushSettings;

	constructor(private readonly deps: MergeQueueDeps) {
		this.push = deps.push ?? { enabled: false, remote: "origin" };
	}

	get pushOnMerge(): boolean {
		return this.push.enabled;
	}

	setPushOnMerge(on: boolean): void {
		this.push = { ...this.push, enabled: on };
	}

	private landing(): Promise<LandingRepo> {
		return ensureLandingRepo(this.deps.projectRoot, this.deps.landingRoot);
	}

	/**
	 * Idempotent by runId (UNIQUE). The job is pinned to the commit the verifier
	 * passed. A run with no checks has none, so it is pinned to its tip as read
	 * here; `requireVerified` (set whenever the run has checks) refuses that.
	 */
	async enqueue(job: {
		runId: string;
		taskId?: string | null;
		branch: string;
		targetBranch: string;
		requireVerified?: boolean;
		/** A person's decision on this run (never the brain's): see `ownerApproval`. */
		ownerApproved?: "review" | "select_winner";
	}): Promise<void> {
		const [run] = await this.deps.handle.db
			.select({ verifiedSha: runs.verifiedSha })
			.from(runs)
			.where(eq(runs.id, job.runId));
		const verified = run?.verifiedSha ?? null;
		if (!verified && job.requireVerified) {
			throw new Error(
				`run ${job.runId} has no verified commit recorded, so it cannot be queued to merge`,
			);
		}
		const pinned = verified ?? (await this.sourceTip(job));
		const approved =
			job.ownerApproved && pinned
				? await this.ownerApproval(job.runId, pinned)
				: null;
		await this.deps.handle.withTx(async (tx) => {
			const inserted = await tx
				.insert(mergeJobs)
				.values({
					runId: job.runId,
					taskId: job.taskId ?? null,
					branch: job.branch,
					targetBranch: job.targetBranch,
					verifiedSha: pinned,
					enqueuedAt: new Date(),
					updatedAt: new Date(),
				})
				.onConflictDoNothing()
				.returning({ id: mergeJobs.id });
			// Only with a new job: one already waiting on a card needs that card's answer.
			if (inserted.length > 0 && approved && pinned) {
				await recordHostMergeApproval(
					tx,
					job.runId,
					approved.fingerprint,
					`owner:${job.ownerApproved}`,
					pinned,
				);
			}
		});
	}

	/**
	 * What a person's decision on this run covers: the protected content of the
	 * pinned commit, so the gate does not ask again for it and accepts nothing
	 * else. Null (no protected file, or it cannot be read) records nothing, and
	 * the gate then decides on its own.
	 */
	private async ownerApproval(
		runId: string,
		pinned: string,
	): Promise<HostExecutedChange | null> {
		const [run] = await this.deps.handle.db
			.select({ baseSha: runs.baseSha })
			.from(runs)
			.where(eq(runs.id, runId));
		if (!run?.baseSha) return null;
		return hostExecutedChange(
			this.deps.projectRoot,
			run.baseSha,
			pinned,
			this.deps.envProtectedPaths?.() ?? [],
		).catch(() => null);
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
			.where(inArray(mergeJobs.state, ["queued", "held", ...IN_FLIGHT]));
		return rows.filter(
			(r): r is { taskId: string; state: MergeJobState } => r.taskId != null,
		);
	}

	/**
	 * Process at most one queued job to completion; callers loop until "idle".
	 */
	async tick(): Promise<
		"idle" | "paused" | "merged" | "parked" | "deferred" | "held"
	> {
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
			// Requeue so an in-flight job is not stuck until restart; a merge holds no
			// state until its ref moves, so this is safe mid-merge.
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
				workspacePath: runs.workspacePath,
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

	/** The target's tip. `finishMerged` moves the ref by compare-and-swap from it. */
	private async targetTip(target: string): Promise<string> {
		const base = await git(
			["rev-parse", "--verify", `refs/heads/${target}^{commit}`],
			this.deps.projectRoot,
		);
		if (base.exitCode !== 0)
			throw new Error(`target branch ${target} missing: ${base.stderr}`);
		return base.stdout.trim();
	}

	private async process(
		job: MergeJobView,
	): Promise<"merged" | "parked" | "deferred" | "held"> {
		const log = this.deps.log.child({ job: job.id, branch: job.branch });
		let baseSha: string;
		try {
			baseSha = await this.targetTip(job.targetBranch);
		} catch (e) {
			// Target unreadable or its config refused: park loudly rather than spin.
			log.error({ err: e }, "merge preparation failed");
			await this.park(job, `merge: ${(e as Error).message}`, "conflict");
			return "parked";
		}

		// Before anything else touches the branch: a rebase must not launder a
		// commit nobody verified. A tip the queue's own rebase produced is the one
		// exception, and it is verified again before it can land.
		const tip = await this.sourceTip(job);
		if (tip) {
			const pin = await this.pinOf(job.id);
			if (tip !== pin.verifiedSha) {
				if (tip === pin.rebasedSha) {
					return this.verifyRebasedAndLand(job, baseSha, tip);
				}
				await this.park(
					job,
					pin.verifiedSha && !(await this.runsChecks(job))
						? MOVED_TIP_REFUSAL
						: pinRefusal(tip, pin.verifiedSha),
					"reverify",
				);
				return "parked";
			}
		}

		await this.setState(job.id, "merging");
		const first = await this.tryMerge(job, baseSha);
		if (first) {
			const sha = await this.restoreBoard(job, baseSha, first);
			if (!(await this.ownerAllows(job, baseSha, sha))) return "held";
			if (!(await this.mergeCommitPasses(job, sha))) return "parked";
			return this.finishMerged(job, baseSha, sha);
		}

		// Conflict: rebase the run onto the target, re-verify, retry once. A
		// workspace run rebases in its own workspace; a clone run rebases in a
		// host-owned scratch clone of its quarantine ref.
		if ((await this.mergeSource(job)) !== job.branch) {
			if (!this.deps.rebaseClone) {
				await this.park(
					job,
					"merge conflict in a clone run and no scratch rebase is available",
					"conflict",
				);
				return "parked";
			}
			await this.setState(job.id, "rebasing");
			const rebased = await this.deps.rebaseClone(job, baseSha);
			if (!rebased.ok) {
				await this.park(
					job,
					rebased.kind === "conflict"
						? rebased.paths.length > 0
							? `rebase conflict in ${rebased.paths.join(", ")}`
							: `rebase conflict: ${rebased.detail}`
						: `rebase of the clone run failed: ${rebased.detail}`,
					"conflict",
				);
				return "parked";
			}
		} else {
			if (!job.workspacePath) {
				await this.park(
					job,
					"merge conflict and no run workspace to rebase",
					"conflict",
				);
				return "parked";
			}
			await this.setState(job.id, "rebasing");
			const rebase = await git(["rebase", job.targetBranch], job.workspacePath);
			if (rebase.exitCode !== 0) {
				// Read conflicting paths before aborting; git's own advice is useless
				// to the operator.
				const paths = await this.conflictingPaths(job.workspacePath);
				await git(["rebase", "--abort"], job.workspacePath);
				await this.park(
					job,
					paths.length > 0
						? `rebase conflict in ${paths.join(", ")}`
						: `rebase conflict: ${tail(rebase.stderr)}`,
					"conflict",
				);
				return "parked";
			}
		}

		const rebased = await this.sourceTip(job);
		if (!rebased) {
			await this.park(job, "the rebased branch cannot be read", "conflict");
			return "parked";
		}
		// Recorded first, so a crash or a failed check retries the verification
		// of this tip instead of refusing the queue's own rebase.
		await this.deps.handle.db
			.update(mergeJobs)
			.set({ rebasedSha: rebased, updatedAt: new Date() })
			.where(eq(mergeJobs.id, job.id));
		return this.verifyRebasedAndLand(job, baseSha, rebased);
	}

	/** The commit a job may land, and the tip its own rebase left to verify. */
	private async pinOf(
		jobId: number,
	): Promise<{ verifiedSha: string | null; rebasedSha: string | null }> {
		const [row] = await this.deps.handle.db
			.select({
				verifiedSha: mergeJobs.verifiedSha,
				rebasedSha: mergeJobs.rebasedSha,
			})
			.from(mergeJobs)
			.where(eq(mergeJobs.id, jobId));
		return row ?? { verifiedSha: null, rebasedSha: null };
	}

	private async runsChecks(job: MergeJobView): Promise<boolean> {
		if (!this.deps.hasChecks) return false;
		return this.deps.hasChecks(job).catch(() => false);
	}

	/** The commit the job's source points at now; null when it cannot be read. */
	private async sourceTip(job: {
		runId: string;
		branch: string;
	}): Promise<string | null> {
		const source = await this.mergeSource(job);
		const tip = await git(
			["rev-parse", "--verify", `${source}^{commit}`],
			this.deps.projectRoot,
		);
		return tip.exitCode === 0 ? tip.stdout.trim() : null;
	}

	/**
	 * A rebased tip is a new commit: it lands only after the checks pass on that
	 * exact SHA and the branch still points at it. The pin then moves to it.
	 */
	private async verifyRebasedAndLand(
		job: MergeJobView,
		baseSha: string,
		rebased: string,
	): Promise<"merged" | "parked" | "deferred" | "held"> {
		await this.setState(job.id, "reverifying");
		const verdict = await this.deps.reverify(job, baseSha, rebased);
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
		const after = await this.sourceTip(job);
		if (after !== rebased) {
			await this.park(
				job,
				pinRefusal(after ?? "(unreadable)", rebased),
				"reverify",
			);
			return "parked";
		}
		await this.deps.handle.withTx(async (tx) => {
			await tx
				.update(mergeJobs)
				.set({ verifiedSha: rebased, rebasedSha: null, updatedAt: new Date() })
				.where(eq(mergeJobs.id, job.id));
			await tx
				.update(runs)
				.set({ verifiedSha: rebased })
				.where(eq(runs.id, job.runId));
		});

		await this.setState(job.id, "merging", { attempt: job.attempt + 1 });
		// The queue is the only mover of the target ref, so baseSha is still current.
		const retried = await this.tryMerge(job, baseSha);
		if (retried) {
			const sha = await this.restoreBoard(job, baseSha, retried);
			if (!(await this.ownerAllows(job, baseSha, sha))) return "held";
			if (!(await this.mergeCommitPasses(job, sha))) return "parked";
			return this.finishMerged(job, baseSha, sha);
		}
		await this.park(job, "merge conflict persisted after rebase", "conflict");
		return "parked";
	}

	/**
	 * The mfw firewall: a run branch may change trigger definitions and nothing
	 * else mfw owns.
	 *
	 * A run's clone holds the whole tracked tree, board included, so this is
	 * the one place a run's edit to a protected path is undone (as is a human
	 * edit on a feature branch). The danger is silent: git follows a task
	 * rename and applies the branch's edit at the new path with no conflict.
	 *
	 * Protected set: every tracked path under `.mfw/` except `.mfw/triggers/`,
	 * plus the board's own files (`board.yaml`, `tasks/`, `adrs/` at the root of
	 * the board folder, see `board-layout.ts`), discovered from the union of
	 * base and merged trees (default-deny for new mfw paths). Only the commit's
	 * tree is rewritten, so untracked runtime state is
	 * unaffected.
	 */
	private async restoreBoard(
		job: MergeJobView,
		baseSha: string,
		mergeSha: string,
	): Promise<string> {
		const board = await readProtectedBoardPaths(this.deps.projectRoot);
		const { sha, reverted } = await landingRestorePaths(
			await this.landing(),
			baseSha,
			mergeSha,
			[".mfw", ...board],
			(path) => path.startsWith(".mfw/triggers/"),
			await this.identity(),
		);
		if (reverted.length === 0) return sha;

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
		return sha;
	}

	/** The repository's committer, read as data; merges never use its config otherwise. */
	private async identity(): Promise<LandingIdentity> {
		const read = async (key: string, fallback: string) => {
			const r = await git(["config", "--get", key], this.deps.projectRoot);
			return r.exitCode === 0 && r.stdout ? r.stdout : fallback;
		};
		return {
			name: await read("user.name", "mfw"),
			email: await read("user.email", "mfw@localhost"),
		};
	}

	/**
	 * What to merge. A clone run's work reaches the primary only as the
	 * host-verified quarantine ref (`refs/mfw/quarantine/<runId>`), so that is
	 * read when it exists; a workspace run's branch lives in the primary itself.
	 */
	private async mergeSource(job: {
		runId: string;
		branch: string;
	}): Promise<string> {
		const ref = quarantineRef(job.runId);
		const found = await git(
			["rev-parse", "--verify", "-q", `${ref}^{commit}`],
			this.deps.projectRoot,
		);
		return found.exitCode === 0 ? ref : job.branch;
	}

	/**
	 * The ask-first gate, on the host's own diff of the exact commit about to
	 * land. True when it changes no host-executed file, or when the owner
	 * approved this exact content; otherwise the job is held on a card.
	 */
	private async ownerAllows(
		job: MergeJobView,
		baseSha: string,
		sha: string,
	): Promise<boolean> {
		const change = await hostExecutedChange(
			this.deps.projectRoot,
			baseSha,
			sha,
			this.deps.envProtectedPaths?.() ?? [],
		);
		if (!change) return true;
		const [row] = await this.deps.handle.db
			.select()
			.from(engineKv)
			.where(eq(engineKv.key, hostMergeApprovalKey(job.runId)));
		const approved = row?.value as { fingerprint?: string } | undefined;
		if (approved?.fingerprint === change.fingerprint) return true;
		await this.holdForOwner(job, sha, change);
		return false;
	}

	/** Park the job on a decision card, with the card and the state in one transaction. */
	private async holdForOwner(
		job: MergeJobView,
		sha: string,
		change: HostExecutedChange,
	): Promise<void> {
		const actionId = ulid();
		const hostMerge: HostMergeHold = {
			jobId: job.id,
			runId: job.runId,
			fingerprint: change.fingerprint,
		};
		const reason = `changes host-executed files: ${change.paths.slice(0, 5).join(", ")}${
			change.paths.length > 5 ? ` and ${change.paths.length - 5} more` : ""
		}`;
		const stored = await this.deps.handle.withTx(async (tx) => {
			await tx
				.delete(engineKv)
				.where(eq(engineKv.key, hostMergeApprovalKey(job.runId)));
			await tx
				.update(mergeJobs)
				.set({ state: "held", error: reason, updatedAt: new Date() })
				.where(eq(mergeJobs.id, job.id));
			await tx.insert(brainActions).values({
				id: actionId,
				idemKey: `host_merge:${actionId}`,
				sessionId: "merge-queue",
				turnRunId: job.runId,
				tool: HOST_MERGE_TOOL,
				args: {
					runId: job.runId,
					...(job.taskId ? { taskId: job.taskId } : {}),
					branch: job.branch,
					target: job.targetBranch,
					commit: sha,
					paths: change.paths.slice(0, 50),
					pathCount: change.paths.length,
					pushes: this.push.enabled,
				},
				status: "held",
				effects: {
					rights: {
						actionClass: "host_executed_merge",
						cause: "default",
						classes: this.push.enabled
							? ["host_executed_merge", "publish_outward"]
							: ["host_executed_merge"],
					},
					hostMerge,
				},
				createdAt: new Date(),
			});
			return appendEvent(tx, {
				type: "brain.action",
				runId: job.runId,
				...(job.taskId ? { taskId: job.taskId } : {}),
				payload: {
					actionId,
					tool: HOST_MERGE_TOOL,
					status: "held",
					sessionId: "merge-queue",
				},
			});
		});
		this.deps.bus.publish([stored]);
		this.deps.log.warn(
			{ job: job.id, runId: job.runId, paths: change.paths.slice(0, 20) },
			"merge held for the owner: it changes host-executed files",
		);
	}

	/**
	 * After the owner declines: the same hand-back as an exhausted park. The
	 * state change already committed with the answer, so a crash before this
	 * leaves an ordinary `merge_parked` inbox item.
	 */
	async settleDeclinedHostMerge(actionId: string): Promise<void> {
		const [card] = await this.deps.handle.db
			.select({ effects: brainActions.effects })
			.from(brainActions)
			.where(eq(brainActions.id, actionId));
		const hold = (card?.effects as { hostMerge?: HostMergeHold } | null)
			?.hostMerge;
		if (!hold) return;
		const [row] = await this.deps.handle.db
			.select({ state: mergeJobs.state, error: mergeJobs.error })
			.from(mergeJobs)
			.where(eq(mergeJobs.id, hold.jobId));
		if (row?.state !== "parked") return;
		const job = await this.requireParked(hold.jobId);
		await this.deps.onParked(
			job,
			row.error ?? "declined by the owner",
			"conflict",
		);
	}

	/**
	 * Verify the merge commit before it lands (clone projects). Returns true
	 * when the job may land; otherwise the job is parked.
	 */
	private async mergeCommitPasses(
		job: MergeJobView,
		sha: string,
	): Promise<boolean> {
		if (!this.deps.verifyMerge) return true;
		await this.setState(job.id, "reverifying");
		const verdict = await this.deps.verifyMerge(job, sha);
		if (verdict.passed) {
			await this.setState(job.id, "merging");
			return true;
		}
		await this.park(
			job,
			verdict.crashed
				? `a DoD check was killed by a signal twice in a row verifying the merge commit; not evidence the merge is bad: ${verdict.detail ?? ""}`
				: `the merge commit failed verification: ${verdict.detail ?? ""}`,
			"reverify",
			verdict.crashed === true,
		);
		return false;
	}

	/**
	 * Merge in the host-owned landing repository, under an empty config.
	 * Returns the merge commit, or null on a conflict.
	 */
	private async tryMerge(
		job: MergeJobView,
		baseSha: string,
	): Promise<string | null> {
		const source = await this.mergeSource(job);
		const sourceSha = await git(
			["rev-parse", "--verify", `${source}^{commit}`],
			this.deps.projectRoot,
		);
		if (sourceSha.exitCode !== 0) {
			throw new Error(`merge source ${source} missing: ${sourceSha.stderr}`);
		}
		// The last read before the merge: a move since the check requeues the
		// job, and the next pass refuses it.
		const candidate = sourceSha.stdout.trim();
		const { verifiedSha } = await this.pinOf(job.id);
		if (candidate !== verifiedSha) {
			throw new Error(pinRefusal(candidate, verifiedSha));
		}
		return landingMerge(
			await this.landing(),
			baseSha,
			candidate,
			`Merge branch '${job.branch}' into ${job.targetBranch}`,
			await this.identity(),
		);
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
	 * thrown error, retried from a fresh target tip. Keep both
	 * checks against live state.
	 */
	private async finishMerged(
		job: MergeJobView,
		baseSha: string,
		sha: string,
	): Promise<"merged" | "deferred"> {
		// Not checked out in the primary: compare-and-swap the ref.
		// Checked out: `merge --ff-only` in the primary, which moves ref, index
		// and workspace together and refuses rather than clobbering. A refusal
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
		await this.reportLandedPaths(job, baseSha, sha);
		const dependencyPaths = await this.landedDependencies(job, baseSha, sha);
		const stored = await this.deps.handle.withTx(async (tx) => {
			await tx
				.update(mergeJobs)
				.set({ state: "merged", updatedAt: new Date() })
				.where(eq(mergeJobs.id, job.id));
			if (dependencyPaths.length > 0) {
				await recordDependencyChange(tx, {
					sha,
					runId: job.runId,
					taskId: job.taskId,
					branch: job.branch,
					target: job.targetBranch,
					paths: dependencyPaths,
					at: Date.now(),
				});
			}
			// An approval covers one landing.
			await tx
				.delete(engineKv)
				.where(eq(engineKv.key, hostMergeApprovalKey(job.runId)));
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
		const refused = await repoConfigRefusal(this.deps.projectRoot);
		if (refused) {
			await this.recordPushRefusal(branch, refused.message);
			return { status: "error", reason: refused.message };
		}
		const remotes = await git(["remote"], this.deps.projectRoot);
		if (remotes.exitCode !== 0) {
			return {
				status: "error",
				reason: `git remote: ${tail(remotes.stderr || remotes.stdout, 300)}`,
			};
		}
		// Only says whether this project publishes at all. The destination is
		// the approved URL, whatever the remote's own URL says.
		if (
			!this.push.url &&
			!remotes.stdout.split("\n").includes(this.push.remote)
		) {
			return { status: "no-remote" };
		}
		const r = await hardenedPush({
			projectRoot: this.deps.projectRoot,
			branch,
			target: this.push.url
				? {
						url: this.push.url,
						...(this.push.allowLocalUrl ? { allowLocal: true } : {}),
					}
				: null,
			...(this.deps.landingRoot ? { landingRoot: this.deps.landingRoot } : {}),
		});
		if (r.status === "refused") await this.recordPushRefusal(branch, r.reason);
		if (r.status === "pushed") {
			await this.deps.handle.db
				.delete(engineKv)
				.where(eq(engineKv.key, PUSH_REFUSED_KEY));
			return { status: "pushed" };
		}
		return { status: "error", reason: r.reason };
	}

	/** Keep the inbox item until a later push succeeds. */
	private async recordPushRefusal(
		branch: string,
		reason: string,
	): Promise<void> {
		const value = { at: Date.now(), branch, reason };
		await this.deps.handle.db
			.insert(engineKv)
			.values({ key: PUSH_REFUSED_KEY, value, updatedAt: new Date() })
			.onConflictDoUpdate({
				target: engineKv.key,
				set: { value, updatedAt: new Date() },
			});
	}

	/**
	 * Tell the owner of armed files what this merge changed, before
	 * `merge.completed` can fire them. Unknown paths are reported as null, which
	 * disarms conservatively. A failure here must not undo a landed merge; the
	 * execution-time pin check still applies.
	 */
	private async reportLandedPaths(
		job: MergeJobView,
		baseSha: string,
		sha: string,
	): Promise<void> {
		if (!this.deps.onLandedPaths) return;
		try {
			const diff = await git(
				["diff-tree", "-r", "-z", "--name-only", "--no-renames", baseSha, sha],
				this.deps.projectRoot,
			);
			await this.deps.onLandedPaths(
				diff.exitCode === 0 ? diff.stdout.split("\0").filter(Boolean) : null,
			);
		} catch (e) {
			this.deps.log.error(
				{ err: e, job: job.id },
				"could not re-check armed files after a merge",
			);
		}
	}

	/** For the notify-after item. The merge has landed: a failure here only logs. */
	private async landedDependencies(
		job: MergeJobView,
		baseSha: string,
		sha: string,
	): Promise<string[]> {
		try {
			const root = this.deps.projectRoot;
			const held = await hostExecutedChange(
				root,
				baseSha,
				sha,
				this.deps.envProtectedPaths?.() ?? [],
			);
			return await landedDependencyPaths(root, baseSha, sha, held?.paths ?? []);
		} catch (e) {
			this.deps.log.warn(
				{ err: e, job: job.id },
				"could not list the dependency files this merge changed",
			);
			return [];
		}
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
			this.deps.projectRoot,
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

		const finalReason = exhausted
			? `${reason}; mfw retried this automatically ${retries} time${retries === 1 ? "" : "s"} and could not resolve it; the brain decides`
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

	/** Re-queue a parked job; reuses the same run workspace and branch. */
	async retry(jobId: number): Promise<void> {
		const job = await this.requireParked(jobId);
		const tip = await this.sourceTip(job);
		const pin = await this.pinOf(jobId);
		const moved =
			tip !== null &&
			pin.verifiedSha !== null &&
			tip !== pin.verifiedSha &&
			tip !== pin.rebasedSha;
		// Before the claim is touched: a refused retry changes nothing but the
		// reason on the job, which stays parked.
		if (moved && !(await this.runsChecks(job))) {
			await this.deps.handle.db
				.update(mergeJobs)
				.set({ error: MOVED_TIP_REFUSAL, updatedAt: new Date() })
				.where(and(eq(mergeJobs.id, jobId), eq(mergeJobs.state, "parked")));
			throw new Error(MOVED_TIP_REFUSAL);
		}
		if (job.taskId) await this.deps.reclaimTask?.(job);
		// A tip changed by hand (a resolved conflict) with checks to run is not
		// trusted: it takes the same re-verification as the queue's own rebase.
		if (moved) {
			await this.deps.handle.db
				.update(mergeJobs)
				.set({ rebasedSha: tip, updatedAt: new Date() })
				.where(eq(mergeJobs.id, jobId));
		}
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
				workspacePath: runs.workspacePath,
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
			workspacePath: job.workspacePath,
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

	/** Boot reconciliation: requeue in-flight jobs. A merge holds no state until its ref moves. */
	async resetInFlight(): Promise<number> {
		const rows = await this.deps.handle.db
			.select({ id: mergeJobs.id })
			.from(mergeJobs)
			.where(inArray(mergeJobs.state, [...IN_FLIGHT]));
		if (rows.length === 0) return 0;
		await this.deps.handle.db
			.update(mergeJobs)
			.set({ state: "queued", updatedAt: new Date() })
			.where(and(inArray(mergeJobs.state, [...IN_FLIGHT])));
		return rows.length;
	}
}

const MOVED_TIP_REFUSAL =
	"the tip moved since it was verified; re-run the task so it is verified again";

function pinRefusal(tip: string, verified: string | null): string {
	return verified
		? `the branch tip ${tip.slice(0, 12)} is not the commit that was verified (${verified.slice(0, 12)}): it must be verified again before it can merge`
		: `this job has no verified commit recorded (tip ${tip.slice(0, 12)}): send the task back to ready to run it again`;
}

function tail(s: string, n = 400): string {
	return s.length > n ? s.slice(-n) : s;
}
