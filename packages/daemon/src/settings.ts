import type { ProviderConfig } from "./agents/adapter.ts";
import {
	catalogueCredentialIds,
	DEFAULT_PROVIDER_ID,
	findProvider,
	MODEL_LIST_IS_A_HINT,
	MODEL_SNAPSHOT_CHECKED,
	PROVIDER_CATALOGUE,
	type ProviderEntry,
	type ProviderModelChoice,
	providerConfigFor,
} from "./agents/catalogue.ts";
import {
	type ProviderAuthStatus,
	type ProviderDetection,
	ProviderDetector,
	probeAuth,
} from "./agents/detect.ts";
import {
	configPath,
	type DaemonConfig,
	effectiveAssistance,
	FALLBACK_MERGE_CHECKS,
	loadConfig,
	mutateConfig,
	type NotifyConfigInput,
	PROJECT_DEFAULTS,
	type RecoveryAssistance,
	type StoredProjectConfig,
} from "./config.ts";
import type { CredentialStore } from "./credentials.ts";
import type {
	RunPodPlacementRequest,
	RunPodProjectPolicy,
} from "./runpod-policy.ts";
import type { ModelTier, VerificationPlan } from "./tasks/types.ts";
import type { EnvPolicy } from "./verifier.ts";

/**
 * Per-project operating settings.
 *
 * Every update rewrites `~/.local/share/mfw/config.json` (atomically, via
 * `saveConfig`) before it touches anything live. Some settings apply
 * immediately; the rest are constructor arguments of services wired at attach
 * time and are reported in `needsRestart`:
 *
 *   APPLIED LIVE   maxConcurrent       -> Scheduler.setMaxConcurrent
 *                  assistance          -> per-decision model policy
 *                  schedulerAutostart  -> starts/stops the dispatch loop now
 *                  selfRepairMainRed   -> Scheduler.setSelfRepairMainRed
 *
 *   NEEDS RESTART  provider, model, modelTiers, reviewModel, reasoningEffort,
 *                  approvalMode, maxRepairs, maxStalls, maxResumes, leaseMs,
 *                  checkPrefix, notify (baked into RunEngine, StepRunner,
 *                  Supervisor, Maintenance and the notifier at `attachProject`)
 *
 * The write surface is a subset: `name`, `root` and `integrationBranch`
 * identify the project and are read-only (changing a root mid-flight would
 * orphan worktrees, runs and the DB itself).
 */

export interface ProjectSettingsValues {
	maxConcurrent: number;
	schedulerAutostart: boolean;
	assistance: RecoveryAssistance;
	/** Which agent CLI runs this project's tasks. */
	provider: ProviderConfig;
	model: string;
	/** Model per task `model_tier`; a missing tier falls back to the
	 *  project model for standard, or the provider tier default then model for light/strong. */
	modelTiers: Partial<Record<ModelTier, string>> | null;
	/** Model for the semantic change review (critic); null = the brain's own model. */
	reviewModel: string | null;
	reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh" | "max";
	/** Whether provider permission requests are handled automatically or shown. */
	approvalMode: "autonomous" | "interactive";
	maxRepairs: number;
	maxStalls: number;
	maxResumes: number;
	leaseMs: number;
	checkPrefix: string | null;
	/** What a verification check may read from the ambient environment. */
	envPolicy: EnvPolicy | null;
	/** Repository-wide mechanical policy applied to every candidate. */
	mergeChecks: VerificationPlan | null;
	notify: NotifyConfigInput | null;
	/** MFW-28: exempt the task that broke main from the red-main dispatch
	 *  gate. See `Scheduler.selfRepairMainRed`. */
	selfRepairMainRed: boolean;
	/** Push the integration branch after each merge lands. On by default; a
	 *  project with no remote pushes nothing either way. */
	pushOnMerge: boolean;
	/** Project opt-in and optional narrowing of the global RunPod policy. */
	runpod: RunPodProjectPolicy | null;
	/** Default remote shape for tasks whose execution_target is runpod. */
	runpodTarget: RunPodPlacementRequest | null;
}

/**
 * What a caller may say about the provider: an id from the catalogue, plus
 * optional extra env. `type` is not accepted: it is derived from the catalogue
 * entry, so no caller can invent a pairing no adapter implements.
 */
