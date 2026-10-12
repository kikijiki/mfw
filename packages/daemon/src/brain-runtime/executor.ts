import type { TaskStatus } from "@mfw/core/types";
import type { ProjectDbHandle } from "@mfw/db/client";
import { appendEvent, type EventBus, type StoredEvent } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import {
	brainActions,
	brainSessions,
	brainTurns,
	decisions,
	engineKv,
	groupIdOf,
	mergeJobs,
	type RunGroupStatus,
	runGroups,
} from "@mfw/db/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import { DispatchPreflightError } from "../dispatch-preflight.ts";
import type { Logger } from "../log.ts";
import { AdmissionHeldError } from "../project-dispatch-admission.ts";
import { GlobalStopError, type GroupRunSpec } from "../run-engine.ts";
import type { RunRegistry, RunRow } from "../run-registry.ts";
import type { TaskService } from "../task-service.ts";
import { TaskOwnershipHeldError } from "../tasks/index.ts";
import type { VerificationPlan } from "../tasks/types.ts";
import { WorktreeManager } from "../worktree.ts";
import { clearAwaiting } from "./awaiting.ts";
import {
	type BoardRefusal,
	boardRefusal,
	type NewTaskSpec,
	patchToEdit,
	specToCreateInput,
} from "./board-effects.ts";
import { type RunFacts, runFacts } from "./facts.ts";

/**
 * The live half of the action service (design §2, §6): effects of an accepted
 * `brain_actions` row. Every effect is idempotent on identifiers that were
 * written to the row BEFORE the effect (pre-minted run and group ids), so a
 * crash at any point is repaired by running the same effect again:
 *
 *   accepted ──launch/execute──► applied | failed
 *
 * Runs start from the scheduler only (`pendingSpawns` / `launch`); `recover()`
 * at boot adopts what already took effect and replays the effects that are
 * not dispatch (steer, stop, select_winner, ...).
 */

type BrainAction = typeof brainActions.$inferSelect;

export const BRAIN_HOLDS_KEY = "brain_task_holds";

export interface TaskHold {
	/** `human`: a person paused it from the UI (the same hold the brain's `pause` writes). */
	by: "pause" | "awaiting_human" | "human";
	reason: string;
	actionId: string;
	at: number;
}
export type TaskHolds = Record<string, TaskHold>;

/** The ids an action pre-minted and wrote to its row before any effect. */
export interface SpawnEffects {
	runIds: string[];
	groupId: string;
	groupKind: "single" | "competing";
	selection: "brain" | "first_verified";
	role: "implement" | "attempt" | "plan" | "import";
	/** Set once the effect ran, for the audit view. */
	launched?: string[];
	[k: string]: unknown;
}

export interface SelectEffects {
	groupId: string;
	runId: string;
	losers: string[];
	[k: string]: unknown;
}

export interface PendingSpawn {
	actionId: string;
	tool: "spawn" | "spawn_attempts";
	taskId: string;
	/** Run ids with no row yet, or a row still `starting`. */
	runIds: string[];
	createdAt: number;
}

export type LaunchOutcome =
	| { outcome: "noop" }
	| { outcome: "applied"; runIds: string[] }
	| {
			outcome: "held";
			kind: "overlap" | "provider" | "resource" | "stopped";
			reason: string;
	  }
	| { outcome: "failed"; error: string };

export interface ExecuteOutcome {
	status: "applied" | "failed" | "accepted";
	result?: Record<string, unknown>;
	error?: string;
	/** Set when the board itself refused the write: a code and fix the model can act on. */
	rejection?: BoardRefusal;
}

/** Crash seams for the recovery tests: a throw here models process death. */
export type ExecutorCrashPoint =
	| "spawn.before_launch"
	| "spawn.after_launch"
	| "select.after_group"
	/** create_tasks / split_task / merge_tasks: after each task is written, before the action is marked applied. */
	| "board.after_write"
	/** Before the claim-locked `owns` re-check of update_task. */
	| "board.before_owns_recheck"
	/** Every board effect: the board is written, `applied` is not recorded yet. */
	| "board.before_applied";

export interface BrainExecutorDeps {
	handle: ProjectDbHandle;
	bus: EventBus;
	tasks: TaskService;
	registry: RunRegistry;
	log: Logger;
	projectRoot: string;
	integrationBranch: string;
	engine: {
		startGroupRun(
			spec: GroupRunSpec,
			opts?: { hostSnapshot?: unknown },
		): Promise<{ runId: string }>;
		stop(runId: string): Promise<void>;
		steer(runId: string, message: string): Promise<void>;
		/** `spawn` role `plan`: a read-only planning run (draft expansion, or a plan from a brief). */
		startPlan?(
			goal: string,
			opts: {
				runId: string;
				taskId?: string;
				model?: string;
				originRef?: string;
			},
		): Promise<{ runId: string }>;
		/** `spawn` role `import`: a read-only survey of the repository. */
		startImport?(opts: {
			runId: string;
			model?: string;
			originRef?: string;
		}): Promise<{ runId: string }>;
	};
	mergeQueue: {
		enqueue(job: {
			runId: string;
			taskId?: string | null;
			branch: string;
			targetBranch: string;
		}): Promise<void>;
	};
	/** `answer_question`: answer the worker's open question and resume it. */
	answerQuestion?: (runId: string, answer: string) => Promise<void>;
	/** `set_budget`: lower a configured budget's limit (`BudgetService.applyBrainLimit`). */
	setBudget?: (input: {
		budget: string;
		limitUsd?: number;
		limitTokens?: number;
		window?: string;
	}) => Promise<Record<string, unknown>>;
	/** `notify_human`: page the owner. */
	notifyHuman?: (input: {
		kind: string;
		title: string;
		body: string;
		taskIds: string[];
	}) => Promise<void>;
	/** `request_review`: run the review judge on a settled run. */
	review?: (input: {
		runId: string;
		mode: "critic" | "agent";
		reviewer?: { harness: string; model: string };
	}) => Promise<{ status: "ok" | "failed"; verdict?: string; reason?: string }>;
	/** Whether a person's review gate applies to this task (`require_review`, project policy). */
	humanReviewGate?: (task: { requireReview: boolean }) => boolean;
	/** A new spawn is waiting: shorten the scheduler's sleep. */
	wakeScheduler?: () => void;
	now?: () => number;
	crashAt?: (point: ExecutorCrashPoint) => void | Promise<void>;
}

