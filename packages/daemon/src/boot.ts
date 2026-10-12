import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadBoardConfig } from "@mfw/board-core";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus, eventsSince, latestSeq, listEvents } from "@mfw/db/eventlog";
import { outcomePrior } from "@mfw/db/outcomes";
import { taskAttemptOutcomes } from "@mfw/db/schema";
import { desc } from "drizzle-orm";
import { AdrService } from "./adrs.ts";
import { AgentHost } from "./agent-host.ts";
import { AgentReviewInference } from "./agent-review.ts";
import { AdapterRegistry } from "./agents/adapter.ts";
import { DEFAULT_PROVIDER_ID, providerConfigFor } from "./agents/catalogue.ts";
import { boardRepoPaths, recordBoardLocation } from "./board-layout.ts";
import {
	assertNoForeignTasksDir,
	relocateLegacyBoard,
} from "./board-relocate.ts";
import { getBoardTemplate } from "./board-templates.ts";
import {
	BrainService,
	type InferenceClient,
	inferenceForProvider,
} from "./brain.ts";
import { BrainRuntime, resolveBrainConfig } from "./brain-runtime/runtime.ts";
import { BudgetService } from "./budgets.ts";
import { ClarifyService, continuationTerminalError } from "./clarify.ts";
import {
	mfwHome as configuredMfwHome,
	effectiveAssistance,
	effectiveReview,
	FALLBACK_MERGE_CHECKS,
	loadConfig,
	mutateConfig,
	normalizeRoot,
	PROJECT_DEFAULTS,
} from "./config.ts";
import { CredentialStore, WorkloadSecretGrantStore } from "./credentials.ts";
import { ensureBoardConfig } from "./default-board-config.ts";
import { readMemAvailable } from "./dispatch-preflight.ts";
import { DocsService } from "./docs.ts";
import {
	ExecutionTargetRegistry,
	executionOwnerKey,
} from "./execution-target.ts";
import { settleParkedMerge } from "./finalize/settle-event.ts";
import { type CriticResult, StepRunner } from "./finalize/step-runner.ts";
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
	type HostConfig,
	HostRegistry,
	hostSlotResourceId,
	type RegisteredHost,
} from "./host-registry.ts";
import type { ProbeTransport } from "./host-registry-probe.ts";
import {
	acquireDaemonLock,
	type HostAdmissionSnapshot,
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
import { HostService, registryTransport } from "./host-service.ts";
import { InboxService } from "./inbox.ts";
import {
	acquireKernelLock,
	type KernelLock,
	KernelLockError,
} from "./kernel-lock.ts";
import { LifecycleService } from "./lifecycle.ts";
import { LifetimeManager } from "./lifetime.ts";
import { createLocalExecutionTarget } from "./local-execution-target.ts";
import { type Logger, rootLogger } from "./log.ts";
import { Maintenance } from "./maintenance.ts";
import { MergeQueue } from "./merge-queue.ts";
import { makeNotifier, type NotifyConfig } from "./notify.ts";
import { OpenAICompatibleInference } from "./openai-compatible-inference.ts";
import { OpenRouterAccountService } from "./openrouter-account-service.ts";
import {
	OPENROUTER_MANAGEMENT_CREDENTIAL_ID,
	OpenRouterClient,
	type OpenRouterClientPort,
	openRouterCredentialSource,
} from "./openrouter-client.ts";
import { OutcomeRecorder } from "./outcome-recorder.ts";
import { assertAppearance } from "./project-appearance.ts";
import {
	type AdmissionRecord,
	type AdmissionTransition,
	ProjectDispatchAdmission,
} from "./project-dispatch-admission.ts";
import { ProjectResourceSlots } from "./project-resource-slots.ts";
import { ProviderHoldStore } from "./provider-holds.ts";
import { RepoViewService } from "./repo-view.ts";
import { ResourceService } from "./resources.ts";
import { ReviewService } from "./review.ts";
import {
	parseExecutionTarget,
	placeRun,
	primaryHarness,
	routingSettingsFrom,
} from "./routing.ts";
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
	effectiveWatchdog,
	ProviderSettings,
	type SettingsLifecycle,
	SettingsService,
} from "./settings.ts";
import {
	SshExecutionTarget,
	type SshExecutionTransport,
} from "./ssh-execution-target.ts";
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
import {
	defaultUsageProbes,
	type UsageConfig,
	usageEnabled,
} from "./usage/default-probes.ts";
import { UsageMonitor, type UsageSubscription } from "./usage-monitor.ts";
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
	/**
	 * Attach-time only, never persisted: the BOARD_TEMPLATES id whose
	 * board.yaml is written when the board folder has none. An existing board
	 * is adopted as-is.
	 */
	template?: string;
	integrationBranch?: string;
	/** Display options, see `project-appearance.ts`; validated before attach. */
	icon?: string;
	color?: string;
	model?: string;
	/** Model per task `model_tier`, see `config.ts`. */
	modelTiers?: import("./config.ts").StoredProjectConfig["modelTiers"];
	/** Model for the semantic change review, see `config.ts`. */
	reviewModel?: string;
	/** Review mode, independence, rounds and fallbacks, see `config.ts`. */
	review?: import("./config.ts").StoredReviewPolicy;
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
	leaseMs?: number;
	notify?: NotifyConfig;
	/** Catalogue harness (+ env, + codex-cli endpoint id), see `config.ts`. */
	provider?: import("./config.ts").StoredProjectConfig["provider"];
	/** Endpoints, fallbacks, escalation (`routing.ts`). */
	routing?: import("./config.ts").StoredProjectConfig["routing"];
	/** The project brain's routes and limits; absent = off. */
	brain?: import("./config.ts").StoredBrainConfig;
	/** Spend budgets (`budgets.ts`); the config file entry, when present, wins live. */
	budgets?: import("./config.ts").StoredBudgets;
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
	/** Dispatch preflight memory floor in MiB; see `config.ts`. */
	minFreeMemoryMb?: number;
	/** Live-run watchdog limits and scope policy; see `config.ts`. Applied live by settings. */
	watchdog?: import("./config.ts").WatchdogConfig;
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
	/**
	 * Subscription usage meters. Off under `bun test` (NODE_ENV=test) unless
	 * `usage.probes` or `usage.enabled: true` is given, so a test never reads the
	 * developer's real login.
	 */
	usage?: UsageConfig;
	afterAdmissionTransition?: (
		transition: AdmissionTransition,
		row: AdmissionRecord,
	) => void | Promise<void>;
	/** Deterministic seam for registry SSH hosts; production uses the pinned SshTransport. */
	sshTransport?: (
		host: RegisteredHost,
		pinned: readonly HostConfig[],
	) => SshExecutionTransport & ProbeTransport;
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
 * `.mfw/` holds daemon state only. The board (`board.yaml`, `tasks/`,
 * `adrs/`) sits at the root of its board folder as ordinary tracked paths, so
 * nothing here re-admits it, and a separate board repository gets no `.mfw`
 * entries at all because it will never contain an `.mfw`.
 */