export interface ProviderSelection {
	id: string;
	env?: Record<string, string>;
}

export type ProjectSettingsPatch = Partial<
	Omit<ProjectSettingsValues, "provider">
> & { provider?: ProviderSelection };

export interface ProjectSettingsView {
	project: string;
	/** Read-only identity. */
	root: string;
	integrationBranch: string;
	values: ProjectSettingsValues;
	/** Keys of `values` that only take effect after a daemon restart. */
	needsRestart: readonly (keyof ProjectSettingsValues)[];
	/** Where the values were persisted (shown in the Daemon section). */
	configPath: string;
}

export const LIVE_KEYS = [
	"maxConcurrent",
	"schedulerAutostart",
	"assistance",
	"selfRepairMainRed",
	"pushOnMerge",
] as const satisfies readonly (keyof ProjectSettingsValues)[];

export const RESTART_KEYS = [
	// `provider` is a RunEngine constructor argument (boot.ts `attachProject`),
	// so a change applies after the next restart. Unlike `root` it is not
	// identity: worktrees, branches and runs are keyed by run/task ids, and
	// in-flight runs keep the argv recorded in their own `providerId` column.
	"provider",
	"model",
	"modelTiers",
	"reviewModel",
	"reasoningEffort",
	"approvalMode",
	"maxRepairs",
	"maxStalls",
	"maxResumes",
	"leaseMs",
	"checkPrefix",
	"envPolicy",
	"mergeChecks",
	"notify",
	"runpod",
	"runpodTarget",
] as const satisfies readonly (keyof ProjectSettingsValues)[];

/** The scheduler slice settings may touch (nothing about dispatch policy). */
export interface SettingsScheduler {
	readonly running: boolean;
	readonly maxConcurrent: number;
	readonly selfRepairMainRed: boolean;
	setMaxConcurrent(n: number): void;
	setSelfRepairMainRed(on: boolean): void;
	start(intervalMs?: number): void;
	stop(): Promise<void>;
}

export interface SettingsBrain {
	readonly enabled: boolean;
	setEnabled(on: boolean): void;
}

export interface SettingsAssistance {
	readonly value: RecoveryAssistance;
	set(value: RecoveryAssistance): void;
}

/** The merge-queue slice settings may touch: publishing only, never whether
 *  or how a branch merges. */
export interface SettingsMergeQueue {
	readonly pushOnMerge: boolean;
	setPushOnMerge(on: boolean): void;
}

/**
 * Project lifecycle boundary supplied by the orchestrator. Persistence and
 * live application must occupy the same critical section as attach/detach;
 * the generation check inside it rejects calls through a detached service.
 */
export interface SettingsLifecycle {
	run<T>(operation: () => Promise<T>): Promise<T>;
}

export class SettingsService {
	constructor(
		private readonly deps: {
			mfwHome: string;
			project: string;
			root: string;
			integrationBranch: string;
			scheduler: SettingsScheduler;
			brain: SettingsBrain;
			assistance: SettingsAssistance;
			mergeQueue: SettingsMergeQueue;
			/** Loop period for a scheduler started by a settings change. */
			schedulerIntervalMs?: number;
			/** Optional only for isolated tests/programmatic composition. */
			lifecycle?: SettingsLifecycle;
		},
	) {}

	async get(): Promise<ProjectSettingsView> {
		return this.withLifecycle(async () => {
			const stored = await this.storedEntry();
			return this.view(stored);
		});
	}

	/**
	 * Persist first, then apply. If the write fails nothing changed; the
	 * opposite order would leave a daemon running settings that exist nowhere
	 * on disk.
	 */
	async update(patch: ProjectSettingsPatch): Promise<ProjectSettingsView> {
		return this.withLifecycle(async () => {
			const entry = await mutateConfig(this.deps.mfwHome, (config) => {
				const stored = this.entryOf(config);
				applyPatch(stored, patch);
				return structuredClone(stored);
			});

			const values = this.effective(entry);
			if (patch.maxConcurrent !== undefined) {
				this.deps.scheduler.setMaxConcurrent(values.maxConcurrent);
			}
			if (patch.assistance !== undefined) {
				this.deps.assistance.set(values.assistance);
			}
			if (patch.selfRepairMainRed !== undefined) {
				this.deps.scheduler.setSelfRepairMainRed(values.selfRepairMainRed);
			}
			if (patch.pushOnMerge !== undefined) {
				this.deps.mergeQueue.setPushOnMerge(values.pushOnMerge);
			}
			if (patch.schedulerAutostart !== undefined) {
				// Autostart is a boot-time flag, but the loop follows immediately so
				// the switch does not appear dead until the next restart.
				if (values.schedulerAutostart) {
					this.deps.scheduler.start(this.deps.schedulerIntervalMs);
				} else if (this.deps.scheduler.running) {
					await this.deps.scheduler.stop();
				}
			}
			return this.view(entry);
		});
	}

