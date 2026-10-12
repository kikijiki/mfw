import { overlappingPatterns } from "@mfw/board";
import type { ProjectDbHandle } from "@mfw/db/client";
import { appendEvent, type EventBus, type StoredEvent } from "@mfw/db/eventlog";
import {
	engineKv,
	type RunKind,
	type RunState,
	resourceSlots,
	resources,
} from "@mfw/db/schema";
import { and, eq, type SQL, sql } from "drizzle-orm";
import type {
	LaunchOutcome,
	PendingSpawn,
	TaskHolds,
} from "./brain-runtime/executor.ts";
import type { HostAdmissionSnapshot } from "./host-resources/index.ts";
import type { Logger } from "./log.ts";
import { refusalFix } from "./refusal-fix.ts";
import type { RunRegistry, RunRow } from "./run-registry.ts";
import type { TaskRow, TaskService } from "./task-service.ts";

/**
 * The only dispatcher.
 *
 * The loop is an awaited `while` (as in Supervisor), so a slow tick cannot
 * overlap itself. The UI's "dispatch now" calls `wake()`, which only shortens
 * the sleep. A failed start is logged with context, releases whatever it held
 * and is counted in `stats.errors`.
 *
 * The project brain decides what runs: the scheduler starts runs only from
 * accepted `spawn` / `spawn_attempts` actions, in the order the brain made
 * them. Promotion, the gates (pause, hold, red main, global stop), the
 * concurrency cap and every resource boundary are still its job and are
 * re-enforced on every launch. A ready task with no spawn action never starts,
 * and a project with no configured brain route dispatches nothing (status
 * `blocked: no_brain_route`).
 *
 * Resource slots are a real semaphore (`resource_slots`, PK `(resourceId,
 * slot)`).
 *
 * ORDERING: `resource_slots.run_id` is a FK onto `runs.id` (FKs are enforced)
 * and `RunEngine.startTask` mints the run id itself, so slot rows cannot exist
 * before the run row. Acquisition is split to stay all-or-nothing:
 *
 *   plan   - one read of resources+slots, then an in-memory reservation that is
 *            rolled back as soon as any required resource is full, so a task
 *            that cannot get everything reserves nothing;
 *   commit - `acquireSlots(runId, plan)`: ONE transaction, every insert
 *            `onConflictDoNothing`; a single lost row throws and rolls back.
 *
 * The scheduler is the only writer of slot acquisitions (releases only free
 * capacity), so the window between plan and commit cannot over-admit.
 */

export interface SchedulerConfig {
	/** Loop period; `start()` may override. */
	intervalMs?: number;
	/** Max non-terminal agent runs in flight for this project. */
	maxConcurrent: number;
	/** Call `maintenance` every Nth tick (0/absent = never). */
	maintenanceEveryNTicks?: number;
	/**
	 * MFW-28: let the task that broke main (`main_red`'s `causeTaskId`) start
	 * even while the breaker is tripped. The sweep is the only thing that clears
	 * `main_red`, and it can only pass again if the reopened task may run and
	 * fix it.
	 *
	 * Default OFF: unlike every other gate, this launches an agent against a
	 * branch already known to be broken and lets it spend attempts unattended
	 * (see `tick()`'s self-repair block). It is the operator's call; see
	 * `setSelfRepairMainRed`.
	 */
	selfRepairMainRed?: boolean;
}

/** The slice of RunEngine the scheduler is allowed to touch. */
export interface DispatchEngine {
	readonly admissionIntegrated?: boolean;
	syncEligibleTasks?(taskIds: readonly string[]): Promise<void>;
	captureAdmissionSnapshot?(): HostAdmissionSnapshot | undefined;
}

/**
 * Where the runs come from: the brain's accepted spawn actions (the action
 * executor). The scheduler asks what is pending, applies admission, and
 * launches through `launch`, which is idempotent by the pre-minted run ids.
 */
export interface SpawnSource {
	pending(): Promise<PendingSpawn[]>;
	launch(
		actionId: string,
		ctx: { hostSnapshot?: HostAdmissionSnapshot },
	): Promise<LaunchOutcome>;
	/** Tasks the brain paused or parked for a person: their spawns wait. */
	holds(): Promise<TaskHolds>;
}

export interface SchedulerDeps {
	handle: ProjectDbHandle;
	bus: EventBus;
	tasks: TaskService;
	engine: DispatchEngine;
	registry: RunRegistry;
	log: Logger;
	config: SchedulerConfig;
	/**
	 * Periodic housekeeping (groomer, regression sweep, run-dir prune, worktree
	 * GC). Runs BEFORE the gates on purpose: the regression sweep is what
	 * clears `main_red`, so gating it behind that would wedge the breaker shut.
	 */
	maintenance?: () => Promise<void>;
	/**
	 * The machine-wide master stop, read on every tick and status call.
	 * Injected rather than read from `engine_kv` because one value governs
	 * every project. Absent = no global stop.
	 */
	globalPaused?: () => { reason: string } | null;
	/** Injectable clock for tests. */
	now?: () => number;
	/** The brain's spawn actions. Absent = nothing can start. */
	spawns?: SpawnSource;
	/**
	 * Whether the project has a brain route. Without one there is no decider
	 * and no headless fallback: dispatch is blocked and says so.
	 */
	brainRoute?: () => boolean;
	/**
	 * The machine-wide provider hold the task's route is under, or null
	 * (`RunEngine.routeTask`). Checked per candidate, so a Claude hold leaves
	 * a Codex-routed task free to start. Throws for an unroutable task (an
	 * unknown provider pin): that task is held with the reason. Absent = no
	 * per-provider holds.
	 */
	routeHold?: (
		task: TaskRow,
	) => Promise<{ key: string; until: number; reason: string } | null>;
	/**
	 * The exhausted resource budget the task depends on, or null
	 * (`BudgetService.holdFor`). The task is held with `task.held_for_resource`;
	 * tasks that do not use the resource still start.
	 */
	budgetHold?: (
		task: TaskRow,
	) => Promise<{ key: string; until: number; reason: string } | null>;
	/** For `status()`: every provider hold in force on this machine. */
	providerHolds?: {
		active(): Promise<Record<string, { until: number; reason: string }>>;
	};
}

