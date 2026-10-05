import { join } from "node:path";
import type { ProjectDbHandle } from "@mfw/db/client";
import { ulid } from "@mfw/db/ids";
import type { RunReasoningEffort } from "@mfw/db/schema";
import type { AdapterRegistry, ProviderConfig } from "./agents/adapter.ts";
import { tierModel } from "./agents/catalogue.ts";
import { type AgentEvent, parseAgentEvents } from "./agents/events.ts";
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
import type { RunRegistry, RunRow } from "./run-registry.ts";
import type { BwrapIsolation } from "./sandbox.ts";
import type { StatusActor, TaskService, TaskWithRefs } from "./task-service.ts";
import type { ModelTier } from "./tasks/types.ts";

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
	provider: ProviderConfig;
	defaults: {
		model: string;
		/** Project overrides per task `model_tier` (see `config.ts`). */
		modelTiers?: Partial<Record<ModelTier, string>>;
		reasoningEffort?: RunReasoningEffort;
		maxRepairs: number;
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
	/** Starting provider work preempts a low-priority regression sweep. */
	beforeLaunch?: () => void;
	buildPrompt: {
		task: (taskId: string) => Promise<string>;
		repair: (taskId: string, parentRunId: string) => Promise<string>;
		resume: (taskId: string, parentRunId: string) => Promise<string>;
		import: () => Promise<string>;
		plan: (
			goal: string,
			answers?: { question: string; answer: string }[],
			opts?: { autonomous?: boolean },
		) => Promise<string>;
		/** The merge queue's automatic conflict-resolution attempt. */
		unblock: (
			taskId: string,
			parentRunId: string,
			reason: string,
		) => Promise<string>;
	};
}

export interface PreparedTaskRun {
	runId: string;
	taskId: string | null;
	target: ResolvedExecutionTarget;
}

/** Which rule picked the model, for the launch log line. */
export type TaskModelRule =
	| "explicit"
	| "project-tier"
	| "project-model-standard"
	| "catalogue-tier"
	| "project-model";

export interface TaskModelResolution {
	model: string;
	rule: TaskModelRule;
}

/**
 * Picks the model for a task run (`startTask` only; repair/resume keep the
 * parent run's model). An explicit override wins outright. Otherwise, a
 * task's `model_tier` first asks the project's own `modelTiers` map; the
 * `standard` tier then falls back to the project's plain `model` (it IS the
 * project default), while `light`/`strong` fall back to the provider
 * catalogue's default for that tier. With no tier, or nothing left to try,
 * the project `model` is the answer.
 */
export function resolveTaskModel(input: {
	explicit?: string;
	modelTier: ModelTier | null;
	providerId: string;
	projectModel: string;
	projectModelTiers?: Partial<Record<ModelTier, string>>;
}): TaskModelResolution {
	if (input.explicit) return { model: input.explicit, rule: "explicit" };
	const tier = input.modelTier;
	if (tier) {
		const override = input.projectModelTiers?.[tier];
		if (override) return { model: override, rule: "project-tier" };
		if (tier === "standard") {
			return { model: input.projectModel, rule: "project-model-standard" };
		}
		const catalogue = tierModel(input.providerId, tier);
		if (catalogue) return { model: catalogue, rule: "catalogue-tier" };
	}
	return { model: input.projectModel, rule: "project-model" };
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
	kind: "task" | "repair" | "import" | "plan" | "action";
	taskId?: string;
	parentRunId?: string;
	label: string;
	model: string;
	reasoningEffort?: RunReasoningEffort;
	steer: boolean;
	prompt: string;
	goal?: string;
	reuse?: { worktreePath: string; branch: string; baseSha?: string };
	attempt?: number;
	resumeOrdinal?: number;
	maxRepairs?: number;
	workloadSecretGrantIds?: string[];
}

export class RunEngine {
	private readonly targets: ExecutionTargetSelector;
	private taskAdmission: TaskDispatchAdmissionPort | null = null;

	get admissionIntegrated(): boolean {
		return this.taskAdmission !== null;
	}

