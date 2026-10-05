import { overlappingPatterns } from "@mfw/board";
import type { Priority as TaskPriority } from "@mfw/core/types";
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
import type { HostAdmissionSnapshot } from "./host-resources/index.ts";
import type { Logger } from "./log.ts";
import { AdmissionHeldError } from "./project-dispatch-admission.ts";
import type { RunRegistry, RunRow } from "./run-registry.ts";
import type { TaskRow, TaskService, TaskWithRefs } from "./task-service.ts";
import { TaskOwnershipHeldError } from "./tasks/index.ts";

/**
 * The only dispatcher.
 *
 * The loop is an awaited `while` (as in Supervisor), so a slow tick cannot
 * overlap itself. The UI's "dispatch now" calls `wake()`, which only shortens
 * the sleep. A failed start is logged with context, releases whatever it held
 * and is counted in `stats.errors`.
 *
 * The concurrency cap is an absolute ceiling. When more than one run could be
 * in flight, an advisory brain chooses a subset of the dependency-ready
 * frontier; the scheduler then re-enforces the cap and every resource boundary.
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
	startTask(
		taskId: string,
		opts?: { model?: string; hostSnapshot?: HostAdmissionSnapshot },
	): Promise<{ runId: string }>;
	syncEligibleTasks?(taskIds: readonly string[]): Promise<void>;
	captureAdmissionSnapshot?(): HostAdmissionSnapshot | undefined;
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
	/** Advisory wave planner. It may only narrow the dependency-ready frontier;
	 * caps and resource admission are rechecked after every answer. */
	dispatchPlanner?: DispatchPlanner;
}

export interface DispatchTaskSummary {
	id: string;
	title: string;
	body: string;
	type: TaskRow["type"];
	priority: TaskRow["priority"];
	size: TaskRow["size"];
	labels: string[];
	/** Declared file ownership; overlapping tasks are never started together. */
	owns: string[];
	dependsOn: string[];
	requiresResources: TaskRow["requiresResources"];
	executionTarget: string;
	parentId: string | null;
	contentRev: number;
}

export interface DispatchRunningSummary {
	runId: string;
	kind: RunKind;
	task: DispatchTaskSummary | null;
}

export interface DispatchPlanInput {
	/** Remaining room below the operator's hard maximum. */
	maxToStart: number;
	/** Priority-ordered dependency-ready frontier. */
	candidates: DispatchTaskSummary[];
	/** Non-terminal hosted work already consuming the project ceiling. */
	running: DispatchRunningSummary[];
}

export interface DispatchPlanResult {
	status: "ok" | "failed";
	selectedTaskIds: string[];
	reason: string;
}

export interface DispatchPlanner {
	planDispatch(input: DispatchPlanInput): Promise<DispatchPlanResult>;
}

/** Why a tick dispatched nothing. */
export type SkipReason = "global" | "paused" | "hold" | "main_red" | "board";

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
	/** Task ids handed to `engine.startTask` this tick. */
	started: string[];
	/** Task ids skipped because a required resource had no free slot. */
	heldForResource: string[];
	/** Task ids skipped because their `owns` overlaps a running or picked task. */
	heldForOverlap: string[];
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
	/** How this tick chose its candidate subset. */
	planning: "not_needed" | "brain" | "fallback";
	/** Brain or fallback explanation for the selected wave. */
	planReason: string | null;
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
	lastTickAt: number;
	lastTickMs: number;
	hold: { until: number; reason: string } | null;
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