	private withLifecycle<T>(operation: () => Promise<T>): Promise<T> {
		return this.deps.lifecycle?.run(operation) ?? operation();
	}

	/** The stored entry for this project, or an empty one if it was attached
	 *  programmatically (tests, one-off boots) and has no config row yet. */
	private async storedEntry(): Promise<StoredProjectConfig> {
		const config = await loadConfig(this.deps.mfwHome);
		return this.entryOf(config);
	}

	private entryOf(config: DaemonConfig): StoredProjectConfig {
		const found = config.projects.find((p) => p.name === this.deps.project);
		if (found) return found;
		const created: StoredProjectConfig = {
			name: this.deps.project,
			root: this.deps.root,
		};
		config.projects.push(created);
		return created;
	}

	/**
	 * Stored value, else default. The live-applied values fall back to the
	 * running service rather than a constant, since a project attached
	 * programmatically (no config entry) runs with a real value.
	 */
	private effective(entry: StoredProjectConfig): ProjectSettingsValues {
		return {
			maxConcurrent: entry.maxConcurrent ?? this.deps.scheduler.maxConcurrent,
			schedulerAutostart:
				entry.schedulerAutostart ?? PROJECT_DEFAULTS.schedulerAutostart,
			assistance: entry.assistance
				? effectiveAssistance(entry)
				: this.deps.assistance.value,
			provider: entry.provider ?? providerConfigFor(DEFAULT_PROVIDER_ID),
			model: entry.model ?? PROJECT_DEFAULTS.model,
			modelTiers: entry.modelTiers ?? null,
			reviewModel: entry.reviewModel ?? null,
			reasoningEffort:
				entry.reasoningEffort ?? PROJECT_DEFAULTS.reasoningEffort,
			approvalMode: entry.approvalMode ?? PROJECT_DEFAULTS.approvalMode,
			maxRepairs: entry.maxRepairs ?? PROJECT_DEFAULTS.maxRepairs,
			maxStalls: entry.maxStalls ?? PROJECT_DEFAULTS.maxStalls,
			maxResumes: entry.maxResumes ?? PROJECT_DEFAULTS.maxResumes,
			leaseMs: entry.leaseMs ?? PROJECT_DEFAULTS.leaseMs,
			checkPrefix: entry.checkPrefix ?? null,
			envPolicy: entry.envPolicy ?? null,
			mergeChecks:
				entry.mergeChecks !== undefined
					? entry.mergeChecks
					: FALLBACK_MERGE_CHECKS,
			notify: entry.notify ?? null,
			selfRepairMainRed:
				entry.selfRepairMainRed ?? this.deps.scheduler.selfRepairMainRed,
			pushOnMerge: entry.pushOnMerge ?? this.deps.mergeQueue.pushOnMerge,
			runpod: entry.runpod ?? null,
			runpodTarget: entry.runpodTarget ?? null,
		};
	}

	private view(entry: StoredProjectConfig): ProjectSettingsView {
		return {
			project: this.deps.project,
			root: this.deps.root,
			integrationBranch: this.deps.integrationBranch,
			values: this.effective(entry),
			needsRestart: RESTART_KEYS,
			configPath: configPath(this.deps.mfwHome),
		};
	}
}