	constructor(private readonly deps: RunEngineDeps) {
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
		if (current?.claimedByRunId !== runId) {
			const claimed = await this.deps.tasks.tryClaim(
				taskId,
				runId,
				this.deps.defaults.leaseMs,
				opts.actor ?? "scheduler",
			);
			if (!claimed) throw new TaskNotClaimableError(taskId);
		}
		const resolved = resolveTaskModel({
			explicit: opts.model,
			modelTier: current?.modelTier ?? null,
			providerId: this.deps.provider.id,
			projectModel: this.deps.defaults.model,
			projectModelTiers: this.deps.defaults.modelTiers,
		});
		this.deps.log.debug(
			{ taskId, model: resolved.model, rule: resolved.rule },
			"resolved task run model",
		);
		return this.prepareRun(
			{
				runId,
				kind: "task",
				taskId,
				label: taskId,
				model: resolved.model,
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
		if (task?.claimedByRunId === runId) {
			await this.deps.tasks.release(taskId, runId, "ready", actor, reason);
		}
	}

	/** Read-only placement resolution for admission; acquire the requirements, then pass the resolution to `prepareTaskRun`. */
	async resolveTaskExecutionTarget(
		taskId: string,
		override?: TargetResolutionInput | ResolvedExecutionTarget,
	): Promise<ResolvedExecutionTarget> {
		const task = await this.deps.tasks.get(taskId);
		if (!task) throw new TaskNotClaimableError(taskId);
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

	/** Child runs reuse the parent's worktree: same branch, same disk state.
	 *  Idempotent by childRunId (the StepRunner journals it before calling). */
	async startRepair(parentRunId: string, childRunId: string): Promise<void> {
		await this.startChild(parentRunId, childRunId, "repair");
	}

	/** Start a first-class recovery run without reopening or claiming the
	 * historical board task whose DoD exposed the regression. */
	async startRegressionRepair(
		taskId: string,
		incidentId: string,
		detail: string,
	): Promise<{ runId: string }> {
		const taskPrompt = await this.deps.buildPrompt.task(taskId);
		const spec: RunLaunchSpec = {
			runId: ulid(),
			kind: "repair",
			taskId,
			label: `recovery:${incidentId}`,
			model: this.deps.defaults.model,
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
	async startResume(parentRunId: string, childRunId: string): Promise<void> {
		await this.startChild(parentRunId, childRunId, "resume");
	}

	private async startChild(
		parentRunId: string,
		childRunId: string,
		mode: "repair" | "resume",
	): Promise<void> {
		const existing = await this.deps.registry.get(childRunId);
		if (existing?.state === "running") {
			// Launch may have committed before the previous caller transferred the
			// claim. Replay must finish that handoff without stealing a successor's.
			if (existing.taskId)
				await this.deps.tasks.moveLease(
					existing.taskId,
					childRunId,
					parentRunId,
				);
			return;
		}
		if (existing && !this.taskAdmission?.startContinuation) return;
		const parent = await this.deps.registry.get(parentRunId);
		if (!parent?.taskId || !parent.worktreePath || !parent.branch)
			throw new Error(`parent run ${parentRunId} has no reusable worktree`);
		const prompt =
			mode === "repair"
				? await this.deps.buildPrompt.repair(parent.taskId, parentRunId)
				: await this.deps.buildPrompt.resume(parent.taskId, parentRunId);
		const spec: RunLaunchSpec = {
			runId: childRunId,
			kind: "task",
			taskId: parent.taskId,
			parentRunId,
			label: `${parent.taskId}#${mode}`,
			model: parent.model,
			reasoningEffort: parent.reasoningEffort ?? undefined,
			steer: true,
			prompt,
			reuse: {
				worktreePath: parent.worktreePath,
				branch: parent.branch,
				baseSha: parent.baseSha ?? undefined,
			},
			attempt: parent.attempt + (mode === "repair" ? 1 : 0),
			resumeOrdinal: parent.resumeOrdinal + (mode === "resume" ? 1 : 0),
			maxRepairs: parent.maxRepairs ?? undefined,
			workloadSecretGrantIds: [...parent.workloadSecretGrantIds],
		};
		const target = await this.resolveTaskExecutionTarget(parent.taskId);
		if (this.taskAdmission?.startContinuation) {
			await this.taskAdmission.startContinuation({
				taskId: parent.taskId,
				parentRunId,
				runId: childRunId,
				target,
				prepare: () => this.prepareRun(spec, target),
			});
		} else {
			await this.launch(spec, this.resolutionForRun(parent));
		}
		// Move the lease to the child.
		await this.deps.tasks.moveLease(parent.taskId, childRunId, parentRunId);
	}

	/**
	 * `MergeQueue.park()`'s automatic conflict-resolution attempt before a
	 * retry-exhausted merge job reaches a human. `parentRunId`'s finalize never
	 * passes `merging` while its job is live, so its worktree, branch and claim
	 * are reusable, as in `startRepair`. The child is an ordinary task run whose
	 * finalize re-verifies the DoD and re-enqueues the merge.
	 */
	async startUnblock(
		parentRunId: string,
		childRunId: string,
		reason: string,
	): Promise<void> {
		const existing = await this.deps.registry.get(childRunId);
		if (existing?.state === "running") {
			if (existing.taskId)
				await this.deps.tasks.moveLease(
					existing.taskId,
					childRunId,
					parentRunId,
				);
			return;
		}
		if (existing && !this.taskAdmission?.startContinuation) return;
		const parent = await this.deps.registry.get(parentRunId);
		if (!parent?.taskId || !parent.worktreePath || !parent.branch)
			throw new Error(`parent run ${parentRunId} has no reusable worktree`);
		if (await this.hasUnblockAncestor(parentRunId))
			throw new Error(
				`run ${parentRunId} is already part of an automatic unblock attempt`,
			);
		const prompt = await this.deps.buildPrompt.unblock(
			parent.taskId,
			parentRunId,
			reason,
		);
		const spec: RunLaunchSpec = {
			runId: childRunId,
			kind: "task",
			taskId: parent.taskId,
			parentRunId,
			label: `${parent.taskId}#unblock`,
			model: parent.model,
			reasoningEffort: parent.reasoningEffort ?? undefined,
			steer: true,
			prompt,
			reuse: {
				worktreePath: parent.worktreePath,
				branch: parent.branch,
				baseSha: parent.baseSha ?? undefined,
			},
			attempt: parent.attempt,
			resumeOrdinal: parent.resumeOrdinal,
			maxRepairs: parent.maxRepairs ?? undefined,
			workloadSecretGrantIds: [...parent.workloadSecretGrantIds],
		};
		const target = await this.resolveTaskExecutionTarget(parent.taskId);
		if (this.taskAdmission?.startContinuation) {
			await this.taskAdmission.startContinuation({
				taskId: parent.taskId,
				parentRunId,
				runId: childRunId,
				target,
				prepare: () => this.prepareRun(spec, target),
			});
		} else {
			await this.launch(spec, this.resolutionForRun(parent));
		}
		// Move the lease to the child, as `startChild` does.
		await this.deps.tasks.moveLease(parent.taskId, childRunId, parentRunId);
	}

	/** One automatic merge reconciliation per run lineage; a second conflict escalates instead of spawning more agents. */
	private async hasUnblockAncestor(runId: string): Promise<boolean> {
		const seen = new Set<string>();
		let id: string | null = runId;
		while (id && !seen.has(id)) {
			seen.add(id);
			const run = await this.deps.registry.get(id);
			if (!run) return false;
			if (run.label.endsWith("#unblock")) return true;
			id = run.parentRunId;
		}
		return false;
	}

	async startImport(opts: { model?: string } = {}): Promise<{ runId: string }> {
		return this.launch({
			runId: ulid(),
			kind: "import",
			label: "import",
			model: opts.model ?? this.deps.defaults.model,
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
				model: opts.model ?? this.deps.defaults.model,
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
		opts: { model?: string } = {},
	): Promise<{ runId: string }> {
		return this.launch({
			runId: ulid(),
			kind: "action",
			label: "action",
			model: opts.model ?? this.deps.defaults.model,
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
		} = {},
	): Promise<{ runId: string }> {
		return this.launch({
			runId: ulid(),
			kind: "action",
			label: "session",
			model: opts.model ?? this.deps.defaults.model,
			steer: true,
			prompt,
			reuse: opts.reuse,
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
		if (run.state !== "running") throw new Error("run is not live");
		if (!run.capabilities.verified || !run.capabilities.approvals) {
			throw new Error("this run's driver cannot resolve approvals");
		}
		const { chunk } = await this.deps.registry.readOutput(
			runId,
			"events.jsonl",
			0,
		);
		const latest = parseAgentEvents(chunk).findLast(
			(e): e is Extract<AgentEvent, { type: "approval" }> =>
				e.type === "approval" && e.requestId === requestId,
		);
		if (latest?.status !== "pending") {
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
		const reasoningEffort =
			spec.reasoningEffort ?? this.deps.defaults.reasoningEffort ?? "medium";
		const inv = this.deps.adapters.invocation(
			this.deps.provider,
			spec.model,
			spec.prompt,
			{
				steer: spec.steer,
				disallowBackgroundAgents: spec.kind === "plan" && !!spec.taskId,
			},
		);
		const projectId = this.deps.projectId ?? this.deps.projectName;
		const owner = this.owner({
			id: spec.runId,
			taskId: spec.taskId ?? null,
			attempt: spec.attempt ?? 1,
			targetProjectId: projectId,
		});
		// Row + run dir exist before any git work: a mid-start crash leaves a "starting" row that reconcile ages into start_failed.
		await this.deps.registry.create({
			id: spec.runId,
			kind: spec.kind,
			taskId: spec.taskId,
			parentRunId: spec.parentRunId,
			label: spec.label,
			model: spec.model,
			providerId: this.deps.provider.id,
			reasoningEffort,
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
			maxRepairs: spec.maxRepairs ?? this.deps.defaults.maxRepairs,
			workloadSecretGrantIds: spec.workloadSecretGrantIds ?? [
				...(this.deps.workloadSecretGrantIds ?? []),
			],
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
			const invocation = this.deps.adapters.invocation(
				this.deps.provider,
				run.model,
				initialPrompt,
				{
					steer: run.capabilities.steer,
					disallowBackgroundAgents: run.kind === "plan" && !!run.taskId,
				},
			);
			const workloadSecrets =
				run.workloadSecretGrantIds.length > 0
					? await this.requireWorkloadSecrets(run)
					: undefined;
			const secretEnvironment = workloadSecrets?.secretEnvironment;
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
						run.reasoningEffort ??
						this.deps.defaults.reasoningEffort ??
						"medium",
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

	private resolutionForRun(run: RunRow): ResolvedExecutionTarget {
		return {
			kind: run.executionTarget,
			requestedShape: { ...run.targetRequestedShape },
			requirements: {
				executionHost: [],
				projectSemaphores: [],
				localStaging: [],
			},
		};
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