const RANK: Record<TaskPriority, number> = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
};

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
	private cachedPlan: {
		key: string;
		at: number;
		result: DispatchPlanResult;
	} | null = null;
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
			skipped: null,
			reason: null,
			capped: false,
			maintenance: false,
			errors: 0,
			planning: "not_needed",
			planReason: null,
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
		 * Runaway repair is bounded by existing machinery: a failing verify bumps
		 * `stallCount` (T17), and past `maxStalls` the task is released to
		 * `blocked` (T18, which also fires `notify`). That drops it out of
		 * `readySet()` and ends the exemption.
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
		const ready = repairTaskId
			? allReady.filter((t) => t.id === repairTaskId)
			: allReady;
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
		if (ready.length === 0) return stats;

		// (5) the maximum is a ceiling, not a target. The planner may narrow the
		// frontier further but cannot widen it or exceed `room`; admission below
		// rechecks every lock.
		const selected = await this.selectCandidates(ready, liveRuns, room, stats);
		if (selected.length === 0) return stats;

		// (6) reserve deterministic project resources for the chosen subset.
		const picked = await this.pickWave(selected, liveRuns, room, stats);

		// (7) dispatch sequentially: the DB serializes transactions anyway.
		for (const { task, plan, hostSnapshot } of picked) {
			if (stats.started.length >= room) break;
			await this.dispatch(task, plan, stats, hostSnapshot);
		}
		return stats;
	}

	private async inFlightRuns(): Promise<RunRow[]> {
		return this.deps.registry.list({
			states: LIVE_STATES,
			kinds: COUNTED_KINDS,
		});
	}

	private taskSummary(
		task: TaskRow,
		dependsOn: string[] = [],
	): DispatchTaskSummary {
		return {
			id: task.id,
			title: task.title,
			body: task.body,
			type: task.type,
			priority: task.priority,
			size: task.size,
			labels: [...task.labels],
			owns: [...task.owns],
			dependsOn: [...dependsOn],
			requiresResources: structuredClone(task.requiresResources),
			executionTarget: task.executionTarget,
			parentId: task.parentId,
			contentRev: task.contentRev,
		};
	}

	private async selectCandidates(
		ready: TaskWithRefs[],
		liveRuns: RunRow[],
		room: number,
		stats: TickStats,
	): Promise<TaskWithRefs[]> {
		const ordered = [...ready].sort(
			(a, b) => RANK[a.priority] - RANK[b.priority] || a.num - b.num,
		);
		const claimed = await this.runningOwnership(liveRuns);
		const admissible: TaskWithRefs[] = [];
		for (const task of ordered) {
			if (!(await this.holdForOverlap(task, claimed, stats)))
				admissible.push(task);
		}
		const bounded = admissible.slice(0, 64);
		const planner = this.deps.dispatchPlanner;
		// A lone candidate with nothing running needs no brain call. With several
		// ready, the brain still picks the order even when the maximum is one; an
		// existing run makes a lone candidate a parallel-safety call too.
		if (!planner || (liveRuns.length === 0 && bounded.length === 1)) {
			// Let pickWave scan past conflicts within the wave to fill the available
			// slots. A planner's explicitly selected subset stays bounded below.
			return admissible;
		}
		if (bounded.length === 0) return [];

		const running: DispatchRunningSummary[] = await Promise.all(
			liveRuns.map(async (run) => {
				const task = run.taskId ? await this.deps.tasks.get(run.taskId) : null;
				return {
					runId: run.id,
					kind: run.kind,
					task: task ? this.taskSummary(task, task.dependsOn) : null,
				};
			}),
		);
		const input: DispatchPlanInput = {
			maxToStart: room,
			candidates: bounded.map((task) => this.taskSummary(task, task.dependsOn)),
			running,
		};
		const key = JSON.stringify({
			maxToStart: room,
			candidates: input.candidates.map((task) => [task.id, task.contentRev]),
			running: running.map((item) => [
				item.runId,
				item.task?.id ?? null,
				item.task?.contentRev ?? null,
			]),
		});
		let result: DispatchPlanResult;
		if (
			this.cachedPlan?.key === key &&
			(this.cachedPlan.result.status === "ok" ||
				this.now() - this.cachedPlan.at < 60_000)
		) {
			result = this.cachedPlan.result;
		} else {
			try {
				result = await planner.planDispatch(input);
			} catch (error) {
				result = {
					status: "failed",
					selectedTaskIds: [],
					reason:
						error instanceof Error ? error.message : "dispatch planner failed",
				};
			}
			this.cachedPlan = { key, at: this.now(), result };
		}

		if (result.status !== "ok") {
			stats.planning = "fallback";
			stats.planReason = `${result.reason}; using conservative serial fallback`;
			// Never add a second run without an affirmative safety decision.
			return liveRuns.length === 0 ? bounded.slice(0, 1) : [];
		}
		stats.planning = "brain";
		stats.planReason = result.reason;
		const selected = new Set(result.selectedTaskIds.slice(0, room));
		return bounded.filter((task) => selected.has(task.id)).slice(0, room);
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
	 * Priority rank, then task number, skipping tasks whose resources cannot all
	 * be reserved or whose declared `owns` overlaps a running task or one picked
	 * earlier in this wave. Label-based collision avoidance was removed because
	 * it was a no-op for unlabelled tasks. Genuine contention goes through
	 * `requires_resources` against the `resource_slots` semaphore (a resource
	 * with `maxConcurrent: 1` is a mutex) and through `owns`; tasks that declare
	 * no `owns` are unconstrained, and the remainder (independent tasks touching
	 * the same undeclared file) is resolved by the merge queue's bounded retry.
	 */
	private async pickWave(
		ready: TaskWithRefs[],
		liveRuns: RunRow[],
		room: number,
		stats: TickStats,
	): Promise<
		{ task: TaskRow; plan: SlotRef[]; hostSnapshot?: HostAdmissionSnapshot }[]
	> {
		const candidates = [...ready].sort(
			(a, b) => RANK[a.priority] - RANK[b.priority] || a.num - b.num,
		);
		const claimed = await this.runningOwnership(liveRuns);
		if (this.deps.engine.admissionIntegrated) {
			const hostSnapshot = this.deps.engine.captureAdmissionSnapshot?.();
			if (!hostSnapshot) {
				throw new Error(
					"integrated host admission did not provide a wave snapshot",
				);
			}
			const wave: {
				task: TaskRow;
				plan: SlotRef[];
				hostSnapshot?: HostAdmissionSnapshot;
			}[] = [];
			for (const task of candidates) {
				if (await this.holdForOverlap(task, claimed, stats)) continue;
				this.announcedHolds.delete(task.id);
				claimed.push({ id: task.id, owns: task.owns });
				wave.push({ task, plan: [], hostSnapshot });
			}
			return wave;
		}
		const needsResources = candidates.some(
			(t) => (t.requiresResources ?? []).length > 0,
		);
		const slots: SlotState = needsResources
			? await this.slotState()
			: new Map();

		const picked: { task: TaskRow; plan: SlotRef[] }[] = [];
		for (const task of candidates) {
			if (picked.length >= room) break;
			if (await this.holdForOverlap(task, claimed, stats)) continue;

			const reserved = this.reserve(task, slots);
			if ("blockedBy" in reserved) {
				stats.heldForResource.push(task.id);
				await this.announceHold(task.id, reserved.blockedBy);
				continue;
			}
			this.announcedHolds.delete(task.id);
			claimed.push({ id: task.id, owns: task.owns });
			picked.push({ task, plan: reserved.plan });
		}
		return picked;
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

	/** One task's turn at dispatch. Failures are logged and counted, never swallowed. */
	private async dispatch(
		task: TaskRow,
		plan: SlotRef[],
		stats: TickStats,
		hostSnapshot?: HostAdmissionSnapshot,
	): Promise<void> {
		let runId: string | null = null;
		try {
			runId = (
				await this.deps.engine.startTask(task.id, {
					...(hostSnapshot ? { hostSnapshot } : {}),
				})
			).runId;
			if (!this.deps.engine.admissionIntegrated) {
				// Legacy/test engines do not own the prepare/acquire/launch seam.
				await this.acquireSlots(runId, plan);
			}
			stats.started.push(task.id);
			this.stats.dispatched++;
		} catch (e) {
			if (e instanceof TaskOwnershipHeldError) {
				stats.heldForOverlap.push(task.id);
				return;
			}
			if (e instanceof AdmissionHeldError) {
				stats.heldForResource.push(task.id);
				return;
			}
			stats.errors++;
			this.stats.tickErrors++;
			this.log.error(
				{
					err: e,
					taskId: task.id,
					runId,
					resources: plan.map((p) => p.resourceId),
				},
				"dispatch failed",
			);
			if (runId) {
				// Return anything held so a start that never happened blocks nothing.
				await this.releaseSlots(runId).catch((err: unknown) => {
					this.log.error({ err, runId }, "slot release after failed dispatch");
				});
			}
		}
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
				payload: { waitingFor, ...(why ?? {}) },
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
		const playing = projectPlaying && globalPlaying;
		// Most specific cause first: an individually stopped project stays stopped
		// when the master goes back on.
		const state: DispatchState = !projectPlaying
			? "stopped"
			: !globalPlaying
				? "stopped_global"
				: playingState(gates);
		return {
			playing,
			projectPlaying,
			globalPlaying,
			running,
			enabled: gates.paused === null,
			state,
			reason: stateReason(state, gates, running),
			selfStopped:
				state !== "dispatching" &&
				state !== "stopped" &&
				state !== "stopped_global",
			lastTickAt: this.stats.lastTickAt,
			lastTickMs: this.stats.lastTickMs,
			hold: gates.hold,
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
