import type { LaunchSpec, RunExit } from "./agent-host.ts";
import type {
	CollectExecutionResult,
	DisposeExecutionResult,
	ExecutionControl,
	ExecutionInventoryItem,
	ExecutionObservation,
	ExecutionReconcileReport,
	ExecutionTarget,
	ExecutionTargetRef,
	LaunchExecutionRequest,
	PreparedExecution,
	PrepareExecutionRequest,
} from "./execution-target.ts";
import { gitOk } from "./git.ts";
import { type Worktree, WorktreeManager } from "./worktree.ts";

/** The tmux-shaped mechanics needed by the local adapter, kept out of RunEngine. */
export interface LocalExecutionHost {
	launch(spec: LaunchSpec): Promise<void>;
	isAlive(runId: string): Promise<boolean>;
	readExit(runDir: string): Promise<RunExit>;
	appendControl(
		runDir: string,
		event:
			| { type: "steer"; message: string }
			| { type: "interrupt" }
			| {
					type: "approval";
					requestId: string;
					decision: "accept" | "acceptForSession" | "decline" | "cancel";
			  },
	): Promise<void>;
	appendSteer(runDir: string, message: string): Promise<void>;
	kill(runDir: string, runId: string, reason: string): Promise<void>;
}

export interface LocalWorktreePort {
	create(runId: string, base?: string): Promise<Worktree>;
	remove(worktree: Worktree): Promise<void>;
}

export interface LocalExecutionTargetDeps {
	projectRoot: string;
	integrationBranch: string;
	host: LocalExecutionHost;
	worktrees?: LocalWorktreePort;
}

const LOCAL_OBSERVED_SHAPE = { host: "daemon", transport: "tmux" } as const;

/** Current local worktree + tmux behavior expressed through the shared target contract. */
export class LocalExecutionTarget implements ExecutionTarget {
	readonly kind = "local";
	private readonly worktrees: LocalWorktreePort;

	constructor(private readonly deps: LocalExecutionTargetDeps) {
		this.worktrees = deps.worktrees ?? new WorktreeManager(deps.projectRoot);
	}

	async prepare(request: PrepareExecutionRequest): Promise<PreparedExecution> {
		if (request.reuse) {
			const baseSha =
				request.reuse.baseSha ??
				(await gitOk(["rev-parse", "HEAD"], request.reuse.worktreePath));
			return {
				targetKind: this.kind,
				workspace: {
					canonicalPath: request.reuse.worktreePath,
					executionPath: request.reuse.worktreePath,
					branch: request.reuse.branch,
					baseSha,
				},
				globalLeaseRef: null,
				observedShape: LOCAL_OBSERVED_SHAPE,
			};
		}
		const worktree = await this.worktrees.create(
			request.owner.runId,
			request.integrationBranch,
		);
		return {
			targetKind: this.kind,
			workspace: {
				canonicalPath: worktree.path,
				executionPath: worktree.path,
				branch: worktree.branch,
				baseSha: worktree.baseSha,
			},
			globalLeaseRef: null,
			observedShape: LOCAL_OBSERVED_SHAPE,
		};
	}

	async rollbackPreparation(
		request: PrepareExecutionRequest,
		prepared: PreparedExecution,
	): Promise<void> {
		if (request.reuse) return;
		await this.worktrees.remove({
			path: prepared.workspace.canonicalPath,
			branch: prepared.workspace.branch,
			baseSha: prepared.workspace.baseSha,
		});
	}

