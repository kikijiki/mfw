import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectDbHandle } from "@mfw/db/client";
import { ulid } from "@mfw/db/ids";
import type { RunReasoningEffort, RunRelation, RunRole } from "@mfw/db/schema";
import type { AdapterRegistry } from "./agents/adapter.ts";
import {
	BRAIN_TURN_LABEL,
	type BrainTurnLaunch,
	isBrainTurnRun,
	readBrainTurnLaunch,
	writeBrainTurnLaunch,
} from "./brain-runtime/turn-run.ts";
import {
	type DispatchPreflightDeps,
	DispatchPreflightError,
	preflightDispatch,
} from "./dispatch-preflight.ts";
import type { SecretEnvironment } from "./execution-environment.ts";
import {
	ExecutionLaunchUncertainError,
	type ExecutionOwnership,
	ExecutionTargetRegistry,
	type ExecutionTargetSelector,
	executionOwnerKey,
	InvalidExecutionTargetRequirementsError,
	type ResolvedExecutionTarget,
	resolveExecutionTarget,
	type TargetResolutionInput,
	targetOperationId,
	UnknownExecutionTargetError,
} from "./execution-target.ts";
import type { HostAdmissionSnapshot } from "./host-resources/index.ts";
import {
	createLocalExecutionTarget,
	type LocalExecutionHost,
} from "./local-execution-target.ts";
import type { Logger } from "./log.ts";
import {
	type ProviderHold,
	providerForRun,
	type RouteInput,
	type RoutingDecision,
	type RoutingSettings,
	routeVendor,
	routeWith,
	routingRecord,
} from "./routing.ts";
import { RunEventTail } from "./run-event-tail.ts";
import type { RunRegistry, RunRow } from "./run-registry.ts";
import type { BwrapIsolation } from "./sandbox.ts";
import {
	runHoldsClaim,
	type StatusActor,
	type TaskService,
	type TaskWithRefs,
} from "./task-service.ts";

/**
 * RunEngine v2: starts runs of every kind. Every run gets a
 * canonical worktree off the recorded integration branch: the primary
 * checkout is never branched, checked out, or reset. Start order is
 * journal-shaped and split at the admission-safe seam:
 *
 *   prepare: resolve → claim → starting row/run dir → status move → worktree
 *   launch:  invocation → selected target launch → "running"
 *
 * A throw anywhere transitions the run to ended/start_failed; the supervisor
 * finalizes it via the machine's T2 row (release claim, task → ready, GC).
 * Steering is triple-gated: adapter declares → driver verifies via hello →
 * steer() checks the verified capability.
 */

export interface RunEngineDeps {
	handle: ProjectDbHandle;
	registry: RunRegistry;
	tasks: TaskService;
	/** Compatibility composition input; wrapped by LocalExecutionTarget. */
	host?: LocalExecutionHost;
	/** Fully constructed adapters, normally injected by process composition. */
	executionTargets?: ExecutionTargetSelector;
	/** Stable project identity from the process-global project registry. */
	projectId?: string;
	/** Pure task-to-target policy hook; it must not acquire leases or call providers. */
	resolveTaskExecutionTarget?: (
		task: TaskWithRefs,
	) => TargetResolutionInput | Promise<TargetResolutionInput>;
	/** Project defaults; task grant ids are unioned and snapshotted into the run. */
	workloadSecretGrantIds?: readonly string[];
	resolveWorkloadSecrets?: (selection: {
		projectId: string;
		taskId: string | null;
		grantIds: readonly string[];
	}) => Promise<{
		secretEnvironment: SecretEnvironment;
		/** Opaque machine credential version binding, never derived from a value. */
		binding: string;
	}>;
	adapters: AdapterRegistry;
	log: Logger;
	projectRoot: string;
	projectName: string;
	integrationBranch: string;
	/**
	 * Live project provider/model/tiers/effort/routing (`routing.ts`), read
	 * once per run at prepare. Launch never reads it for the provider: a
	 * prepared run launches with the route persisted on its row.
	 */
	routing: () => RoutingSettings;
	/** Machine-wide rate-limit holds (`provider-holds.ts`). Absent = none. */
	providerHolds?: {
		snapshot(): Promise<(key: string) => ProviderHold | null>;
	};
	/**
	 * The exhausted resource budget a task depends on (`BudgetService.holdFor`).
	 * A task start that depends on it is refused at preflight, human or not.
	 */
	budgetHold?: (task: {
		requiresResources?: readonly (string | { id: string })[] | null;
		executionTarget?: string | null;
	}) => Promise<{ key: string; until: number; reason: string } | null>;
	/** Outcome priors, used only to order fallbacks. Absent = configured order. */
	outcomePriors?: () => Promise<RouteInput["prior"] | undefined>;
	defaults: {
		leaseMs: number;
		approvalMode?: "autonomous" | "interactive";
	};
	/**
	 * Machine-wide master stop (same getter as the schedulers, `boot.ts`
	 * `opts.globalPaused`). `startTask` bypasses `Scheduler.dispatch`, so it
	 * checks this itself. Other dispatch gates (pause, hold, `main_red`,
	 * `maxConcurrent`, slots) stay bypassed: a human picking a task overrides
	 * queue policy. Absent = no global stop.
	 */
	globalPaused?: () => { reason: string } | null;
	/** Filesystem-isolate every run from the daemon's own home. Undefined = unsandboxed. */
	isolation?: BwrapIsolation;
	/** Dispatch preflight for local task runs (`dispatch-preflight.ts`). Absent = no preflight. */
	preflight?: Pick<
		DispatchPreflightDeps,
		"memoryFloorBytes" | "memAvailableBytes"
	>;
	/** Starting provider work preempts a low-priority regression sweep. */
	beforeLaunch?: () => void;
	buildPrompt: {
		task: (taskId: string) => Promise<string>;
		/**
		 * The prompt of a `continue:<runId>` spawn: the task, plus what the
		 * parent's settle says went wrong (failed checks, review findings, the
		 * answered question, interrupted work, a merge conflict).
		 */
		continuation: (taskId: string, parentRunId: string) => Promise<string>;
		import: () => Promise<string>;
		plan: (
			goal: string,
			answers?: { question: string; answer: string }[],
			opts?: { autonomous?: boolean },
		) => Promise<string>;
	};
}

/**
 * Runs that must not start work a later turn would have to collect: a run is
 * one-shot, so when its turn ends the session closes and a background agent
 * or scheduled wakeup is killed unseen. Task and repair runs (the coding
 * work) and draft expansion (which must answer in its final message).
 */
export function noBackgroundAgents(run: {
	kind: string;
	taskId?: string | null;
}): boolean {
	if (run.kind === "task" || run.kind === "repair") return true;
	return run.kind === "plan" && !!run.taskId;
}

/**
 * The placement a target resolver recorded in the requested shape
 * (`{ hostId, placement: { harnesses } }` for a registry SSH host), as
 * routing reads it. Absent for local/RunPod targets.
 */