/** The one sentence a project without a brain route reports. */
export const NO_BRAIN_ROUTE_REASON =
	"blocked: no brain route: configure brain.routes in the project's config so a brain can decide what runs";

/** Why a tick dispatched nothing. */
export type SkipReason =
	| "global"
	| "paused"
	| "hold"
	| "main_red"
	| "board"
	| "no_brain";

/**
 * The one-word answer to "is this project dispatching?".
 *
 * `stopped` is something a person did (loop not running, or persisted pause
 * flag set); the others the engine did to itself and will undo on its own.
 */
export type DispatchState =
	| "dispatching"
	| "stopped"
	| "stopped_global"
	| "held"
	| "main_red"
	| "board_suspended";

export interface TickStats {
	/** Tasks the DoR gate promoted backlog → ready this tick. */
	promoted: number;
	/** Size of the ready set after promotion. */
	ready: number;
	/** Non-terminal runs counted against `maxConcurrent`. */
	inFlight: number;
	/** Task ids whose runs were launched from a spawn action this tick (one per run). */
	started: string[];
	/** Task ids skipped because a required resource had no free slot. */
	heldForResource: string[];
	/** Task ids skipped because their `owns` overlaps a running or picked task. */
	heldForOverlap: string[];
	/** Task ids skipped because their route's provider is held (or unroutable). */
	heldForProvider: string[];
	/** Gate that returned early, if any. */
	skipped: SkipReason | null;
	/** Human-readable detail for `skipped`. */
	reason: string | null;
	/** True when the concurrency cap left no room. */
	capped: boolean;
	/** Maintenance ran this tick. */
	maintenance: boolean;
	/** Failures surfaced (never swallowed) this tick. */
	errors: number;
	/** Spawn actions waiting on the brain's own holds (pause, awaiting a person). */
	heldByBrain: string[];
	/** Accepted spawn actions the tick looked at. */
	pendingSpawns: number;
}

/**
 * What the dispatch control renders. There are two independent switches
 * (project and global); `enabled` alone is only the persisted pause flag and
 * says nothing about whether a loop is running.
 */
export interface SchedulerStatus {
	/**
	 * The effective answer: `projectPlaying && globalPlaying`. The only field a
	 * screen should use to say whether this project can start work.
	 */
	playing: boolean;
	/**
	 * This project's own switch: its loop exists AND its persisted pause is
	 * clear. Stays true while the master stop is off.
	 */
	projectPlaying: boolean;
	/** The machine-wide master switch; identical across every project. */
	globalPlaying: boolean;
	/** Whether the dispatch loop exists at all (in memory). */
	running: boolean;
	/** Whether the persisted `engine_kv["pause"]` flag is clear. Survives a
	 *  restart; says nothing about whether a loop is running. */
	enabled: boolean;
	/** See `DispatchState`. */
	state: DispatchState;
	/** One sentence for `state`. Null only while dispatching. */
	reason: string | null;
	/** True when `state` is something the engine did to itself and will undo on
	 *  its own (hold, red main, suspended board). Pressing play does not clear
	 *  any of them. */
	selfStopped: boolean;
	/**
	 * What blocks dispatch in a way no switch fixes: the project has no brain
	 * route (`brain.routes`), so nothing decides what runs.
	 */
	blocked: "no_brain_route" | null;
	lastTickAt: number;
	lastTickMs: number;
	hold: { until: number; reason: string } | null;
	/** Machine-wide per-provider rate-limit holds in force (key → hold). They
	 *  hold only tasks routed to that provider, so they never stop the project. */
	providerHolds?: { key: string; until: number; reason: string }[];
	mainRed: boolean;
	recovery?: {
		incidentId: string | null;
		causeTaskId: string | null;
		repairRunId: string | null;
		phase: string;
	} | null;
	boardSuspended: boolean;
	inFlight: number;
	errors: number;
}

/** Every reason dispatch can be stopped, read in one pass. `tick()` and
 *  `status()` share it so the screen and the loop cannot disagree. */
