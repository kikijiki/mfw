import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RunActivity } from "@mfw/core/activity";
import type { ProjectDbHandle } from "@mfw/db/client";
import { engineKv } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import type { AgentHost } from "./agent-host.ts";
import {
	type ActivityResult,
	activityOf,
	activitySignature,
} from "./agents/activity.ts";
import { parseAgentEvents } from "./agents/events.ts";
import { isBrainTurnRun } from "./brain-runtime/turn-run.ts";
import { PROJECT_DEFAULTS } from "./config.ts";
import type { StepRunner } from "./finalize/step-runner.ts";
import type { Logger } from "./log.ts";
import type { NotificationType } from "./notify.ts";
import { RunEventTail } from "./run-event-tail.ts";
import {
	CLAIM_HOLDING_RUN_STATES,
	type RunRegistry,
	type RunRow,
} from "./run-registry.ts";
import {
	assessScope,
	changedFiles,
	DEFAULT_SCOPE_POLICY,
	foreignClaims,
	type ScopeOwners,
	type ScopePolicy,
	type ScopeSample,
	scopeKill,
	scopeSignature,
} from "./scope-watchdog.ts";
import { closeDanglingSpans } from "./spans.ts";
import type { TaskService } from "./task-service.ts";

/**
 * The single observe loop.
 *
 * The loop is an awaited `while`, so a pass that outlives the interval (finalization
 * routinely does) cannot overlap the next one and double-finalize a run.
 * `wake()` only shortens the sleep.
 *
 * One pass: adopt/observe live runs (watchdog), then drive finalization for
 * every run whose session has ended, sequentially, behind the DB single-flight
 * claim so a second daemon (or a stale boot) cannot race us.
 */

export interface WatchdogLimits {
	/** Kill after this long with no new events.jsonl output (0 = off). */
	idleMs: number;
	/** Kill after this much wall-clock time (0 = off). */
	wallMs: number;
	/** Kill after this many assistant turns (0 = off). */
	maxTurns: number;
	/** Diff-scope watchdog over a local run's worktree (`scope-watchdog.ts`). */
	scope: ScopePolicy;
}

/** What a caller may set; every absent field takes its default. */
export type WatchdogLimitsInput = Partial<Omit<WatchdogLimits, "scope">> & {
	scope?: Partial<ScopePolicy>;
};

export const DEFAULT_WATCHDOG_LIMITS: WatchdogLimits = {
	idleMs: PROJECT_DEFAULTS.watchdog.idleMs,
	wallMs: PROJECT_DEFAULTS.watchdog.wallMs,
	maxTurns: PROJECT_DEFAULTS.watchdog.maxTurns,
	scope: DEFAULT_SCOPE_POLICY,
};