export function placementOf(
	target: Partial<Pick<ResolvedExecutionTarget, "kind" | "requestedShape">>,
): RouteInput["placement"] | undefined {
	const shape = target.requestedShape;
	const hostId = typeof shape?.hostId === "string" ? shape.hostId : null;
	if (!hostId || !target.kind) return undefined;
	const placement = shape?.placement as { harnesses?: unknown } | undefined;
	const harnesses = Array.isArray(placement?.harnesses)
		? placement.harnesses.filter((h): h is string => typeof h === "string")
		: null;
	return { target: target.kind, hostId, harnesses };
}

export interface PreparedTaskRun {
	runId: string;
	taskId: string | null;
	target: ResolvedExecutionTarget;
}

/**
 * A task start refused because its route is rate-limit held. A preflight
 * refusal (with its fix), so admission turns it into a hold and the
 * scheduler counts the task as held, not as an error.
 */
export class ProviderHeldError extends DispatchPreflightError {
	constructor(
		readonly taskId: string,
		readonly hold: ProviderHold & { key: string },
	) {
		super(
			"provider_held",
			[hold.key],
			`task ${taskId} routes to ${hold.key}, which is held until ${new Date(hold.until).toISOString()}: ${hold.reason}`,
		);
		this.name = "ProviderHeldError";
	}
}

export interface TaskDispatchAdmissionPort {
	startTask(
		taskId: string,
		opts?: {
			model?: string;
			actor?: StatusActor;
			hostSnapshot?: HostAdmissionSnapshot;
		},
	): Promise<{ runId: string }>;
	captureAdmissionSnapshot?(): HostAdmissionSnapshot;
	/**
	 * Admit one run of a task that may have siblings (an attempt group): the
	 * planned run id is its own admission, so sibling attempts of one task
	 * never supersede each other the way a continuation does.
	 */
	startRun?(input: {
		taskId: string;
		runId: string;
		target: ResolvedExecutionTarget;
		prepare: () => Promise<PreparedTaskRun>;
		hostSnapshot?: HostAdmissionSnapshot;
	}): Promise<{ runId: string }>;
	startContinuation?(input: {
		taskId: string;
		parentRunId: string;
		runId: string;
		target: ResolvedExecutionTarget;
		prepare: () => Promise<PreparedTaskRun>;
	}): Promise<{ runId: string }>;
	syncEligibleTasks?(taskIds: readonly string[]): Promise<void>;
}

interface RunLaunchSpec {
	runId: string;
	kind: "task" | "repair" | "import" | "plan" | "action" | "brain";
	taskId?: string;
	parentRunId?: string;
	label: string;
	/** Decided once, before any write; persisted on the row at prepare. */
	route: RoutingDecision;
	steer: boolean;
	prompt: string;
	goal?: string;
	reuse?: { worktreePath: string; branch: string; baseSha?: string };
	attempt?: number;
	resumeOrdinal?: number;
	workloadSecretGrantIds?: string[];
	/** A project-brain turn's native-session and MCP launch facts. */
	brain?: BrainTurnLaunch;
	/** Attempt group and role (0017); a group of one is named after its run. */
	groupId?: string;
	role?: RunRole;
	/** Typed lineage written at row creation; the registry derives it when absent. */
	relation?: RunRelation;
	/** Non-run origin (`session:<id>`, `trigger:<id>`, `clarify:<runId>`, `human:<actor>`). */
	originRef?: string;
	spawnedByDecisionId?: number;
}

/** One run of an attempt group, as the brain's action executor asks for it. */
export interface GroupRunSpec {
	runId: string;
	taskId: string;
	/** The claim holder; a group of one is named after its run. */
	groupId: string;
	groupKind: "single" | "competing";
	selection?: "brain" | "first_verified";
	role: "implement" | "attempt";
	/** The `brain_actions.id` and `decisions.id` that asked for the run. */
	actionId?: string;
	decisionId?: number;
	/** Origin of the run; absent = `brain:<actionId>`. A person's reroute names itself `human:ui`. */
	originRef?: string;
	brief?: string;
	/** The brain's harness / model / effort pick (`routeRun` rule `brain`). */
	pick?: NonNullable<RouteInput["brain"]>;
	/** Placement in `execution_target` syntax (`local`, `ssh:<host>`, `runpod`). */
	target?: string;
	worktree: { mode: "new" } | { mode: "continue"; runId: string };
}

/** A brain turn has no worktree; its row records this in place of a base commit. */
export const BRAIN_BASE_SHA = "0".repeat(40);

export class RunEngine {
	private readonly targets: ExecutionTargetSelector;
	private taskAdmission: TaskDispatchAdmissionPort | null = null;
	/**
	 * Incremental per-run fold of `events.jsonl` (approvals, turns, activity).
	 * Shared with the Supervisor so both read each transcript byte once.
	 */
	readonly eventTail: RunEventTail;

	get admissionIntegrated(): boolean {
		return this.taskAdmission !== null;
	}

	constructor(private readonly deps: RunEngineDeps) {
		this.eventTail = new RunEventTail((runId, offset) =>
			deps.registry.readOutput(runId, "events.jsonl", offset),
		);
		if (deps.executionTargets) {
			this.targets = deps.executionTargets;
		} else {
			if (!deps.host) {
				throw new Error(
					"RunEngine requires executionTargets or a local execution host",
				);
			}
			this.targets = new ExecutionTargetRegistry([
				createLocalExecutionTarget({
					projectRoot: deps.projectRoot,
					integrationBranch: deps.integrationBranch,
					host: deps.host,
				}),
			]);
		}
	}

	async startTask(
		taskId: string,
		opts: {
			model?: string;
			actor?: StatusActor;
			hostSnapshot?: HostAdmissionSnapshot;
		} = {},
	): Promise<{ runId: string }> {
		if (this.taskAdmission) return this.taskAdmission.startTask(taskId, opts);
		const prepared = await this.prepareTaskRun(taskId, opts);
		return this.launchPreparedRun(prepared);
	}

	/**
	 * Start one run of an attempt group, with a pre-minted id. The brain's
	 * `spawn` / `spawn_attempts` land here (through the action executor): the
	 * route rule is `brain`, the claim is the group's (taken once, by whichever
	 * member prepares first), and every member gets its own worktree unless it
	 * continues a settled run's.
	 *
	 * Idempotent by `runId`: a replay after a crash finds the prepared or
	 * running row and finishes the launch instead of minting a second run.
	 */
	async startGroupRun(
		spec: GroupRunSpec,
		opts: { hostSnapshot?: HostAdmissionSnapshot } = {},
	): Promise<{ runId: string }> {
		const existing = await this.deps.registry.get(spec.runId);
		if (existing?.state === "running") return { runId: existing.id };
		if (existing && existing.state !== "starting") {
			return { runId: existing.id };
		}
		const target = await this.resolveTaskExecutionTarget(
			spec.taskId,
			undefined,
			spec.target,
		);
		const prepare = () => this.prepareGroupRun(spec, target);
		if (this.taskAdmission?.startRun) {
			return this.taskAdmission.startRun({
				taskId: spec.taskId,
				runId: spec.runId,
				target,
				prepare,
				...(opts.hostSnapshot ? { hostSnapshot: opts.hostSnapshot } : {}),
			});
		}
		if (existing) return this.launchPreparedRun({ runId: existing.id });
		return this.launchPreparedRun(await prepare());
	}

