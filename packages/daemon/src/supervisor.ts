import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectDbHandle } from "@mfw/db/client";
import { engineKv } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import type { AgentHost } from "./agent-host.ts";
import { parseAgentEvents } from "./agents/events.ts";
import type { StepRunner } from "./finalize/step-runner.ts";
import type { Logger } from "./log.ts";
import {
	CLAIM_HOLDING_RUN_STATES,
	type RunRegistry,
	type RunRow,
} from "./run-registry.ts";
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
}

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
	log: Logger;
	projectRoot: string;
	bootId: string;
	limits?: Partial<WatchdogLimits>;
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
	/** Housekeeping (groom, gc, regression sweep, lifetime), every Nth pass. */
	maintenance?: () => Promise<void>;
	maintenanceEveryNPasses?: number;
	/** Lease renewal window for observed runs. */
	leaseMs?: number;
	/** Injectable clock for tests. */
	now?: () => number;
}

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
	}

	private get limits(): WatchdogLimits {
		return {
			idleMs: this.deps.limits?.idleMs ?? 5 * 60_000,
			wallMs: this.deps.limits?.wallMs ?? 45 * 60_000,
			maxTurns: this.deps.limits?.maxTurns ?? 0,
		};
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
			// Brain runs are headless subprocesses owned by BrainService, not tmux
			// sessions; `isAlive` is always false for them, so including them would
			// finalize in-flight decisions as `interrupted`.
			if (run.kind === "brain") continue;
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

		this.passCount++;
		const every = this.deps.maintenanceEveryNPasses ?? 0;
		const providerWorkLive = live.some((run) => run.kind !== "brain");
		if (
			this.deps.maintenance &&
			every > 0 &&
			(this.maintenanceRequested || this.passCount % every === 0) &&
			!providerWorkLive
		) {
			this.maintenanceRequested = false;
			this.startMaintenance();
		}
		return stats;
	}

	/** Housekeeping may take many minutes (notably the regression sweep). Run it
	 * beside the short observe/finalize cadence, but never overlap two sweeps. */
	private startMaintenance(): void {
		if (!this.deps.maintenance || this.maintenanceInFlight) return;
		const work = this.deps
			.maintenance()
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

		if (limits.wallMs > 0 && now - run.startedAt.getTime() > limits.wallMs) {
			await this.kill(run, "watchdog-wall", stats);
			return;
		}
		if (limits.idleMs > 0) {
			const waitingForApproval = await this.hasPendingApproval(run.id);
			const mtime = await this.outputMtime(runDir);
			// Measured on events.jsonl, not raw.log: tmux heartbeats in the pane
			// are not agent progress.
			const since = mtime > 0 ? now - mtime : now - run.startedAt.getTime();
			if (!waitingForApproval && since > limits.idleMs) {
				await this.kill(run, "watchdog-idle", stats);
				return;
			}
		}
		if (limits.maxTurns > 0) {
			const turns = await this.countTurns(run.id);
			if (turns > limits.maxTurns) {
				await this.kill(run, "watchdog-turns", stats);
			}
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

	private async hasPendingApproval(runId: string): Promise<boolean> {
		const { chunk } = await this.deps.registry.readOutput(
			runId,
			"events.jsonl",
			0,
		);
		const state = new Map<string, string>();
		for (const event of parseAgentEvents(chunk)) {
			if (event.type === "approval") {
				state.set(event.requestId, event.status);
			}
		}
		return [...state.values()].some((status) => status === "pending");
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

	private async countTurns(runId: string): Promise<number> {
		const { chunk } = await this.deps.registry.readOutput(
			runId,
			"events.jsonl",
			0,
		);
		return parseAgentEvents(chunk).filter(
			(e) => e.type === "message" && e.role === "assistant",
		).length;
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

		this.log.info({ report }, "boot reconciliation complete");
		return report;
	}

	/** Release tasks whose claiming run is gone (or terminal) to their claimable
	 * state. Draft claims do not rename the task, so they are listed explicitly;
	 * a crash before the run row insert would otherwise leave a permanent claim. */
	private async releaseOrphanLeases(): Promise<number> {
		const claimed = [
			...(await this.deps.tasks.list("in_progress")),
			...(await this.deps.tasks.list("draft")),
		].filter((task) => task.claimedByRunId !== null);
		let released = 0;
		for (const task of claimed) {
			// No claim at all (crash between the claiming rename and the state
			// write, or the state directory was wiped): nothing can be running it.
			if (task.claimedByRunId) {
				if (await this.deps.registry.hasPendingCleanup(task.claimedByRunId))
					continue;
				const run = await this.deps.registry.get(task.claimedByRunId);
				const finalizable = run && CLAIM_HOLDING_RUN_STATES.includes(run.state);
				if (finalizable) continue;
			}
			// Keyed on the claim seen above: if a resume/repair has since moved it
			// to a new run, `release` no-ops.
			const rec = await this.deps.tasks.release(
				task.id,
				task.claimedByRunId,
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