const LIVE = ["starting", "running", "ended", "finalizing", "merging"] as const;

/** Act tools whose landing means the brain has decided what happens to the task. */
const CLEARS_AWAITING: ReadonlySet<string> = new Set([
	"spawn",
	"spawn_attempts",
	"select_winner",
	"set_status",
	"split_task",
	"merge_tasks",
	"notify_human",
	"request_review",
]);

export class BrainActionExecutor {
	private readonly now: () => number;

	constructor(private readonly deps: BrainExecutorDeps) {
		this.now = deps.now ?? (() => Date.now());
	}

	// -----------------------------------------------------------------------
	// task holds (pause / awaiting_human): the scheduler skips these tasks
	// -----------------------------------------------------------------------

	async holds(): Promise<TaskHolds> {
		const [row] = await this.deps.handle.db
			.select()
			.from(engineKv)
			.where(eq(engineKv.key, BRAIN_HOLDS_KEY));
		return (row?.value as { holds?: TaskHolds } | undefined)?.holds ?? {};
	}

	/** A human override: drop these tasks' brain holds (`pause`, `awaiting_human`). Returns the ids that had one. */
	async releaseHolds(taskIds: readonly string[]): Promise<string[]> {
		const holds = await this.holds();
		const released = taskIds.filter((id) => id in holds);
		if (released.length === 0) return [];
		for (const id of released) delete holds[id];
		await this.writeHolds(holds);
		return released;
	}

	/** A human override of a `resume`: hold these tasks again. Existing holds stay. */
	async addHolds(
		taskIds: readonly string[],
		reason: string,
		actionId: string,
	): Promise<string[]> {
		const holds = await this.holds();
		const added = taskIds.filter((id) => !(id in holds));
		if (added.length === 0) return [];
		for (const id of added) {
			holds[id] = { by: "pause", reason, actionId, at: this.now() };
		}
		await this.writeHolds(holds);
		return added;
	}

	/**
	 * A human override of a spawn that has not launched yet: the accepted
	 * action will never start. False when it already left `accepted`.
	 */
	async cancelPending(actionId: string, reason: string): Promise<boolean> {
		const row = await this.action(actionId);
		if (row?.status !== "accepted") return false;
		await this.settle(row, "failed", {
			error: reason,
			rejection: { code: "overridden", message: reason },
		});
		return true;
	}

	private async writeHolds(holds: TaskHolds): Promise<void> {
		const value = { holds };
		await this.deps.handle.db
			.insert(engineKv)
			.values({ key: BRAIN_HOLDS_KEY, value, updatedAt: new Date() })
			.onConflictDoUpdate({
				target: engineKv.key,
				set: { value, updatedAt: new Date() },
			});
	}

	// -----------------------------------------------------------------------
	// outbox access
	// -----------------------------------------------------------------------

	async action(id: string): Promise<BrainAction | null> {
		const [row] = await this.deps.handle.db
			.select()
			.from(brainActions)
			.where(eq(brainActions.id, id));
		return row ?? null;
	}

	/** Accepted actions, oldest first. */
	async accepted(tools?: readonly string[]): Promise<BrainAction[]> {
		const rows = await this.deps.handle.db
			.select()
			.from(brainActions)
			.where(eq(brainActions.status, "accepted"))
			.orderBy(asc(brainActions.createdAt), asc(brainActions.id));
		return tools ? rows.filter((r) => tools.includes(r.tool)) : rows;
	}

	private async settle(
		row: BrainAction,
		status: "applied" | "failed",
		patch: {
			effects?: Record<string, unknown>;
			error?: string;
			rejection?: BoardRefusal;
			/** The task the action is about, when the call itself named none (a create). */
			subjectTaskId?: string;
		} = {},
	): Promise<void> {
		const nowMs = this.now();
		const events: StoredEvent[] = [];
		await this.deps.handle.withTx(async (tx) => {
			const [cur] = await tx
				.select()
				.from(brainActions)
				.where(eq(brainActions.id, row.id));
			if (cur?.status !== "accepted") return;
			const effects = { ...(cur.effects ?? {}), ...(patch.effects ?? {}) };
			await tx
				.update(brainActions)
				.set({
					status,
					effects,
					appliedAt: new Date(nowMs),
					...(status === "failed"
						? {
								rejection: patch.rejection ?? {
									code: "effect_failed",
									message: patch.error ?? "the effect failed",
								},
							}
						: {}),
				})
				.where(eq(brainActions.id, row.id));
			if (cur.decisionId) {
				const [d] = await tx
					.select()
					.from(decisions)
					.where(eq(decisions.id, cur.decisionId));
				await tx
					.update(decisions)
					.set({
						output: {
							...((d?.output as Record<string, unknown> | null) ?? {}),
							status,
							effects,
							...(patch.rejection
								? { rejection: patch.rejection }
								: patch.error
									? { error: patch.error }
									: {}),
						},
						...(patch.subjectTaskId && !d?.taskId
							? { taskId: patch.subjectTaskId }
							: {}),
						finishedAt: new Date(nowMs),
					})
					.where(eq(decisions.id, cur.decisionId));
			}
			const args = cur.args as Record<string, unknown>;
			const taskId =
				typeof args.taskId === "string"
					? args.taskId
					: typeof args.id === "string"
						? args.id
						: undefined;
			events.push(
				await appendEvent(
					tx,
					{
						type: "brain.action",
						runId: cur.turnRunId,
						...(taskId ? { taskId } : {}),
						payload: {
							actionId: cur.id,
							tool: cur.tool,
							status,
							...(cur.decisionId ? { decisionId: cur.decisionId } : {}),
							sessionId: cur.sessionId,
							...(patch.error ? { error: patch.error } : {}),
						},
					},
					nowMs,
				),
			);
		});
		this.deps.bus.publish(events);
		// The brain's effect landed on these tasks: they are no longer waiting.
		if (status === "applied") {
			await this.releaseAwaiting(row).catch((e) => {
				this.deps.log.warn(
					{ err: e, actionId: row.id },
					"could not clear awaiting_brain",
				);
			});
		}
	}