	private async prepareGroupRun(
		spec: GroupRunSpec,
		target: ResolvedExecutionTarget,
	): Promise<PreparedTaskRun> {
		const halted = this.deps.globalPaused?.();
		if (halted) throw new GlobalStopError(halted.reason);
		const task = await this.deps.tasks.get(spec.taskId);
		if (!task) throw new TaskNotClaimableError(spec.taskId);
		// A `continue:<runId>` spawn is what repair, resume, an answered question
		// and a parked merge used to be: the same worktree and branch, with what
		// the parent's settle recorded in the prompt. The brain's pick wins; with
		// none, the continuation keeps the parent's harness, model and effort.
		let reuse: RunLaunchSpec["reuse"];
		let parentRunId: string | undefined;
		let parentAttempt = 0;
		let pick = spec.pick;
		let base: string;
		if (spec.worktree.mode === "continue") {
			const parent = await this.deps.registry.get(spec.worktree.runId);
			if (!parent?.worktreePath || !parent.branch) {
				throw new Error(
					`run ${spec.worktree.runId} has no worktree to continue`,
				);
			}
			parentRunId = parent.id;
			parentAttempt = parent.attempt;
			reuse = {
				worktreePath: parent.worktreePath,
				branch: parent.branch,
				baseSha: parent.baseSha ?? undefined,
			};
			if (!pick && parent.providerId) {
				pick = {
					provider: parent.providerId,
					...(parent.model ? { model: parent.model } : {}),
					...(parent.reasoningEffort ? { effort: parent.reasoningEffort } : {}),
				};
			}
			base = await this.deps.buildPrompt.continuation(spec.taskId, parent.id);
			// The parent's question report is journaled on it; left in place the
			// child's own finalize would ingest it and ask the same question again.
			await rm(join(parent.worktreePath, "MFW_REPORT.json"), { force: true });
		} else {
			base = await this.deps.buildPrompt.task(spec.taskId);
		}
		const prompt = spec.brief
			? `${base}\n\n## Brief from the project brain\n\n${spec.brief}\n`
			: base;
		const route = await this.routeTask(task, {
			target: target.kind,
			placement: placementOf(target),
			...(pick ? { brain: pick } : {}),
		});
		const claimed = task.claimedByGroupId;
		if (claimed !== spec.groupId) {
			if (route.held) throw new ProviderHeldError(spec.taskId, route.held);
			await this.preflightTask(spec.runId, target);
			const ok = await this.deps.tasks.tryClaim(
				spec.taskId,
				spec.groupId,
				this.deps.defaults.leaseMs,
				"scheduler",
				"ready",
				spec.groupId === spec.runId ? undefined : { leadRunId: spec.runId },
			);
			if (!ok) throw new TaskNotClaimableError(spec.taskId);
		}
		await this.deps.registry.ensureGroup({
			id: spec.groupId,
			taskId: spec.taskId,
			kind: spec.groupKind,
			selection: spec.selection ?? "brain",
			createdByAction: spec.actionId ?? null,
		});
		return this.prepareRun(
			{
				runId: spec.runId,
				kind: "task",
				taskId: spec.taskId,
				label: `${spec.taskId}#${spec.role}`,
				groupId: spec.groupId,
				role: spec.role,
				relation: reuse
					? "continue"
					: spec.role === "attempt"
						? "attempt"
						: "fresh",
				...(parentRunId ? { parentRunId } : {}),
				originRef: spec.originRef ?? `brain:${spec.actionId ?? "unknown"}`,
				...(spec.decisionId !== undefined
					? { spawnedByDecisionId: spec.decisionId }
					: {}),
				route,
				steer: true,
				prompt,
				...(reuse ? { reuse, attempt: parentAttempt + 1 } : {}),
				workloadSecretGrantIds: [
					...new Set([
						...(this.deps.workloadSecretGrantIds ?? []),
						...(task.workloadSecretGrants ?? []),
					]),
				].sort(),
			},
			target,
		);
	}

	captureAdmissionSnapshot(): HostAdmissionSnapshot | undefined {
		return this.taskAdmission?.captureAdmissionSnapshot?.();
	}

	/** Production composition installs exactly one admission owner. */
	setTaskAdmission(admission: TaskDispatchAdmissionPort): void {
		if (this.taskAdmission && this.taskAdmission !== admission) {
			throw new Error("task dispatch admission is already installed");
		}
		this.taskAdmission = admission;
	}

	async syncEligibleTasks(taskIds: readonly string[]): Promise<void> {
		await this.taskAdmission?.syncEligibleTasks?.(taskIds);
	}

	/**
	 * Claim and durably prepare one task attempt. May create the worktree but
	 * never launches a driver or process, so admission can lease capacity
	 * before `launchPreparedRun`.
	 */
	async prepareTaskRun(
		taskId: string,
		opts: {
			model?: string;
			actor?: StatusActor;
			target?: TargetResolutionInput | ResolvedExecutionTarget;
			runId?: string;
		} = {},
	): Promise<PreparedTaskRun> {
		const halted = this.deps.globalPaused?.();
		if (halted) throw new GlobalStopError(halted.reason);
		const target = await this.resolveTaskExecutionTarget(taskId, opts.target);
		// Build the prompt before the atomic claim: a render failure must not leave an in-progress task with no run row.
		const prompt = await this.deps.buildPrompt.task(taskId);
		const runId = opts.runId ?? ulid();
		const current = await this.deps.tasks.get(taskId);
		// Routed before the claim: an unknown task provider or a held route
		// refuses with nothing written.
		const route = await this.routeTask(current, {
			model: opts.model,
			actor: opts.actor,
			target: target.kind,
			placement: placementOf(target),
		});
		if (current?.claimedByGroupId !== runId) {
			if (route.held) throw new ProviderHeldError(taskId, route.held);
			await this.preflightTask(runId, target);
			const claimed = await this.deps.tasks.tryClaim(
				taskId,
				runId,
				this.deps.defaults.leaseMs,
				opts.actor ?? "scheduler",
			);
			if (!claimed) throw new TaskNotClaimableError(taskId);
		}
		this.deps.log.debug(
			{
				taskId,
				provider: route.holdKey,
				model: route.model,
				rule: route.reason,
			},
			"routed task run",
		);
		return this.prepareRun(
			{
				runId,
				kind: "task",
				taskId,
				label: taskId,
				role: "implement",
				relation: "fresh",
				route,
				steer: true,
				prompt,
				workloadSecretGrantIds: [
					...new Set([
						...(this.deps.workloadSecretGrantIds ?? []),
						...(current?.workloadSecretGrants ?? []),
					]),
				].sort(),
			},
			target,
		);
	}

