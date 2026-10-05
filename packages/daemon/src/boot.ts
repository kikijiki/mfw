import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadBoardConfig } from "@mfw/board-core";
import { openProjectDb } from "@mfw/db/client";
import { EventBus, eventsSince, latestSeq, listEvents } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import { AdrService } from "./adrs.ts";
import { AgentHost } from "./agent-host.ts";
import { AdapterRegistry, type ProviderConfig } from "./agents/adapter.ts";
import { DEFAULT_PROVIDER_ID, providerConfigFor } from "./agents/catalogue.ts";
import { BrainService, inferenceForProvider } from "./brain.ts";
import { ClarifyService, continuationTerminalError } from "./clarify.ts";
import {
	mfwHome as configuredMfwHome,
	effectiveAssistance,
	FALLBACK_MERGE_CHECKS,
	loadConfig,
	mutateConfig,
	normalizeRoot,
	PROJECT_DEFAULTS,
} from "./config.ts";
import { CredentialStore, WorkloadSecretGrantStore } from "./credentials.ts";
import { ensureBoardConfig } from "./default-board-config.ts";
import {
	ExecutionTargetRegistry,
	executionOwnerKey,
} from "./execution-target.ts";
import { StepRunner } from "./finalize/step-runner.ts";
import { git } from "./git.ts";
import { GlobalDispatch } from "./global-dispatch.ts";
import { Health } from "./health.ts";
import type { HostObservationServiceOptions } from "./host-observation-service.ts";
import {
	createProductionHostProbeRuntime,
	type HostProbeRuntime,
} from "./host-probe-runtime.ts";
import { createDefaultHostProbeAdapters } from "./host-probes.ts";
import {
	acquireDaemonLock,
	HostResourceCoordinator,
	type HostResourceCoordinatorPort,
	type HostResourceStore,
	type HostTransition,
	type LeaseLivenessInspector,
	openHostResourceStore,
	type ProjectIdentity,
	readKernelBootId,
	SystemLeaseLiveness,
	stableProjectIdentity,
} from "./host-resources/index.ts";
import { InboxService } from "./inbox.ts";
import {
	acquireKernelLock,
	type KernelLock,
	KernelLockError,
} from "./kernel-lock.ts";
import { LifetimeManager } from "./lifetime.ts";
import { createLocalExecutionTarget } from "./local-execution-target.ts";
import { type Logger, rootLogger } from "./log.ts";
import { Maintenance } from "./maintenance.ts";
import { MergeQueue } from "./merge-queue.ts";
import { makeNotifier, type NotifyConfig } from "./notify.ts";
import { OpenRouterAccountService } from "./openrouter-account-service.ts";
import {
	OPENROUTER_MANAGEMENT_CREDENTIAL_ID,
	OpenRouterClient,
	type OpenRouterClientPort,
	openRouterCredentialSource,
} from "./openrouter-client.ts";
import {
	type AdmissionRecord,
	type AdmissionTransition,
	ProjectDispatchAdmission,
} from "./project-dispatch-admission.ts";
import { ProjectResourceSlots } from "./project-resource-slots.ts";
import { ResourceService } from "./resources.ts";
import { ReviewService } from "./review.ts";
import { RunEngine } from "./run-engine.ts";
import { RunRegistry } from "./run-registry.ts";
import {
	RunPodAccountService,
	type RunPodProviderClient,
} from "./runpod-account-service.ts";
import { RunPodClient, runPodCredentialSource } from "./runpod-client.ts";
import { createRunPodExecutionTarget } from "./runpod-execution-target.ts";
import type {
	RunPodMachinePolicy,
	RunPodPlacementRequest,
	RunPodProjectPolicy,
} from "./runpod-policy.ts";
import { Scheduler } from "./scheduler.ts";
import type { Orchestrator, ProjectServices } from "./services.ts";
import { SessionService } from "./session.ts";
import {
	ProviderSettings,
	type SettingsLifecycle,
	SettingsService,
} from "./settings.ts";
import { Supervisor } from "./supervisor.ts";
import { TaskService } from "./task-service.ts";
import { BoardRepo } from "./tasks/board-git.ts";
import { resolveTaskKey } from "./tasks/key.ts";
import type { VerificationPlan } from "./tasks/types.ts";
import { TriggerActionRegistry } from "./triggers/actions.ts";
import { createAgentAction } from "./triggers/agent-action.ts";
import { createCreateTaskAction } from "./triggers/create-task-action.ts";
import { createNotifyAction } from "./triggers/notify-action.ts";
import { createScriptAction, Semaphore } from "./triggers/script-action.ts";
import { TriggerService } from "./triggers/service.ts";
import { VerificationCoordinator } from "./verification-coordinator.ts";
import { type EnvPolicy, verify } from "./verifier.ts";
import { WorkspaceService } from "./workspace.ts";

/**
 * Composition root. Loops start eagerly so runs resume after a reboot without
 * the UI. Attach reads the board off disk before returning, so no service sees
 * an unbuilt index. Shutdown stops loops but leaves live runs to be adopted next boot.
 */

export interface ProjectConfig {
	name: string;
	root: string;
	/** Where the board lives, if not `root` (see `config.ts`'s `projectSchema`). */
	boardRoot?: string;
	integrationBranch?: string;
	model?: string;
	/** Model per task `model_tier`, see `config.ts`. */
	modelTiers?: import("./config.ts").StoredProjectConfig["modelTiers"];
	/** Model for the semantic change review, see `config.ts`. */
	reviewModel?: string;
	/** Provider reasoning budget. Codex applies it to each turn. */
	reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
	/** Provider permission handling for runs in this project. */
	approvalMode?: "autonomous" | "interactive";
	maxConcurrent?: number;
	/** `action: script` triggers' own semaphore, see `config.ts`. */
	maxConcurrentTriggers?: number;
	assistance?: import("./config.ts").RecoveryAssistance;
	/**
	 * Start dispatching at boot. Defaults to false: attaching must never spend
	 * a subscription on its own. The supervisor always runs (adopts in-flight runs).
	 */
	schedulerAutostart?: boolean;
	maxRepairs?: number;
	maxStalls?: number;
	maxResumes?: number;
	leaseMs?: number;
	notify?: NotifyConfig;
	provider?: ProviderConfig;
	/** Wrapper command for verification checks (sandbox or dev-env entrypoint, e.g. `direnv exec .`). Never auto-detected. */
	checkPrefix?: string;
	/** Ambient environment a verification check may read. */
	envPolicy?: EnvPolicy;
	/** Repository-wide checks applied to every candidate before merge. */
	mergeChecks?: VerificationPlan | null;
	/** Exempt the task that broke main from the red-main dispatch gate so it can repair itself. */
	selfRepairMainRed?: boolean;
	/** Push the integration branch after every merge. Default on; no remote means no push and no error. */
	pushOnMerge?: boolean;
	/** Remote to push to. Defaults to `origin`. */
	pushRemote?: string;
	/** Filesystem-isolate agent runs via `bwrap`. Defaults and fallback: see `config.ts`. */
	agentIsolation?: "none" | "bwrap";
	/** Failed expansion runs a draft tolerates before the bounded retry releases
	 * it as its captured intent. Project merge checks remain inherited policy. */
	draftExpandMaxAttempts?: number;
	/** Cap on simultaneous draft-expansion runs. */
	maxConcurrentDraftExpansions?: number;
	/** Optional narrowing of the machine-wide RunPod policy. */
	runpod?: RunPodProjectPolicy;
	/** Concrete bounded placement for tasks opting into the RunPod target. */
	runpodTarget?: RunPodPlacementRequest;
	/** Default workload credential grant IDs; tasks may add narrower IDs. */
	workloadSecretGrants?: string[];
}

export interface BootOptions {
	projects: ProjectConfig[];
	log?: Logger;
	/** Start project/host loops. Provider safety reconciliation remains on. */
	autostart?: boolean;
	supervisorIntervalMs?: number;
	schedulerIntervalMs?: number;
	/** Machine-wide master stop from config.json. Absent = running; each project's own switch decides. */
	dispatchPaused?: boolean;
	/** Explicit coordination domain; production defaults to configured MFW_HOME. */
	mfwHome?: string;
	/** Recovery seams for deterministic boot/reboot tests. */
	hostLiveness?: LeaseLivenessInspector;
	kernelBootId?: string | null;
	hostNow?: () => number;
	hostLeaseMs?: number;
	hostLivenessMaxAgeMs?: number;
	daemonLockTimeoutMs?: number;
	afterHostTransition?: (
		transition: HostTransition,
		lease: import("./host-resources/index.ts").HostLease,
	) => void | Promise<void>;
	/** Deterministic seams for the sole process-global hardware poller. */
	hostProbes?: HostObservationServiceOptions & {
		runtime?: HostProbeRuntime;
	};
	/** Process-global RunPod account policy from config.json. */
	runpod?: RunPodMachinePolicy;
	/** Deterministic composition seam; production always uses RunPodClient. */
	runpodClient?: RunPodProviderClient;
	/** Deterministic composition seam; production always uses OpenRouterClient. */
	openrouterClient?: OpenRouterClientPort;
	/** Deterministic seam for the separately scoped management credential. */
	openrouterManagementClient?: OpenRouterClientPort;
	afterAdmissionTransition?: (
		transition: AdmissionTransition,
		row: AdmissionRecord,
	) => void | Promise<void>;
}