	/** Tasks whose settle this action answers (spawn, select, status, escalation). */
	private async releaseAwaiting(row: BrainAction): Promise<void> {
		if (!CLEARS_AWAITING.has(row.tool)) return;
		const a = row.args as Record<string, unknown>;
		const ids = new Set<string>();
		for (const k of ["taskId", "id"]) {
			if (typeof a[k] === "string") ids.add(a[k] as string);
		}
		for (const k of ["ids", "blocking"]) {
			if (Array.isArray(a[k])) {
				for (const v of a[k] as unknown[]) {
					if (typeof v === "string") ids.add(v);
				}
			}
		}
		if (typeof a.runId === "string") {
			const run = await this.deps.registry.get(a.runId);
			if (run?.taskId) ids.add(run.taskId);
		}
		await clearAwaiting(this.deps.handle, [...ids]);
	}

	// -----------------------------------------------------------------------
	// spawn: the scheduler's source of runs
	// -----------------------------------------------------------------------

	/** A new spawn is waiting: shorten the scheduler's sleep. */
	nudge(): void {
		this.deps.wakeScheduler?.();
	}

	/** Worker slots promised to accepted spawns whose runs have no live row yet. */
	async reservedSlots(): Promise<number> {
		let n = 0;
		for (const row of await this.accepted(["spawn", "spawn_attempts"])) {
			const fx = row.effects as SpawnEffects | null;
			for (const id of fx?.runIds ?? []) {
				const run = await this.deps.registry.get(id);
				if (!run || run.state === "starting") n++;
			}
		}
		return n;
	}

	/** Accepted `spawn` / `spawn_attempts` with at least one run still to launch, in the brain's order. */
	async pendingSpawns(): Promise<PendingSpawn[]> {
		const out: PendingSpawn[] = [];
		for (const row of await this.accepted(["spawn", "spawn_attempts"])) {
			const fx = row.effects as SpawnEffects | null;
			if (!fx?.runIds) continue;
			const todo: string[] = [];
			for (const id of fx.runIds) {
				const run = await this.deps.registry.get(id);
				if (!run || run.state === "starting") todo.push(id);
			}
			const taskId = String((row.args as Record<string, unknown>).taskId);
			if (todo.length === 0) {
				// Everything already took effect: nothing to launch, only to record.
				await this.settle(row, "applied", {
					effects: { launched: fx.runIds },
				});
				continue;
			}
			out.push({
				actionId: row.id,
				tool: row.tool as "spawn" | "spawn_attempts",
				taskId,
				runIds: todo,
				createdAt: row.createdAt.getTime(),
			});
		}
		return out;
	}

	/**
	 * Launch every run of one accepted spawn that has no live row yet. Idempotent
	 * by the pre-minted run ids: a replay finds the rows and starts nothing twice.
	 */
	async launch(
		actionId: string,
		ctx: { hostSnapshot?: unknown } = {},
	): Promise<LaunchOutcome> {
		const row = await this.action(actionId);
		if (row?.status !== "accepted") return { outcome: "noop" };
		const fx = row.effects as SpawnEffects | null;
		if (!fx?.runIds?.length) {
			await this.settle(row, "failed", {
				error: "action has no pre-minted run",
			});
			return { outcome: "failed", error: "action has no pre-minted run" };
		}
		if (fx.role === "plan") return this.launchPlan(row, fx);
		if (fx.role === "import") return this.launchImport(row, fx);
		const specs = this.specsFor(row, fx);
		for (const [i, runId] of fx.runIds.entries()) {
			const existing = await this.deps.registry.get(runId);
			if (existing && existing.state !== "starting") continue;
			const spec = specs[i];
			if (!spec) continue;
			await this.deps.crashAt?.("spawn.before_launch");
			try {
				await this.deps.engine.startGroupRun(spec, {
					...(ctx.hostSnapshot ? { hostSnapshot: ctx.hostSnapshot } : {}),
				});
			} catch (e) {
				const held = heldReason(e);
				if (held) return { outcome: "held", ...held };
				const error = e instanceof Error ? e.message : String(e);
				this.deps.log.warn(
					{ err: e, actionId, runId },
					"brain spawn failed to launch",
				);
				await this.settle(row, "failed", { error });
				return { outcome: "failed", error };
			}
			await this.deps.crashAt?.("spawn.after_launch");
		}
		await this.settle(row, "applied", { effects: { launched: fx.runIds } });
		return { outcome: "applied", runIds: fx.runIds };
	}

	/** An `import`-role spawn: the engine's import run under the pre-minted id. Its proposal settles `plan_output`. */
	private async launchImport(
		row: BrainAction,
		fx: SpawnEffects,
	): Promise<LaunchOutcome> {
		const runId = fx.runIds[0] as string;
		const existing = await this.deps.registry.get(runId);
		if (existing && existing.state !== "starting") {
			await this.settle(row, "applied", { effects: { launched: fx.runIds } });
			return { outcome: "applied", runIds: fx.runIds };
		}
		const a = row.args as Record<string, unknown>;
		const startImport = this.deps.engine.startImport;
		if (!startImport) {
			const error = "import runs are not wired";
			await this.settle(row, "failed", { error });
			return { outcome: "failed", error };
		}
		await this.deps.crashAt?.("spawn.before_launch");
		try {
			await startImport.call(this.deps.engine, {
				runId,
				...(typeof a.model === "string" ? { model: a.model } : {}),
				originRef: `brain:${row.id}`,
			});
		} catch (e) {
			const held = heldReason(e);
			if (held) return { outcome: "held", ...held };
			const error = e instanceof Error ? e.message : String(e);
			await this.settle(row, "failed", { error });
			return { outcome: "failed", error };
		}
		await this.deps.crashAt?.("spawn.after_launch");
		await this.settle(row, "applied", { effects: { launched: fx.runIds } });
		return { outcome: "applied", runIds: fx.runIds };
	}