	/**
	 * The route a fresh run of `task` would get now (no writes). The
	 * scheduler asks this to skip a task whose route is held; a human start
	 * (`actor: "human"`) or an explicit model overrides holds.
	 */
	async routeTask(
		task: Pick<TaskWithRefs, "provider" | "model" | "modelTier"> | null,
		opts: {
			model?: string;
			actor?: StatusActor;
			target?: string;
			placement?: RouteInput["placement"];
			brain?: RouteInput["brain"];
		} = {},
	): Promise<RoutingDecision> {
		return routeWith(this.router(), {
			kind: "task",
			...(opts.brain ? { brain: opts.brain } : {}),
			...(opts.model ? { explicit: { model: opts.model } } : {}),
			task: task
				? {
						provider: task.provider ?? null,
						model: task.model ?? null,
						modelTier: task.modelTier ?? null,
					}
				: null,
			ignoreHolds: opts.actor === "human",
			target: opts.target ?? "local",
			...(opts.placement ? { placement: opts.placement } : {}),
		});
	}

	private router() {
		return {
			settings: this.deps.routing,
			...(this.deps.providerHolds ? { holds: this.deps.providerHolds } : {}),
			...(this.deps.outcomePriors ? { priors: this.deps.outcomePriors } : {}),
		};
	}

	/** Route a run that is not a task attempt (plan, import, action, session).
	 *  A held primary moves to a fallback when one is free; with none it
	 *  still starts: these runs were never gated by holds. */
	private async routeOther(
		kind: "plan" | "import" | "action",
		model: string | undefined,
	): Promise<RoutingDecision> {
		const route = await routeWith(this.router(), {
			kind,
			...(model ? { explicit: { model } } : {}),
		});
		return route.held ? { ...route, held: null } : route;
	}

	/**
	 * Refuse a local task dispatch before the claim when it cannot succeed or
	 * would hurt the host (`DispatchPreflightError`, with a fix). Admission
	 * calls this before taking any lease; `prepareTaskRun` repeats it. With
	 * `taskId`, a held route refuses too (`ProviderHeldError`).
	 */
	async preflightTask(
		runId: string,
		target: Pick<ResolvedExecutionTarget, "kind"> &
			Partial<Pick<ResolvedExecutionTarget, "requestedShape">>,
		taskId?: string,
		actor?: StatusActor,
	): Promise<void> {
		if (taskId) {
			const task = await this.deps.tasks.get(taskId);
			const route = await this.routeTask(task, {
				actor,
				target: target.kind,
				placement: placementOf(target),
			});
			if (route.held) throw new ProviderHeldError(taskId, route.held);
			const spent = this.deps.budgetHold
				? await this.deps.budgetHold({
						requiresResources: task?.requiresResources,
						executionTarget: placementOf(target)?.hostId
							? `ssh:${placementOf(target)?.hostId}`
							: target.kind,
					})
				: null;
			if (spent) {
				throw new DispatchPreflightError(
					"budget_exhausted",
					[spent.key],
					`task ${taskId} depends on ${spent.key}: ${spent.reason}`,
				);
			}
		}
		if (!this.deps.preflight || target.kind !== "local") return;
		await preflightDispatch(
			{
				projectRoot: this.deps.projectRoot,
				integrationBranch: this.deps.integrationBranch,
				...this.deps.preflight,
			},
			runId,
		);
	}

	/** Reverse the claim/run half of an admission that never launched. */
	async abortPreparedTaskRun(
		taskId: string,
		runId: string,
		reason: string,
		actor: StatusActor = "scheduler",
	): Promise<void> {
		const run = await this.deps.registry.get(runId);
		if (run) {
			if (run.state === "starting") {
				await this.deps.registry.recordExit(runId, { outcome: "start_failed" });
			}
		}
		const task = await this.deps.tasks.get(taskId);
		// A sibling attempt that failed to start leaves the group's claim alone
		// while another member of the group is still live.
		if (
			runHoldsClaim(task, run ?? { id: runId }) &&
			!(await this.deps.tasks.siblingsLive(runId))
		) {
			await this.deps.tasks.release(taskId, runId, "ready", actor, reason);
		}
	}

	/** Read-only placement resolution for admission; acquire the requirements, then pass the resolution to `prepareTaskRun`. */
	async resolveTaskExecutionTarget(
		taskId: string,
		override?: TargetResolutionInput | ResolvedExecutionTarget,
		/** The brain's placement for this run, in `execution_target` syntax. */
		executionTarget?: string,
	): Promise<ResolvedExecutionTarget> {
		const stored = await this.deps.tasks.get(taskId);
		if (!stored) throw new TaskNotClaimableError(taskId);
		const task = executionTarget ? { ...stored, executionTarget } : stored;
		const targetInput = override ??
			(await this.deps.resolveTaskExecutionTarget?.(task)) ?? {
				kind: task.executionTarget,
				requiresResources: task.requiresResources,
				localStagingResources: task.localStagingResources,
			};
		const target =
			"requirements" in targetInput
				? targetInput
				: resolveExecutionTarget(targetInput);
		if (
			target.kind !== "local" &&
			target.requirements.executionHost.length > 0
		) {
			throw new InvalidExecutionTargetRequirementsError(
				`execution target '${target.kind}' cannot carry execution-host requirements`,
			);
		}
		this.requireTarget(target.kind);
		return target;
	}

	/** Start a first-class recovery run without reopening or claiming the
	 * historical board task whose DoD exposed the regression. */
	async startRegressionRepair(
		taskId: string,
		incidentId: string,
		detail: string,
	): Promise<{ runId: string }> {
		const taskPrompt = await this.deps.buildPrompt.task(taskId);
		// A recovery is new work, not a continuation: routed fresh with the
		// task's pins, and (like plan/action runs) never refused by a hold.
		const routed = await this.routeTask(await this.deps.tasks.get(taskId), {
			actor: "human",
		});
		const spec: RunLaunchSpec = {
			runId: ulid(),
			kind: "repair",
			taskId,
			label: `recovery:${incidentId}`,
			relation: "recovery",
			route: routed,
			steer: true,
			prompt: [
				`You are repairing autonomous recovery incident ${incidentId}.`,
				"The integration branch is red. Diagnose and fix the regression; do not reimplement the historical task blindly.",
				`Observed failure: ${detail}`,
				"The deterministic verifier will decide whether this repair can merge.",
				"",
				taskPrompt,
			].join("\n"),
		};
		if (this.taskAdmission?.startContinuation) {
			const target = await this.resolveTaskExecutionTarget(taskId);
			return this.taskAdmission.startContinuation({
				taskId,
				parentRunId: "",
				runId: spec.runId,
				target,
				prepare: () => this.prepareRun(spec, target),
			});
		}
		return this.launch(spec);
	}
	async startImport(
		opts: { runId?: string; model?: string; originRef?: string } = {},
	): Promise<{ runId: string }> {
		return this.launch({
			runId: opts.runId ?? ulid(),
			kind: "import",
			label: "import",
			relation: "fresh",
			route: await this.routeOther("import", opts.model),
			...(opts.originRef ? { originRef: opts.originRef } : {}),
			steer: false,
			prompt: await this.deps.buildPrompt.import(),
		});
	}