export interface SupervisorDeps {
	handle: ProjectDbHandle;
	registry: RunRegistry;
	tasks: TaskService;
	host: AgentHost;
	/** Target-neutral observation/control/finalization supplied by RunEngine. */
	execution?: {
		observeRun(runId: string): Promise<{
			state: "starting" | "running" | "unknown" | "exited" | "absent";
		}>;
		killRun(runId: string, reason: string): Promise<void>;
		finalizeExecutionTarget(runId: string): Promise<{
			collectionError: unknown | null;
		}>;
	};
	stepRunner: StepRunner;
	/**
	 * Whether another attached project owns this run id. The tmux socket is
	 * shared by every project, so a session with no row HERE is an orphan only
	 * when no sibling project has a row for it either.
	 */
	ownedElsewhere?: (runId: string) => Promise<boolean>;
	log: Logger;
	projectRoot: string;
	bootId: string;
	/** Initial limits; `Supervisor.setLimits` replaces them live (settings). */
	limits?: WatchdogLimitsInput;
	/** Changed-file listing for the scope watchdog; tests inject failures. */
	scopeFiles?: (
		worktreePath: string,
		baseSha: string,
	) => Promise<{ files: string[]; truncated: boolean }>;
	/**
	 * Incremental transcript fold shared with RunEngine (`engine.eventTail`),
	 * so approvals, turns and activity are read from new bytes only. Absent =
	 * a private one over `registry`.
	 */
	eventTail?: RunEventTail;
	/** Pings for activity that needs a human; once per run and kind. */
	notify?: (
		kind: NotificationType,
		detail: Record<string, unknown>,
	) => Promise<unknown>;
	/**
	 * Drained every pass. Merging is the tail of finalizing a run, so it lives
	 * on the loop that always runs, not on the opt-in scheduler (otherwise
	 * verified work never merges with `schedulerAutostart: false`).
	 */
	mergeQueue?: { tick(): Promise<string> };
	/**
	 * Frees a terminated run's resource slots (slot rows only vanish by FK
	 * cascade, and run rows are never deleted).
	 */
	releaseSlots?: (runId: string) => Promise<unknown>;
	/** Renew/adopt the fenced host half only after this pass proves the run live. */
	renewAdmission?: (runId: string) => Promise<unknown>;
	/**
	 * Detects edits made to the board outside the daemon (an editor, `mv`,
	 * `rm`). Runs every pass: it is a readdir plus a small hash, and inotify
	 * proved unreliable in the bundled server.
	 */
	boardPoll?: () => Promise<unknown>;
	/** Commits pending board changes to its branch. Coalesces internally, so
	 *  calling it every pass costs nothing when nothing moved. */
	boardCommit?: () => Promise<unknown>;
	/**
	 * Project triggers (MFW-117 §7.1). On this loop for the same reason as
	 * merging: a project with dispatch disabled must still notify when main
	 * goes red. Post-commit and off the merge queue's critical path, so a slow
	 * deploy cannot stall other tasks' merges.
	 */
	triggers?: { dispatch(): Promise<unknown> };
	/**
	 * The project brain (`brain-runtime/`): woken from this loop's cadence,
	 * which also supervises and finalizes its turns. `turnTimeoutMs` replaces
	 * the worker wall clock for a turn (a brain turn is short).
	 */
	brainRuntime?: {
		tick(): Promise<unknown>;
		turnTimeoutMs(): number;
		/** Attempt-group bookkeeping: selections, loser archival, abandoned groups. */
		settleGroups?(): Promise<unknown>;
	};
	/** Budget evaluation (`budgets.ts`), rate-limited inside; before the brain tick so its events wake it this pass. */
	budgets?: { tick(): Promise<unknown> };
	/**
	 * Housekeeping, every Nth pass. `exclusive` is true only while no provider
	 * run is live: the regression sweep (and anything else heavy) runs then;
	 * otherwise only the cheap part (groom, gc) runs, so a busy project still
	 * cleans up.
	 */
	maintenance?: (mode: { exclusive: boolean }) => Promise<void>;
	maintenanceEveryNPasses?: number;
	/** Lease renewal window for observed runs. */
	leaseMs?: number;
	/** Injectable clock for tests. */
	now?: () => number;
}

/** Live activities a human should hear about, and the notification kind. */
const ACTIVITY_NOTIFICATION: Partial<Record<RunActivity, NotificationType>> = {
	awaiting_approval: "approval_pending",
	needs_answer: "needs_answer",
	stalled: "stalled",
};

/** States the loop still has work to do for. */
const LIVE_STATES = ["starting", "running", "ended", "finalizing"] as const;

/** A `starting` row younger than this may still be racing its own launch. */
const START_GRACE_MS = 120_000;

export interface ReconcileReport {
	adopted: number;
	endedByExit: number;
	interrupted: number;
	startFailed: number;
	staleClaimsCleared: number;
	orphanSessionsKilled: number;
	leasesReleased: number;
}

export interface PassStats {
	observed: number;
	killed: number;
	finalized: number;
	errors: number;
}