	/**
	 * A `plan`-role spawn: the engine's read-only planning run, under the
	 * pre-minted run id. A draft task is expanded in place; any other task is
	 * planned from the brief. The run's output is the brain's to apply
	 * (`run_report`, then the board tools).
	 */
	private async launchPlan(
		row: BrainAction,
		fx: SpawnEffects,
	): Promise<LaunchOutcome> {
		const runId = fx.runIds[0] as string;
		const existing = await this.deps.registry.get(runId);
		if (existing && existing.state !== "starting") {
			await this.settle(row, "applied", { effects: { launched: fx.runIds } });
			return { outcome: "applied", runIds: fx.runIds };
		}
		const a = row.args as Record<string, unknown>;
		const task = await this.deps.tasks.get(String(a.taskId));
		const startPlan = this.deps.engine.startPlan;
		if (!startPlan || !task) {
			const error = !task
				? `no task '${String(a.taskId)}'`
				: "planning runs are not wired";
			await this.settle(row, "failed", { error });
			return { outcome: "failed", error };
		}
		const goal =
			(typeof a.brief === "string" && a.brief.trim()) ||
			task.draftPrompt ||
			[task.title, task.body].filter(Boolean).join("\n\n");
		await this.deps.crashAt?.("spawn.before_launch");
		try {
			await startPlan.call(this.deps.engine, goal, {
				runId,
				...(task.status === "draft" ? { taskId: task.id } : {}),
				...(typeof a.model === "string" ? { model: a.model } : {}),
				originRef: `brain:${row.id}`,
			});
		} catch (e) {
			const held = heldReason(e);
			if (held) return { outcome: "held", ...held };
			const error = e instanceof Error ? e.message : String(e);
			this.deps.log.warn(
				{ err: e, actionId: row.id, runId },
				"brain plan run failed to launch",
			);
			await this.settle(row, "failed", { error });
			return { outcome: "failed", error };
		}
		await this.deps.crashAt?.("spawn.after_launch");
		await this.settle(row, "applied", { effects: { launched: fx.runIds } });
		return { outcome: "applied", runIds: fx.runIds };
	}

	private specsFor(row: BrainAction, fx: SpawnEffects): GroupRunSpec[] {
		const a = row.args as Record<string, unknown>;
		const taskId = String(a.taskId);
		const base = {
			taskId,
			groupId: fx.groupId,
			groupKind: fx.groupKind,
			selection: fx.selection,
			actionId: row.id,
			...(row.decisionId ? { decisionId: row.decisionId } : {}),
		};
		const pickOf = (v: Record<string, unknown>): GroupRunSpec["pick"] => ({
			...(typeof v.harness === "string" ? { provider: v.harness } : {}),
			...(typeof v.model === "string" ? { model: v.model } : {}),
			...(typeof v.effort === "string"
				? { effort: v.effort as NonNullable<GroupRunSpec["pick"]>["effort"] }
				: {}),
		});
		if (row.tool === "spawn_attempts") {
			const variants = (a.variants as Record<string, unknown>[]) ?? [];
			return fx.runIds.map((runId, i) => {
				const v = variants[i] ?? {};
				return {
					...base,
					runId,
					role: "attempt" as const,
					pick: pickOf(v),
					...(typeof v.target === "string" ? { target: v.target } : {}),
					...(typeof v.brief === "string" ? { brief: v.brief } : {}),
					worktree: { mode: "new" as const },
				};
			});
		}
		const wt = String(a.worktree ?? "new");
		return [
			{
				...base,
				runId: fx.runIds[0] as string,
				role: fx.role as "implement" | "attempt",
				pick: pickOf(a),
				...(typeof a.target === "string" ? { target: a.target } : {}),
				...(typeof a.brief === "string" ? { brief: a.brief } : {}),
				worktree: wt.startsWith("continue:")
					? { mode: "continue" as const, runId: wt.slice("continue:".length) }
					: { mode: "new" as const },
			},
		];
	}

	// -----------------------------------------------------------------------
	// the rest of the act tools
	// -----------------------------------------------------------------------

	/** Run the effect of one accepted, non-spawn action. Idempotent. */
	async execute(actionId: string): Promise<ExecuteOutcome> {
		const row = await this.action(actionId);
		if (!row) return { status: "failed", error: "unknown action" };
		if (row.status === "applied") return { status: "applied" };
		if (row.status !== "accepted") {
			return { status: "failed", error: `action is ${row.status}` };
		}
		const a = row.args as Record<string, unknown>;
		try {
			let result: Record<string, unknown> = {};
			switch (row.tool) {
				case "steer":
					await this.deps.engine.steer(String(a.runId), String(a.message));
					break;
				case "stop":
					result = await this.stop(String(a.runId));
					break;
				case "pause":
				case "resume":
					result = await this.pauseResume(row, a);
					break;
				case "sleep":
					result = await this.sleep(row, a);
					break;
				case "notify_human":
					result = await this.notify(row, a);
					break;
				case "answer_question":
					if (!this.deps.answerQuestion) {
						throw new Error("answering worker questions is not wired");
					}
					await this.deps.answerQuestion(String(a.runId), String(a.answer));
					break;
				case "request_review":
					result = await this.requestReview(a);
					break;
				case "set_budget":
					if (!this.deps.setBudget) throw new Error("budgets are not wired");
					result = await this.deps.setBudget({
						budget: String(a.budget),
						...(typeof a.limitUsd === "number" ? { limitUsd: a.limitUsd } : {}),
						...(typeof a.limitTokens === "number"
							? { limitTokens: a.limitTokens }
							: {}),
						...(typeof a.window === "string" ? { window: a.window } : {}),
					});
					break;
				case "select_winner":
					result = await this.applySelectWinner(
						row.effects as SelectEffects | null,
					);
					break;
				case "create_tasks":
				case "update_task":
				case "reparent":
				case "split_task":
				case "merge_tasks":
				case "set_status":
					result = await this.board(row, a);
					await this.deps.crashAt?.("board.before_applied");
					break;
				default:
					throw new Error(`${row.tool} has no live effect`);
			}
			const created = Array.isArray(result.ids)
				? (result.ids as string[])[0]
				: undefined;
			await this.settle(row, "applied", {
				effects: { result },
				...(created ? { subjectTaskId: created } : {}),
			});
			return { status: "applied", result };
		} catch (e) {
			if (isCrash(e)) throw e;
			const error = e instanceof Error ? e.message : String(e);
			const rejection = boardRefusal(e) ?? undefined;
			this.deps.log.warn(
				{ err: e, actionId, tool: row.tool },
				"brain effect failed",
			);
			await this.settle(row, "failed", {
				error,
				...(rejection ? { rejection } : {}),
			});
			return { status: "failed", error, ...(rejection ? { rejection } : {}) };
		}
	}