/** Write the safe subset onto a stored entry. `null` clears an optional. */
function applyPatch(
	entry: StoredProjectConfig,
	patch: ProjectSettingsPatch,
): void {
	if (patch.maxConcurrent !== undefined) {
		entry.maxConcurrent = Math.max(1, Math.floor(patch.maxConcurrent));
	}
	if (patch.schedulerAutostart !== undefined) {
		entry.schedulerAutostart = patch.schedulerAutostart;
	}
	if (patch.assistance !== undefined) {
		entry.assistance = patch.assistance;
	}
	if (patch.provider !== undefined) {
		// Throws for an id with no adapter before the config is saved, so a
		// project is never persisted pointing at a CLI the daemon cannot launch.
		entry.provider = providerConfigFor(
			patch.provider.id,
			patch.provider.env,
		) as StoredProjectConfig["provider"];
		if (patch.model === undefined) {
			entry.model = findProvider(patch.provider.id)?.defaultModel;
		}
	}
	if (patch.model !== undefined) entry.model = patch.model;
	if (patch.modelTiers !== undefined) {
		entry.modelTiers = patch.modelTiers ?? undefined;
	}
	if (patch.reviewModel !== undefined) {
		entry.reviewModel = patch.reviewModel ?? undefined;
	}
	if (patch.reasoningEffort !== undefined) {
		entry.reasoningEffort = patch.reasoningEffort;
	}
	if (patch.approvalMode !== undefined) {
		entry.approvalMode = patch.approvalMode;
	}
	if (patch.maxRepairs !== undefined) {
		entry.maxRepairs = Math.max(0, Math.floor(patch.maxRepairs));
	}
	if (patch.maxStalls !== undefined) {
		entry.maxStalls = Math.max(1, Math.floor(patch.maxStalls));
	}
	if (patch.maxResumes !== undefined) {
		entry.maxResumes = Math.max(0, Math.floor(patch.maxResumes));
	}
	if (patch.leaseMs !== undefined) {
		entry.leaseMs = Math.max(1000, Math.floor(patch.leaseMs));
	}
	if (patch.runpod !== undefined) entry.runpod = patch.runpod ?? undefined;
	if (patch.runpodTarget !== undefined) {
		entry.runpodTarget = patch.runpodTarget ?? undefined;
	}
	if (patch.checkPrefix !== undefined) {
		entry.checkPrefix = patch.checkPrefix ?? undefined;
	}
	if (patch.envPolicy !== undefined) {
		entry.envPolicy = patch.envPolicy ?? undefined;
	}
	if (patch.mergeChecks !== undefined) {
		entry.mergeChecks = patch.mergeChecks;
	}
	if (patch.notify !== undefined) entry.notify = patch.notify ?? undefined;
	if (patch.selfRepairMainRed !== undefined) {
		entry.selfRepairMainRed = patch.selfRepairMainRed;
	}
	if (patch.pushOnMerge !== undefined) entry.pushOnMerge = patch.pushOnMerge;
}

/**
 * Provider credentials as the API is allowed to see them. No shape returned
 * by this class can carry a key. Keys go in (`set`) and are never read back
 * out; the daemon reads them from `CredentialStore` when it launches an agent.
 */
export interface ProviderStatus {
	id: string;
	hasKey: boolean;
}

export interface ProviderCredentialCoordinator {
	setCredential(
		mutate: (validate: () => Promise<void>) => Promise<void>,
	): Promise<void>;
	removeCredential(mutate: () => Promise<void>): Promise<void>;
}

/** One catalogue entry joined with what is true on this machine. */
export interface ProviderView {
	id: string;
	name: string;
	description: string;
	/** False ⇒ a picker must not offer it as a project's provider. */
	drivable: boolean;
	unsupportedReason?: string;
	/** The executable detection looked for. */
	bin: string;
	installed: boolean;
	path: string | null;
	version: string | null;
	versionError?: string;
	/** Subscription and/or API-key methods, each with whether it is satisfied. */
	auth: ProviderAuthStatus[];
	models: ProviderModelChoice[];
	defaultModel: string;
	modelsAreSnapshot: boolean;
	docsUrl?: string;
	/** Catalogue default per task `model_tier`, shown as placeholders for the project's own overrides. */
	tiers?: { light: string; standard: string; strong: string };
}