	/** `answers` re-plans against a resolved clarify set; `goal` stays the original goal on the row.
	 *
	 *  `taskId`: the plan run expands one `draft` task instead of proposing a new
	 *  DAG. `launch()` only claims for `kind === "task"`; `createTasks` in
	 *  `finalize/step-runner.ts` handles the different success/failure treatment. */
	async startPlan(
		goal: string,
		opts: {
			runId?: string;
			model?: string;
			answers?: { question: string; answer: string }[];
			taskId?: string;
			parentRunId?: string;
			originRef?: string;
		} = {},
	): Promise<{ runId: string }> {
		const runId = opts.runId ?? ulid();
		if (opts.taskId) {
			const claimed = await this.deps.tasks.tryClaimDraftExpansion(
				opts.taskId,
				runId,
				this.deps.defaults.leaseMs,
			);
			if (!claimed) throw new TaskNotClaimableError(opts.taskId);
		}
		try {
			// A draft without human review must not ask questions; `recordQuestions` drops any the planner raises.
			const requireReview = opts.taskId
				? ((await this.deps.tasks.get(opts.taskId))?.requireReview ?? false)
				: false;
			return await this.launch({
				runId,
				kind: "plan",
				taskId: opts.taskId,
				parentRunId: opts.parentRunId,
				label: opts.taskId
					? "plan#expand"
					: opts.answers?.length
						? "plan#replan"
						: "plan",
				relation: opts.parentRunId ? "replan" : "fresh",
				// A re-plan consuming clarify answers is caused by the asking run's question.
				...(opts.originRef
					? { originRef: opts.originRef }
					: opts.parentRunId && opts.answers?.length
						? { originRef: `clarify:${opts.parentRunId}` }
						: {}),
				route: await this.routeOther("plan", opts.model),
				steer: false,
				prompt: await this.deps.buildPrompt.plan(goal, opts.answers, {
					autonomous: !!opts.taskId && !requireReview,
				}),
				goal,
			});
		} catch (error) {
			if (opts.taskId) {
				await this.deps.tasks
					.release(
						opts.taskId,
						runId,
						"draft",
						"brain",
						"draft expansion failed to start",
					)
					.catch(() => {});
			}
			throw error;
		}
	}

	async startAction(
		prompt: string,
		opts: { model?: string; originRef?: string } = {},
	): Promise<{ runId: string }> {
		return this.launch({
			runId: ulid(),
			kind: "action",
			label: "action",
			// A trigger-launched action is `trigger`, a hand-started one `fresh`.
			relation: opts.originRef?.startsWith("trigger:") ? "trigger" : "fresh",
			...(opts.originRef ? { originRef: opts.originRef } : {}),
			route: await this.routeOther("action", opts.model),
			steer: true,
			prompt,
		});
	}

	/**
	 * `SessionService.open()`'s hand-started `action` run. Like `startAction`,
	 * but reuses the session's worktree when named (blocked task or parked merge
	 * job run); without `reuse` it gets a fresh worktree off the integration branch.
	 */
	async startSession(
		prompt: string,
		opts: {
			model?: string;
			reuse?: { worktreePath: string; branch: string; baseSha?: string };
			/** The escalation session this run opens (`runs.origin_ref = session:<id>`). */
			sessionId?: string;
		} = {},
	): Promise<{ runId: string }> {
		return this.launch({
			runId: ulid(),
			kind: "action",
			label: "session",
			relation: "session",
			...(opts.sessionId ? { originRef: `session:${opts.sessionId}` } : {}),
			route: await this.routeOther("action", opts.model),
			steer: true,
			prompt,
			reuse: opts.reuse,
		});
	}

	/**
	 * Resolve a configured brain route (`brain.routes[i]`) to a concrete
	 * decision, plus whether its account is held. A brain route is explicit, so
	 * `routeRun` never reports it held; the candidate carries the truth.
	 */
	async routeBrain(target: {
		provider: string;
		model?: string;
		effort?: RunReasoningEffort;
	}): Promise<{
		route: RoutingDecision;
		held: (ProviderHold & { key: string }) | null;
	}> {
		const route = await routeWith(this.router(), {
			kind: "action",
			explicit: {
				provider: target.provider,
				...(target.model ? { model: target.model } : {}),
				...(target.effort ? { effort: target.effort } : {}),
			},
		});
		const first = route.candidates[0];
		return {
			route,
			held: first?.held ? { key: first.holdKey, ...first.held } : null,
		};
	}

	/**
	 * One project-brain turn: a `kind: brain` run in tmux, in the session's
	 * scratch dir (no worktree, no claim, no task). The caller pre-minted
	 * `runId` and journaled the turn before this launch, so a crash anywhere
	 * in here leaves a turn row recovery can close.
	 */
	async startBrainTurn(opts: {
		runId: string;
		route: RoutingDecision;
		prompt: string;
		scratchDir: string;
		launch: BrainTurnLaunch;
	}): Promise<{ runId: string }> {
		await writeBrainTurnLaunch(
			this.deps.registry.runDir(opts.runId),
			opts.launch,
		);
		return this.launch({
			runId: opts.runId,
			kind: "brain",
			role: "brain",
			label: BRAIN_TURN_LABEL,
			route: opts.route,
			steer: false,
			prompt: opts.prompt,
			reuse: {
				worktreePath: opts.scratchDir,
				branch: "mfw-brain",
				baseSha: BRAIN_BASE_SHA,
			},
			brain: opts.launch,
		});
	}