	/**
	 * The board tools' effects. Each is idempotent on what is on disk (see the
	 * `*ByBrain` methods of TaskService), so a replay after a crash between
	 * the board write and `applied` finishes the action without repeating it.
	 */
	private async board(
		row: BrainAction,
		a: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const tasks = this.deps.tasks;
		const actionId = row.id;
		const afterWrite = async () => {
			await this.deps.crashAt?.("board.after_write");
		};
		switch (row.tool) {
			case "create_tasks": {
				const specs = (a.tasks as NewTaskSpec[]).map(specToCreateInput);
				const made = await tasks.createBatch(
					specs,
					{ actionId },
					{ afterWrite },
				);
				await this.writeSpecs(a.tasks as NewTaskSpec[], made);
				return {
					ids: made.map((t) => t.id),
					tasks: made.map((t, i) => ({
						ref: (a.tasks as NewTaskSpec[])[i]?.ref ?? null,
						id: t.id,
						title: t.title,
					})),
				};
			}
			case "update_task": {
				const t = await tasks.editByBrain(
					String(a.id),
					patchToEdit(a.patch as Record<string, unknown>),
					{ baseRev: Number(a.baseRev), actionId },
					{
						beforeOwnsRecheck: async () => {
							await this.deps.crashAt?.("board.before_owns_recheck");
						},
					},
				);
				return { id: t.id, rev: t.contentRev };
			}
			case "reparent": {
				const t = await tasks.reparentByBrain(
					String(a.id),
					(a.parent as string | null) ?? null,
					{ actionId },
				);
				return { id: t.id, parent: t.parentId, rev: t.contentRev };
			}
			case "split_task": {
				const id = String(a.id);
				if (a.stop_live === true) await this.stopLiveRuns(id);
				const specs = (a.into as NewTaskSpec[]).map(specToCreateInput);
				const { children, original } = await tasks.splitByBrain(
					id,
					specs,
					a.keep_original as "archive" | "epic",
					{ actionId },
					{ afterWrite },
				);
				await this.writeSpecs(a.into as NewTaskSpec[], children);
				return {
					id,
					ids: children.map((c) => c.id),
					original: { id: original.id, status: original.status },
					keep: a.keep_original,
				};
			}
			case "merge_tasks": {
				const into = a.into as {
					title: string;
					body?: string;
					owns?: string[];
					verification?: Record<string, unknown>;
					acceptance?: Record<string, unknown>[];
				};
				const { merged, archived } = await tasks.mergeByBrain(
					a.ids as string[],
					{
						title: into.title,
						...(into.body !== undefined ? { body: into.body } : {}),
						...(into.owns ? { owns: into.owns } : {}),
						...(into.verification
							? {
									verification:
										into.verification as unknown as VerificationPlan,
								}
							: {}),
						...(into.acceptance
							? {
									criteria: patchToEdit({ acceptance: into.acceptance })
										.criteria,
								}
							: {}),
					},
					{ actionId },
					{ afterWrite },
				);
				return { ids: [merged.id], archived };
			}
			case "set_status": {
				const t = await tasks.setStatusByBrain(
					String(a.id),
					a.to as TaskStatus,
					{ reason: String(a.reason), actionId },
				);
				return { id: t.id, status: t.status };
			}
		}
		throw new Error(`${row.tool} has no board effect`);
	}

	/** Each created task's `spec` text, written once the task exists (a replay writes it again, harmlessly). */
	private async writeSpecs(
		specs: readonly NewTaskSpec[],
		made: readonly { id: string }[],
	): Promise<void> {
		for (const [i, s] of specs.entries()) {
			const id = made[i]?.id;
			if (!id || !s.spec?.trim()) continue;
			const cur = await this.deps.tasks.getSpec(id);
			if (cur?.exists) continue;
			await this.deps.tasks.setSpec(id, s.spec);
		}
	}

	/** `split_task` with `stop_live`: stop the task's live runs and wait for their claim to clear. */
	private async stopLiveRuns(taskId: string): Promise<void> {
		const live = (await this.deps.registry.list({ taskId })).filter((r) =>
			LIVE.includes(r.state as (typeof LIVE)[number]),
		);
		for (const r of live) {
			await this.deps.engine.stop(r.id).catch(() => {
				// already gone: finalize will see the exit record
			});
		}
		const until = Date.now() + 30_000;
		while (Date.now() < until) {
			const t = await this.deps.tasks.get(taskId);
			if (!t?.claimedByGroupId) return;
			await new Promise((r) => setTimeout(r, 250));
		}
	}

	private async stop(runId: string): Promise<Record<string, unknown>> {
		const run = await this.deps.registry.get(runId);
		if (!run) throw new Error(`no run '${runId}'`);
		if (!LIVE.includes(run.state as (typeof LIVE)[number])) {
			return { alreadyStopped: true, state: run.state };
		}
		await this.deps.engine.stop(runId);
		return { stopped: true };
	}