async function ensureGitExclude(root: string, log: Logger): Promise<void> {
	const path = join(root, ".git", "info", "exclude");
	const block = [
		EXCLUDE_BEGIN,
		"worktrees/",
		"MFW_REPORT.json",
		"/.mfw/*",
		"!/.mfw/config.yaml",
		"!/.mfw/AGENTS.md",
		"!/.mfw/lifetime/",
		"!/.mfw/triggers/",
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
		/** Registry SSH hosts; absent = no `ssh` target. */
		hosts?: HostService;
		sshTransport?: BootOptions["sshTransport"];
		credentials?: CredentialStore;
		workloadGrants?: WorkloadSecretGrantStore;
		/** Announces durable ownership identity before DB migration can fail. */
		onProjectIdentity?: (identity: ProjectIdentity) => void;
		/** Shared attach/detach/settings serialization and generation guard. */
		lifecycle?: SettingsLifecycle;
		/** Every attached project's ledger, for machine-scoped budgets. */
		ledgers?: () => ProjectDbHandle[];
		/** Whether a sibling project owns this run id (shared tmux socket). */
		ownedElsewhere?: (runId: string) => Promise<boolean>;
		/** Machine-wide subscription usage, for the brain's capacity read. */
		usage?: () => UsageSubscription[];
	},
): Promise<ProjectServices> {
	// Must run before any write: mkdir(recursive) would recreate a moved or
	// unmounted root and report a healthy attach.
	await assertGitRepo(cfg.root);
	// A typo in `boardRoot` must not be "fixed" by mkdir(recursive) below.
	if (cfg.boardRoot) await assertBoardRoot(cfg.boardRoot, cfg.root);
	// Canonical root: git cwd, worktree base and path-escape prefix all compare
	// as strings, and boot() can be called without loadConfig's normalization.
	const root = normalizeRoot(cfg.root);
	const mfwDir = join(root, ".mfw");
	// The board (task.md/spec.md/adrs/board.yaml/templates) can live in a
	// completely separate checkout from the code being orchestrated — e.g. the
	// repo is `~/dev/app` but its board is tracked in `~/docs/projects/app`.
	// Everything orchestration-only (worktrees, runs, mfw.db, the daemon lock,
	// triggers, per-task sidecars) lives in `mfwDir`, the repository's `.mfw/`.
	// The board itself sits at the ROOT of `boardDir` (board.yaml, tasks/,
	// adrs/, templates/): the repository root unless `boardRoot` is set.
	const boardRoot = cfg.boardRoot ? normalizeRoot(cfg.boardRoot) : root;
	const boardDir = boardRoot;
	await ensureGitExclude(root, log);
	await mkdir(mfwDir, { recursive: true });
	const releaseLock = await acquireProjectLock(mfwDir, bootId);
	let projectIdentity: ProjectIdentity;
	let taskKey: string;
	let handle: Awaited<ReturnType<typeof openProjectDb>>;
	try {
		projectIdentity = await stableProjectIdentity(mfwDir);
		opts.onProjectIdentity?.(projectIdentity);
		// Before the board loads: a board from the `.mfw/` era is moved to the
		// folder root (refusing, with nothing changed, on a collision).
		const relocated = await relocateLegacyBoard({
			boardFolder: boardDir,
			daemonDir: mfwDir,
			log,
		});
		if (relocated.moved.length === 0) {
			await assertNoForeignTasksDir(boardDir);
		}
		// Resolved before board.yaml is written so a brand-new project's board
		// agrees with the ids it will really mint (resolveTaskKey reads
		// board.json/config.yaml/the raw files, never board.yaml itself) —
		// board-core now validates an id against its type's own-sequence
		// grammar, so a mismatched default key here would quarantine every id
		// this project writes.
		taskKey = await resolveTaskKey(mfwDir, root, boardDir);
		handle = await openProjectDb(mfwDir);
	} catch (error) {
		await releaseLock();
		throw error;
	}
	// Also upgrades an existing board.yaml in place (the task type's
	// `acceptance` checklist); a conflicting field refuses the attach.
	let boardConfig: Awaited<ReturnType<typeof loadBoardConfig>>;
	let boardYamlUpgraded: boolean;
	try {
		const template = cfg.template ? getBoardTemplate(cfg.template) : undefined;
		if (cfg.template && !template) {
			throw new Error(`unknown board template '${cfg.template}'`);
		}
		boardYamlUpgraded = (
			await ensureBoardConfig(
				boardDir,
				taskKey,
				template ? (key) => template.yaml(key) : undefined,
			)
		).upgraded;
		boardConfig = await loadBoardConfig(join(boardDir, "board.yaml"));
		// The worktree sparse rules and the merge firewall read this.
		await recordBoardLocation(
			root,
			boardRepoPaths(root, boardDir, boardConfig),
		);
	} catch (error) {
		handle.close();
		await releaseLock();
		throw error;
	}
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
		boardDir,
		stateDir: mfwDir,
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
		boardDir,
		integrationBranch: boardIntegrationBranch,
		log: plog,
	});
	tasks.onBoardChanged = () => board.touch();
	const adrs = new AdrService({
		boardDir,
		stateDir: mfwDir,
		taskKey,
		log: plog,
	});
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
	// A planner's answers re-plan; a task run's answer wakes the brain, which
	// continues the run with `spawn worktree: continue:<runId>` (no autonomous
	// resume path).
	const clarify: ClarifyService = new ClarifyService({
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
	// Live routing source (settings changes replace it; see `settings.ts`).
	// Resolved via the catalogue so an unknown provider or endpoint in
	// config.json fails at attach, not at every launch.
	let liveRouting = routingSettingsFrom({
		provider: {
			id: providerConfigFor(
				cfg.provider?.id ?? DEFAULT_PROVIDER_ID,
				cfg.provider?.env,
			).id,
			...(cfg.provider?.env ? { env: cfg.provider.env } : {}),
			...(cfg.provider?.endpoint ? { endpoint: cfg.provider.endpoint } : {}),
		},
		model: cfg.model ?? DEFAULTS.model,
		modelTiers: cfg.modelTiers ?? null,
		reasoningEffort: cfg.reasoningEffort ?? DEFAULTS.reasoningEffort,
		routing: cfg.routing ?? null,
	});
	const providerHolds = ProviderHoldStore.at(opts.mfwHome);
	const brainInference = (): InferenceClient => {
		const endpoint = liveRouting.provider.endpoint;
		if (!endpoint)
			return inferenceForProvider(liveRouting.provider, { cwd: root });
		const grant = liveRouting.routing?.endpoints?.[endpoint.id]?.grant;
		return new OpenAICompatibleInference({
			baseUrl: endpoint.baseUrl,
			// Daemon-side only: the brain is not an agent, so it reads the key
			// through the same grant the endpoint's agent runs use.
			apiKey: async () => {
				if (!grant || !endpoint.envKey) return undefined;
				if (!opts.credentials || !opts.workloadGrants)
					throw new Error("workload secret grant resolver is unavailable");
				const env = await opts.workloadGrants.resolve(
					{ projectId: projectIdentity.id, taskId: null, grantIds: [grant] },
					opts.credentials,
				);
				return env.materializeForLaunch()[endpoint.envKey];
			},
		});
	};

	const assistance = effectiveAssistance(cfg);
	const assistanceState = { ...assistance };
	const reviewPolicy = effectiveReview(cfg);
	const brain = new BrainService({
		review: reviewPolicy,
		// Agent review runs the project's current harness (read live, like the
		// brain's own transport), read-only, in a throwaway checkout of the run
		// branch (see agent-review.ts). Other harnesses fall back to the critic.
		agentReview: (subject) => {
			const type = liveRouting.provider.type;
			if (type !== "claude-cli" && type !== "codex-cli") return null;
			return new AgentReviewInference({
				subject: { projectRoot: root, ...subject },
				harness: type,
				hidePaths: [opts.mfwHome],
			});
		},
		registry,
		handle,
		bus,
		// Resolved per call so a live provider change reaches the brain too.
		inference: {
			complete: (prompt, o) => brainInference().complete(prompt, o),
		},
		tasks,
		log: plog,
		get model() {
			return liveRouting.model;
		},
		reviewModel: cfg.reviewModel,
		get providerId() {
			return liveRouting.provider.id;
		},
		get reasoningEffort() {
			return liveRouting.reasoningEffort ?? DEFAULTS.reasoningEffort;
		},
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
			if (job.taskId && mergedRun?.kind !== "repair") {
				// A board rule refusing `done` must not strand the run in `merging`.
				const landed = await tasks.releaseMerged(job.taskId, job.runId);
				if (landed.violation !== null) {
					plog.warn(
						{ taskId: job.taskId, runId: job.runId, to: landed.to },
						"merged task refused by a board rule",
					);
					await notifier
						.notify("review", {
							project: cfg.name,
							taskId: job.taskId,
							runId: job.runId,
							message: `merged, but a board rule refused done: ${landed.violation}`,
						})
						.catch(() => {
							// best-effort: the task's status already says it needs a human
						});
				}
			}
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
			if (parkedRun?.kind === "repair") {
				// A main-red recovery run has no task to hand back: the sweep's
				// own escalation (main_red) is what tells a person.
				await registry.finish(job.runId, "failed", reason);
				await notifier.notify("blocked", {
					project: cfg.name,
					taskId: job.taskId ?? undefined,
					runId: job.runId,
					message: reason,
				});
				return;
			}
			// Retries are exhausted: the `merge_parked` settle, for the brain.
			await settleParkedMerge(
				{ handle, bus, registry, tasks, mergeQueue, log: plog },
				job,
				reason,
				kind,
			);
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
		...(opts.hosts
			? [
					new SshExecutionTarget({
						hosts: opts.hosts.registry,
						projectRoot: root,
						integrationBranch,
						transport:
							opts.sshTransport ??
							((host, pinned) =>
								registryTransport(host, pinned, {
									commandTimeoutMs: 10 * 60_000,
									maxOutputBytes: 96 * 1024 * 1024,
								})),
					}),
				]
			: []),
	]);
	const budgets: BudgetService = new BudgetService({
		handle,
		bus,
		log: plog,
		mfwHome: opts.mfwHome,
		project: cfg.name,
		stored: cfg.budgets,
		holds: providerHolds,
		registry,
		// Late-bound: the engine and brain runtime are built below.
		stopRun: (runId): Promise<void> => engine.stop(runId),
		ledgers: () => opts.ledgers?.() ?? [handle],
		pauseBrain: (paused): Promise<void> => brainRuntime.setPaused(paused),
	});
	// Set once the Docs service exists (after settings); the import prompt reads it lazily.
	const docsRef: { current: DocsService | null } = { current: null };
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
		resolveTaskExecutionTarget: async (task) => {
			if (task.executionTarget !== "runpod") {
				// Placement: task execution_target > project routing.placement > local.
				const hosts = opts.hosts;
				const wantsSsh =
					parseExecutionTarget(task.executionTarget).target === "ssh" ||
					(task.executionTarget === "local" &&
						liveRouting.routing?.placement?.target === "ssh");
				if (!wantsSsh) {
					return {
						kind: task.executionTarget,
						requiresResources: task.requiresResources,
						localStagingResources: task.localStagingResources,
					};
				}
				const placed = placeRun({
					taskTarget: task.executionTarget,
					placement: liveRouting.routing?.placement ?? null,
					hosts: hosts ? await hosts.candidates() : [],
					harness: primaryHarness(task, liveRouting),
					...(hosts ? { free: (id: string) => hosts.free(id) } : {}),
				});
				if (placed.target === "ssh" && placed.hostId) {
					return {
						kind: "ssh",
						requestedShape: {
							hostId: placed.hostId,
							placement: {
								rule: placed.rule,
								detail: placed.detail,
								harnesses: placed.harnesses,
							},
						},
						requiresResources: task.requiresResources,
						localStagingResources: task.localStagingResources,
						targetCapacity: [
							{ scope: "host", id: hostSlotResourceId(placed.hostId) },
						],
					};
				}
				return {
					kind: placed.target,
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
		routing: () => liveRouting,
		providerHolds,
		budgetHold: (task): ReturnType<BudgetService["holdFor"]> =>
			budgets.holdFor(task),
		outcomePriors: async () => {
			const rows = await handle.db
				.select()
				.from(taskAttemptOutcomes)
				.orderBy(desc(taskAttemptOutcomes.startedAt))
				.limit(2000);
			return (c) => outcomePrior(rows, { harness: c.harness, model: c.model });
		},
		defaults: {
			leaseMs: cfg.leaseMs ?? DEFAULTS.leaseMs,
			approvalMode: cfg.approvalMode ?? DEFAULTS.approvalMode,
		},
		preflight: {
			memoryFloorBytes:
				BigInt(cfg.minFreeMemoryMb ?? DEFAULTS.minFreeMemoryMb) * 1024n * 1024n,
			memAvailableBytes: readMemAvailable,
		},
		globalPaused: opts.globalPaused,
		beforeLaunch: () => verification.preemptBackground(),
		buildPrompt: buildPrompts(
			tasks,
			registry,
			{ get: (runId) => clarify.get(runId) },
			{ hint: async () => (await docsRef.current?.promptHint()) ?? null },
		),
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
			critic: (ctx) => brain.critic(ctx),
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
		providerHolds,
		projectName: cfg.name,
		log: plog,
		config: {
			draftExpandMaxAttempts:
				cfg.draftExpandMaxAttempts ?? DEFAULTS.draftExpandMaxAttempts,
			mergeChecks: configuredMergeChecks ?? FALLBACK_MERGE_CHECKS,
		},
		eventTail: engine.eventTail,
		// The supervisor holds the live watchdog policy (settings apply it there).
		scopePolicy: () => supervisor.limits.scope,
	});
	sessions.startSession = (prompt, opts) => engine.startSession(prompt, opts);

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
		// `scheduler` is built later; safe because this is only called from the maintenance loop.
		dispatching: () => scheduler.status().then((s) => s.playing),
		// BrainService implements DiagnosePort structurally; the wrapper gates it
		// on the failure-diagnosis policy.
		diagnose: {
			enabled: true,
			diagnose: (ctx) => brain.diagnose(ctx),
		},
		sessions,
		startRepair: (taskId, incidentId, detail) =>
			scheduler.selfRepairMainRed
				? engine.startRegressionRepair(taskId, incidentId, detail)
				: Promise.resolve(null),
	});

	// The project brain: off unless `brain.routes` is configured, and then it
	// decides what runs: the scheduler launches only its accepted spawns.
	// Settings replace this live: the runtime reads it on every tick.
	let liveBrainConfig = cfg.brain;
	const brainRuntime = new BrainRuntime({
		handle,
		bus,
		registry,
		tasks,
		engine,
		log: plog,
		mfwDir,
		projectName: cfg.name,
		bootId,
		config: () => resolveBrainConfig(liveBrainConfig),
		exec: {
			projectRoot: root,
			integrationBranch,
			engine: {
				startGroupRun: (spec, o) =>
					engine.startGroupRun(
						spec,
						o?.hostSnapshot
							? { hostSnapshot: o.hostSnapshot as HostAdmissionSnapshot }
							: {},
					),
				stop: (runId) => engine.stop(runId),
				steer: (runId, message) => engine.steer(runId, message),
				startImport: (o) =>
					engine.startImport({
						runId: o.runId,
						...(o.model ? { model: o.model } : {}),
						...(o.originRef ? { originRef: o.originRef } : {}),
					}),
				startPlan: (goal, o) =>
					engine.startPlan(goal, {
						runId: o.runId,
						...(o.taskId ? { taskId: o.taskId } : {}),
						...(o.model ? { model: o.model } : {}),
						...(o.originRef ? { originRef: o.originRef } : {}),
					}),
			},
			mergeQueue,
			humanReviewGate: (task) =>
				task.requireReview || assistanceState.changeReview === "human",
			wakeScheduler: () => scheduler?.wake(),
			setBudget: async (input): Promise<Record<string, unknown>> => ({
				...(await budgets.applyBrainLimit(input)),
			}),
			answerQuestion: async (runId, answer) => {
				const current = await clarify.get(runId);
				if (!current) throw new Error(`no open question on run ${runId}`);
				const answers = current.items
					.map((item, index) => ({ item, index }))
					.filter(({ item }) => item.answer === null)
					.map(({ index }) => ({ index, answer }));
				if (answers.length === 0) {
					throw new Error(`run ${runId} has no unanswered question`);
				}
				await clarify.answer(runId, answers, { by: "brain" });
			},
			notifyHuman: async ({ kind, title, body, taskIds }) => {
				await notifier.notify("brain_escalation", {
					project: cfg.name,
					...(taskIds[0] ? { taskId: taskIds[0] } : {}),
					message: `[${kind}] ${title}: ${body}`,
				});
				for (const id of taskIds) {
					await tasks
						.move(id, "blocked", "brain", `${kind}: ${title}`)
						.catch(() => {
							// a task with a live run keeps it; the hold still stops new spawns
						});
					await sessions
						.raise({
							source: "blocked",
							sourceKey: id,
							taskId: id,
							title: `${title} (${id})`,
							summary: body,
							whatWasTried: [`the project brain asked for a person (${kind})`],
							environment:
								"The brain does not work in a shell; this note is its escalation.",
						})
						.catch(() => {});
				}
			},
			review: async ({ runId }) => {
				const run = await registry.get(runId);
				if (!run) throw new Error(`no run '${runId}'`);
				const steps = await registry.steps(runId);
				const verify = steps.find(
					(s) => s.step === "verify" && s.status === "done",
				)?.result;
				const result = await brain.critic({
					runId,
					taskId: run.taskId,
					worktreePath: run.worktreePath,
					branch: run.branch,
					baseSha: run.baseSha,
					verify: (verify as never) ?? null,
					report: null,
				});
				return {
					status: result.status,
					...(result.verdict ? { verdict: result.verdict } : {}),
					...(result.reason ? { reason: result.reason } : {}),
				};
			},
		},
		world: {
			maxConcurrent: () => scheduler.maxConcurrent,
			maxPlanRuns: () =>
				cfg.maxConcurrentDraftExpansions ??
				DEFAULTS.maxConcurrentDraftExpansions,
			providerHolds: () => providerHolds.active(),
			subscriptionUsage: () => opts.usage?.() ?? [],
			budgets: (): ReturnType<BudgetService["list"]> => budgets.list(),
			budgetHold: (task): ReturnType<BudgetService["holdFor"]> =>
				budgets.holdFor(task),
			checkBudget: (input): ReturnType<BudgetService["checkBrainLimit"]> =>
				budgets.checkBrainLimit(input),
			routeHeld: async (task, pick) => {
				const held = (await engine.routeTask(task, pick ? { brain: pick } : {}))
					.held;
				return held
					? { key: held.key, until: held.until, reason: held.reason }
					: null;
			},
			dispatchPaused: async () =>
				(await scheduler.blockedReason()) ?? opts.globalPaused?.() ?? null,
		},
		notifyStuck: (detail) =>
			notifier.notify("brain_stuck", {
				project: cfg.name,
				message: `the project brain failed ${detail.failures} turns in a row and is paused: ${detail.error ?? "no error recorded"}`,
			}),
	});

	supervisor = new Supervisor({
		handle,
		registry,
		tasks,
		host,
		execution: engine,
		brainRuntime,
		budgets,
		stepRunner,
		eventTail: engine.eventTail,
		// The tmux socket is machine-wide: a run another project owns is no orphan.
		ownedElsewhere: opts.ownedElsewhere,
		notify: (kind, detail) =>
			notifier.notify(kind, { project: cfg.name, ...detail }),
		log: plog,
		projectRoot: root,
		bootId,
		leaseMs: cfg.leaseMs ?? DEFAULTS.leaseMs,
		limits: effectiveWatchdog(cfg),
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
		maintenance: async ({ exclusive }) => {
			const coordinated = await verification.backgroundWork(async (signal) => {
				if (!exclusive) {
					// Provider runs are live: only groom and gc, never the sweep.
					await maintenance.tick(signal, { exclusive: false });
					return;
				}
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

	scheduler = new Scheduler({
		handle,
		bus,
		tasks,
		engine,
		registry,
		log: plog,
		// The brain's accepted spawn actions are the only source of runs.
		spawns: {
			pending: () => brainRuntime.executor.pendingSpawns(),
			launch: (actionId, ctx) => brainRuntime.executor.launch(actionId, ctx),
			holds: () => brainRuntime.executor.holds(),
		},
		// No brain route, no decider: dispatch is blocked and says why.
		brainRoute: () => resolveBrainConfig(liveBrainConfig) !== null,
		// Per candidate: a task whose route is held waits; others still start.
		routeHold: async (task) => (await engine.routeTask(task)).held,
		budgetHold: (task): ReturnType<BudgetService["holdFor"]> =>
			budgets.holdFor(task),
		providerHolds,
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
		budgets,
	});
	sessions.dismissInboxItem = (itemId) => inbox.dismiss(itemId);
	const review = new ReviewService({
		handle,
		registry,
		tasks,
		projectRoot: root,
		mergeQueue,
		maxReviewRounds: reviewPolicy.maxRounds,
	});
	const lifecycle = new LifecycleService({
		handle,
		bus,
		registry,
		tasks,
		projectRoot: root,
		integrationBranch,
		log: plog,
	});
	tasks.closeGuard = lifecycle;
	const workspace = new WorkspaceService({ root: root, registry });
	const repoView = new RepoViewService({
		root,
		integrationBranch,
		registry,
		handle,
	});
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
		supervisor,
		brainConfig: {
			set(next) {
				liveBrainConfig = next;
			},
		},
		routing: {
			set(next) {
				liveRouting = next;
				scheduler.wake();
			},
		},
		schedulerIntervalMs: opts.schedulerIntervalMs,
		lifecycle: opts.lifecycle,
	});
	const docs = new DocsService({
		repoRoot: root,
		boardDir,
		stateDir: mfwDir,
		taskKey,
		log: plog,
		configured: async () => (await settings.get()).values.docs,
		save: async (next) => {
			await settings.update({ docs: next });
		},
	});
	docsRef.current = docs;

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

	// Once per board: old body `## Acceptance Criteria` lists move into the
	// `acceptance` field, committed together with the board.yaml upgrade as
	// one commit. Deferred (retried next attach) while the board is suspended.
	const acceptance = await tasks.migrateAcceptance();
	if (acceptance) {
		plog.info(
			{
				migrated: acceptance.migrated.length,
				skipped: acceptance.skipped.length,
				boardYamlUpgraded,
			},
			"acceptance criteria moved into the acceptance field",
		);
	}
	if (acceptance?.migrated.length || boardYamlUpgraded) {
		await board.commit(
			acceptance?.migrated.length
				? "mfw: move acceptance criteria into the acceptance field"
				: "mfw: upgrade board.yaml task fields",
		);
	}

	// Once per board: claim sidecars name an attempt group, not a run. A group
	// of one is named after its run, so only the key moves.
	const claimGroups = await tasks.migrateClaimGroups();
	if (claimGroups?.rewritten.length) {
		plog.info(
			{ rewritten: claimGroups.rewritten.length },
			"task claims moved to attempt groups",
		);
	}

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
	new OutcomeRecorder({ handle, bus, tasks, log: plog }).start();
	const releaseHostWake = opts.hostResources.subscribe(projectIdentity.id, () =>
		scheduler.wake(),
	);

	return {
		name: cfg.name,
		projectId: projectIdentity.id,
		root: root,
		mfwDir,
		boardDir,
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
		brainRuntime,
		budgets,
		releaseLock,
		board,
		inbox,
		review,
		lifecycle,
		maintenance,
		sessions,
		lifetime,
		triggers,
		clarify,
		adrs,
		docs,
		workspace,
		repoView,
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

/**
 * How a task run ends. Every task-run prompt carries it: a run is one-shot
 * (its session closes about a second after its turn ends), so work left in
 * the background dies unseen, and a question asked in prose is never read as
 * one.
 */
const RUN_RULES = [
	"\n## Ending your turn",
	"Your session ends when your turn ends, and nothing wakes you afterwards.",
	"Never end your turn with a background job, background agent or scheduled",
	"wakeup still running: run commands in the foreground and wait for them.",
	"If you cannot continue without a decision only the operator can make, write",
	'MFW_REPORT.json (at `$MFW_REPORT_PATH`) as `{"status": "question",',
	'"question": "...", "options": ["...", "..."]}` and end your turn. The',
	"answer resumes your work in this same worktree. A question asked only in",
	"your final message is not seen as one.",
].join("\n");

interface ReapedProcess {
	pid: number;
	command: string;
}

/** Background jobs the parent's transcript shows it never saw finish (journaled by `classify`). */
async function backgroundJobsOf(
	registry: RunRegistry,
	runId: string,
): Promise<{ tool: string; summary: string }[]> {
	const step = (await registry.steps(runId)).find(
		(s) => s.step === "classify" && s.status === "done",
	);
	const jobs = (step?.result as { background?: unknown } | undefined)
		?.background;
	if (!Array.isArray(jobs)) return [];
	return jobs.filter(
		(j): j is { tool: string; summary: string } =>
			typeof j === "object" &&
			j !== null &&
			typeof (j as { summary?: unknown }).summary === "string" &&
			typeof (j as { tool?: unknown }).tool === "string",
	);
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

/**
 * The repair brief for a review `fix` verdict (finalize T14f): the reviewer's
 * findings, addressed by file and line. Null when the parent's review did not
 * ask for fixes (a verification repair).
 */
export function reviewFixOf(
	steps: readonly { step: string; status: string; result: unknown }[],
): string | null {
	const critic = steps.find((s) => s.step === "critic" && s.status === "done");
	const r = critic?.result as CriticResult | undefined;
	if (r?.status !== "ok" || r.verdict !== "fix") return null;
	const findings = r.findings ?? [];
	const unmet = (r.criteria ?? []).filter(
		(c) => c.verdict !== "met" || c.evidenceClass === "claimed",
	);
	return [
		`## Review asked for changes (round ${r.round ?? 1})`,
		"Verification passed, but the reviewer found the work not ready to merge.",
		...(findings.length > 0
			? [
					"",
					"### Findings",
					...findings.map(
						(f) =>
							`- [${f.severity}] ${f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\`` : "(general)"}: ${f.change}`,
					),
				]
			: []),
		...(unmet.length > 0
			? [
					"",
					"### Acceptance criteria not yet shown to be met",
					...unmet.map(
						(c) => `- ${c.criterion}${c.evidence ? ` (${c.evidence})` : ""}`,
					),
				]
			: []),
		...(r.reason ? ["", "### Reviewer notes", r.reason] : []),
		"",
		"The work so far is in this worktree. Address every blocker and major finding,",
		"and show each criterion is met. Verification and review run again afterwards.",
	].join("\n");
}

/** Prompt construction, kept out of RunEngine so wording is tunable separately from lifecycle. */
export function buildPrompts(
	tasks: TaskService,
	registry: RunRegistry,
	clarify?: {
		get(
			runId: string,
		): Promise<{ items: { question: string; answer: string | null }[] } | null>;
	},
	/** Where the repository keeps its documentation, told to the import survey. */
	docs?: { hint(): Promise<string | null> },
) {
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
		const feedback = tasks.pendingFeedback(taskId);
		return [
			`# ${t.id}: ${t.title}`,
			"",
			t.body,
			criteria ? `\n## Acceptance Criteria\n${criteria}` : "",
			`\n## Task verification checks\n\`\`\`json\n${taskVerification}\n\`\`\``,
			`\n## Project merge checks\n\`\`\`json\n${mergeChecks}\n\`\`\``,
			renderScopeSection(t.owns),
			renderSpecSection(taskId, spec?.body ?? ""),
			feedback ? `\n${feedback}` : "",
			RUN_RULES,
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

		/**
		 * What a `continue:<runId>` spawn tells the continuing agent. The class the
		 * parent settled in selects the section; the parent's journal supplies the
		 * detail (failed checks, review findings, the answered question, the
		 * commands left running, the merge conflict).
		 */
		continuation: async (taskId: string, parentRunId: string) => {
			const steps = await registry.steps(parentRunId);
			const settled = steps.find(
				(s) => s.step === "settle" && s.status === "done",
			)?.result as { class?: string } | undefined;
			const leftovers = await leftoversOf(registry, parentRunId);
			const background = await backgroundJobsOf(registry, parentRunId);
			// A journal that predates `settle` (or a parent that never reached
			// it) still names what was left running.
			const cls =
				settled?.class ??
				(leftovers.length > 0 || background.length > 0
					? "background_work"
					: null);
			const head = await describeTask(taskId);
			if (cls === "question") {
				const asked = clarify ? await clarify.get(parentRunId) : null;
				const answers = (asked?.items ?? []).filter(
					(i): i is { question: string; answer: string } => i.answer !== null,
				);
				return [
					head,
					"",
					"## The question you asked was answered",
					`A previous run (${parentRunId}) stopped to ask:`,
					...answers.flatMap((a) => [
						"",
						"Question:",
						a.question,
						"",
						"Answer:",
						a.answer,
					]),
					"",
					"Its work is already in this worktree: inspect `git status` and `git log`",
					"before continuing, and do not redo what is done. Continue the task with",
					"this answer.",
				].join("\n");
			}
			if (cls === "merge_parked") {
				const parent = await registry.get(parentRunId);
				return [
					head,
					"",
					"## This task's branch would not merge",
					"mfw tried to merge this task's work into the target branch and could",
					"not, after retrying automatically against the current target several",
					"times:",
					"```",
					parent?.note ?? "(no reason recorded)",
					"```",
					"Resolve it in this worktree: rebase onto the target branch and fix",
					"the conflict (or otherwise make the branch mergeable), keeping the",
					"task's actual work intact. Verification and acceptance run again",
					"afterwards, and a passing result re-enters the merge queue like any",
					"other run; this does not merge anything by itself.",
				].join("\n");
			}
			if (
				cls === "background_work" ||
				cls === "interrupted" ||
				cls === "watchdog_killed"
			) {
				const parent = await registry.get(parentRunId);
				return [
					head,
					"",
					"## Resuming interrupted work",
					leftovers.length > 0 || background.length > 0
						? `A previous run (${parentRunId}) ended its session while commands it started were still running.`
						: `A previous run (${parentRunId}) was ${cls === "watchdog_killed" ? "stopped by a watchdog" : "interrupted"} before finishing.`,
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
					...(background.length > 0
						? [
								"",
								"## Background work that never finished",
								"Your previous turn ended while it was still running these in the",
								"background, so they were killed and you never saw their results:",
								...background.map((j) => `- ${j.tool}: ${j.summary}`),
								"Re-run them in the foreground and wait for each to finish.",
							]
						: []),
				].join("\n");
			}
			const review = reviewFixOf(steps);
			if (review) return [head, "", review].join("\n");
			const verifyStep = steps.find((s) => s.step === "verify");
			if (verifyStep?.result) {
				return [
					head,
					"",
					"## The previous attempt did not pass verification",
					"```json",
					JSON.stringify(verifyStep.result, null, 2),
					"```",
					"Fix exactly what failed. The same checks run again afterwards.",
				].join("\n");
			}
			return [
				head,
				"",
				"## Continuing earlier work",
				`A previous run (${parentRunId}) worked on this task${cls ? ` and settled as ${cls}` : ""}.`,
				"Its work is already in this worktree: inspect `git status` and `git log`",
				"before continuing, and do not redo what is done.",
			].join("\n");
		},

		/**
		 * An import describes a repository, so work may already be done and each
		 * task states its status. `in_progress` is absent on purpose
		 * (see IMPORT_STATUS_ALIASES in finalize/step-runner.ts).
		 */
		import: async () => {
			const docsHint = await docs?.hint();
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
				...(docsHint ? ["", docsHint] : []),
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
	const hosts = new HostService({
		registry: HostRegistry.at(home),
		ledger: hostResources,
		log: log.child({ svc: "ssh-hosts" }),
		...(opts.sshTransport ? { transport: opts.sshTransport } : {}),
	});
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
	const usageOn =
		usageEnabled(opts.usage) &&
		(opts.usage?.enabled === true ||
			opts.usage?.probes !== undefined ||
			process.env.NODE_ENV !== "test");
	const usage = new UsageMonitor({
		probes: usageOn ? defaultUsageProbes(opts.usage) : [],
		holds: ProviderHoldStore.at(home),
		log: log.child({ svc: "usage" }),
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
				hosts,
				sshTransport: opts.sshTransport,
				credentials: credentialStore,
				workloadGrants,
				lifecycle: settingsLifecycle(cfg.name, generation),
				ledgers: () => [...projects.values()].map((p) => p.handle),
				ownedElsewhere: async (runId) => {
					for (const [other, svc] of projects) {
						if (other !== cfg.name && (await svc.registry.get(runId)))
							return true;
					}
					return false;
				},
				usage: () => usage.snapshot(),
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
			// What a crash left half done in the brain's outbox: adopt the spawns
			// whose runs exist, replay the other effects.
			await svc.brainRuntime.executor.recover();
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
		// Not awaited: a slow `codex` spawn must not delay boot.
		if (opts.autostart !== false && usageOn) void usage.start();
		await hosts.syncSlots();
		if (opts.autostart !== false) hosts.start();
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
		await hosts.stop().catch((cleanupError) => failures.push(cleanupError));
		openrouter.stop();
		usage.stop();
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
		providerHolds: ProviderHoldStore.at(home),
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
		usage,
		globalDispatch,
		hostResources,
		hosts,
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
				// `template` only shapes a new board.yaml; it is not project config.
				const { template, ...stored } = cfg;
				if (template && !getBoardTemplate(template)) {
					throw new Error(`unknown board template '${template}'`);
				}
				assertAppearance(stored);
				const entry: ProjectConfig = { ...stored, name, root };
				const svc = await attachProject(
					template ? { ...entry, template } : entry,
					log,
					bootId,
					{
						schedulerIntervalMs: opts.schedulerIntervalMs,
						globalPaused: globalDispatch.gate,
						hostResources,
						mfwHome: home,
						afterAdmissionTransition: opts.afterAdmissionTransition,
						runpod,
						hosts,
						sshTransport: opts.sshTransport,
						credentials: credentialStore,
						workloadGrants,
						lifecycle: settingsLifecycle(name, generation),
						ledgers: () => [...projects.values()].map((p) => p.handle),
						ownedElsewhere: async (runId) => {
							for (const [other, svc] of projects) {
								if (other !== name && (await svc.registry.get(runId)))
									return true;
							}
							return false;
						},
						usage: () => usage.snapshot(),
						onProjectIdentity: (identity) => {
							configuredRunpodOwners.set(identity.id, { projectName: name });
						},
					},
				);
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
		 * entry). `tasks/`, `adrs/` and history stay, so re-attaching
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
				await hosts.stop().catch((error) => failures.push(error));
				openrouter.stop();
				usage.stop();
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
/** The board folder must already exist; it is not required to be a git repository. */
async function assertBoardRoot(
	rawBoardRoot: string,
	rawRoot: string,
): Promise<void> {
	const boardRoot = normalizeRoot(rawBoardRoot);
	try {
		const st = await stat(boardRoot);
		if (!st.isDirectory()) throw new Error("not a directory");
	} catch {
		throw new Error(
			`board folder ${boardRoot} does not exist or is not a directory; create it first or leave the board in the repository`,
		);
	}
	if (boardRoot === normalizeRoot(rawRoot)) return; // same as the repo: the default layout
}

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