export class Supervisor {
	private readonly log: Logger;
	private readonly now: () => number;
	private stopping = false;
	private wakeup: (() => void) | null = null;
	private loopDone: Promise<void> | null = null;
	private maintenanceInFlight: Promise<void> | null = null;
	private maintenanceRequested = false;
	private passCount = 0;
	private readonly tail: RunEventTail;
	/** Last persisted activity signature per live run. */
	private readonly activitySeen = new Map<string, string>();
	/** `runId:kind` already notified (debounce). */
	private readonly notified = new Set<string>();
	/** Scope watchdog bookkeeping per live run: last sample time, the
	 *  events.jsonl mtime it saw, and the persisted counts signature. */
	private readonly scopeSeen = new Map<
		string,
		{ at: number; mtime: number; sig: string | null }
	>();
	private limitsInput: WatchdogLimitsInput;
	/** Health surface. */
	readonly stats = {
		lastPassAt: 0,
		lastPassMs: 0,
		passErrors: 0,
		kills: {} as Record<string, number>,
	};

	constructor(private readonly deps: SupervisorDeps) {
		this.log = deps.log.child({ svc: "supervisor" });
		this.now = deps.now ?? (() => Date.now());
		this.limitsInput = deps.limits ?? {};
		this.tail =
			deps.eventTail ??
			new RunEventTail((runId, offset) =>
				deps.registry.readOutput(runId, "events.jsonl", offset),
			);
	}

	/** The watchdog limits in force; read every pass, so `setLimits` is live. */
	get limits(): WatchdogLimits {
		const input = this.limitsInput;
		const d = DEFAULT_WATCHDOG_LIMITS;
		return {
			idleMs: input.idleMs ?? d.idleMs,
			wallMs: input.wallMs ?? d.wallMs,
			maxTurns: input.maxTurns ?? d.maxTurns,
			scope: { ...d.scope, ...input.scope },
		};
	}

	/** Replace the limits (settings `watchdog`, applied live). */
	setLimits(input: WatchdogLimitsInput): void {
		this.limitsInput = structuredClone(input);
	}

	/**
	 * The loop. Started by boot; returns when `stop()` resolves. Each pass is
	 * awaited, so a slow pass delays the next instead of overlapping it.
	 */
	start(intervalMs = 2000): void {
		if (this.loopDone) return;
		this.loopDone = this.runLoop(intervalMs);
	}