	/**
	 * A person's pause or resume of tasks (and optionally a whole subtree):
	 * the same hold store the brain's `pause`/`resume` write, so the scheduler
	 * and the brain's validators see one truth.
	 */
	async setHumanHolds(input: {
		taskIds: readonly string[];
		subtree?: string;
		paused: boolean;
		reason: string;
		decisionId: number;
	}): Promise<string[]> {
		const ids = new Set<string>(input.taskIds);
		if (input.subtree) {
			for (const id of await this.descendants(input.subtree)) ids.add(id);
		}
		const holds = await this.holds();
		for (const id of ids) {
			if (input.paused) {
				holds[id] = {
					by: "human",
					reason: input.reason,
					actionId: `human:${input.decisionId}`,
					at: this.now(),
				};
			} else {
				delete holds[id];
			}
		}
		await this.writeHolds(holds);
		return [...ids];
	}

	/** Launch one run for a person (an added attempt): the brain's own launch path. */
	async startHumanRun(spec: GroupRunSpec): Promise<{ runId: string }> {
		return this.deps.engine.startGroupRun(spec);
	}

	private async descendants(root: string): Promise<string[]> {
		const all = await this.deps.tasks.list();
		const out: string[] = [];
		const queue = [root];
		const seen = new Set<string>();
		while (queue.length > 0) {
			const id = queue.shift() as string;
			if (seen.has(id)) continue;
			seen.add(id);
			out.push(id);
			for (const t of all) if (t.parentId === id) queue.push(t.id);
		}
		return out;
	}

	private async pauseResume(
		row: BrainAction,
		a: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const ids = new Set<string>((a.taskIds as string[] | undefined) ?? []);
		if (typeof a.subtree === "string") {
			for (const id of await this.descendants(a.subtree)) ids.add(id);
		}
		const holds = await this.holds();
		if (row.tool === "pause") {
			for (const id of ids) {
				holds[id] = {
					by: "pause",
					reason: String(a.rationale ?? "paused by the brain"),
					actionId: row.id,
					at: this.now(),
				};
			}
		} else {
			for (const id of ids) delete holds[id];
		}
		await this.writeHolds(holds);
		return { tool: row.tool, taskIds: [...ids] };
	}

	private async sleep(
		row: BrainAction,
		a: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const hint = {
			wakeAfterMin: a.wakeAfterMin ?? null,
			wakeOn: a.wakeOn ?? [],
			setAt: this.now(),
		};
		await this.deps.handle.db
			.update(brainSessions)
			.set({ wakeHint: hint })
			.where(eq(brainSessions.id, row.sessionId));
		return { wakeHint: hint };
	}

	private async notify(
		row: BrainAction,
		a: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		// An `fyi` informs, it never blocks: listing tasks on one must not hold
		// them (or move them to `blocked` with an "fyi: ..." reason).
		const taskIds =
			a.kind === "fyi" ? [] : ((a.blocking as string[] | undefined) ?? []);
		await this.deps.notifyHuman?.({
			kind: String(a.kind),
			title: String(a.title),
			body: String(a.body),
			taskIds,
		});
		if (taskIds.length > 0) {
			const holds = await this.holds();
			for (const id of taskIds) {
				holds[id] = {
					by: "awaiting_human",
					reason: String(a.title),
					actionId: row.id,
					at: this.now(),
				};
			}
			await this.writeHolds(holds);
		}
		// The decision row is the escalation record the owner reads.
		if (row.decisionId) {
			await this.deps.handle.db
				.update(decisions)
				.set({ kind: "escalation" })
				.where(eq(decisions.id, row.decisionId));
		}
		return { kind: a.kind, blocking: taskIds };
	}

	private async requestReview(
		a: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		if (!this.deps.review) throw new Error("review is not wired");
		const r = await this.deps.review({
			runId: String(a.runId),
			mode: a.mode as "critic" | "agent",
			...(a.reviewer
				? { reviewer: a.reviewer as { harness: string; model: string } }
				: {}),
		});
		// A settled run whose review could not give a verdict (or the brain
		// asked a different reviewer) and which now passes the floor goes on
		// through the same gates a first-pass success does.
		const out: Record<string, unknown> = { ...r };
		if (r.status === "ok" && r.verdict === "merge") {
			Object.assign(out, await this.approveSettled(String(a.runId)));
		}
		return out;
	}

	/**
	 * The single-run counterpart of `select_winner`, after a review the floor
	 * accepts: a settled, verified, in-scope run of an unclaimed task goes to
	 * the merge queue (or to a person when a review gate applies). Anything
	 * else is reported, never forced.
	 */
	async approveSettled(runId: string): Promise<Record<string, unknown>> {
		const run = await this.deps.registry.get(runId);
		if (!run?.taskId || !run.branch || run.kind !== "task") {
			return { approved: false, why: "not a task run with a branch" };
		}
		// A replay finds its merge job before anything else is asked of the run.
		const [job] = await this.deps.handle.db
			.select()
			.from(mergeJobs)
			.where(eq(mergeJobs.runId, runId));
		if (job) return { approved: true, enqueued: true, replay: true };
		if (LIVE.includes(run.state as (typeof LIVE)[number])) {
			return { approved: false, why: `run is ${run.state}` };
		}
		const group = await this.deps.registry.getGroup(groupIdOf(run));
		if (group?.kind === "competing") {
			return { approved: false, why: "an attempt: use select_winner" };
		}
		const f = await this.facts(runId);
		if (!f.verified || f.scopeOutside > 0) {
			return {
				approved: false,
				why: f.verified
					? "files changed outside the task's owns"
					: "the run has not passed verification",
			};
		}
		const task = await this.deps.tasks.get(run.taskId);
		if (!task || task.claimedByGroupId !== null) {
			return { approved: false, why: "the task is claimed by another run" };
		}
		if (task.status !== "ready") {
			return { approved: false, why: `the task is ${task.status}, not ready` };
		}
		if (this.deps.humanReviewGate?.(task) ?? task.requireReview) {
			await this.deps.tasks.move(
				task.id,
				"review",
				"brain",
				"review gate (settled run approved by review)",
			);
			return { approved: true, review: true };
		}
		await this.deps.tasks.reclaimForRetry(task.id, runId);
		const targetBranch = run.integrationBranch ?? this.deps.integrationBranch;
		await this.deps.registry.transition(runId, "merging");
		await this.deps.mergeQueue.enqueue({
			runId,
			taskId: task.id,
			branch: run.branch,
			targetBranch,
		});
		return { approved: true, enqueued: true, targetBranch };
	}