	/** Kill the session; the supervisor's next pass finalizes (T3). Never finalizes inline. */
	async stop(runId: string): Promise<void> {
		const run = await this.deps.registry.get(runId);
		if (!run) throw new Error(`unknown run ${runId}`);
		const target = this.requireTarget(run.executionTarget);
		const ref = await this.targetRefWithSecrets(run);
		if (run.capabilities.verified && run.capabilities.interrupt) {
			await target.control(ref, { type: "interrupt" });
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline) {
				const observed = await target.observe(ref);
				if (observed.state === "exited" || observed.state === "absent") return;
				await Bun.sleep(100);
			}
		}
		await target.control(ref, { type: "kill", reason: "manual" });
	}

	/** Observe through the selected target and sync remote evidence. */
	async observeRun(runId: string) {
		const run = await this.deps.registry.get(runId);
		if (!run) throw new Error(`unknown run ${runId}`);
		return this.requireTarget(run.executionTarget).observe(
			await this.targetRefWithSecrets(run),
		);
	}

	async killRun(runId: string, reason: string): Promise<void> {
		const run = await this.deps.registry.get(runId);
		if (!run) throw new Error(`unknown run ${runId}`);
		await this.requireTarget(run.executionTarget).control(
			await this.targetRefWithSecrets(run),
			{
				type: "kill",
				reason,
			},
		);
	}

	/**
	 * Pull remote evidence into the local worktree, then dispose the provider
	 * allocation even if collection failed. Only confirmed absence counts as
	 * cleaned up; a provider error leaves the intent for boot/shutdown retry.
	 */
	async finalizeExecutionTarget(runId: string): Promise<{
		collectionError: unknown | null;
	}> {
		const run = await this.deps.registry.get(runId);
		if (!run) throw new Error(`unknown run ${runId}`);
		if (run.targetAbsenceConfirmedAt) return { collectionError: null };
		const target = this.requireTarget(run.executionTarget);
		const owner = this.owner(run);
		const ref = await this.targetRefWithSecrets(run);
		let collectionError: unknown | null = null;
		await this.deps.registry.recordTargetLifecycle({
			runId,
			operationId: targetOperationId(owner, "collect/intent"),
			phase: "collect",
			status: "intent",
			lifecycleState: "collecting",
			targetKind: target.kind,
			targetLeaseRef: run.targetLeaseRef,
		});
		try {
			const observation = await target.observe(ref);
			if (observation.state === "running") {
				await target.control(ref, { type: "kill", reason: "finalize" });
			}
			const collected = await target.collect(ref);
			await this.deps.registry.recordTargetLifecycle({
				runId,
				operationId: targetOperationId(owner, "collect/completed"),
				phase: "collect",
				status: "completed",
				lifecycleState: "disposing",
				targetKind: target.kind,
				targetLeaseRef: run.targetLeaseRef,
				observedShape: collected.observedShape
					? { ...collected.observedShape }
					: null,
			});
		} catch (error) {
			collectionError = error;
			await this.deps.registry.recordTargetLifecycle({
				runId,
				operationId: targetOperationId(owner, "collect/failed"),
				phase: "collect",
				status: "failed",
				lifecycleState: "cleanup_pending",
				targetKind: target.kind,
				targetLeaseRef: run.targetLeaseRef,
				detail: { code: "collection_failed" },
			});
		}

		await this.deps.registry.recordTargetLifecycle({
			runId,
			operationId: targetOperationId(owner, "dispose/intent"),
			phase: "dispose",
			status: "intent",
			lifecycleState: "disposing",
			targetKind: target.kind,
			targetLeaseRef: run.targetLeaseRef,
		});
		try {
			const disposed = await target.dispose(ref);
			if (!disposed.absenceConfirmed) {
				throw new Error(`target ${target.kind} did not prove absence`);
			}
			await this.deps.registry.recordTargetLifecycle({
				runId,
				operationId: targetOperationId(owner, "dispose/completed"),
				phase: "dispose",
				status: "completed",
				lifecycleState: "absent",
				targetKind: target.kind,
				targetLeaseRef: run.targetLeaseRef,
				observedShape: disposed.observedShape
					? { ...disposed.observedShape }
					: null,
			});
		} catch (error) {
			await this.deps.registry.recordTargetLifecycle({
				runId,
				operationId: targetOperationId(owner, "dispose/failed"),
				phase: "dispose",
				status: "failed",
				lifecycleState: "cleanup_pending",
				targetKind: target.kind,
				targetLeaseRef: run.targetLeaseRef,
				detail: { code: "absence_unproven" },
			});
			throw collectionError
				? new AggregateError(
						[collectionError, error],
						"target collection and disposal failed",
					)
				: error;
		}
		return { collectionError };
	}

	/** Best-effort process control followed by mandatory target cleanup. */
	async drainExecutionTargets(reason: string): Promise<void> {
		const runs = await this.deps.registry.list({
			states: ["starting", "running", "ended", "finalizing"],
		});
		const errors: unknown[] = [];
		for (const run of runs.filter((item) => item.kind !== "brain")) {
			if (run.state === "starting" || run.state === "running") {
				try {
					await this.killRun(run.id, reason);
				} catch (error) {
					errors.push(error);
				}
				await this.deps.registry.recordExit(run.id, { outcome: "interrupted" });
			}
			try {
				const result = await this.finalizeExecutionTarget(run.id);
				if (result.collectionError) errors.push(result.collectionError);
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length > 0)
			throw new AggregateError(errors, "execution target drain failed");
	}

	/** Triple gate: declared (adapter) → verified (hello) → checked here. */
	async steer(runId: string, message: string): Promise<void> {
		const run = await this.deps.registry.get(runId);
		if (!run) throw new Error(`unknown run ${runId}`);
		const caps = run.capabilities;
		if (!caps.verified)
			throw new SteerUnsupportedError(
				"run has not verified steering yet (no hello observed)",
			);
		if (!caps.steer)
			throw new SteerUnsupportedError("this run's driver cannot be steered");
		await this.requireTarget(run.executionTarget).control(
			await this.targetRefWithSecrets(run),
			{
				type: "steer",
				message,
				interruptCapable: caps.interrupt,
			},
		);
	}

	async respondApproval(
		runId: string,
		requestId: string,
		decision: "accept" | "acceptForSession" | "decline" | "cancel",
	): Promise<void> {
		const run = await this.deps.registry.get(runId);
		if (!run) throw new Error(`unknown run ${runId}`);
		if (run.state !== "running") {
			this.eventTail.forget(runId);
			throw new Error("run is not live");
		}
		if (!run.capabilities.verified || !run.capabilities.approvals) {
			throw new Error("this run's driver cannot resolve approvals");
		}
		const fold = await this.eventTail.fold(runId);
		if (fold.approvals.get(requestId)?.status !== "pending") {
			throw new Error(`approval '${requestId}' is not pending`);
		}
		await this.requireTarget(run.executionTarget).control(
			await this.targetRefWithSecrets(run),
			{
				type: "approval",
				requestId,
				decision,
			},
		);
	}

	// ---------- internals ----------

	private async launch(
		spec: RunLaunchSpec,
		targetResolution = resolveExecutionTarget({ kind: "local" }),
	): Promise<{ runId: string }> {
		const prepared = await this.prepareRun(spec, targetResolution);
		return this.launchPreparedRun(prepared);
	}

	private async prepareRun(
		spec: RunLaunchSpec,
		targetResolution: ResolvedExecutionTarget,
	): Promise<PreparedTaskRun> {
		const target = this.requireTarget(targetResolution.kind);
		const requestedShape = {
			...targetResolution.requestedShape,
			...(targetResolution.kind === "local" ? { host: "daemon" } : {}),
		};
		const { route } = spec;
		const shapeHost = targetResolution.requestedShape.hostId;
		const hostId = typeof shapeHost === "string" ? shapeHost : null;
		const routing = routingRecord({
			...route,
			target: targetResolution.kind,
			...(hostId ? { hostId } : {}),
		});
		const provider = providerForRun(
			{ providerId: route.provider, routing },
			this.deps.routing(),
		);
		// The endpoint's key reaches the agent only through its grant.
		const grantIds = [
			...new Set([
				...(spec.workloadSecretGrantIds ??
					this.deps.workloadSecretGrantIds ??
					[]),
				...(route.endpoint?.grant ? [route.endpoint.grant] : []),
			]),
		].sort();
		const inv = this.deps.adapters.invocation(
			provider,
			route.model,
			spec.prompt,
			{
				steer: spec.steer,
				disallowBackgroundAgents: noBackgroundAgents(spec),
				runId: spec.runId,
				...(spec.brain ? { brain: spec.brain } : {}),
			},
		);
		const projectId = this.deps.projectId ?? this.deps.projectName;
		const owner = this.owner({
			id: spec.runId,
			taskId: spec.taskId ?? null,
			attempt: spec.attempt ?? 1,
			targetProjectId: projectId,
		});
		// Every task run belongs to an attempt group; absent an explicit one it is
		// a group of one named after the run (continuations inherit their parent's).
		const taskRun =
			(spec.kind === "task" || spec.kind === "repair") && !!spec.taskId;
		const groupId = taskRun ? (spec.groupId ?? spec.runId) : undefined;
		if (taskRun && groupId === spec.runId && spec.taskId) {
			await this.deps.registry.ensureGroup({
				id: groupId,
				taskId: spec.taskId,
				kind: "single",
			});
		}
		// Row + run dir exist before any git work: a mid-start crash leaves a "starting" row that reconcile ages into start_failed.
		await this.deps.registry.create({
			id: spec.runId,
			kind: spec.kind,
			...(groupId ? { groupId } : {}),
			...(spec.role ? { role: spec.role } : {}),
			taskId: spec.taskId,
			parentRunId: spec.parentRunId,
			label: spec.label,
			...(spec.relation ? { relation: spec.relation } : {}),
			...(spec.originRef ? { originRef: spec.originRef } : {}),
			...(spec.spawnedByDecisionId !== undefined
				? { spawnedByDecisionId: spec.spawnedByDecisionId }
				: {}),
			model: route.model,
			providerId: route.provider,
			reasoningEffort: route.effort,
			routing,
			harness: route.provider,
			modelVendor: routeVendor(route),
			hostId,
			cwd: spec.reuse?.worktreePath ?? this.deps.projectRoot,
			worktreePath: spec.reuse?.worktreePath,
			branch: spec.reuse?.branch,
			integrationBranch: this.deps.integrationBranch,
			baseSha: spec.reuse?.baseSha,
			argv: inv.agentArgv,
			initialPrompt: spec.prompt,
			goal: spec.goal,
			attempt: spec.attempt,
			resumeOrdinal: spec.resumeOrdinal,
			workloadSecretGrantIds: grantIds,
			capabilities: { steer: inv.declaredCapabilities.steer, verified: false },
			executionTarget: targetResolution.kind,
			targetProjectId: projectId,
			targetRequestedShape: requestedShape,
			targetPrepareOperationId: targetOperationId(owner, "prepare/intent"),
		});
		try {
			// A task run's claim already moved it to in_progress. Draft expansion also claims but stays in backlog (UI shows "expanding").
			if (spec.taskId && spec.kind === "task")
				await this.deps.tasks.move(spec.taskId, "in_progress", "scheduler");

			const request = {
				owner,
				runDir: this.deps.registry.runDir(spec.runId),
				projectRoot: this.deps.projectRoot,
				integrationBranch: this.deps.integrationBranch,
				requestedShape,
				reuse: spec.reuse,
			};
			const prepared = await target.prepare(request);
			try {
				await this.deps.registry.recordTargetLifecycle({
					runId: spec.runId,
					operationId: targetOperationId(owner, "prepare/completed"),
					phase: "prepare",
					status: "completed",
					lifecycleState: "prepared",
					targetKind: target.kind,
					targetLeaseRef: prepared.globalLeaseRef,
					requestedShape,
					observedShape: prepared.observedShape
						? { ...prepared.observedShape }
						: null,
					runPatch: {
						cwd: prepared.workspace.canonicalPath,
						worktreePath: prepared.workspace.canonicalPath,
						branch: prepared.workspace.branch,
						baseSha: prepared.workspace.baseSha,
						targetExecutionPath: prepared.workspace.executionPath,
					},
					startingOnly: true,
				});
			} catch (error) {
				try {
					await target.rollbackPreparation?.(request, prepared);
				} catch (cleanupError) {
					throw new AggregateError(
						[error, cleanupError],
						"project linkage and target preparation rollback failed",
					);
				}
				throw error;
			}
			return {
				runId: spec.runId,
				taskId: spec.taskId ?? null,
				target: { ...targetResolution, requestedShape },
			};
		} catch (e) {
			this.deps.log.error(
				{ err: e, runId: spec.runId },
				"run preparation failed",
			);
			await this.deps.registry
				.recordTargetLifecycle({
					runId: spec.runId,
					operationId: targetOperationId(owner, "prepare/failed"),
					phase: "prepare",
					status: "failed",
					lifecycleState: "failed",
					targetKind: target.kind,
					detail: { code: "prepare_failed" },
				})
				.catch(() => {});
			await this.deps.registry.recordExit(spec.runId, {
				outcome: "start_failed",
			});
			throw e;
		}
	}

	/** Idempotently launch a durably prepared run, including after restart. */
	async launchPreparedRun(
		prepared: PreparedTaskRun | { runId: string },
	): Promise<{ runId: string }> {
		const run = await this.deps.registry.get(prepared.runId);
		if (!run) throw new Error(`unknown prepared run ${prepared.runId}`);
		if (run.state === "running") return { runId: run.id };
		if (run.state !== "starting") {
			throw new Error(`prepared run ${run.id} is in state ${run.state}`);
		}
		if (!run.worktreePath || !run.branch || !run.baseSha) {
			throw new Error(`prepared run ${run.id} has no canonical worktree`);
		}
		const target = this.requireTarget(run.executionTarget);
		const owner = this.owner(run);
		const ref = this.targetRef(run);
		await this.deps.registry.recordTargetLifecycle({
			runId: run.id,
			operationId: targetOperationId(owner, "launch/intent"),
			phase: "launch",
			status: "intent",
			lifecycleState: "launching",
			targetKind: target.kind,
			targetLeaseRef: run.targetLeaseRef,
		});
		let launchReturned = false;
		try {
			this.deps.beforeLaunch?.();
			const initialPrompt = run.initialPrompt ?? "";
			const live = this.deps.routing();
			// The route persisted at prepare, never the project's current one.
			const provider = providerForRun(run, live);
			// A brain turn's native-session and MCP facts were persisted before the row.
			const brain = isBrainTurnRun(run)
				? await readBrainTurnLaunch(this.deps.registry.runDir(run.id))
				: undefined;
			const invocation = this.deps.adapters.invocation(
				provider,
				run.model,
				initialPrompt,
				{
					steer: run.capabilities.steer,
					disallowBackgroundAgents: noBackgroundAgents(run),
					runId: run.id,
					...(brain ? { brain } : {}),
				},
			);
			const workloadSecrets =
				run.workloadSecretGrantIds.length > 0
					? await this.requireWorkloadSecrets(run)
					: undefined;
			const secretEnvironment = workloadSecrets?.secretEnvironment;
			const envKey = provider.endpoint?.envKey;
			if (envKey && !secretEnvironment?.names().includes(envKey)) {
				throw new Error(
					`endpoint '${provider.endpoint?.id}' reads its key from ${envKey}, but no workload grant of this run provides it: set the endpoint's grant to a grant whose environment is ${envKey}`,
				);
			}
			await this.deps.registry.bindWorkloadSecrets(
				run.id,
				secretEnvironment?.names() ?? [],
				workloadSecrets?.binding ?? null,
			);
			await target.launch({
				owner,
				runDir: ref.runDir,
				projectRoot: this.deps.projectRoot,
				workspace: ref.workspace as NonNullable<typeof ref.workspace>,
				globalLeaseRef: run.targetLeaseRef,
				driver: {
					driverScript: invocation.driverScript,
					agentArgv: invocation.agentArgv,
					bridgeArgv: invocation.bridgeArgv,
					providerArgv: invocation.providerArgv,
					env: {
						...invocation.env,
						MFW_RUN_ID: run.id,
						MFW_PROJECT: this.deps.projectName,
						MFW_TASK_ID: run.taskId ?? "",
						MFW_RUN_KIND: run.kind,
						MFW_REPORT_PATH: join(run.worktreePath, "MFW_REPORT.json"),
					},
					model: run.model,
					reasoningEffort:
						run.reasoningEffort ?? live.reasoningEffort ?? "medium",
					initialMessage: initialPrompt,
					steer: invocation.declaredCapabilities.steer,
					approvalMode: this.deps.defaults.approvalMode ?? "autonomous",
					isolation: this.deps.isolation,
					secretEnvironment,
				},
			});
			launchReturned = true;
			const observation = await target.observe({
				...ref,
				secretEnvironment,
			});
			if (observation.state === "starting" || observation.state === "unknown") {
				throw new ExecutionLaunchUncertainError(
					"target launch returned but execution identity is not yet observable",
				);
			}
			const terminal =
				observation.state === "exited" || observation.state === "absent";
			await this.deps.registry.recordTargetLifecycle({
				runId: run.id,
				operationId: targetOperationId(owner, "launch/completed"),
				phase: "launch",
				status: "completed",
				lifecycleState: terminal ? "cleanup_pending" : "running",
				targetKind: target.kind,
				targetLeaseRef: run.targetLeaseRef,
				observedShape: observation.observedShape
					? { ...observation.observedShape }
					: null,
			});
			if (terminal) {
				if (observation.state === "absent") {
					await this.deps.registry.recordExit(run.id, {
						outcome: "start_failed",
					});
				} else {
					await this.deps.registry.transition(run.id, "ended", {
						from: "starting",
					});
				}
				return { runId: run.id };
			}
			const transitioned = await this.deps.registry.transition(
				run.id,
				"running",
				{ from: "starting" },
			);
			if (!transitioned) {
				const current = await this.deps.registry.get(run.id);
				if (current?.state !== "running") {
					throw new Error(`run ${run.id} left starting state during launch`);
				}
			}
			return { runId: run.id };
		} catch (e) {
			if (e instanceof ExecutionLaunchUncertainError || launchReturned) {
				this.deps.log.warn(
					{ runId: run.id },
					"run launch outcome is uncertain; retaining admission for observation",
				);
				await this.deps.registry.recordTargetLifecycle({
					runId: run.id,
					operationId: targetOperationId(owner, "launch/uncertain"),
					phase: "launch",
					status: "failed",
					lifecycleState: "launching",
					targetKind: target.kind,
					targetLeaseRef: run.targetLeaseRef,
					detail: { code: "launch_observation_uncertain" },
				});
				return { runId: run.id };
			}
			this.deps.log.error({ err: e, runId: run.id }, "run launch failed");
			await this.deps.registry
				.recordTargetLifecycle({
					runId: run.id,
					operationId: targetOperationId(owner, "launch/failed"),
					phase: "launch",
					status: "failed",
					lifecycleState: "failed",
					targetKind: target.kind,
					targetLeaseRef: run.targetLeaseRef,
					detail: { code: "launch_failed" },
				})
				.catch(() => {});
			await this.deps.registry.recordExit(run.id, { outcome: "start_failed" });
			throw e;
		}
	}

	private requireTarget(kind: string) {
		const target = this.targets.get(kind);
		if (!target) throw new UnknownExecutionTargetError(kind);
		return target;
	}

	private requireWorkloadSecrets(run: RunRow): Promise<{
		secretEnvironment: SecretEnvironment;
		binding: string;
	}> {
		if (!this.deps.resolveWorkloadSecrets) {
			throw new Error(
				"run selected workload secret grants but no resolver is installed",
			);
		}
		return this.deps.resolveWorkloadSecrets({
			projectId:
				run.targetProjectId ?? this.deps.projectId ?? this.deps.projectName,
			taskId: run.taskId,
			grantIds: run.workloadSecretGrantIds,
		});
	}

	private owner(
		run: Pick<RunRow, "id" | "taskId" | "attempt" | "targetProjectId">,
	): ExecutionOwnership {
		const projectId =
			run.targetProjectId ?? this.deps.projectId ?? this.deps.projectName;
		return {
			projectId,
			projectName: this.deps.projectName,
			runId: run.id,
			taskId: run.taskId,
			attempt: run.attempt,
			ownerKey: executionOwnerKey(projectId, run.id, run.attempt),
		};
	}

	private targetRef(run: RunRow) {
		return {
			owner: this.owner(run),
			runDir: this.deps.registry.runDir(run.id),
			globalLeaseRef: run.targetLeaseRef,
			workspace:
				run.worktreePath && run.branch && run.baseSha
					? {
							canonicalPath: run.worktreePath,
							executionPath: run.targetExecutionPath ?? run.worktreePath,
							branch: run.branch,
							baseSha: run.baseSha,
						}
					: null,
		};
	}

	private async targetRefWithSecrets(run: RunRow) {
		const base = {
			...this.targetRef(run),
			secretNames: run.workloadSecretNames,
		};
		if (run.workloadSecretGrantIds.length === 0) return base;
		try {
			const resolved = await this.requireWorkloadSecrets(run);
			if (
				resolved.binding !== run.workloadSecretBinding ||
				resolved.secretEnvironment.names().join("\0") !==
					run.workloadSecretNames.join("\0")
			) {
				return { ...base, evidenceSecretsUnavailable: true };
			}
			return {
				...base,
				secretEnvironment: resolved.secretEnvironment,
			};
		} catch {
			this.deps.log.warn(
				{ runId: run.id },
				"workload secrets unavailable; remote evidence access is blocked while status and cleanup continue",
			);
			return { ...base, evidenceSecretsUnavailable: true };
		}
	}
}

export class SteerUnsupportedError extends Error {}

/** `startTask` refused: the machine-wide master stop is on. */
export class GlobalStopError extends Error {
	constructor(reason: string) {
		super(`mfw is stopped everywhere: ${reason}`);
		this.name = "GlobalStopError";
	}
}

/** `startTask` refused: the task is not in `ready` (`TaskService.tryClaim` only claims out of `ready/`). Server-side backstop for the UI's disabled Run control. */
export class TaskNotClaimableError extends Error {
	constructor(readonly taskId: string) {
		super(`task ${taskId} is not claimable`);
		this.name = "TaskNotClaimableError";
	}
}