	private async runLoop(intervalMs: number): Promise<void> {
		while (!this.stopping) {
			const t0 = this.now();
			try {
				await this.pass();
			} catch (e) {
				this.stats.passErrors++;
				this.log.error({ err: e }, "supervisor pass failed");
			}
			this.stats.lastPassAt = this.now();
			this.stats.lastPassMs = this.now() - t0;
			if (this.stopping) break;
			await this.sleep(Math.max(250, intervalMs - this.stats.lastPassMs));
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise<void>((resolve) => {
			const timer = setTimeout(finish, ms);
			this.wakeup = finish;
			function finish() {
				clearTimeout(timer);
				resolve();
			}
		});
	}

	/** Shorten the current sleep (stop/boot/tests). Never starts a second pass. */
	wake(): void {
		this.wakeup?.();
		this.wakeup = null;
	}

	/** Ask for a background maintenance pass at the next provider-idle point.
	 * Used after a recovery merge to confirm main immediately without blocking
	 * the merge worker or the observe loop on the full regression suite. */
	requestMaintenance(): void {
		this.maintenanceRequested = true;
		this.wake();
	}

	async stop(): Promise<void> {
		this.stopping = true;
		this.wake();
		await this.loopDone?.catch(() => {
			// the loop logs its own failures; stop() must always settle
		});
		// Maintenance owns the same DB and board services as the observe loop.
		// Drain it before boot closes those resources underneath it.
		await this.maintenanceInFlight?.catch(() => {});
		this.loopDone = null;
	}

	/** One pass: watchdog live runs, then finalize ended ones sequentially. */
	async pass(): Promise<PassStats> {
		const stats: PassStats = {
			observed: 0,
			killed: 0,
			finalized: 0,
			errors: 0,
		};
		const live = await this.deps.registry.list({ states: [...LIVE_STATES] });
		for (const run of live) {
			// Advisory brain calls are headless subprocesses owned by BrainService,
			// not tmux sessions; `isAlive` is always false for them, so including
			// them would finalize in-flight decisions as `interrupted`. A project
			// brain TURN is a real tmux run and is supervised like any other.
			if (run.kind === "brain" && !isBrainTurnRun(run)) continue;
			stats.observed++;
			try {
				if (run.state === "starting" || run.state === "running") {
					const remote =
						Boolean(this.deps.execution) && run.executionTarget !== "local";
					const targetObservation = this.deps.execution
						? await this.deps.execution.observeRun(run.id)
						: (await this.deps.host.isAlive(run.id))
							? { state: "running" as const }
							: { state: "absent" as const };
					if (targetObservation.state === "running") {
						if (run.state === "starting") {
							await this.deps.registry.transition(run.id, "running", {
								from: "starting",
							});
						}
						await this.observe(run, stats);
						continue;
					}
					if (
						remote &&
						(targetObservation.state === "starting" ||
							targetObservation.state === "unknown")
					) {
						await this.renewUncertain(run);
						continue;
					}
					if (targetObservation.state === "starting") continue;
					if (
						!remote &&
						run.state === "starting" &&
						this.now() - run.startedAt.getTime() < START_GRACE_MS
					) {
						continue; // the launch may still be in flight
					}
					await this.deps.registry.transition(run.id, "ended");
				}
				// ended | finalizing: drive the machine behind the DB claim
				if (await this.deps.registry.claimFinalize(run.id, this.deps.bootId)) {
					const targetResult =
						await this.deps.execution?.finalizeExecutionTarget(run.id);
					if (targetResult?.collectionError) {
						this.log.error(
							{ err: targetResult.collectionError, runId: run.id },
							"target collection failed; provider absence was still proven",
						);
					}
					await this.deps.stepRunner.finalize(run.id);
					stats.finalized++;
					this.forgetRun(run.id);
					// Terminal now: free its resource slots.
					const after = await this.deps.registry.get(run.id);
					if (
						after &&
						!LIVE_STATES.includes(after.state as never) &&
						!(await this.deps.registry.hasPendingCleanup(run.id))
					) {
						await this.deps.releaseSlots?.(run.id);
					}
				}
			} catch (e) {
				if (
					this.deps.execution &&
					run.executionTarget !== "local" &&
					(run.state === "starting" || run.state === "running")
				) {
					await this.renewUncertain(run);
				}
				stats.errors++;
				this.stats.passErrors++;
				this.log.error({ err: e, runId: run.id }, "run pass failed");
			}
		}

		try {
			await this.deps.boardPoll?.();
			await this.deps.boardCommit?.();
		} catch (e) {
			stats.errors++;
			this.stats.passErrors++;
			this.log.error({ err: e }, "mirror poll failed");
		}

		// Verified work merges here.
		try {
			let drained = 0;
			while ((await this.deps.mergeQueue?.tick()) === "merged") {
				if (++drained > 50) break; // never starve the rest of the pass
			}
		} catch (e) {
			stats.errors++;
			this.stats.passErrors++;
			this.log.error({ err: e }, "merge queue drain failed");
		}

		// After the merge drain, so a `merge.completed` from this pass dispatches
		// in the same pass.
		try {
			await this.deps.triggers?.dispatch();
		} catch (e) {
			stats.errors++;
			this.stats.passErrors++;
			this.log.error({ err: e }, "trigger dispatch pass failed");
		}

		try {
			await this.deps.budgets?.tick();
		} catch (e) {
			stats.errors++;
			this.stats.passErrors++;
			this.log.error({ err: e }, "budget pass failed");
		}

		// Attempt groups advance whether or not dispatch is on: a selected winner
		// merges, losers are archived, and a dead group gives its claim back.
		try {
			await this.deps.brainRuntime?.settleGroups?.();
		} catch (e) {
			stats.errors++;
			this.stats.passErrors++;
			this.log.error({ err: e }, "attempt group pass failed");
		}

		// Last, so a turn that ended or a run that settled this pass is seen now.
		try {
			await this.deps.brainRuntime?.tick();
		} catch (e) {
			stats.errors++;
			this.stats.passErrors++;
			this.log.error({ err: e }, "brain runtime pass failed");
		}

		this.passCount++;
		const every = this.deps.maintenanceEveryNPasses ?? 0;
		const providerWorkLive = live.some((run) => run.kind !== "brain");
		if (this.deps.maintenance && every > 0) {
			const cadence = this.passCount % every === 0;
			if (!providerWorkLive && (this.maintenanceRequested || cadence)) {
				this.maintenanceRequested = false;
				this.startMaintenance({ exclusive: true });
			} else if (providerWorkLive && cadence) {
				// The sweep stays exclusive (a requested recovery confirmation keeps
				// waiting for idle), but groom and gc must not starve on a project
				// that is never idle.
				this.startMaintenance({ exclusive: false });
			}
		}
		return stats;
	}

	/** Housekeeping may take many minutes (notably the regression sweep). Run it
	 * beside the short observe/finalize cadence, but never overlap two sweeps. */
	private startMaintenance(mode: { exclusive: boolean }): void {
		if (!this.deps.maintenance || this.maintenanceInFlight) return;
		const work = this.deps
			.maintenance(mode)
			.catch((e) => {
				this.stats.passErrors++;
				this.log.error({ err: e }, "maintenance failed");
			})
			.finally(() => {
				if (this.maintenanceInFlight === work) {
					this.maintenanceInFlight = null;
				}
			});
		this.maintenanceInFlight = work;
	}

	/**
	 * Watch one live run: copy the driver's verified `hello` capabilities into
	 * the row once, then apply the consolidated watchdog (idle / wall / turns /
	 * spike timebox).
	 */
	private async observe(run: RunRow, stats: PassStats): Promise<void> {
		if (!run.capabilities.verified) await this.adoptCapabilities(run);

		// A live run's lease must keep moving, or the groomer hands its task to a
		// second agent mid-flight (default lease 15m < wall watchdog 45m).
		await this.renewUncertain(run);

		const limits = this.limits;
		const runDir = this.deps.registry.runDir(run.id);
		const now = this.now();
		const fold = await this.tail.fold(run.id);
		if (fold.nativeSessionId && fold.nativeSessionId !== run.nativeSessionId) {
			await this.deps.registry
				.recordNativeSession(run.id, fold.nativeSessionId)
				.catch((e) =>
					this.log.warn(
						{ err: e, runId: run.id },
						"could not record native session id",
					),
				);
		}
		const usageSample = this.tail.takeUsageSample(run.id, now);
		if (usageSample) {
			await this.deps.registry
				.recordUsageSample(run.id, usageSample)
				.catch((e) =>
					this.log.warn({ err: e, runId: run.id }, "could not record usage"),
				);
		}
		const subagents = this.tail.takeSubagents(run.id, now);
		if (subagents) {
			await this.deps.registry
				.recordSubagents(run.id, subagents)
				.catch((e) =>
					this.log.warn(
						{ err: e, runId: run.id },
						"could not record subagents",
					),
				);
		}
		const mtime = await this.outputMtime(runDir);
		await this.recordActivity(
			run,
			activityOf(fold, {
				now,
				idleMs: limits.idleMs,
				lastOutputAt: mtime > 0 ? mtime : run.startedAt.getTime(),
			}),
		);

		const wallMs =
			isBrainTurnRun(run) && this.deps.brainRuntime
				? this.deps.brainRuntime.turnTimeoutMs()
				: limits.wallMs;
		if (wallMs > 0 && now - run.startedAt.getTime() > wallMs) {
			await this.kill(run, "watchdog-wall", stats);
			return;
		}
		if (limits.idleMs > 0) {
			const waitingForApproval = [...fold.approvals.values()].some(
				(a) => a.status === "pending",
			);
			// Measured on events.jsonl, not raw.log: tmux heartbeats in the pane
			// are not agent progress.
			const since = mtime > 0 ? now - mtime : now - run.startedAt.getTime();
			if (!waitingForApproval && since > limits.idleMs) {
				await this.kill(run, "watchdog-idle", stats);
				return;
			}
		}
		if (limits.maxTurns > 0 && fold.turns > limits.maxTurns) {
			await this.kill(run, "watchdog-turns", stats);
			return;
		}
		await this.watchScope(run, limits.scope, mtime, stats);
	}

	/**
	 * Diff-scope watchdog for one live local run. Throttled to one sample per
	 * `sampleMs`, and only once events.jsonl moved since the last one (an agent
	 * that wrote nothing changed nothing). A sample that fails (git error,
	 * timeout, worktree mid-rewrite) is skipped and retried next time: a
	 * failed sample never kills.
	 */
	private async watchScope(
		run: RunRow,
		policy: ScopePolicy,
		mtime: number,
		stats: PassStats,
	): Promise<void> {
		if (policy.mode === "off") return;
		if (run.kind !== "task" && run.kind !== "repair") return;
		// Remote targets have no local worktree to sample (deferred).
		if (run.executionTarget !== "local") return;
		if (!run.worktreePath || !run.baseSha) return;
		const now = this.now();
		const seen = this.scopeSeen.get(run.id);
		if (seen && (now - seen.at < policy.sampleMs || seen.mtime === mtime))
			return;
		let sample: ScopeSample;
		try {
			const listed = await (this.deps.scopeFiles ?? changedFiles)(
				run.worktreePath,
				run.baseSha,
			);
			sample = assessScope(
				listed.files,
				await this.scopeOwners(run),
				policy,
				now,
				listed.truncated,
			);
		} catch (e) {
			this.log.debug(
				{ err: e, runId: run.id },
				"scope sample failed; retrying next pass",
			);
			return;
		}
		const sig = scopeSignature(sample);
		this.scopeSeen.set(run.id, { at: now, mtime, sig });
		if (seen?.sig !== sig) {
			try {
				await this.deps.registry.setScopeSample(run.id, { ...sample });
			} catch (e) {
				this.log.warn({ err: e, runId: run.id }, "could not record scope");
				this.scopeSeen.set(run.id, { at: now, mtime, sig: null });
			}
		}
		const reason = scopeKill(sample, policy);
		if (reason) await this.kill(run, reason, stats);
	}

	/** The run's own `owns` and every other claimed task's. */
	private async scopeOwners(run: RunRow): Promise<ScopeOwners> {
		const claimed = await this.deps.tasks.list("in_progress");
		const own = run.taskId
			? (claimed.find((t) => t.id === run.taskId) ??
				(await this.deps.tasks.get(run.taskId)))
			: null;
		return {
			owns: own?.owns ?? [],
			// The sibling rule: a claim held by this run's own group (its attempt
			// siblings, or a continuation of the same worktree chain) is never foreign.
			others: foreignClaims(run, claimed),
		};
	}

	/**
	 * Persist a live run's activity when it changed (the registry announces
	 * `run.activity_changed` on an activity change only), and ping once per run
	 * for each kind that needs a human. Never fails the pass.
	 */
	private async recordActivity(
		run: RunRow,
		result: ActivityResult,
	): Promise<void> {
		const sig = activitySignature(result);
		if (this.activitySeen.get(run.id) === sig) return;
		try {
			await this.deps.registry.setActivity(
				run.id,
				result.activity,
				result.detail,
			);
			this.activitySeen.set(run.id, sig);
		} catch (e) {
			this.log.warn({ err: e, runId: run.id }, "could not record activity");
			return;
		}
		const kind = ACTIVITY_NOTIFICATION[result.activity];
		// A message that merely ends in "?" labels the run; it is no reason to page anyone.
		if (!kind || !this.deps.notify) return;
		if (result.detail.questionSource === "heuristic") return;
		const key = `${run.id}:${kind}`;
		if (this.notified.has(key)) return;
		this.notified.add(key);
		await this.deps
			.notify(kind, {
				runId: run.id,
				...(run.taskId ? { taskId: run.taskId } : {}),
				message:
					result.detail.question ??
					result.detail.approvalSummary ??
					(result.detail.stallCause === "background"
						? "turn ended with background work still running"
						: "no output for a while"),
			})
			.catch((e) => {
				this.log.warn({ err: e, runId: run.id }, "activity notify failed");
			});
	}

	private forgetRun(runId: string): void {
		this.tail.forget(runId);
		this.activitySeen.delete(runId);
		this.scopeSeen.delete(runId);
		for (const key of this.notified) {
			if (key.startsWith(`${runId}:`)) this.notified.delete(key);
		}
	}

	private async renewUncertain(run: RunRow): Promise<void> {
		if (run.taskId) {
			await this.deps.tasks
				.renewLease(run.id, this.deps.leaseMs ?? 15 * 60_000)
				.catch((e) => {
					this.log.warn({ err: e, runId: run.id }, "lease renewal failed");
				});
		}
		await this.deps.renewAdmission?.(run.id).catch((e) => {
			this.log.warn({ err: e, runId: run.id }, "host admission renewal failed");
		});
	}

	private async adoptCapabilities(run: RunRow): Promise<void> {
		const { chunk } = await this.deps.registry.readOutput(
			run.id,
			"events.jsonl",
			0,
		);
		const hello = parseAgentEvents(chunk).find((e) => e.type === "hello");
		if (hello?.type !== "hello") return;
		await this.deps.registry.setCapabilities(run.id, {
			...hello.capabilities,
			verified: true,
		});
	}

	private async kill(
		run: RunRow,
		reason: string,
		stats: PassStats,
	): Promise<void> {
		this.log.warn({ runId: run.id, reason }, "watchdog killing run");
		if (this.deps.execution) await this.deps.execution.killRun(run.id, reason);
		else {
			await this.deps.host.kill(
				this.deps.registry.runDir(run.id),
				run.id,
				reason,
			);
		}
		this.stats.kills[reason] = (this.stats.kills[reason] ?? 0) + 1;
		stats.killed++;
	}

	private async outputMtime(runDir: string): Promise<number> {
		try {
			return (await stat(join(runDir, "events.jsonl"))).mtimeMs;
		} catch {
			return 0; // no events yet: idle is measured from startedAt
		}
	}

	/**
	 * Boot reconciliation: the runs table is checked against tmux sessions, run
	 * dirs and leases (the event log is not read).
	 */
	async reconcile(): Promise<ReconcileReport> {
		const report: ReconcileReport = {
			adopted: 0,
			endedByExit: 0,
			interrupted: 0,
			startFailed: 0,
			staleClaimsCleared: 0,
			orphanSessionsKilled: 0,
			leasesReleased: 0,
		};

		// D: run dirs with no row (DB lost/rebuilt) are the recovery source;
		// surfaced as a warning, rebuilding rows is a separate ops action.
		const sessions = new Set(await this.deps.host.listSessions());
		const live = await this.deps.registry.list({ states: [...LIVE_STATES] });

		for (const run of live) {
			// These rows already have an observed outcome and no execution session.
			// Preserve it (do not rewrite start_failed as interrupted); the normal
			// pass resumes their idempotent finalization journal.
			if (run.state === "ended" || run.state === "finalizing") continue;
			if (run.executionTarget !== "local" && this.deps.execution) {
				let observation: Awaited<
					ReturnType<NonNullable<SupervisorDeps["execution"]>["observeRun"]>
				>;
				try {
					observation = await this.deps.execution.observeRun(run.id);
				} catch {
					await this.renewUncertain(run);
					this.log.warn(
						{ runId: run.id },
						"remote reconciliation observation is uncertain; retaining run and admission",
					);
					report.adopted++;
					continue;
				}
				if (
					observation.state === "running" ||
					observation.state === "starting" ||
					observation.state === "unknown"
				) {
					if (observation.state === "running" && run.state === "starting") {
						await this.deps.registry.transition(run.id, "running", {
							from: "starting",
						});
					}
					report.adopted++;
					await this.renewUncertain(run);
					continue;
				}
				if (observation.state === "exited") {
					await this.deps.registry.transition(run.id, "ended");
					report.endedByExit++;
				} else if (run.state === "starting") {
					await this.deps.registry.recordExit(run.id, {
						outcome: "start_failed",
					});
					report.startFailed++;
				} else {
					await this.deps.registry.recordExit(run.id, {
						outcome: "interrupted",
					});
					report.interrupted++;
				}
				continue;
			}
			const alive = sessions.has(this.deps.host.session(run.id));
			if (alive) {
				report.adopted++;
				continue;
			}
			const exit = await this.deps.host.readExit(
				this.deps.registry.runDir(run.id),
			);
			if (exit.kind === "exit" || exit.kind === "killed") {
				await this.deps.registry.transition(run.id, "ended");
				report.endedByExit++;
			} else if (run.state === "starting") {
				await this.deps.registry.recordExit(run.id, {
					outcome: "start_failed",
				});
				report.startFailed++;
			} else {
				await this.deps.registry.recordExit(run.id, {
					outcome: "interrupted",
				});
				report.interrupted++;
			}
		}

		// C4: a crashed finalizer's claim must not block this boot forever.
		report.staleClaimsCleared =
			await this.deps.registry.clearStaleFinalizeOwners(this.deps.bootId);

		// E: mfw_* sessions with no row can never be finalized; kill them.
		const known = new Set(
			(await this.deps.registry.list({})).map((r) =>
				this.deps.host.session(r.id),
			),
		);
		for (const session of sessions) {
			if (known.has(session)) continue;
			const runId = session.replace(/^mfw_/, "");
			if (await this.deps.ownedElsewhere?.(runId)) continue;
			await this.deps.host.kill(
				this.deps.registry.runDir(runId),
				runId,
				"orphan",
			);
			report.orphanSessionsKilled++;
		}

		// G: tasks claimed by a run that can never finalize go back to ready.
		report.leasesReleased = await this.releaseOrphanLeases();

		// I: drop an expired dispatch hold so boot doesn't sit paused forever.
		await this.dropExpiredHold();

		// J: spans whose closing event was lost end with their (terminal) run.
		const danglingSpans = await closeDanglingSpans(this.deps.handle.db).catch(
			() => 0,
		);

		this.log.info({ report, danglingSpans }, "boot reconciliation complete");
		return report;
	}

	/** Release tasks whose claiming run is gone (or terminal) to their claimable
	 * state. Draft claims do not rename the task, so they are listed explicitly;
	 * a crash before the run row insert would otherwise leave a permanent claim. */
	private async releaseOrphanLeases(): Promise<number> {
		const claimed = [
			...(await this.deps.tasks.list("in_progress")),
			...(await this.deps.tasks.list("draft")),
		].filter((task) => task.claimedByGroupId !== null);
		let released = 0;
		for (const task of claimed) {
			// No claim at all (crash between the claiming rename and the state
			// write, or the state directory was wiped): nothing can be running it.
			// A group keeps its claim while any member can still finalize, and
			// while an open competing group waits for its winner.
			if (task.claimedByGroupId) {
				const holder = task.claimedByGroupId;
				let held = false;
				for (const member of await this.deps.registry.groupRuns(holder)) {
					if (
						(await this.deps.registry.hasPendingCleanup(member.id)) ||
						CLAIM_HOLDING_RUN_STATES.includes(member.state)
					) {
						held = true;
						break;
					}
				}
				const group = await this.deps.registry.getGroup(holder);
				if (
					group?.kind === "competing" &&
					(group.status === "open" || group.status === "selecting")
				) {
					held = true;
				}
				if (held) continue;
			}
			// Keyed on the claim seen above: if a resume/repair has since moved it
			// to a new run, `release` no-ops.
			const rec = await this.deps.tasks.release(
				task.id,
				task.claimedByGroupId,
				task.status === "draft" ? "draft" : "ready",
				"boot",
				"claiming run is gone",
			);
			if (rec) released++;
		}
		return released;
	}

	private async dropExpiredHold(): Promise<void> {
		const [row] = await this.deps.handle.db
			.select()
			.from(engineKv)
			.where(eq(engineKv.key, "dispatch_hold"));
		if (!row) return;
		const until = (row.value as { until?: number }).until ?? 0;
		if (until > this.now()) return;
		await this.deps.handle.db
			.delete(engineKv)
			.where(eq(engineKv.key, "dispatch_hold"));
	}

	/** Run dirs with no DB row (the DB is rebuildable from these). */
	async orphanRunDirs(): Promise<string[]> {
		const runsDir = join(this.deps.projectRoot, ".mfw", "runs");
		let entries: string[];
		try {
			entries = await readdir(runsDir);
		} catch {
			return [];
		}
		const known = new Set((await this.deps.registry.list({})).map((r) => r.id));
		return entries.filter((id) => !known.has(id));
	}
}