	// -----------------------------------------------------------------------
	// select_winner and attempt-group settlement
	// -----------------------------------------------------------------------

	private hasChecks(task: { verification: unknown; dod: unknown } | null) {
		return (
			this.deps.tasks.effectiveVerification(
				(task?.verification ?? task?.dod ?? null) as never,
			) != null
		);
	}

	async facts(runId: string): Promise<RunFacts> {
		const run = await this.deps.registry.get(runId);
		const task = run?.taskId ? await this.deps.tasks.get(run.taskId) : null;
		return runFacts(this.deps.registry, runId, {
			hasChecks: this.hasChecks(task),
		});
	}

	private async emitGroup(
		taskId: string,
		groupId: string,
		status: RunGroupStatus,
		winnerRunId: string | null,
		reason?: string,
	): Promise<void> {
		const event = await this.deps.handle.withTx((tx) =>
			appendEvent(tx, {
				type: "run.group_changed",
				taskId,
				payload: {
					groupId,
					status,
					winnerRunId,
					...(reason ? { reason } : {}),
				},
			}),
		);
		this.deps.bus.publish([event]);
	}

	/**
	 * Mark the winner, stop live losers and send the winner through the gates:
	 * the merge queue, or a person when scope left the task's `owns` or a
	 * review gate applies. Losers are archived by `settleGroups` once they stop.
	 */
	async applySelectWinner(
		fx: SelectEffects | null,
		actor: "brain" | "human" = "brain",
	): Promise<Record<string, unknown>> {
		if (!fx) throw new Error("select_winner has no recorded effect ids");
		const winner = await this.deps.registry.get(fx.runId);
		if (!winner?.taskId || !winner.branch) {
			throw new Error(`run ${fx.runId} has no branch to merge`);
		}
		const taskId = winner.taskId;
		const group = await this.deps.registry.getGroup(fx.groupId);
		if (group && group.status === "open") {
			await this.deps.registry.setGroup(fx.groupId, {
				status: "selecting",
				winnerRunId: fx.runId,
			});
			await this.emitGroup(taskId, fx.groupId, "selecting", fx.runId);
		}
		await this.deps.crashAt?.("select.after_group");
		for (const id of fx.losers) {
			const loser = await this.deps.registry.get(id);
			if (loser && LIVE.includes(loser.state as (typeof LIVE)[number])) {
				await this.deps.engine.stop(id).catch(() => {
					// already gone: finalize will see the exit record
				});
			}
		}

		// The winner's gates. The same journal facts the validator read.
		const f = await this.facts(fx.runId);
		const task = await this.deps.tasks.get(taskId);
		const [job] = await this.deps.handle.db
			.select()
			.from(mergeJobs)
			.where(eq(mergeJobs.runId, fx.runId));
		if (job) return { enqueued: true, replay: true };
		if (task && task.status === "review") return { review: true, replay: true };
		const gated =
			f.scopeOutside > 0 ||
			(task
				? (this.deps.humanReviewGate?.(task) ?? task.requireReview)
				: false);
		if (gated) {
			const reason =
				f.scopeOutside > 0
					? "scope gate: files changed outside the task's owns"
					: "review gate";
			await this.deps.tasks.release(
				taskId,
				fx.runId,
				"review",
				actor,
				`${reason} (winner of attempt group ${fx.groupId})`,
			);
			return { review: true, reason };
		}
		const targetBranch =
			winner.integrationBranch ?? this.deps.integrationBranch;
		// `merging` before the job is visible, as finalize's enqueue_merge does.
		await this.deps.registry.transition(fx.runId, "merging");
		await this.deps.mergeQueue.enqueue({
			runId: fx.runId,
			taskId,
			branch: winner.branch,
			targetBranch,
		});
		return { enqueued: true, targetBranch };
	}

	/**
	 * Periodic: advance every open or selecting attempt group.
	 *  - `first_verified`: the first verified member wins, through the same
	 *    effect `select_winner` uses.
	 *  - all members ended and none can win: the group is abandoned and its
	 *    claim released, so the brain is woken by the settles and decides.
	 *  - selecting: stopped losers are archived to `wip/` (branch kept) and the
	 *    group closes `merged` once the winner's merge job has landed.
	 */
	async settleGroups(): Promise<number> {
		let changed = 0;
		const groups = await this.deps.handle.db
			.select()
			.from(runGroups)
			.where(
				and(
					eq(runGroups.kind, "competing"),
					inArray(runGroups.status, ["open", "selecting"]),
				),
			);
		for (const g of groups) {
			const members = await this.deps.registry.groupRuns(g.id);
			if (members.length === 0) continue;
			if (g.status === "open") {
				changed += await this.settleOpen(g, members);
			} else {
				changed += await this.settleSelecting(g, members);
			}
		}
		return changed;
	}

	private ended(run: RunRow): boolean {
		return !LIVE.includes(run.state as (typeof LIVE)[number]);
	}

	private async settleOpen(
		g: { id: string; taskId: string; selection: string },
		members: RunRow[],
	): Promise<number> {
		if (members.some((m) => !this.ended(m))) {
			if (g.selection !== "first_verified") return 0;
		}
		const facts: RunFacts[] = [];
		for (const m of members) facts.push(await this.facts(m.id));
		const winnable = facts.filter(
			(f) =>
				f.run &&
				this.ended(f.run) &&
				f.run.state === "completed" &&
				f.verified &&
				f.scopeOutside === 0 &&
				(!f.review ||
					(f.review.status === "ok" && f.review.verdict === "merge")),
		);
		if (g.selection === "first_verified" && winnable[0]?.run) {
			const winner = winnable[0].run;
			const fx: SelectEffects = {
				groupId: g.id,
				runId: winner.id,
				losers: members.filter((m) => m.id !== winner.id).map((m) => m.id),
			};
			await this.applySelectWinner(fx);
			return 1;
		}
		if (members.every((m) => this.ended(m)) && winnable.length === 0) {
			// Nothing in the group can win. Verified-but-reviewed-down members
			// still wait for the brain; only a group with no verified member is dead.
			if (facts.some((f) => f.verified && f.run?.state === "completed"))
				return 0;
			await this.deps.registry.setGroup(g.id, {
				status: "abandoned",
				closedAt: new Date(),
			});
			await this.deps.tasks
				.release(
					g.taskId,
					g.id,
					"ready",
					"scheduler",
					"every attempt of the group ended without a verified result",
				)
				.catch((e) => {
					this.deps.log.warn({ err: e, groupId: g.id }, "group claim release");
				});
			await this.emitGroup(
				g.taskId,
				g.id,
				"abandoned",
				null,
				"no attempt verified",
			);
			return 1;
		}
		return 0;
	}