/** Composition-only extension; ProjectServices receives the narrower port. */
export interface HostResourceAttachPort extends HostResourceCoordinatorPort {
	registerProject(input: {
		identity: ProjectIdentity;
		root: string;
		displayName: string;
		metadata?: Record<string, unknown>;
	}): Promise<void>;
}

const DEFAULTS = PROJECT_DEFAULTS;

/** Reason stored with the master stop; reported by every project's status. */
const STOPPED_EVERYWHERE = "mfw is stopped everywhere (global stop)";

/** Resolve the merge target once, at attach, and record it. */
async function resolveIntegrationBranch(root: string): Promise<string> {
	const head = await git(["symbolic-ref", "--short", "-q", "HEAD"], root);
	if (head.exitCode === 0 && head.stdout.trim()) return head.stdout.trim();
	const remote = await git(
		["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"],
		root,
	);
	if (remote.exitCode === 0 && remote.stdout.trim())
		return remote.stdout.trim().replace(/^origin\//, "");
	return "main";
}

const EXCLUDE_BEGIN = "# --- mfw (managed; rewritten on every attach) ---";
const EXCLUDE_END = "# --- end mfw ---";

/**
 * Keep runtime artifacts out of git via .git/info/exclude (never touches .gitignore).
 * Default-deny: exclude all of `.mfw/*`, then re-admit the human-meaningful paths.
 * Single `*` on purpose: git cannot re-include a file under an excluded directory.
 * A file a human puts in `.mfw/` needs `git add -f`.
 *
 * `root` and `boardDir`'s parent can be different checkouts (`boardRoot`):
 * each repo only ever sees the `.mfw` entries that actually live under it, so
 * a standalone board repo isn't told to re-admit orchestration-only paths it
 * will never have, and vice versa.
 */
async function ensureGitExclude(
	root: string,
	log: Logger,
	kind: "code" | "board" | "combined",
): Promise<void> {
	const path = join(root, ".git", "info", "exclude");
	const codeReadmits = [
		"!/.mfw/config.yaml",
		"!/.mfw/AGENTS.md",
		"!/.mfw/lifetime/",
		"!/.mfw/triggers/",
	];
	const boardReadmits = [
		"!/.mfw/templates/",
		"!/.mfw/tasks/",
		"!/.mfw/adrs/",
		"!/.mfw/board.yaml",
	];
	const block = [
		EXCLUDE_BEGIN,
		...(kind !== "board" ? ["worktrees/", "MFW_REPORT.json"] : []),
		"/.mfw/*",
		...(kind !== "board" ? codeReadmits : []),
		...(kind !== "code" ? boardReadmits : []),
		EXCLUDE_END,
	];

	let cur = "";
	try {
		cur = await readFile(path, "utf8");
	} catch {
		// no exclude file yet; created below
	}

	// Strip any previous managed block; keep the human's lines in order.
	const kept: string[] = [];
	let inBlock = false;
	for (const line of cur.split("\n")) {
		const t = line.trim();
		if (t === EXCLUDE_BEGIN) {
			inBlock = true;
			continue;
		}
		if (t === EXCLUDE_END) {
			inBlock = false;
			continue;
		}
		if (inBlock) continue;
		kept.push(line);
	}
	while (kept.length > 0 && kept[kept.length - 1]?.trim() === "") kept.pop();

	const next = `${[...kept, ...block].join("\n")}\n`;
	if (next === cur) return;
	try {
		await mkdir(join(root, ".git", "info"), { recursive: true });
		await writeFile(path, next);
		log.info("git exclude block rewritten");
	} catch (e) {
		// Not a standard repo layout (bare, worktree, permissions), worth
		// knowing about, since the DB is then visible to `git add`.
		log.warn({ err: e, path }, "could not update .git/info/exclude");
	}
}

export async function attachProject(
	cfg: ProjectConfig,
	log: Logger,
	bootId: string,
	/** Loop period for a scheduler started after boot (settings or dispatch control), so it matches `config.json`. */
	opts: {
		schedulerIntervalMs?: number;
		/** Machine-wide master stop; all schedulers share this one getter. */
		globalPaused?: () => { reason: string } | null;
		/** The one process-global coordinator constructed by Orchestrator. */
		hostResources: HostResourceAttachPort;
		mfwHome: string;
		afterAdmissionTransition?: BootOptions["afterAdmissionTransition"];
		/** The one process-global RunPod control plane. */
		runpod?: RunPodAccountService;
		credentials?: CredentialStore;
		workloadGrants?: WorkloadSecretGrantStore;
		/** Announces durable ownership identity before DB migration can fail. */
		onProjectIdentity?: (identity: ProjectIdentity) => void;
		/** Shared attach/detach/settings serialization and generation guard. */
		lifecycle?: SettingsLifecycle;
	},
): Promise<ProjectServices> {
	// Must run before any write: mkdir(recursive) would recreate a moved or
	// unmounted root and report a healthy attach.
	await assertGitRepo(cfg.root);
	// Canonical root: git cwd, worktree base and path-escape prefix all compare
	// as strings, and boot() can be called without loadConfig's normalization.
	const root = normalizeRoot(cfg.root);
	const mfwDir = join(root, ".mfw");
	// The board (task.md/spec.md/adrs/board.yaml/templates) can live in a
	// completely separate checkout from the code being orchestrated — e.g. the
	// repo is `~/dev/app` but its board is tracked in `~/docs/projects/app`.
	// Everything orchestration-only (worktrees, runs, mfw.db, the daemon lock,
	// triggers) stays keyed on `root`/`mfwDir`; everything board-only is keyed
	// on `boardRoot`/`boardDir` instead. They're equal unless `boardRoot` is set.
	const boardRoot = cfg.boardRoot ? normalizeRoot(cfg.boardRoot) : root;
	const boardDir = boardRoot === root ? mfwDir : join(boardRoot, ".mfw");
	await ensureGitExclude(root, log, boardRoot === root ? "combined" : "code");
	if (boardRoot !== root && existsSync(join(boardRoot, ".git"))) {
		await ensureGitExclude(boardRoot, log, "board");
	}
	await mkdir(mfwDir, { recursive: true });
	await mkdir(boardDir, { recursive: true });
	const releaseLock = await acquireProjectLock(mfwDir, bootId);
	let projectIdentity: ProjectIdentity;
	let taskKey: string;
	let handle: Awaited<ReturnType<typeof openProjectDb>>;
	try {
		projectIdentity = await stableProjectIdentity(mfwDir);
		opts.onProjectIdentity?.(projectIdentity);
		// Resolved before board.yaml is written so a brand-new project's board
		// agrees with the ids it will really mint (resolveTaskKey reads
		// board.json/config.yaml/the raw files, never board.yaml itself) —
		// board-core now validates an id against its type's own-sequence
		// grammar, so a mismatched default key here would quarantine every id
		// this project writes.
		taskKey = await resolveTaskKey(boardDir, root);
		handle = await openProjectDb(mfwDir);
	} catch (error) {
		await releaseLock();
		throw error;
	}
	await ensureBoardConfig(boardDir, taskKey);
	const boardConfig = await loadBoardConfig(join(boardDir, "board.yaml"));
	const plog = log.child({ project: cfg.name });
	const bus = new EventBus();

	const integrationBranch =
		cfg.integrationBranch ?? (await resolveIntegrationBranch(root));
	// When the board lives in its own checkout, it commits to THAT repo's
	// history, on whatever branch is checked out there — it has nothing to do
	// with the code repo's integration branch once the two are split.
	const boardIntegrationBranch =
		boardRoot === root
			? integrationBranch
			: await resolveIntegrationBranch(boardRoot);

	const configuredMergeChecks =
		cfg.mergeChecks !== undefined ? cfg.mergeChecks : FALLBACK_MERGE_CHECKS;
	const tasks = new TaskService({
		handle,
		bus,
		mfwDir: boardDir,
		config: boardConfig,
		taskKey,
		log: plog,
		mergeChecks: configuredMergeChecks,
	});
	// Board is committed path-scoped and pinned to its own integration branch;
	// on any other branch the on-disk board belongs to that branch. If
	// `boardRoot` isn't a git repo (or isn't one yet), `BoardRepo` stays
	// disabled and the board is simply unversioned — the same fallback as a
	// same-repo board with no git (MFW-ADR-5).
	const board = new BoardRepo({
		projectRoot: boardRoot,
		mfwDir: boardDir,
		integrationBranch: boardIntegrationBranch,
		log: plog,
	});
	tasks.onBoardChanged = () => board.touch();
	const adrs = new AdrService({ mfwDir: boardDir, taskKey, log: plog });
	adrs.onBoardChanged = () => board.touch();
	// A board the loader distrusts (circuit breaker) must not be committed.
	tasks.onBoardSuspended = (on) => board.setSuspended(on);
	const registry = new RunRegistry({
		handle,
		bus,
		runsDir: join(mfwDir, "runs"),
	});
	const projectSlots = new ProjectResourceSlots({
		handle,
		bus,
		log: plog,
	});
	const host = new AgentHost(plog);
	const adapters = new AdapterRegistry();
	const notifier = makeNotifier(cfg.notify, plog);
	// Built before mergeQueue/maintenance/stepRunner, which raise sessions.
	// `startSession` (needs RunEngine) and `dismissInboxItem` (needs InboxService) are late-bound below.
	const sessions = new SessionService({
		handle,
		bus,
		log: plog,
		project: cfg.name,
		tasks,
		registry,
	});
	const clarify = new ClarifyService({
		handle,
		bus,
		log: plog,
		// Late-bound: a re-plan starts a run and RunEngine does not exist yet.
		replan: async (input) => {
			const prior = await registry.get(input.continuationRunId);
			if (prior) {
				if (prior.kind !== "plan" || prior.parentRunId !== input.sourceRunId) {
					throw new Error(
						`continuation id ${input.continuationRunId} belongs to another run`,
					);
				}
				const terminalError = continuationTerminalError(prior);
				if (terminalError) throw terminalError;
				return { runId: prior.id };
			}
			const source = await registry.get(input.sourceRunId);
			return engine.startPlan(input.goal, {
				runId: input.continuationRunId,
				answers: input.answers,
				taskId:
					source?.kind === "plan" ? (source.taskId ?? undefined) : undefined,
				parentRunId: input.sourceRunId,
			});
		},
	});
	const provider = providerConfigFor(
		cfg.provider?.id ?? DEFAULT_PROVIDER_ID,
		cfg.provider?.env,
	);
	const model = cfg.model ?? DEFAULTS.model;
	const reasoningEffort = cfg.reasoningEffort ?? DEFAULTS.reasoningEffort;

	const assistance = effectiveAssistance(cfg);
	const assistanceState = { ...assistance };
	const brain = new BrainService({
		registry,
		handle,
		bus,
		inference: inferenceForProvider(provider, { cwd: root }),
		tasks,
		log: plog,
		model,
		reviewModel: cfg.reviewModel,
		providerId: provider.id,
		reasoningEffort,
		// Dispatch planning always needs the brain; optional actions (diagnose,
		// conflicts, review) keep their own gates below.
		enabled: true,
		projectRoot: root,
	});
	const verification = new VerificationCoordinator();
	// MergeQueue is built before Scheduler; the breaker exemption follows the live setting.
	let scheduler!: Scheduler;
	let maintenance!: Maintenance;
	let supervisor!: Supervisor;

	const mergeQueue = new MergeQueue({
		handle,
		bus,
		projectRoot: root,
		log: plog,
		reverify: async (job) => {
			const task = job.taskId ? await tasks.get(job.taskId) : null;
			const dod = tasks.effectiveDod(task?.dod ?? null);
			if (!dod) return { passed: true }; // nothing to re-check
			const run = await registry.get(job.runId);
			if (!run?.worktreePath || !run.baseSha)
				return { passed: false, detail: "run worktree is gone" };
			const result = await verification.foreground(() =>
				verify(run.worktreePath as string, dod, run.baseSha as string, {
					checkPrefix: cfg.checkPrefix,
					envPolicy: cfg.envPolicy,
				}),
			);
			return {
				passed: result.passed,
				// Lets MergeQueue tell a crashed check from a real re-verify failure.
				crashed: result.crashed,
				detail: result.checks
					.filter((c) => !c.ok)
					.map((c) => c.check)
					.join(", "),
			};
		},
		onMerged: async (job) => {
			const mergedRun = await registry.get(job.runId);
			if (job.taskId && mergedRun?.kind !== "repair")
				await tasks.release(
					job.taskId,
					job.runId,
					"done",
					"scheduler",
					"merged",
				);
			await registry.finish(job.runId, "completed", "merged");
			if (mergedRun?.kind === "repair") {
				supervisor.requestMaintenance();
			}
			await tasks.promoteReady(); // dependents may now be eligible
			// MergeQueue publishes as soon as this callback returns. Task release and
			// dependent promotion only mark the board dirty, while the normal board
			// commit is debounced until the next supervisor pass. Flush here so
			// "Push after merge" includes the resulting Done/Ready state in the same
			// push instead of stopping at the merge commit.
			await board.flush();
			scheduler.wake();
		},
		onParked: async (job, reason, kind) => {
			const parkedRun = await registry.get(job.runId);
			if (job.taskId && parkedRun?.kind !== "repair") {
				await tasks.release(
					job.taskId,
					job.runId,
					kind === "conflict" ? "blocked" : "review",
					"scheduler",
					reason,
				);
			}
			await registry.finish(job.runId, "failed", reason);
			await notifier.notify(kind === "conflict" ? "blocked" : "review", {
				project: cfg.name,
				taskId: job.taskId ?? undefined,
				runId: job.runId,
				message: reason,
			});
			// Reached only after park() exhausted its retries and any automatic unblock.
			// `job` keeps the run's worktree and branch, which `open()` reuses.
			await sessions
				.raise({
					source: "merge_parked",
					sourceKey: String(job.id),
					taskId: job.taskId ?? undefined,
					runId: job.runId,
					mergeJobId: job.id,
					title: `merge parked: ${job.branch}`,
					summary: reason,
					whatWasTried: [
						`rebased this branch onto ${job.targetBranch} and retried, ${job.parkRetries} time(s), each attempt against the CURRENT tip of ${job.targetBranch} (never the same stale target twice)`,
						kind === "reverify"
							? "the rebase itself succeeded cleanly each time: it was re-running mechanical verification afterwards that kept failing"
							: "the rebase itself produced conflicting files each time",
					],
					environment:
						"The rebase and re-verify both ran in the RUN's own worktree " +
						"(path above)); the merge attempt itself ran separately, in " +
						"mfw's own integration worktree at `.mfw/integration`, which " +
						"is not reusable and already reset. The worktree above still " +
						"has whatever state the last automatic attempt left it in.",
				})
				.catch((e) => {
					plog.warn(
						{ err: e, job: job.id },
						"could not raise a session for the parked merge",
					);
				});
		},
		reclaimTask: async (job) => {
			if (job.taskId) await tasks.reclaimForRetry(job.taskId, job.runId);
		},
		sendTaskToReady: async (job) => {
			if (job.taskId)
				await tasks.move(
					job.taskId,
					"ready",
					"human",
					"merge parked, sent back to ready",
				);
		},
		push: {
			enabled: cfg.pushOnMerge !== false,
			remote: cfg.pushRemote ?? "origin",
		},
		selfRepairMainRed: () => scheduler.selfRepairMainRed,
	});

	const executionTargets = new ExecutionTargetRegistry([
		createLocalExecutionTarget({
			projectRoot: root,
			integrationBranch,
			host,
		}),
		...(opts.runpod
			? [
					createRunPodExecutionTarget({
						account: opts.runpod,
						projectRoot: root,
						integrationBranch,
					}),
				]
			: []),
	]);
	const engine = new RunEngine({
		handle,
		registry,
		tasks,
		host,
		executionTargets,
		projectId: projectIdentity.id,
		workloadSecretGrantIds: cfg.workloadSecretGrants ?? [],
		resolveWorkloadSecrets: (selection) => {
			if (!opts.credentials || !opts.workloadGrants) {
				throw new Error("workload secret grant resolver is unavailable");
			}
			return opts.workloadGrants.resolveBound(selection, opts.credentials);
		},
		resolveTaskExecutionTarget: (task) => {
			if (task.executionTarget !== "runpod") {
				return {
					kind: task.executionTarget,
					requiresResources: task.requiresResources,
					localStagingResources: task.localStagingResources,
				};
			}
			if (!cfg.runpodTarget) {
				throw new Error(
					"execution_target: runpod requires project runpodTarget placement",
				);
			}
			const remoteGate = opts.runpod?.gate.gate();
			if (remoteGate) {
				throw new Error(remoteGate.reason);
			}
			return {
				kind: "runpod",
				requestedShape: cfg.runpodTarget,
				requiresResources: task.requiresResources,
				localStagingResources: task.localStagingResources,
			};
		},
		adapters,
		log: plog,
		projectRoot: root,
		projectName: cfg.name,
		integrationBranch,
		// Resolved via the catalogue so an unknown provider in config.json fails at attach, not at every launch.
		provider,
		defaults: {
			model,
			modelTiers: cfg.modelTiers ?? {},
			reasoningEffort,
			maxRepairs: cfg.maxRepairs ?? DEFAULTS.maxRepairs,
			leaseMs: cfg.leaseMs ?? DEFAULTS.leaseMs,
			approvalMode: cfg.approvalMode ?? DEFAULTS.approvalMode,
		},
		globalPaused: opts.globalPaused,
		beforeLaunch: () => verification.preemptBackground(),
		buildPrompt: buildPrompts(tasks, registry),
		// Hide the daemon's home (trigger arming store, credentials.json).
		isolation:
			(cfg.agentIsolation ?? DEFAULTS.agentIsolation) === "bwrap"
				? { mode: "bwrap", hidePaths: [opts.mfwHome] }
				: undefined,
	});
	const admission = new ProjectDispatchAdmission(
		{
			projectId: projectIdentity.id,
			projectName: cfg.name,
			handle,
			bus,
			tasks,
			registry,
			engine,
			host: opts.hostResources,
			projectSlots,
			sessionId: (runId) => host.session(runId),
			log: plog,
		},
		{ afterTransition: opts.afterAdmissionTransition },
	);
	engine.setTaskAdmission(admission);

	const stepRunner = new StepRunner({
		handle,
		bus,
		registry,
		tasks,
		clarify,
		mergeQueue,
		host,
		brain: {
			get enabled() {
				return Object.values(assistanceState).includes("assisted");
			},
			get criticEnabled() {
				return assistanceState.changeReview === "assisted";
			},
			get humanReviewEnabled() {
				return assistanceState.changeReview === "human";
			},
			get replanEnabled() {
				return assistanceState.failureDiagnosis === "assisted";
			},
			get importReviewEnabled() {
				return assistanceState.changeReview === "assisted";
			},
			critic: (ctx) => brain.critic(ctx),
			replan: (ctx) => brain.replan(ctx),
			importReview: (ctx) => brain.importReview(ctx),
		},
		notifier: {
			notify: async (kind, detail) => {
				await notifier.notify(kind, { project: cfg.name, ...detail });
			},
		},
		projectRoot: root,
		checkPrefix: cfg.checkPrefix,
		envPolicy: cfg.envPolicy,
		verification,
		log: plog,
		config: {
			maxStalls: cfg.maxStalls ?? DEFAULTS.maxStalls,
			maxResumes: cfg.maxResumes ?? DEFAULTS.maxResumes,
			draftExpandMaxAttempts:
				cfg.draftExpandMaxAttempts ?? DEFAULTS.draftExpandMaxAttempts,
			mergeChecks: configuredMergeChecks ?? FALLBACK_MERGE_CHECKS,
		},
		sessions,
	});
	// Late bindings: repair/resume children spawn from a finalize step, which would otherwise cycle.
	stepRunner.spawnRepair = (parent, child) => engine.startRepair(parent, child);
	stepRunner.spawnResume = (parent, child) => engine.startResume(parent, child);
	sessions.startSession = (prompt, opts) => engine.startSession(prompt, opts);
	// Late-bound (MergeQueue predates RunEngine). Returning null makes park()
	// escalate straight to a human; a spawn failure degrades the same way.
	mergeQueue.unblock = async (job, reason) => {
		if (assistanceState.conflictResolution !== "assisted" || !job.taskId)
			return null;
		const childRunId = ulid();
		try {
			await engine.startUnblock(job.runId, childRunId, reason);
		} catch (e) {
			plog.error(
				{ err: e, job: job.id, taskId: job.taskId },
				"automatic unblock spawn failed",
			);
			return null;
		}
		await registry.finish(
			job.runId,
			"failed",
			`${reason}; spawned automatic unblock run ${childRunId}`,
		);
		return { runId: childRunId };
	};

	const lifetime = new LifetimeManager({
		handle,
		bus,
		tasks,
		log: plog,
		projectRoot: root,
		// Named predicates for `trigger.condition:`. `maintenance` is built later; safe because these run on tick.
		conditions: {
			main_is_red: async () => maintenance.isMainRed(),
			board_has_no_ready_tasks: async () =>
				(await tasks.readySet()).length === 0,
		},
	});

	// Action kinds. `script` has its own semaphore, separate from `maxConcurrent`,
	// so a chatty trigger cannot starve the board of agents.
	const triggerActions = new TriggerActionRegistry();
	const triggerCredentials = CredentialStore.at(opts.mfwHome);
	const triggerScriptSemaphore = new Semaphore(
		cfg.maxConcurrentTriggers ?? DEFAULTS.maxConcurrentTriggers,
	);
	triggerActions
		.register("notify", createNotifyAction({ notifier, tasks }))
		.register(
			"script",
			createScriptAction({
				log: plog,
				secrets: triggerCredentials,
				semaphore: triggerScriptSemaphore,
			}),
		)
		.register("agent", createAgentAction({ engine, tasks }))
		.register("create_task", createCreateTaskAction({ tasks }));
	const triggers = new TriggerService({
		handle,
		bus,
		log: plog,
		projectRoot: root,
		projectName: cfg.name,
		mfwHome: opts.mfwHome,
		actions: triggerActions,
		notifier: {
			notify: async (kind, detail) => {
				await notifier.notify(kind, { project: cfg.name, ...detail });
			},
		},
		// `scheduler` is built later; safe because this is only called after construction.
		holdDispatch: (untilMs, reason) => scheduler.hold(untilMs, reason),
	});

	maintenance = new Maintenance({
		handle,
		bus,
		tasks,
		registry,
		log: plog,
		projectRoot: root,
		mfwHome: opts.mfwHome,
		integrationBranch,
		checkPrefix: cfg.checkPrefix,
		envPolicy: cfg.envPolicy,
		leaseMs: cfg.leaseMs ?? DEFAULTS.leaseMs,
		startExpand: (taskId, prompt) => engine.startPlan(prompt, { taskId }),
		// `scheduler` is built later; safe because this is only called from the maintenance loop.
		dispatching: () => scheduler.status().then((s) => s.playing),
		maxConcurrentDraftExpansions:
			cfg.maxConcurrentDraftExpansions ?? DEFAULTS.maxConcurrentDraftExpansions,
		// BrainService implements DiagnosePort structurally; the wrapper gates it
		// on the failure-diagnosis policy.
		diagnose: {
			get enabled() {
				return assistanceState.failureDiagnosis === "assisted";
			},
			diagnose: (ctx) => brain.diagnose(ctx),
		},
		sessions,
		startRepair: (taskId, incidentId, detail) =>
			scheduler.selfRepairMainRed &&
			assistanceState.failureDiagnosis === "assisted"
				? engine.startRegressionRepair(taskId, incidentId, detail)
				: Promise.resolve(null),
	});

	supervisor = new Supervisor({
		handle,
		registry,
		tasks,
		host,
		execution: engine,
		stepRunner,
		log: plog,
		projectRoot: root,
		bootId,
		leaseMs: cfg.leaseMs ?? DEFAULTS.leaseMs,
		// Merging and housekeeping hang off the supervisor (always runs), so a
		// project with dispatch disabled still merges, grooms and sweeps.
		mergeQueue,
		triggers,
		// Reads are branch-pinned too: on another branch a reload would emit a
		// `task.deleted` per task. Hold the last integration-branch state instead.
		boardPoll: async () => {
			if (!(await board.onIntegrationBranch())) return [];
			return tasks.refresh();
		},
		boardCommit: () => board.tick(),
		releaseSlots: (runId) => admission.releaseRun(runId),
		renewAdmission: (runId) => admission.renewRun(runId),
		maintenance: async () => {
			const coordinated = await verification.backgroundWork(async (signal) => {
				await lifetime.tick();
				await maintenance.tick(signal);
				// A parked merge is usually a stale conflict: requeue (bounded). This
				// cadence is the retry backoff.
				await mergeQueue.retryParked().catch((e) => {
					plog.warn({ err: e }, "periodic parked-merge retry failed");
				});
				// Full reconcile; the change poll only reloads when a hash moved.
				if (await board.onIntegrationBranch()) {
					await tasks.load().catch((e) => {
						plog.warn({ err: e }, "periodic board reconcile failed");
					});
				}
				// Backstop for board changes that bypassed a mutation.
				await board.tick(true).catch((e) => {
					plog.warn({ err: e }, "periodic board commit failed");
				});
				// Board-only commits have no merge to ride along with; this sweep pushes them.
				await mergeQueue.publishBranch(integrationBranch).catch((e) => {
					plog.warn({ err: e }, "periodic push failed");
				});
			});
			if (coordinated.status === "busy") {
				plog.debug("maintenance deferred behind foreground verification");
			}
		},
		maintenanceEveryNPasses: 150, // ~5 min at the 2s pass interval
	});
	let draftExpansionWake: Promise<void> | null = null;
	let draftExpansionWakeRequested = false;
	const wakeDraftExpansion = () => {
		if (draftExpansionWake) {
			draftExpansionWakeRequested = true;
			return;
		}
		draftExpansionWake = maintenance
			.expandDrafts()
			.then(() => {})
			.catch((error) => {
				plog.error({ err: error }, "immediate draft expansion sweep failed");
			})
			.finally(() => {
				draftExpansionWake = null;
				if (draftExpansionWakeRequested) {
					draftExpansionWakeRequested = false;
					wakeDraftExpansion();
				}
			});
	};
	tasks.onDraftCaptured = wakeDraftExpansion;

	scheduler = new Scheduler({
		handle,
		bus,
		tasks,
		engine,
		registry,
		log: plog,
		dispatchPlanner: brain,
		config: {
			maxConcurrent: cfg.maxConcurrent ?? DEFAULTS.maxConcurrent,
			selfRepairMainRed: cfg.selfRepairMainRed ?? DEFAULTS.selfRepairMainRed,
		},
		globalPaused: opts.globalPaused,
	});

	const health = new Health({
		handle,
		tasks,
		bootId,
		startedAt: Date.now(),
		supervisor,
		scheduler,
		brain,
		admission,
	});

	const inbox = new InboxService({
		handle,
		project: cfg.name,
		tasks,
		triggers,
		// Read live off the scheduler, not `cfg`, so settings changes apply immediately.
		selfRepairMainRed: () => scheduler.selfRepairMainRed,
		mergeQueue,
		admission,
	});
	sessions.dismissInboxItem = (itemId) => inbox.dismiss(itemId);
	const review = new ReviewService({
		handle,
		registry,
		tasks,
		projectRoot: root,
		mergeQueue,
	});
	const workspace = new WorkspaceService({ root: root, registry });
	const resources = new ResourceService({ handle, scheduler });
	const settings = new SettingsService({
		mfwHome: opts.mfwHome,
		project: cfg.name,
		root: root,
		integrationBranch,
		scheduler,
		brain,
		assistance: {
			get value() {
				return { ...assistanceState };
			},
			set(value) {
				Object.assign(assistanceState, value);
			},
		},
		mergeQueue,
		schedulerIntervalMs: opts.schedulerIntervalMs,
		lifecycle: opts.lifecycle,
	});

	// Before the board is read: creates the board dirs and the circuit-breaker sentinel.
	await board.ensureTracked();

	// Load before any service can query the shared in-memory index.
	const scan = await tasks.load();
	plog.info(
		{
			tasks: scan.loaded,
			adopted: scan.adopted,
			quarantined: scan.quarantined.length,
			versioned: board.isEnabled,
		},
		"board loaded from disk",
	);

	// Commit the freshly loaded board now instead of waiting for a transition.
	// Idempotent: nothing staged means no empty commit.
	board.touch();

	try {
		await opts.hostResources.registerProject({
			identity: projectIdentity,
			root,
			displayName: cfg.name,
			metadata: { integrationBranch },
		});
	} catch (error) {
		handle.close();
		await releaseLock();
		throw error;
	}
	await admission.reconcile();
	const releaseHostWake = opts.hostResources.subscribe(projectIdentity.id, () =>
		scheduler.wake(),
	);

	return {
		name: cfg.name,
		projectId: projectIdentity.id,
		root: root,
		mfwDir,
		integrationBranch,
		schedulerAutostart: cfg.schedulerAutostart ?? false,
		handle,
		bus,
		log: plog,
		hostResources: opts.hostResources,
		releaseHostWake,
		tasks,
		registry,
		host,
		engine,
		admission,
		mergeQueue,
		supervisor,
		health,
		scheduler,
		brain,
		releaseLock,
		board,
		inbox,
		review,
		maintenance,
		sessions,
		lifetime,
		triggers,
		clarify,
		adrs,
		workspace,
		resources,
		settings,
		events: {
			since: (seq, limit) => eventsSince(handle.db, seq, limit),
			latestSeq: () => latestSeq(handle.db),
			list: (query) => listEvents(handle.db, query),
		},
	};
}

// Spec prose can be long; cap it so it cannot crowd out the task body. Truncation is marked.
const SPEC_CAP_BYTES = 24 * 1024;

/** Render a task's own `spec.md` as a delimited, capped section. */
function renderSpecSection(taskId: string, body: string): string {
	const text = body.trim();
	if (!text) return "";
	const shown =
		text.length > SPEC_CAP_BYTES
			? `${text.slice(0, SPEC_CAP_BYTES)}\n…(${taskId}'s spec truncated, over the ${SPEC_CAP_BYTES}-byte cap)`
			: text;
	return `\n## Spec\n\n${shown}`;
}

/** The paths a task may edit, and what to do when that is not enough. */
function renderScopeSection(owns: readonly string[]): string {
	if (owns.length === 0) return "";
	return [
		"\n## Scope",
		"Edit only these paths (repository-relative, globs allowed):",
		...owns.map((p) => `- \`${p}\``),
		"Other tasks may be editing the rest of the repository at the same time.",
		"If this task cannot be done inside these paths, stop: write",
		'MFW_REPORT.json with `"status": "blocked"` and name the paths you need in',
		"`issues`.",
	].join("\n");
}

/** Optional per-task fields the planner and importer may set. */
const PROPOSAL_TASK_FIELDS = [
	"Two optional fields per task:",
	'- `owns`: ["repo/relative/path", "src/dir/**"], the paths the task may edit.',
	"  Tasks whose `owns` overlap never run at the same time; omit it when the",
	"  task's footprint is not clear.",
	'- `model_tier`: "light" | "standard" | "strong". Set it only when the task',
	"  clearly needs a stronger model, or is simple enough for a cheaper one.",
].join("\n");

/** The implementation template, when the project has one. */
async function renderTemplateSection(tasks: TaskService): Promise<string> {
	const template = await tasks.templateFor("implementation");
	if (!template) return "";
	return [
		"",
		"## Task body template",
		"Every task `body` must fill in the required sections of this template",
		"(`##` headings; a heading ending in `(optional)` may be left out). Replace",
		"the guidance text; do not copy it.",
		"```markdown",
		template.text.trim(),
		"```",
	].join("\n");
}

interface ReapedProcess {
	pid: number;
	command: string;
}

/** What a parent run's `reap_leftovers` step found still running, if anything. */
async function leftoversOf(
	registry: RunRegistry,
	runId: string,
): Promise<ReapedProcess[]> {
	const step = (await registry.steps(runId)).find(
		(s) => s.step === "reap_leftovers" && s.status === "done",
	);
	const processes = (step?.result as { processes?: unknown } | undefined)
		?.processes;
	if (!Array.isArray(processes)) return [];
	return processes.filter(
		(p): p is ReapedProcess =>
			typeof p === "object" &&
			p !== null &&
			typeof (p as ReapedProcess).command === "string",
	);
}

/** Prompt construction, kept out of RunEngine so wording is tunable separately from lifecycle. */
export function buildPrompts(tasks: TaskService, registry: RunRegistry) {
	const describeTask = async (taskId: string): Promise<string> => {
		const t = await tasks.get(taskId);
		if (!t) return `Task ${taskId} (details unavailable).`;
		const criteria = t.criteria
			.map((c) => `- [${c.checked ? "x" : " "}] ${c.text}`)
			.join("\n");
		const taskVerification = t.verification
			? JSON.stringify(t.verification, null, 2)
			: "(none; project merge checks still apply)";
		const mergeChecks = tasks.projectMergeChecks()
			? JSON.stringify(tasks.projectMergeChecks(), null, 2)
			: "(none configured)";
		const spec = await tasks.getSpec(taskId);
		return [
			`# ${t.id}: ${t.title}`,
			"",
			t.body,
			criteria ? `\n## Acceptance Criteria\n${criteria}` : "",
			`\n## Task verification checks\n\`\`\`json\n${taskVerification}\n\`\`\``,
			`\n## Project merge checks\n\`\`\`json\n${mergeChecks}\n\`\`\``,
			renderScopeSection(t.owns),
			renderSpecSection(taskId, spec?.body ?? ""),
		].join("\n");
	};

	return {
		task: async (taskId: string) =>
			[
				await describeTask(taskId),
				"",
				"Implement this task in the current worktree. Commit your work.",
				"Project and task verification checks run independently after you finish.",
				"Semantic acceptance is also reviewed against the goal and every criterion;",
				"claiming success is evidence, not the acceptance decision.",
			].join("\n"),

		repair: async (taskId: string, parentRunId: string) => {
			const steps = await registry.steps(parentRunId);
			const verifyStep = steps.find((s) => s.step === "verify");
			const failures = JSON.stringify(verifyStep?.result ?? {}, null, 2);
			return [
				await describeTask(taskId),
				"",
				"## The previous attempt did not pass verification",
				"```json",
				failures,
				"```",
				"Fix exactly what failed. The same checks run again afterwards.",
			].join("\n");
		},

		resume: async (taskId: string, parentRunId: string) => {
			const parent = await registry.get(parentRunId);
			const leftovers = await leftoversOf(registry, parentRunId);
			return [
				await describeTask(taskId),
				"",
				"## Resuming interrupted work",
				leftovers.length > 0
					? `A previous run (${parentRunId}) ended its session while commands it started were still running.`
					: `A previous run (${parentRunId}) was interrupted before finishing.`,
				parent?.worktreePath
					? "Its work is already in this worktree: inspect `git status` and `git log` before continuing, and do not redo what is done."
					: "",
				...(leftovers.length > 0
					? [
							"",
							"## Commands left running",
							"These were still running when that session ended, and mfw stopped them:",
							"```",
							...leftovers.map((p) => p.command),
							"```",
							"Their results were never seen. Nothing wakes an agent after its",
							"session ends: a background job cannot report back to you. Run long",
							"commands in the foreground, wait for them, and finish all of your",
							"work within this session.",
						]
					: []),
			].join("\n");
		},

		/** Automatic attempt before a retry-exhausted conflict reaches a human. `reason` is park()'s message (paths or re-verify detail). */
		unblock: async (taskId: string, _parentRunId: string, reason: string) =>
			[
				await describeTask(taskId),
				"",
				"## This task's branch would not merge",
				`mfw tried to merge this task's work into the target branch and could`,
				`not, after retrying automatically against the current target several`,
				"times:",
				"```",
				reason,
				"```",
				"Resolve it in this worktree: rebase onto the target branch and fix",
				"the conflict (or otherwise make the branch mergeable), keeping the",
				"task's actual work intact. Verification and acceptance run again",
				"afterwards, and a passing result re-enters the merge queue like any",
				"other run; this does not merge anything by itself.",
			].join("\n"),

		/**
		 * An import describes a repository, so work may already be done and each
		 * task states its status. `in_progress` is absent on purpose
		 * (see IMPORT_STATUS_ALIASES in finalize/step-runner.ts).
		 */
		import: async () => {
			return [
				"Survey this repository and write its work as mfw tasks, plus a spec",
				"for each body of work that several tasks share a design for.",
				"Cover what is DONE as well as what is outstanding: this is a census",
				"of the repository, not a wishlist.",
				"",
				"Emit JSON in your final message:",
				'{"tasks": [{"title", "body", "status", "depends_on": [<indexes>],',
				'            "criteria": ["observable outcome", "..."], "verification": {...}}],',
				' "specs":  [{"title", "body", "tasks": [<indexes>]}],',
				' "questions": ["..."]}',
				"",
				'`status` per task is one of: "backlog" (planned), "ready", "blocked",',
				'"review", "done", "archived". Omit it and the task lands in backlog.',
				"A spec is the design a group of tasks is built against: the shared",
				"contract, constraints and decisions. mfw files it as the `spec.md` of a",
				"container task that the listed tasks become children of.",
				"",
				"`depends_on` and a spec's `tasks` refer to tasks by their INDEX in the",
				"`tasks` array above: ids do not exist yet; mfw assigns them. A spec's",
				"`tasks` list is the only place the link is recorded, so a spec with an",
				"empty list covers nothing.",
				"",
				PROPOSAL_TASK_FIELDS,
				await renderTemplateSection(tasks),
				"",
				"Every outstanding task needs explicit semantic acceptance criteria.",
				"Task verification is optional and focused; project merge checks always apply.",
				"Prefer few well-scoped tasks over many vague ones. If something about",
				"this repository is genuinely ambiguous, put it in `questions` rather",
				"than guessing.",
			].join("\n");
		},

		/** `answers` is a previous run's answered clarify set, fed back into the plan prompt. */
		plan: async (
			goal: string,
			answers: { question: string; answer: string }[] = [],
			opts: { autonomous?: boolean } = {},
		) =>
			[
				`Decompose this goal into a dependency-ordered task DAG:\n\n${goal}`,
				answers.length > 0
					? [
							"",
							"## Answers to your earlier questions",
							"A previous planning run asked these; they are now settled: plan",
							"against them and do not ask them again.",
							...answers.map((a) => `\n**${a.question}**\n${a.answer}`),
						].join("\n")
					: "",
				"",
				"Emit JSON in your final message:",
				'{"tasks": [{"title", "body", "depends_on": [<indexes>],',
				'            "criteria": ["observable outcome", "..."], "verification": {...}}],',
				opts.autonomous
					? ' "specs": [{"title", "body", "tasks": [<indexes>]}]}'
					: ' "specs": [{"title", "body", "tasks": [<indexes>]}],',
				opts.autonomous ? "" : ' "questions": ["..."]}',
				"Every task needs explicit semantic acceptance criteria.",
				"Add focused task verification only where it gives evidence beyond the",
				"repository-wide project merge checks.",
				"`specs` is optional: emit one when several of the tasks must agree on a",
				"shared design (a contract, a format, an invariant). mfw files it as the",
				"`spec.md` of a container task those tasks become children of. Indexes in",
				"`depends_on` and in a spec's `tasks` refer to positions in the `tasks`",
				"array; mfw assigns the real ids.",
				PROPOSAL_TASK_FIELDS,
				await renderTemplateSection(tasks),
				opts.autonomous
					? "This task opted out of human review: decide any ambiguity yourself, note the assumption you made in the task body it affects, and emit a complete plan. Do not ask questions: nothing will be waiting to answer them."
					: "If a decision is genuinely ambiguous, ask rather than guess.",
			].join("\n"),
	};
}

/**
 * One daemon per project, enforced by a lifetime kernel lock. Boot clears
 * finalize claims not owned by this boot, so a second process would steal a
 * live peer's claims and double-finalize runs. The flock on the file's inode is
 * ownership; the file itself is persistent metadata.
 */
/**
 * On `globalThis`, not module scope: a bundler that emits this module into two
 * chunks gives each copy its own set and the double-attach check goes blind
 * (this booted two orchestrators in the production bundle).
 */
const LOCKS_KEY = Symbol.for("mfw.heldProjectLocks");
const globalScope = globalThis as Record<symbol, unknown>;
if (!globalScope[LOCKS_KEY]) globalScope[LOCKS_KEY] = new Set<string>();
const heldLocks = globalScope[LOCKS_KEY] as Set<string>;

async function acquireProjectLock(
	mfwDir: string,
	bootId: string,
): Promise<() => Promise<void>> {
	const lockPath = join(mfwDir, "daemon.lock");
	// In-process conflict (two orchestrators in one server, or a test booting
	// twice): the pid file cannot see this, since the pid is our own.
	if (heldLocks.has(mfwDir)) {
		throw new Error(
			`this process already owns ${mfwDir}; shut the other orchestrator down first`,
		);
	}
	let lock: KernelLock;
	try {
		lock = await acquireKernelLock(lockPath, {
			timeoutMs: 2_000,
			busyMessage:
				`another mfw daemon already owns ${mfwDir}; ` +
				"shut it down before attaching this repository",
			metadata: {
				pid: process.pid,
				bootId,
				project: resolve(mfwDir, ".."),
				acquiredAt: Date.now(),
			},
		});
	} catch (error) {
		if (error instanceof KernelLockError) throw new Error(error.message);
		throw error;
	}
	heldLocks.add(mfwDir);
	let released = false;
	return async () => {
		if (released) return;
		released = true;
		heldLocks.delete(mfwDir);
		await lock.release();
	};
}

export async function boot(opts: BootOptions): Promise<Orchestrator> {
	const bootId = randomUUID();
	const startedAt = Date.now();
	const log = (opts.log ?? rootLogger()).child({ bootId });
	const home = resolve(opts.mfwHome ?? configuredMfwHome());
	const kernelBootId =
		opts.kernelBootId === undefined
			? await readKernelBootId()
			: opts.kernelBootId;
	// First, so a second daemon never attaches, migrates, recovers or dispatches.
	const daemonLock = await acquireDaemonLock(home, {
		processBootId: bootId,
		timeoutMs: opts.daemonLockTimeoutMs,
	});
	let hostResources!: HostResourceCoordinator;
	let hostStore: HostResourceStore | undefined;
	try {
		hostStore = await openHostResourceStore(home, {
			processBootId: bootId,
			kernelBootId,
			now: opts.hostNow,
		});
		const livenessHost = new AgentHost(log);
		const probeRuntime =
			opts.hostProbes?.runtime ?? createProductionHostProbeRuntime();
		const {
			runtime: _runtime,
			adapters: injectedAdapters,
			...observationOptions
		} = opts.hostProbes ?? {};
		hostResources = await HostResourceCoordinator.create(hostStore, {
			liveness:
				opts.hostLiveness ??
				new SystemLeaseLiveness({
					kernelBootId,
					now: opts.hostNow,
					sessions: {
						isAlive: (_sessionId, runId) => livenessHost.sessionLiveness(runId),
					},
				}),
			now: opts.hostNow,
			leaseMs: opts.hostLeaseMs,
			livenessMaxAgeMs: opts.hostLivenessMaxAgeMs,
			afterTransition: opts.afterHostTransition,
			observations: {
				...observationOptions,
				adapters:
					injectedAdapters ??
					createDefaultHostProbeAdapters({
						runtime: probeRuntime,
						processBootId: bootId,
						kernelBootId,
						freshnessMs: Math.max(
							1_000,
							(observationOptions.pollIntervalMs ?? 5_000) * 3,
						),
					}),
				clock: observationOptions.clock ?? probeRuntime.clock,
				timer: observationOptions.timer ?? probeRuntime.timer,
				log: observationOptions.log ?? log.child({ svc: "host-observation" }),
			},
		});
		if (opts.autostart !== false) await hostResources.observations.start();
		await hostResources.reconcile("startup");
	} catch (error) {
		if (hostResources) await hostResources.shutdown().catch(() => {});
		else hostStore?.close();
		await daemonLock.release();
		throw error;
	}
	const projects = new Map<string, ProjectServices>();
	// One serialization domain per project name: attach, detach and settings calls.
	// A generation token is a tombstone; after detach, stale services cannot read, write or apply settings.
	const lifecycleTails = new Map<string, Promise<void>>();
	const projectGenerations = new Map<string, symbol>();
	const serializeProjectLifecycle = <T>(
		name: string,
		operation: () => Promise<T>,
	): Promise<T> => {
		const preceding = lifecycleTails.get(name) ?? Promise.resolve();
		const result = preceding.catch(() => {}).then(operation);
		const tail = result.then(
			() => {},
			() => {},
		);
		lifecycleTails.set(name, tail);
		void tail.finally(() => {
			if (lifecycleTails.get(name) === tail) lifecycleTails.delete(name);
		});
		return result;
	};
	const settingsLifecycle = (
		name: string,
		generation: symbol,
	): SettingsLifecycle => ({
		run: (operation) =>
			serializeProjectLifecycle(name, async () => {
				if (projectGenerations.get(name) !== generation) {
					throw new Error(`project '${name}' is detached`);
				}
				return operation();
			}),
	});
	const credentialStore = CredentialStore.at(home);
	const workloadGrants = WorkloadSecretGrantStore.at(home);
	const openrouter = new OpenRouterAccountService({
		client:
			opts.openrouterClient ??
			new OpenRouterClient({
				credentials: openRouterCredentialSource(credentialStore),
			}),
		managementClient:
			opts.openrouterManagementClient ??
			new OpenRouterClient({
				credentials: openRouterCredentialSource(
					credentialStore,
					OPENROUTER_MANAGEMENT_CREDENTIAL_ID,
				),
			}),
		log: log.child({ svc: "openrouter-account" }),
	});
	// Keyed by stable run-ownership identity, not the editable project name.
	const runpodProjectPolicies = new Map<
		string,
		RunPodProjectPolicy | undefined
	>();
	const configuredRunpodOwners = new Map<string, { projectName: string }>();
	const unavailableConfiguredProjects = new Set(
		opts.projects.map((project) => project.name),
	);
	const runpod = new RunPodAccountService({
		mfwHome: home,
		policy: opts.runpod ?? { enabled: false },
		client:
			opts.runpodClient ??
			new RunPodClient({
				credentials: runPodCredentialSource(credentialStore),
			}),
		log: log.child({ svc: "runpod-account" }),
		projectPolicy: (projectId) => runpodProjectPolicies.get(projectId),
		resolveOwner: async (owner, leaseRef, projectNameHint) => {
			const project = [...projects.values()].find(
				(candidate) => candidate.projectId === owner.project,
			);
			if (!project) {
				const configured = configuredRunpodOwners.get(owner.project);
				// Accepted joins: the project id from its .mfw identity, or the name on
				// the machine-wide lease. Never guess an owner from an arbitrary entry.
				const unavailableName =
					configured?.projectName ??
					(projectNameHint !== undefined &&
					unavailableConfiguredProjects.has(projectNameHint)
						? projectNameHint
						: undefined);
				if (unavailableName) {
					return {
						state: "unavailable",
						projectName: unavailableName,
						reason: "project_unavailable",
					};
				}
				// Ours, but possibly just unavailable rather than detached: keep it, close remote dispatch.
				return {
					state: "unavailable",
					projectName:
						`unresolved identity ${owner.project} ` +
						"(attach the matching project or inspect it in the provider console)",
					reason: "project_unavailable",
				};
			}
			const run = await project.registry.get(owner.run).catch(() => null);
			if (!run) {
				return {
					state: "unrecoverable",
					projectName: project.name,
					reason: "run_missing",
				};
			}
			if (
				run.executionTarget !== "runpod" ||
				run.targetProjectId !== owner.project ||
				run.targetLeaseRef !== leaseRef ||
				run.taskId !== owner.task ||
				run.attempt !== owner.attempt ||
				executionOwnerKey(owner.project, run.id, run.attempt) !== owner.owner
			) {
				return {
					state: "unrecoverable",
					projectName: project.name,
					reason: "identity_mismatch",
				};
			}
			if (run.state === "starting" || run.state === "running") {
				return { state: "active", projectName: project.name };
			}
			if (run.state === "ended" || run.state === "finalizing") {
				return {
					state: "ended",
					projectName: project.name,
					resumeFinalization: () => project.supervisor.wake(),
				};
			}
			return {
				state: "unrecoverable",
				projectName: project.name,
				reason: "terminal",
			};
		},
	});
	// One per machine, created before attach so every scheduler shares the same getter.
	const globalDispatch = GlobalDispatch.from(
		{ dispatchPaused: opts.dispatchPaused },
		STOPPED_EVERYWHERE,
		home,
	);

	for (const cfg of opts.projects) {
		let configuredProjectId: string | null = null;
		const generation = Symbol(cfg.name);
		try {
			// Refuse duplicates: overwriting would orphan the first service with its lock, DB and loops.
			if (projects.has(cfg.name)) {
				throw new Error(
					`duplicate project name '${cfg.name}' in config.json: ` +
						"the second entry is ignored; give it a different name",
				);
			}
			const svc = await attachProject(cfg, log, bootId, {
				schedulerIntervalMs: opts.schedulerIntervalMs,
				globalPaused: globalDispatch.gate,
				hostResources,
				mfwHome: home,
				afterAdmissionTransition: opts.afterAdmissionTransition,
				runpod,
				credentials: credentialStore,
				workloadGrants,
				lifecycle: settingsLifecycle(cfg.name, generation),
				onProjectIdentity: (identity) => {
					configuredProjectId = identity.id;
					configuredRunpodOwners.set(identity.id, { projectName: cfg.name });
				},
			});
			runpodProjectPolicies.set(svc.projectId, cfg.runpod);
			await runpod.markProjectReattached(svc.projectId, cfg.name);
			unavailableConfiguredProjects.delete(cfg.name);
			projectGenerations.set(cfg.name, generation);
			projects.set(cfg.name, svc);
		} catch (e) {
			// Fail loudly: never run on a half-migrated schema or a missing repo.
			log.error({ err: e, project: cfg.name }, "project attach FAILED");
			if (configuredProjectId) {
				runpod.gate.close(
					`RunPod owner project '${cfg.name}' is configured but unavailable`,
				);
			}
		}
	}

	/** Reconcile and start the loops for one freshly-attached project. */
	const spinUp = async (svc: ProjectServices): Promise<void> => {
		try {
			await svc.supervisor.reconcile();
			await svc.brain.reconcileOrphans();
			await svc.mergeQueue.resetInFlight();
		} catch (e) {
			svc.log.error({ err: e }, "boot reconciliation failed");
		}

		if (opts.autostart !== false) {
			svc.supervisor.start(opts.supervisorIntervalMs);
			if (svc.schedulerAutostart) {
				svc.scheduler.start(opts.schedulerIntervalMs);
			} else {
				svc.log.info(
					"scheduler not started (schedulerAutostart is off), runs are still supervised",
				);
			}
		}
	};

	/** Stop everything this project owns, in the order shutdown uses. */
	const windDown = async (
		svc: ProjectServices,
		mode: "handoff" | "detach" = "handoff",
	): Promise<void> => {
		const failures: unknown[] = [];
		const attempt = async (operation: () => unknown | Promise<unknown>) => {
			try {
				await operation();
			} catch (error) {
				failures.push(error);
			}
		};
		await attempt(() => svc.scheduler.stop());
		await attempt(() => svc.supervisor.stop());
		if (mode === "detach") {
			// Detach must not leave provider spend behind. Ambiguous cleanup stays in the global journal for retry.
			await attempt(() => svc.engine.drainExecutionTargets("project_detach"));
		}
		await attempt(() => svc.board.flush());
		await attempt(() => svc.releaseHostWake());
		await attempt(() => hostResources.detachProject(svc.projectId));
		await attempt(() => svc.handle.close());
		await attempt(() => svc.releaseLock());
		if (failures.length > 0) {
			throw new AggregateError(
				failures,
				`failed to fully stop project '${svc.name}'`,
			);
		}
	};

	// Attach may make project/run metadata reachable again: reconcile before any scheduler starts.
	try {
		// Provider inventory precedes any remote dispatch; a failure closes only the RunPod gate.
		// Provider cleanup is machine safety and runs even when autostart is off.
		await Promise.all([runpod.start(), openrouter.start()]);
		await hostResources.reconcile("project_attached");
		for (const svc of projects.values()) await spinUp(svc);
	} catch (error) {
		const failures: unknown[] = [error];
		for (const svc of projects.values()) {
			await windDown(svc).catch((cleanupError) => failures.push(cleanupError));
		}
		await hostResources
			.shutdown()
			.catch((cleanupError) => failures.push(cleanupError));
		await runpod.stop().catch((cleanupError) => failures.push(cleanupError));
		openrouter.stop();
		await daemonLock
			.release()
			.catch((cleanupError) => failures.push(cleanupError));
		throw new AggregateError(failures, "orchestrator boot failed");
	}

	log.info({ projects: [...projects.keys()] }, "orchestrator ready");
	let shutDown = false;

	return {
		bootId,
		startedAt,
		mfwHome: home,
		projects,
		log,
		// Process-global, not per project: one credentials file for the machine.
		providers: new ProviderSettings(credentialStore, {
			runpod,
			openrouter,
			openrouterManagement: {
				setCredential: (mutate) => openrouter.setManagementCredential(mutate),
				removeCredential: (mutate) =>
					openrouter.removeManagementCredential(mutate),
			},
		}),
		runpod,
		openrouter,
		globalDispatch,
		hostResources,
		get(name) {
			const svc = projects.get(name);
			if (!svc) throw new Error(`unknown project '${name}'`);
			return svc;
		},
		list: () => [...projects.values()],

		/** Attach at runtime: validate, attach, then persist, so a failed attach never leaves a config.json entry that fails every boot. */
		async attach(cfg) {
			const name = cfg.name.trim();
			if (!name) throw new Error("a project needs a name");
			return serializeProjectLifecycle(name, async () => {
				if (projects.has(name)) {
					throw new Error(`project '${name}' is already attached`);
				}
				const generation = Symbol(name);
				const root = normalizeRoot(cfg.root);
				const assertConfigAvailable = (
					existing: Awaited<ReturnType<typeof loadConfig>>,
				) => {
					// Check against persisted config, not only attached projects: one whose
					// attach failed this boot is still in config.json, and reusing its name
					// would write a second entry that later shadows and orphans the first.
					if (existing.projects.some((p) => p.name === name)) {
						throw new Error(
							`project '${name}' is already in config.json (it is not attached: ` +
								"fix or remove that entry before reusing the name)",
						);
					}
					if (existing.projects.some((p) => normalizeRoot(p.root) === root)) {
						throw new Error(`${root} is already registered under another name`);
					}
				};
				assertConfigAvailable(await loadConfig(home));
				const entry: ProjectConfig = { ...cfg, name, root };
				const svc = await attachProject(entry, log, bootId, {
					schedulerIntervalMs: opts.schedulerIntervalMs,
					globalPaused: globalDispatch.gate,
					hostResources,
					mfwHome: home,
					afterAdmissionTransition: opts.afterAdmissionTransition,
					runpod,
					credentials: credentialStore,
					workloadGrants,
					lifecycle: settingsLifecycle(name, generation),
					onProjectIdentity: (identity) => {
						configuredRunpodOwners.set(identity.id, { projectName: name });
					},
				});
				try {
					await hostResources.reconcile("project_attached");
				} catch (error) {
					await windDown(svc).catch((cleanupError) => {
						log.error(
							{ err: cleanupError, project: name },
							"runtime attach cleanup failed",
						);
					});
					configuredRunpodOwners.delete(svc.projectId);
					throw error;
				}
				try {
					await mutateConfig(home, (config) => {
						// Re-check inside the transaction; another attach may have committed meanwhile.
						assertConfigAvailable(config);
						config.projects.push(entry);
					});
				} catch (e) {
					// An unpersisted attach would vanish on restart; back it out.
					log.error(
						{ err: e, project: name },
						"could not persist the new project",
					);
					projects.delete(name);
					runpodProjectPolicies.delete(svc.projectId);
					configuredRunpodOwners.delete(svc.projectId);
					unavailableConfiguredProjects.delete(name);
					await windDown(svc).catch((cleanupError) => {
						log.error(
							{ err: cleanupError, project: name },
							"failed to clean up project after config persistence failure",
						);
					});
					throw e;
				}
				runpodProjectPolicies.set(svc.projectId, entry.runpod);
				await runpod.markProjectReattached(svc.projectId, name);
				unavailableConfiguredProjects.delete(name);
				projectGenerations.set(name, generation);
				projects.set(name, svc);
				if (runpod.policy.enabled) {
					await runpod.reconcile("project-attached").catch((error) => {
						log.warn(
							{ code: error instanceof Error ? error.name : "unknown" },
							"RunPod reconciliation after project attach kept remote dispatch closed",
						);
					});
				}
				await spinUp(svc);
				log.info({ project: name, root }, "project attached");
				return svc;
			});
		},

		/**
		 * Detach: removes only mfw's own state (loops, DB handle, lock, config
		 * entry). `.mfw/tasks`, `.mfw/adrs` and history stay, so re-attaching
		 * restores the project. windDown may add a final board commit.
		 */
		async detach(name) {
			return serializeProjectLifecycle(name, async () => {
				const svc = projects.get(name);
				const detachedProjectIds = svc
					? [svc.projectId]
					: [...configuredRunpodOwners]
							.filter(([, owner]) => owner.projectName === name)
							.map(([projectId]) => projectId);
				for (const projectId of detachedProjectIds) {
					await runpod.markProjectDetached(projectId, name);
				}
				// Persist first: if config.json cannot be replaced, nothing is detached.
				let configRemoved: boolean;
				try {
					configRemoved = await mutateConfig(home, (config) => {
						const before = config.projects.length;
						config.projects = config.projects.filter((p) => p.name !== name);
						const removed = config.projects.length < before;
						if (!svc && !removed) throw new Error(`unknown project '${name}'`);
						return removed;
					});
				} catch (error) {
					// Detach did not happen: undo the detached marks.
					for (const projectId of detachedProjectIds) {
						await runpod.markProjectReattached(projectId, name).catch(() => {});
					}
					throw error;
				}
				const root = svc?.root ?? "";

				// In-memory transition right after the config commit, before fallible
				// cleanup, so a partial windDown cannot leave a config-less service reachable.
				projects.delete(name);
				projectGenerations.delete(name);
				unavailableConfiguredProjects.delete(name);
				if (svc) {
					runpodProjectPolicies.delete(svc.projectId);
					configuredRunpodOwners.delete(svc.projectId);
				} else if (configRemoved) {
					for (const [projectId, owner] of configuredRunpodOwners) {
						if (owner.projectName === name) {
							configuredRunpodOwners.delete(projectId);
							runpodProjectPolicies.delete(projectId);
						}
					}
				}

				const failures: unknown[] = [];
				if (svc) {
					await windDown(svc, "detach").catch((error) => failures.push(error));
				}
				if (runpod.policy.enabled) {
					await runpod.reconcile("project-detached").catch((error) => {
						failures.push(error);
						log.warn(
							{ code: error instanceof Error ? error.name : "unknown" },
							"RunPod reconciliation after project detach remains pending",
						);
					});
				}

				log.info({ project: name, configRemoved }, "project detached");
				if (failures.length > 0) {
					throw new AggregateError(
						failures,
						`project '${name}' detached with cleanup errors`,
					);
				}
				return { name, root, configRemoved };
			});
		},

		async shutdown() {
			if (shutDown) return;
			shutDown = true;
			const failures: unknown[] = [];
			try {
				for (const svc of projects.values()) {
					await windDown(svc).catch((error) => failures.push(error));
				}
				projects.clear();
				projectGenerations.clear();
				await runpod.stop().catch((error) => failures.push(error));
				openrouter.stop();
			} finally {
				await hostResources.shutdown().catch((error) => failures.push(error));
				await daemonLock.release().catch((error) => failures.push(error));
			}
			if (failures.length > 0)
				throw new AggregateError(failures, "orchestrator shutdown failed");
			log.info("orchestrator shut down");
		},
	};
}

/** A project must be a git repository (worktrees, merge queue, tracked board). Checked before anything is written. */
async function assertGitRepo(rawRoot: string): Promise<void> {
	// Normalize so a trailing slash from a hand-edited config does not fail the toplevel comparison.
	const root = normalizeRoot(rawRoot);
	try {
		const st = await stat(root);
		if (!st.isDirectory()) throw new Error("not a directory");
	} catch {
		throw new Error(`${root} does not exist or is not a directory`);
	}
	const inside = await git(["rev-parse", "--is-inside-work-tree"], root);
	// 127 = `runProc` could not spawn git at all (no git on PATH, or no Bun.spawn
	// under a Node `vite dev` server); don't misreport it as "not a git repository".
	if (inside.exitCode === 127) {
		throw new Error(
			`could not run git while attaching ${root}: ${inside.stderr || "git could not be spawned"}`,
		);
	}
	if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
		throw new Error(`${root} is not a git repository`);
	}
	const top = await git(["rev-parse", "--show-toplevel"], root);
	if (top.exitCode === 0 && normalizeRoot(top.stdout.trim()) !== root) {
		throw new Error(
			`${root} is inside a git repository but is not its root (${top.stdout.trim()})`,
		);
	}
}