interface Gates {
	globalPaused: { reason: string } | null;
	boardSuspended: boolean;
	paused: { reason: string } | null;
	hold: { until: number; reason: string } | null;
	mainRed: {
		reason: string;
		causeTaskId: string | null;
		/** MFW-28: `selfRepairMainRed` is on AND the sweep named a cause (the
		 *  one exception `blockingGate` grants to the breaker, see `tick()`).
		 *  MFW-37: false once the sweep has escalated; see `escalated`. */
		selfRepairEligible: boolean;
		/** MFW-37: the sweep retried the same cause past its escalation
		 *  threshold with no successful repair. Forces `selfRepairEligible`
		 *  off whatever the setting says; a human is needed. */
		escalated: boolean;
		incidentId: string | null;
		repairRunId: string | null;
		phase: string;
	} | null;
}

interface SlotRef {
	resourceId: string;
	slot: number;
}

/** Free-slot bookkeeping for one tick: DB state + this wave's reservations. */
type SlotState = Map<string, { max: number; used: Set<number> }>;

/** Runs that still occupy a concurrency slot. */
const LIVE_STATES: RunState[] = [
	"starting",
	"running",
	"ended",
	"finalizing",
	"merging",
];

/** Hosted agents count against the cap; `brain` runs are sub-2-minute headless
 *  subprocesses and would otherwise starve dispatch. */
const COUNTED_KINDS: RunKind[] = ["task", "repair", "import", "plan", "action"];

/** A lost race on a slot insert; rolls the acquisition transaction back. */
export class SlotConflictError extends Error {
	constructor(readonly slot: SlotRef) {
		super(`resource ${slot.resourceId} slot ${slot.slot} was taken`);
		this.name = "SlotConflictError";
	}
}

export class Scheduler {
	private readonly log: Logger;
	private readonly now: () => number;
	private stopping = false;
	private wakeup: (() => void) | null = null;
	private loopDone: Promise<void> | null = null;
	private ticks = 0;
	/** Last `waitingFor` announced per task; re-announced only on change. */
	private readonly announcedHolds = new Map<string, string>();

	/** Resource ids already warned about as unregistered (warn once). */
	private readonly warnedUnknownResources = new Set<string>();
	/** Health surface. */
	readonly stats = {
		lastTickAt: 0,
		lastTickMs: 0,
		tickErrors: 0,
		dispatched: 0,
	};

	constructor(private readonly deps: SchedulerDeps) {
		this.log = deps.log.child({ svc: "scheduler" });
		this.now = deps.now ?? (() => Date.now());
	}

	// ------------------------------------------------------------------
	// the loop
	// ------------------------------------------------------------------

	/** Start the awaited loop. Idempotent. */
	start(intervalMs = this.deps.config.intervalMs ?? 5_000): void {
		if (this.loopDone) return;
		this.stopping = false;
		this.loopDone = this.runLoop(intervalMs);
	}