export interface ProviderCatalogueView {
	providers: ProviderView[];
	/**
	 * Keys in `credentials.json` that no catalogue entry claims, so a key
	 * stored by hand stays visible and removable.
	 */
	extraCredentials: ProviderStatus[];
	/** Date the pinned model ids were last checked. */
	modelSnapshotCheckedOn: string;
	/**
	 * Always true: the model list is a suggestion, and a free-text field sits
	 * beside it so newer models stay usable.
	 */
	allowsCustomModel: boolean;
	/** Ids a project's provider may be set to right now. */
	selectableProviderIds: string[];
}

export class ProviderSettings {
	private readonly detector: ProviderDetector;

	constructor(
		private readonly store: CredentialStore,
		private readonly deps: {
			detector?: ProviderDetector;
			home?: string;
			env?: NodeJS.ProcessEnv;
			runpod?: ProviderCredentialCoordinator;
			openrouter?: ProviderCredentialCoordinator;
			openrouterManagement?: ProviderCredentialCoordinator;
		} = {},
	) {
		this.detector = deps.detector ?? new ProviderDetector({ env: deps.env });
	}

	/** The provider picker: every known provider, whether it is installed, how
	 *  it authenticates, and which models it takes. */
	async catalogue(): Promise<ProviderCatalogueView> {
		const detections = await this.detector.detectAll(PROVIDER_CATALOGUE);
		const stored = new Set(await this.store.list());
		const providers: ProviderView[] = [];
		for (const entry of PROVIDER_CATALOGUE) {
			providers.push(
				await this.viewOf(entry, detections.get(entry.id), (id) =>
					Promise.resolve(stored.has(id)),
				),
			);
		}
		const known = new Set(catalogueCredentialIds());
		return {
			providers,
			extraCredentials: [...stored]
				.filter((id) => !known.has(id))
				.sort()
				.map((id) => ({ id, hasKey: true })),
			modelSnapshotCheckedOn: MODEL_SNAPSHOT_CHECKED,
			allowsCustomModel: MODEL_LIST_IS_A_HINT,
			selectableProviderIds: PROVIDER_CATALOGUE.filter((p) => p.drivable).map(
				(p) => p.id,
			),
		};
	}

	private async viewOf(
		entry: ProviderEntry,
		detection: ProviderDetection | undefined,
		hasCredential: (id: string) => Promise<boolean>,
	): Promise<ProviderView> {
		return {
			id: entry.id,
			name: entry.name,
			description: entry.description,
			drivable: entry.drivable,
			...(entry.unsupportedReason
				? { unsupportedReason: entry.unsupportedReason }
				: {}),
			bin: entry.bin,
			installed: detection?.installed ?? false,
			path: detection?.path ?? null,
			version: detection?.version ?? null,
			...(detection?.versionError
				? { versionError: detection.versionError }
				: {}),
			auth: await probeAuth(entry, {
				home: this.deps.home,
				env: this.deps.env,
				hasCredential,
			}),
			models: [...entry.models],
			defaultModel: entry.defaultModel,
			modelsAreSnapshot: entry.modelsAreSnapshot,
			...(entry.docsUrl ? { docsUrl: entry.docsUrl } : {}),
			...(entry.tiers ? { tiers: entry.tiers } : {}),
		};
	}

	async list(): Promise<ProviderStatus[]> {
		return (await this.store.list()).sort().map((id) => ({ id, hasKey: true }));
	}

	async status(id: string): Promise<ProviderStatus> {
		return { id, hasKey: (await this.store.get(id)) !== undefined };
	}

	async set(id: string, apiKey: string): Promise<ProviderStatus> {
		const coordinator =
			id === "runpod"
				? this.deps.runpod
				: id === "openrouter"
					? this.deps.openrouter
					: id === "openrouter-management"
						? this.deps.openrouterManagement
						: undefined;
		if (coordinator) {
			await coordinator.setCredential((validate) =>
				this.store.setProviderValidated(id, apiKey, validate),
			);
		} else {
			await this.store.set(id, apiKey);
		}
		return { id, hasKey: true };
	}

	async remove(id: string): Promise<ProviderStatus> {
		const coordinator =
			id === "runpod"
				? this.deps.runpod
				: id === "openrouter"
					? this.deps.openrouter
					: id === "openrouter-management"
						? this.deps.openrouterManagement
						: undefined;
		if (coordinator) {
			await coordinator.removeCredential(() => this.store.remove(id));
		} else {
			await this.store.remove(id);
		}
		return { id, hasKey: false };
	}
}