	private async settleSelecting(
		g: { id: string; taskId: string },
		members: RunRow[],
	): Promise<number> {
		let changed = 0;
		const grp = await this.deps.registry.getGroup(g.id);
		const winnerId = grp?.winnerRunId ?? null;
		for (const m of members) {
			if (m.id === winnerId || !this.ended(m)) continue;
			if (await this.deps.registry.hasPendingCleanup(m.id)) continue;
			if (await this.archiveLoser(m)) changed++;
		}
		if (winnerId) {
			const [job] = await this.deps.handle.db
				.select()
				.from(mergeJobs)
				.where(eq(mergeJobs.runId, winnerId));
			if (job?.state === "merged") {
				await this.deps.registry.setGroup(g.id, {
					status: "merged",
					closedAt: new Date(),
				});
				await this.emitGroup(g.taskId, g.id, "merged", winnerId);
				changed++;
			}
		}
		return changed;
	}

	/** Save a loser's work to `wip/<task>-<run>`, then drop its worktree and keep its branch. */
	private async archiveLoser(run: RunRow): Promise<boolean> {
		if (!run.worktreePath || !run.branch || !run.baseSha) return false;
		const wt = new WorktreeManager(this.deps.projectRoot);
		const handle = {
			path: run.worktreePath,
			branch: run.branch,
			baseSha: run.baseSha,
		};
		const present = (await wt.list()).some(
			(p) => p === run.worktreePath || p.endsWith(run.worktreePath as string),
		);
		if (!present) return false;
		const archive = await wt.archiveWip(handle, {
			runId: run.id,
			taskId: run.taskId,
		});
		await wt.remove(handle, { force: true, deleteBranch: false });
		const event = await this.deps.handle.withTx((tx) =>
			appendEvent(tx, {
				type: "run.wip_archived",
				runId: run.id,
				...(run.taskId ? { taskId: run.taskId } : {}),
				payload: {
					ref: archive?.ref ?? null,
					sha: archive?.sha ?? null,
					actor: "brain",
					reason: "losing attempt",
				},
			}),
		);
		this.deps.bus.publish([event]);
		return true;
	}

	// -----------------------------------------------------------------------
	// boot recovery
	// -----------------------------------------------------------------------

	/**
	 * Re-run what a crash interrupted, in order. Spawns are never launched here
	 * (the scheduler owns dispatch): rows whose pre-minted runs already exist are
	 * adopted as applied; the rest stay `accepted` for the next scheduler pass,
	 * which launches them under the same ids, so a replay can never start a
	 * second run. Every other effect is replayed through `execute`.
	 */
	async recover(): Promise<{
		adopted: number;
		pending: number;
		replayed: number;
	}> {
		let adopted = 0;
		let pending = 0;
		let replayed = 0;
		for (const row of await this.accepted()) {
			if (row.tool === "spawn" || row.tool === "spawn_attempts") {
				const fx = row.effects as SpawnEffects | null;
				const rows = fx?.runIds
					? await Promise.all(fx.runIds.map((id) => this.deps.registry.get(id)))
					: [];
				const allThere =
					rows.length > 0 && rows.every((r) => r && r.state !== "starting");
				if (allThere) {
					await this.settle(row, "applied", {
						effects: { launched: fx?.runIds ?? [], adopted: true },
					});
					adopted++;
				} else pending++;
				continue;
			}
			const out = await this.execute(row.id);
			if (out.status !== "accepted") replayed++;
		}
		return { adopted, pending, replayed };
	}

	/** Mint the ids a spawn will use; recorded on the row before any effect. */
	static mint(): string {
		return ulid();
	}

	/** The turn's session, for callers that only have the turn run id. */
	async sessionOf(turnRunId: string): Promise<string | null> {
		const [t] = await this.deps.handle.db
			.select({ sessionId: brainTurns.sessionId })
			.from(brainTurns)
			.where(eq(brainTurns.runId, turnRunId));
		return t?.sessionId ?? null;
	}

	/** The group of a run, falling back to the run itself. */
	static groupOf(run: { id: string; groupId: string | null }): string {
		return groupIdOf(run);
	}
}

function isCrash(e: unknown): boolean {
	return e instanceof Error && e.name === "InjectedExecutorCrash";
}

/** A crash seam error: models process death, so effects must not catch it. */
export class InjectedExecutorCrash extends Error {
	constructor(readonly point: ExecutorCrashPoint) {
		super(`injected crash at ${point}`);
		this.name = "InjectedExecutorCrash";
	}
}

function heldReason(e: unknown): {
	kind: "overlap" | "provider" | "resource" | "stopped";
	reason: string;
} | null {
	if (e instanceof TaskOwnershipHeldError) {
		return { kind: "overlap", reason: e.message };
	}
	if (e instanceof AdmissionHeldError) {
		return {
			kind: e.code === "provider_held" ? "provider" : "resource",
			reason: e.message,
		};
	}
	if (e instanceof DispatchPreflightError) {
		return {
			kind: e.code === "provider_held" ? "provider" : "resource",
			reason: e.message,
		};
	}
	if (e instanceof GlobalStopError) {
		return { kind: "stopped", reason: e.message };
	}
	return null;
}