	private async runLoop(intervalMs: number): Promise<void> {
		while (!this.stopping) {
			const t0 = this.now();
			try {
				await this.tick();
			} catch (e) {
				this.stats.tickErrors++;
				this.log.error({ err: e }, "scheduler tick failed");
			}
			this.stats.lastTickAt = this.now();
			this.stats.lastTickMs = this.now() - t0;
			if (this.stopping) break;
			await this.sleep(Math.max(50, intervalMs - this.stats.lastTickMs));
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

	/** Shorten the current sleep. Never dispatches or starts a second pass. */
	wake(): void {
		this.wakeup?.();
		this.wakeup = null;
	}

	async stop(): Promise<void> {
		this.stopping = true;
		this.wake();
		await this.loopDone?.catch(() => {
			// the loop logs its own failures; stop() must always settle
		});
		this.loopDone = null;
	}

	// ------------------------------------------------------------------
	// one pass
	// ------------------------------------------------------------------

	async tick(): Promise<TickStats> {
		const stats: TickStats = {
			promoted: 0,
			ready: 0,
			inFlight: 0,
			started: [],
			heldForResource: [],
			heldForOverlap: [],
			heldForProvider: [],
			skipped: null,
			reason: null,
			capped: false,
			maintenance: false,
			errors: 0,
			heldByBrain: [],
			pendingSpawns: 0,
		};
		this.ticks++;

		const every = this.deps.config.maintenanceEveryNTicks ?? 0;
		if (every > 0 && this.deps.maintenance && this.ticks % every === 0) {
			stats.maintenance = true;
			try {
				await this.deps.maintenance();
			} catch (e) {
				stats.errors++;
				this.stats.tickErrors++;
				this.log.error({ err: e }, "scheduler maintenance failed");
			}
		}

		// (1) gates: paused / held / red main.
		const gates = await this.gates();
		const gate = blockingGate(gates);
		/**
		 * MFW-28: the one exemption from the red-main breaker is the task named as
		 * the cause, and only that task. It is a single id read off the sweep
		 * result, so nothing else can become eligible by being reopened, retried
		 * or merely ready. If the sweep found several broken tasks, only
		 * `broken[0]` was recorded and the rest wait behind the breaker.
		 *
		 * Verification is not weakened: `finalize`'s T12 `verify` step runs the
		 * same DoD checks the sweep just failed, on a branch that is knowingly
		 * red (the fix has to land on top of whatever broke it).
		 *
		 * Runaway repair is bounded by the brain's loop guard (I10): the fix task
		 * is refused further spawns after four consecutive failed groups, and
		 * the sweep's own cap turns self-repair off.
		 */
		const repairTaskId =
			gate?.skipped === "main_red" && gates.mainRed?.selfRepairEligible
				? gates.mainRed.causeTaskId
				: null;
		if (gate && !repairTaskId) {
			stats.skipped = gate.skipped;
			stats.reason = gate.reason;
			return stats;
		}
		// No brain route, no decider: there is no headless fallback.
		if (!this.hasBrainRoute()) {
			stats.skipped = "no_brain";
			stats.reason = NO_BRAIN_ROUTE_REASON;
			return stats;
		}

		// (2) DoR gate. Re-run every tick so API-created tasks get promoted.
		try {
			stats.promoted = (await this.deps.tasks.promoteReady()).length;
		} catch (e) {
			stats.errors++;
			this.stats.tickErrors++;
			this.log.error({ err: e }, "promoteReady failed");
		}

		// (3) ready set (already excludes tasks with unmet deps). While repairing
		// it is narrowed to the one exempt task, which may not be ready yet
		// (still `in_progress`, or `blocked` past its stall cap), in which case
		// nothing is dispatched.
		const allReady = await this.deps.tasks.readySet();
		const ready = await this.withoutHeldRoutes(
			repairTaskId ? allReady.filter((t) => t.id === repairTaskId) : allReady,
			stats,
		);
		stats.ready = ready.length;
		await this.deps.engine.syncEligibleTasks?.(ready.map((task) => task.id));

		// (4) concurrency cap.
		const liveRuns = await this.inFlightRuns();
		stats.inFlight = liveRuns.length;
		const room = this.deps.config.maxConcurrent - stats.inFlight;
		if (room <= 0) {
			stats.capped = true;
			return stats;
		}

		// (5) the brain's spawns, in the order it made them. The maximum is a
		// ceiling, not a target; admission below rechecks every lock.
		let pending: PendingSpawn[] = [];
		try {
			pending = (await this.deps.spawns?.pending()) ?? [];
		} catch (e) {
			stats.errors++;
			this.stats.tickErrors++;
			this.log.error({ err: e }, "reading pending spawns failed");
		}
		if (repairTaskId)
			pending = pending.filter((j) => j.taskId === repairTaskId);
		stats.pendingSpawns = pending.length;
		if (pending.length === 0) return stats;
		await this.launchPending(pending, liveRuns, room, stats);
		return stats;
	}

	/**
	 * Drop the tasks whose route is under a provider hold, announcing each
	 * once. Per candidate, not a gate: a Claude hold never stops a task routed
	 * to Codex (or to a fallback that is free).
	 */
	private async withoutHeldRoutes<T extends TaskRow>(
		tasks: T[],
		stats: TickStats,
	): Promise<T[]> {
		const routeHold = this.deps.routeHold;
		const budgetHold = this.deps.budgetHold;
		if (!routeHold && !budgetHold) return tasks;
		const out: T[] = [];
		for (const task of tasks) {
			const spent = budgetHold ? await budgetHold(task) : null;
			if (spent) {
				stats.heldForResource.push(task.id);
				await this.announceHold(task.id, [spent.key], {
					code: "budget_exhausted",
					reason: `${spent.key}: ${spent.reason}, resets ${new Date(spent.until).toISOString()}`,
				});
				continue;
			}
			if (!routeHold) {
				out.push(task);
				continue;
			}
			let held: { key: string; until: number; reason: string } | null;
			let code = "provider_held";
			try {
				held = await routeHold(task);
			} catch (e) {
				code = "route_invalid";
				held = {
					key: task.id,
					until: Number.POSITIVE_INFINITY,
					reason: e instanceof Error ? e.message : String(e),
				};
			}
			if (!held) {
				out.push(task);
				continue;
			}
			stats.heldForProvider.push(task.id);
			await this.announceHold(task.id, [held.key], {
				code,
				reason:
					code === "route_invalid"
						? held.reason
						: `${held.key} is held until ${new Date(held.until).toISOString()}: ${held.reason}`,
			});
		}
		return out;
	}

	private async inFlightRuns(): Promise<RunRow[]> {
		return this.deps.registry.list({
			states: LIVE_STATES,
			kinds: COUNTED_KINDS,
		});
	}

	/** Read every gate. `tick()` and `status()` both apply the same precedence
	 *  (`blockingGate`). */
	private async gates(): Promise<Gates> {
		const [pause, hold, red] = await Promise.all([
			this.kv<{ paused?: boolean; reason?: string }>("pause"),
			// Persisted so a rate-limit hold survives a reboot.
			this.kv<{ until?: number; reason?: string }>("dispatch_hold"),
			this.kv<{
				red?: boolean;
				causeTaskId?: string;
				escalated?: boolean;
				incidentId?: string;
				repairRunId?: string;
			}>("main_red"),
		]);
		const until = hold?.until ?? 0;
		const repair = red?.repairRunId
			? await this.deps.registry.get(red.repairRunId)
			: null;
		const phase = red?.escalated
			? "needs_attention"
			: (repair?.state ?? (red?.repairRunId ? "pending" : "detected"));
		return {
			// Machine-wide, so not in this project's kv.
			globalPaused: this.deps.globalPaused?.() ?? null,
			// In memory, not `engine_kv`: not an operator policy, it says the board
			// on disk is not one the daemon believes.
			boardSuspended: this.deps.tasks.isBoardSuspended,
			paused:
				pause?.paused === true ? { reason: pause.reason ?? "paused" } : null,
			hold:
				until > this.now()
					? {
							until,
							reason:
								hold?.reason ?? `held until ${new Date(until).toISOString()}`,
						}
					: null,
			// Red-main breaker: nothing new starts while the integration branch is
			// broken; verified work waits in the merge queue.
			mainRed:
				red?.red === true
					? {
							reason: red.repairRunId
								? `main is red: recovery ${red.repairRunId} is ${phase.replaceAll("_", " ")}`
								: red.causeTaskId
									? red.escalated
										? `main is red (${red.causeTaskId}): repair has not converged, needs a human`
										: `main is red (${red.causeTaskId})`
									: "main is red",
							causeTaskId: red.causeTaskId ?? null,
							selfRepairEligible:
								this.deps.config.selfRepairMainRed === true &&
								!!red.causeTaskId &&
								!red.repairRunId &&
								red.escalated !== true,
							escalated: red.escalated === true,
							incidentId: red.incidentId ?? null,
							repairRunId: red.repairRunId ?? null,
							phase,
						}
					: null,
		};
	}

	private async inFlight(): Promise<number> {
		return (await this.inFlightRuns()).length;
	}

	/**
	 * Launch the brain's pending spawns in the order it made them, until the
	 * cap is used. A spawn is skipped (and stays accepted for the next tick)
	 * when its task is held by the brain, its `owns` overlaps running or
	 * earlier work, or a project resource has no free slot. A spawn_attempts
	 * needs a slot per variant and starts all or none.
	 */
	private async launchPending(
		pending: PendingSpawn[],
		liveRuns: RunRow[],
		room: number,
		stats: TickStats,
	): Promise<void> {
		const spawns = this.deps.spawns;
		if (!spawns) return;
		const holds = await spawns.holds().catch(() => ({}) as TaskHolds);
		const claimed = await this.runningOwnership(liveRuns);
		const integrated = this.deps.engine.admissionIntegrated === true;
		const hostSnapshot = integrated
			? this.deps.engine.captureAdmissionSnapshot?.()
			: undefined;
		if (integrated && !hostSnapshot) {
			throw new Error(
				"integrated host admission did not provide a wave snapshot",
			);
		}
		let slots: SlotState | null = null;
		let used = 0;
		for (const job of pending) {
			if (used >= room) {
				stats.capped = true;
				break;
			}
			const need = job.runIds.length;
			if (used + need > room) {
				stats.capped = true;
				break; // the brain's order is kept: a later job does not jump it
			}
			const task = await this.deps.tasks.get(job.taskId);
			if (!task) continue; // the executor fails the action when it launches
			if (holds[task.id]) {
				stats.heldByBrain.push(task.id);
				continue;
			}
			// A spawn for a spent resource budget waits; the others still start.
			const spent = this.deps.budgetHold
				? await this.deps.budgetHold(task)
				: null;
			if (spent) {
				stats.heldForResource.push(task.id);
				await this.announceHold(task.id, [spent.key], {
					code: "budget_exhausted",
					reason: `${spent.key}: ${spent.reason}, resets ${new Date(spent.until).toISOString()}`,
				});
				continue;
			}
			if (await this.holdForOverlap(task, claimed, stats)) continue;

			// Project resources: one reservation per run, all or nothing.
			const plans: SlotRef[][] = [];
			if (!integrated) {
				if ((task.requiresResources ?? []).length > 0) {
					slots ??= await this.slotState();
					let blocked: string[] | null = null;
					for (let i = 0; i < need && !blocked; i++) {
						const r = this.reserve(task, slots);
						if ("blockedBy" in r) blocked = r.blockedBy;
						else plans.push(r.plan);
					}
					if (blocked) {
						for (const plan of plans) {
							for (const p of plan)
								slots.get(p.resourceId)?.used.delete(p.slot);
						}
						stats.heldForResource.push(task.id);
						await this.announceHold(task.id, blocked);
						continue;
					}
				}
			}
			this.announcedHolds.delete(task.id);

			let outcome: LaunchOutcome | null = null;
			try {
				outcome = await spawns.launch(job.actionId, {
					...(hostSnapshot ? { hostSnapshot } : {}),
				});
			} catch (e) {
				stats.errors++;
				this.stats.tickErrors++;
				this.log.error(
					{ err: e, taskId: task.id, actionId: job.actionId },
					"dispatch failed",
				);
				continue;
			}
			if (outcome.outcome === "held") {
				if (outcome.kind === "overlap") stats.heldForOverlap.push(task.id);
				else if (outcome.kind === "provider")
					stats.heldForProvider.push(task.id);
				else stats.heldForResource.push(task.id);
				continue;
			}
			if (outcome.outcome === "failed") {
				stats.errors++;
				this.stats.tickErrors++;
				this.log.warn(
					{ taskId: task.id, actionId: job.actionId, error: outcome.error },
					"spawn action failed",
				);
				continue;
			}
			if (outcome.outcome !== "applied") continue;
			for (const [i, runId] of outcome.runIds.entries()) {
				const plan = plans[i];
				if (!integrated && plan && plan.length > 0) {
					await this.acquireSlots(runId, plan).catch(async (e: unknown) => {
						stats.errors++;
						this.log.error({ err: e, runId }, "slot acquisition failed");
						await this.releaseSlots(runId).catch(() => {});
					});
				}
				stats.started.push(task.id);
				this.stats.dispatched++;
				used++;
			}
			claimed.push({ id: task.id, owns: task.owns });
		}
	}

	/** Declared ownership of the tasks behind live counted runs. */
	private async runningOwnership(
		liveRuns: RunRow[],
	): Promise<{ id: string; owns: string[] }[]> {
		const out: { id: string; owns: string[] }[] = [];
		for (const run of liveRuns) {
			if (!run.taskId) continue;
			const task = await this.deps.tasks.get(run.taskId);
			if (task && task.owns.length > 0) {
				out.push({ id: task.id, owns: task.owns });
			}
		}
		return out;
	}

	/**
	 * Hold `task` when its `owns` overlaps any claim already made this tick.
	 * Records and announces the hold; returns whether it was held.
	 */
	private async holdForOverlap(
		task: TaskRow,
		claimed: { id: string; owns: string[] }[],
		stats: TickStats,
	): Promise<boolean> {
		if (task.owns.length === 0) return false;
		const others: string[] = [];
		const pairs: string[] = [];
		for (const other of claimed) {
			if (other.id === task.id) continue;
			const overlap = overlappingPatterns(task.owns, other.owns);
			if (overlap.length === 0) continue;
			others.push(other.id);
			for (const [mine, theirs] of overlap) {
				pairs.push(`${mine} (${task.id}) vs ${theirs} (${other.id})`);
			}
		}
		if (others.length === 0) return false;
		stats.heldForOverlap.push(task.id);
		await this.announceHold(task.id, others, {
			code: "owns-overlap",
			reason: `owns overlaps: ${pairs.join(", ")}`,
		});
		return true;
	}

	// ------------------------------------------------------------------
	// resource semaphore
	// ------------------------------------------------------------------

	private async slotState(): Promise<SlotState> {
		const defs = await this.deps.handle.db.select().from(resources);
		const held = await this.deps.handle.db.select().from(resourceSlots);
		const state: SlotState = new Map();
		for (const r of defs) {
			state.set(r.id, {
				max: Math.max(1, r.maxConcurrent),
				used: new Set<number>(),
			});
		}
		for (const s of held) state.get(s.resourceId)?.used.add(s.slot);
		return state;
	}

	/**
	 * All-or-nothing reservation against `state`. Every required resource must
	 * yield a free slot; if one does not, every slot already taken for this task
	 * is handed back. Unknown resource ids impose no constraint.
	 */
	private reserve(
		task: TaskRow,
		state: SlotState,
	): { plan: SlotRef[] } | { blockedBy: string[] } {
		const required = [
			...new Set(
				(task.requiresResources ?? [])
					.filter(
						(requirement) =>
							typeof requirement === "string" ||
							requirement.scope === "project",
					)
					.map((requirement) =>
						typeof requirement === "string" ? requirement : requirement.id,
					),
			),
		];
		if (required.length === 0) return { plan: [] };

		const plan: SlotRef[] = [];
		const blockedBy: string[] = [];
		for (const resourceId of required) {
			const entry = state.get(resourceId);
			if (!entry) {
				// An unregistered resource imposes no constraint. Failing closed would
				// wedge a board on a typo, and forward-declaring a resource before
				// registering it is legitimate, so warn once instead.
				if (!this.warnedUnknownResources.has(resourceId)) {
					this.warnedUnknownResources.add(resourceId);
					this.log.warn(
						{ taskId: task.id, resourceId },
						"task requires an unregistered resource, dispatching with NO " +
							"constraint from it; register it (Settings → Resources) if it " +
							"is meant to limit concurrency",
					);
				}
				continue;
			}
			let free: number | null = null;
			for (let slot = 0; slot < entry.max; slot++) {
				if (!entry.used.has(slot)) {
					free = slot;
					break;
				}
			}
			if (free === null) {
				blockedBy.push(resourceId);
				continue;
			}
			entry.used.add(free);
			plan.push({ resourceId, slot: free });
		}
		if (blockedBy.length > 0) {
			for (const p of plan) state.get(p.resourceId)?.used.delete(p.slot);
			return { blockedBy };
		}
		return { plan };
	}

	/** Persist a reservation in ONE transaction; a slot lost to a concurrent
	 *  writer throws and rolls everything back. */
	async acquireSlots(runId: string, plan: SlotRef[]): Promise<void> {
		if (plan.length === 0) return;
		const events = await this.deps.handle.withTx(async (tx) => {
			const out: StoredEvent[] = [];
			for (const p of plan) {
				const won = await tx
					.insert(resourceSlots)
					.values({
						resourceId: p.resourceId,
						slot: p.slot,
						runId,
						lockedAt: new Date(this.now()),
					})
					.onConflictDoNothing()
					.returning({ slot: resourceSlots.slot });
				if (won.length === 0) throw new SlotConflictError(p);
				out.push(
					await appendEvent(tx, {
						type: "resource.locked",
						runId,
						payload: { resourceId: p.resourceId, slot: p.slot },
					}),
				);
			}
			return out;
		});
		this.deps.bus.publish(events);
	}

	/**
	 * Free every slot a run holds. Public because the StepRunner/merge path and
	 * the watchdog release through it. Idempotent.
	 */
	async releaseSlots(
		runId: string,
		opts: { forced?: boolean } = {},
	): Promise<number> {
		return this.freeSlots(eq(resourceSlots.runId, runId), opts.forced ?? false);
	}

	/**
	 * Operator force-unlock: free a resource's slots (one or all) whatever run
	 * holds them. Emits `resource.released` per slot with `forced: true`, the
	 * only record that a human freed the capacity.
	 */
	async forceReleaseSlots(resourceId: string, slot?: number): Promise<number> {
		const where =
			slot === undefined
				? eq(resourceSlots.resourceId, resourceId)
				: and(
						eq(resourceSlots.resourceId, resourceId),
						eq(resourceSlots.slot, slot),
					);
		return this.freeSlots(where as SQL, true);
	}

	/** The one delete-and-announce path: every release, forced or not. */
	private async freeSlots(where: SQL, forced: boolean): Promise<number> {
		const events = await this.deps.handle.withTx(async (tx) => {
			const freed = await tx.delete(resourceSlots).where(where).returning();
			const out: StoredEvent[] = [];
			for (const row of freed) {
				await tx
					.update(resources)
					.set({ lastUnlockedAt: new Date(this.now()) })
					.where(eq(resources.id, row.resourceId));
				out.push(
					await appendEvent(tx, {
						type: "resource.released",
						payload: {
							resourceId: row.resourceId,
							slot: row.slot,
							runId: row.runId,
							forced,
						},
					}),
				);
			}
			return out;
		});
		this.deps.bus.publish(events);
		return events.length;
	}

	/** Slot refs currently held by a run (health/debug surface). */
	async heldSlots(runId: string): Promise<SlotRef[]> {
		const rows = await this.deps.handle.db
			.select()
			.from(resourceSlots)
			.where(eq(resourceSlots.runId, runId));
		return rows.map((r) => ({ resourceId: r.resourceId, slot: r.slot }));
	}

	private async announceHold(
		taskId: string,
		waitingFor: string[],
		why?: { code: string; reason: string },
	): Promise<void> {
		const key = `${why?.code ?? "resource"}:${waitingFor.join(",")}`;
		if (this.announcedHolds.get(taskId) === key) return;
		this.announcedHolds.set(taskId, key);
		const event = await this.deps.handle.withTx((tx) =>
			appendEvent(tx, {
				type: "task.held_for_resource",
				taskId,
				payload: {
					waitingFor,
					...(why ?? {}),
					fix: refusalFix(why?.code ?? "resource", waitingFor),
				},
			}),
		);
		this.deps.bus.publish([event]);
	}

	// ------------------------------------------------------------------
	// persisted control surface
	// ------------------------------------------------------------------

	private async kv<T>(key: string): Promise<T | null> {
		const [row] = await this.deps.handle.db
			.select()
			.from(engineKv)
			.where(eq(engineKv.key, key));
		return row ? (row.value as T) : null;
	}

	/**
	 * Pause/resume dispatch. Persisted across restarts. Only half a switch: it
	 * does not start or stop the loop. `setDispatching` (dispatch.ts) moves both
	 * switches together and is what the UI calls.
	 */
	async setEnabled(on: boolean, reason = "manual"): Promise<void> {
		const value = on ? { paused: false } : { paused: true, reason };
		const event = await this.deps.handle.withTx(async (tx) => {
			await tx
				.insert(engineKv)
				.values({ key: "pause", value, updatedAt: new Date(this.now()) })
				.onConflictDoUpdate({
					target: engineKv.key,
					set: { value, updatedAt: new Date(this.now()) },
				});
			return appendEvent(
				tx,
				on
					? { type: "scheduler.resumed", payload: {} }
					: { type: "scheduler.paused", payload: { reason } },
				this.now(),
			);
		});
		this.deps.bus.publish([event]);
	}

	private hasBrainRoute(): boolean {
		return this.deps.brainRoute?.() === true;
	}

	/**
	 * Why a brain spawn cannot be accepted right now (master stop, suspended
	 * board, the project's own stop, red main), or null. A rate-limit hold is
	 * not here: spawns wait out a hold.
	 */
	async blockedReason(): Promise<{ reason: string } | null> {
		const g = await this.gates();
		const gate = blockingGate({ ...g, hold: null });
		return gate ? { reason: gate.reason } : null;
	}

	/** Whether the dispatch loop exists (not the persisted pause flag). */
	get running(): boolean {
		return this.loopDone !== null;
	}

	get maxConcurrent(): number {
		return this.deps.config.maxConcurrent;
	}

	/** MFW-28: the operator's opt-in (`SettingsService`/`config.json`) to let the
	 *  cause task through the red-main breaker. */
	get selfRepairMainRed(): boolean {
		return this.deps.config.selfRepairMainRed === true;
	}

	/** Live-tune the self-repair exemption; no restart needed. */
	setSelfRepairMainRed(on: boolean): void {
		this.deps.config.selfRepairMainRed = on;
	}

	/** Live-tune the concurrency cap from settings. Takes effect on the next
	 *  tick; runs already in flight are never killed to fit a lower cap. */
	setMaxConcurrent(n: number): void {
		this.deps.config.maxConcurrent = Math.max(1, Math.floor(n));
	}

	async isPaused(): Promise<boolean> {
		return (await this.kv<{ paused?: boolean }>("pause"))?.paused === true;
	}

	/**
	 * Hold dispatch until `untilMs` (rate limits, manual quiet periods). The
	 * upsert keeps the furthest `until`, so a shorter hold never cuts a quota
	 * hold short.
	 */
	async hold(untilMs: number, reason: string): Promise<void> {
		const value = { until: untilMs, reason };
		const event = await this.deps.handle.withTx(async (tx) => {
			await tx
				.insert(engineKv)
				.values({
					key: "dispatch_hold",
					value,
					updatedAt: new Date(this.now()),
				})
				.onConflictDoUpdate({
					target: engineKv.key,
					set: {
						value: sql`CASE
							WHEN json_extract(excluded.value,'$.until') > json_extract(${engineKv.value},'$.until')
							THEN excluded.value ELSE ${engineKv.value} END`,
						updatedAt: new Date(this.now()),
					},
				});
			return appendEvent(
				tx,
				{ type: "scheduler.paused", payload: { reason, until: untilMs } },
				this.now(),
			);
		});
		this.deps.bus.publish([event]);
	}

	/** Is this project dispatching, and if not, why not? */
	async status(): Promise<SchedulerStatus> {
		const gates = await this.gates();
		const running = this.running;
		// `playing` is the AND of both switches. An operator stop takes precedence
		// over a gate the engine set on itself, so pressing play surfaces the gate
		// underneath.
		const projectPlaying = running && gates.paused === null;
		const globalPlaying = gates.globalPaused === null;
		const noBrain = !this.hasBrainRoute();
		const playing = projectPlaying && globalPlaying && !noBrain;
		// Most specific cause first: an individually stopped project stays stopped
		// when the master goes back on.
		const state: DispatchState = !projectPlaying
			? "stopped"
			: !globalPlaying
				? "stopped_global"
				: noBrain
					? "held"
					: playingState(gates);
		return {
			playing,
			projectPlaying,
			globalPlaying,
			running,
			enabled: gates.paused === null,
			state,
			// No brain route is the cause no switch fixes, so it is the one named.
			reason: noBrain
				? NO_BRAIN_ROUTE_REASON
				: stateReason(state, gates, running),
			blocked: noBrain ? "no_brain_route" : null,
			selfStopped:
				state !== "dispatching" &&
				state !== "stopped" &&
				state !== "stopped_global",
			lastTickAt: this.stats.lastTickAt,
			lastTickMs: this.stats.lastTickMs,
			hold: gates.hold,
			providerHolds: this.deps.providerHolds
				? Object.entries(
						await this.deps.providerHolds.active().catch(() => ({})),
					).map(([key, h]) => ({ key, until: h.until, reason: h.reason }))
				: [],
			mainRed: gates.mainRed !== null,
			recovery: gates.mainRed
				? {
						incidentId: gates.mainRed.incidentId,
						causeTaskId: gates.mainRed.causeTaskId,
						repairRunId: gates.mainRed.repairRunId,
						phase: gates.mainRed.phase,
					}
				: null,
			boardSuspended: gates.boardSuspended,
			inFlight: await this.inFlight(),
			errors: this.stats.tickErrors,
		};
	}
}

/** The gate precedence, in ONE place. Returns null when dispatch may proceed. */
function blockingGate(
	g: Gates,
): { skipped: SkipReason; reason: string } | null {
	// The master stop outranks everything.
	if (g.globalPaused)
		return { skipped: "global", reason: g.globalPaused.reason };
	// Board next: a frozen index would claim tasks whose files are not in the
	// checkout, and the claim could not be committed.
	if (g.boardSuspended) {
		return {
			skipped: "board",
			reason: "the board is suspended (see board.suspended)",
		};
	}
	if (g.paused) return { skipped: "paused", reason: g.paused.reason };
	if (g.hold) return { skipped: "hold", reason: g.hold.reason };
	if (g.mainRed) return { skipped: "main_red", reason: g.mainRed.reason };
	return null;
}

/** What a project with both switches on is doing (same precedence as the
 *  loop's, minus the two switches). */
function playingState(g: Gates): DispatchState {
	const gate = blockingGate({ ...g, globalPaused: null, paused: null });
	if (!gate) return "dispatching";
	return gate.skipped === "board"
		? "board_suspended"
		: gate.skipped === "hold"
			? "held"
			: "main_red";
}

function stateReason(
	state: DispatchState,
	g: Gates,
	running: boolean,
): string | null {
	if (state === "dispatching") return null;
	if (state === "stopped_global") return g.globalPaused?.reason ?? null;
	if (state !== "stopped") {
		const reason =
			blockingGate({ ...g, globalPaused: null, paused: null })?.reason ?? null;
		// MFW-28: the inbox says this is self-repairing (`inbox.ts`); the status
		// line must not read like a plain human-needed stop.
		if (state === "main_red" && g.mainRed?.selfRepairEligible && reason) {
			return `${reason}: attempting self-repair via ${g.mainRed.causeTaskId}, everything else stays held`;
		}
		return reason;
	}
	// Name every switch that is holding dispatch down, so turning one back on
	// does not look broken.
	const why =
		g.paused && !running
			? `${g.paused.reason} (and the dispatch loop is not running)`
			: g.paused
				? g.paused.reason
				: "the dispatch loop is not running";
	return g.globalPaused ? `${why}, and mfw is stopped everywhere` : why;
}