	async launch(request: LaunchExecutionRequest): Promise<void> {
		const ref = this.refFromLaunch(request);
		const before = await this.observe(ref);
		// A retry after launch (including a driver which already exited) must not
		// create a second tmux session or execute the driver twice.
		if (before.state !== "absent") return;
		try {
			await this.deps.host.launch({
				runId: request.owner.runId,
				runDir: request.runDir,
				cwd: request.workspace.executionPath,
				projectRoot: request.projectRoot,
				driverScript: request.driver.driverScript,
				agentArgv: request.driver.agentArgv,
				bridgeArgv: request.driver.bridgeArgv,
				providerArgv: request.driver.providerArgv,
				env: request.driver.env,
				secretEnvironment: request.driver.secretEnvironment,
				model: request.driver.model,
				reasoningEffort: request.driver.reasoningEffort,
				initialMessage: request.driver.initialMessage,
				steer: request.driver.steer,
				approvalMode: request.driver.approvalMode,
				isolation: request.driver.isolation,
			});
		} catch (error) {
			// `tmux new-session` may have succeeded just before pipe/send failed or
			// the caller lost the response. Live/finished ownership makes this an
			// idempotent success; only proven absence is safe to report as failure.
			if ((await this.observe(ref)).state === "absent") throw error;
		}
	}

	async observe(ref: ExecutionTargetRef): Promise<ExecutionObservation> {
		const exit = await this.deps.host.readExit(ref.runDir);
		if (exit.kind === "exit") {
			return {
				state: "exited",
				exitCode: exit.code,
				observedShape: LOCAL_OBSERVED_SHAPE,
			};
		}
		if (exit.kind === "killed") {
			return {
				state: "exited",
				killReason: exit.reason,
				observedShape: LOCAL_OBSERVED_SHAPE,
			};
		}
		return (await this.deps.host.isAlive(ref.owner.runId))
			? { state: "running", observedShape: LOCAL_OBSERVED_SHAPE }
			: { state: "absent", observedShape: LOCAL_OBSERVED_SHAPE };
	}

	async control(
		ref: ExecutionTargetRef,
		command: ExecutionControl,
	): Promise<void> {
		switch (command.type) {
			case "interrupt":
				await this.deps.host.appendControl(ref.runDir, { type: "interrupt" });
				return;
			case "kill":
				await this.deps.host.kill(ref.runDir, ref.owner.runId, command.reason);
				return;
			case "steer":
				if (command.interruptCapable) {
					await this.deps.host.appendControl(ref.runDir, {
						type: "steer",
						message: command.message,
					});
				} else {
					await this.deps.host.appendSteer(ref.runDir, command.message);
				}
				return;
			case "approval":
				await this.deps.host.appendControl(ref.runDir, command);
				return;
		}
	}

	async collect(_ref: ExecutionTargetRef): Promise<CollectExecutionResult> {
		// The canonical worktree and run directory already are local.
		return { observedShape: LOCAL_OBSERVED_SHAPE };
	}

	async dispose(ref: ExecutionTargetRef): Promise<DisposeExecutionResult> {
		if (await this.deps.host.isAlive(ref.owner.runId)) {
			await this.deps.host.kill(ref.runDir, ref.owner.runId, "dispose");
		}
		return {
			absenceConfirmed: !(await this.deps.host.isAlive(ref.owner.runId)),
			observedShape: LOCAL_OBSERVED_SHAPE,
		};
	}

	async inventory(
		refs: readonly ExecutionTargetRef[],
	): Promise<readonly ExecutionInventoryItem[]> {
		return Promise.all(
			refs.map(async (ref) => ({
				ownerKey: ref.owner.ownerKey,
				globalLeaseRef: ref.globalLeaseRef,
				observation: await this.observe(ref),
			})),
		);
	}

	async reconcile(
		refs: readonly ExecutionTargetRef[],
	): Promise<ExecutionReconcileReport> {
		return { observations: await this.inventory(refs), errors: [] };
	}

	private refFromLaunch(request: LaunchExecutionRequest): ExecutionTargetRef {
		return {
			owner: request.owner,
			runDir: request.runDir,
			globalLeaseRef: request.globalLeaseRef,
			workspace: request.workspace,
		};
	}
}

export function createLocalExecutionTarget(
	deps: LocalExecutionTargetDeps,
): LocalExecutionTarget {
	return new LocalExecutionTarget(deps);
}
