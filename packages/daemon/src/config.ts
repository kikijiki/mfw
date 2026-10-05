import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "@mfw/core/fsatomic";
import { z } from "zod";
import type { ProjectConfig } from "./boot.ts";
import {
	RunPodMachinePolicySchema,
	RunPodPlacementRequestSchema,
	RunPodProjectPolicySchema,
} from "./runpod-policy.ts";
import { serializeFileMutation } from "./serialized-file-mutation.ts";
import {
	type VerificationPlan,
	VerificationPlanSchema,
} from "./tasks/types.ts";

/**
 * Daemon-level config: only what is needed before any project opens (where
 * projects are, their limits). No secrets (`credentials.json`, chmod 600).
 */

export function mfwHome(): string {
	return process.env.MFW_HOME ?? join(homedir(), ".local", "share", "mfw");
}

export function configPath(home = mfwHome()): string {
	return join(home, "config.json");
}

/** Expand a leading `~` and resolve to an absolute path. */
export function normalizeRoot(root: string): string {
	let r = root.trim();
	if (r === "~") r = homedir();
	else if (r.startsWith("~/")) r = join(homedir(), r.slice(2));
	return resolve(r);
}

const notifySchema = z.object({
	webhook: z.string().url().optional(),
	command: z.string().optional(),
	timeoutMs: z.number().int().positive().optional(),
});

/** Which agent CLI this project runs. Credentials are per-machine; the tool is per-repo. */
const providerSchema = z.object({
	id: z.string().min(1),
	type: z.enum(["claude-cli", "codex-cli", "custom"]),
	command: z.array(z.string().min(1)).optional(),
	env: z.record(z.string(), z.string()).optional(),
});

export const assistanceSchema = z.object({
	failureDiagnosis: z.enum(["assisted", "escalate"]),
	conflictResolution: z.enum(["assisted", "escalate"]),
	changeReview: z.enum(["off", "assisted", "human"]),
});
export type RecoveryAssistance = z.infer<typeof assistanceSchema>;

const projectSchema = z.object({
	name: z.string().min(1),
	root: z.string().min(1),
	/** Where the board (`.mfw/board.yaml`, `tasks/`, `adrs/`, templates) lives,
	 * if different from `root` — e.g. the repo is `~/dev/app` but its board is
	 * tracked in a separate docs checkout like `~/docs/projects/app`.
	 * Defaults to `root`. Irrelevant to the standalone `board` CLI, which only
	 * ever cares about wherever its `board.yaml` is; this only matters for the
	 * service, which also needs to know the code repo for worktrees/git. */
	boardRoot: z.string().min(1).optional(),
	integrationBranch: z.string().optional(),
	model: z.string().optional(),
	/** Model per task `model_tier`; standard defaults to `model`, while light/strong use the provider tier default, then `model`. */
	modelTiers: z
		.object({
			light: z.string().min(1).optional(),
			standard: z.string().min(1).optional(),
			strong: z.string().min(1).optional(),
		})
		.optional(),
	/** Model for the semantic change review (critic); unset = the brain's `model`. */
	reviewModel: z.string().min(1).optional(),
	reasoningEffort: z
		.enum(["none", "low", "medium", "high", "xhigh", "max"])
		.optional(),
	approvalMode: z.enum(["autonomous", "interactive"]).optional(),
	provider: providerSchema.optional(),
	maxConcurrent: z.number().int().positive().optional(),
	/** Semaphore for `action: script` triggers, separate from `maxConcurrent` (which limits LLM spend). */
	maxConcurrentTriggers: z.number().int().positive().optional(),
	schedulerAutostart: z.boolean().optional(),
	assistance: assistanceSchema.optional(),
	maxRepairs: z.number().int().nonnegative().optional(),
	maxStalls: z.number().int().positive().optional(),
	maxResumes: z.number().int().nonnegative().optional(),
	leaseMs: z.number().int().positive().optional(),
	/**
	 * Wrapper command for every verification check (sandbox or dev-environment
	 * entrypoint such as `direnv exec .`, `nix develop -c`). Never auto-detected.
	 */
	checkPrefix: z.string().optional(),
	/** Env vars a check may read. Absent = `DEFAULT_ENV_ALLOWLIST` in `verifier.ts`. */
	envPolicy: z
		.object({
			allow: z.array(z.string()).optional(),
			inherit: z.boolean().optional(),
		})
		.optional(),
	/** Repository-wide gates for every candidate; task verification adds to them, never replaces them. */
	mergeChecks: VerificationPlanSchema.nullable().optional(),
	notify: notifySchema.optional(),
	/** Let the task that broke main run despite the red-main dispatch gate (see `Scheduler`). */
	selfRepairMainRed: z.boolean().optional(),
	/**
	 * Push the integration branch after every merge the queue lands. A failed
	 * push never fails or parks the already-landed merge.
	 */
	pushOnMerge: z.boolean().optional(),
	/** Remote to push to when `pushOnMerge` is set. Defaults to `origin`. */
	pushRemote: z.string().min(1).optional(),
	/**
	 * Isolate agent runs from the daemon's home (trigger arming store,
	 * `credentials.json`) via `bwrap`. Degrades to unsandboxed, with a log
	 * warning, if the binary is missing.
	 */
	agentIsolation: z.enum(["none", "bwrap"]).optional(),
	/** Failed expansion runs before a `draft` is marked failed (see `TaskService.recordDraftExpandFailure`). */
	draftExpandMaxAttempts: z.number().int().positive().optional(),
	/** Budget for draft expansion runs, separate from `maxConcurrent` like `maxConcurrentTriggers`. */
	maxConcurrentDraftExpansions: z.number().int().positive().optional(),
	/** A project may only narrow the process-global RunPod account policy. */
	runpod: RunPodProjectPolicySchema.optional(),
	/** Explicit placement used only by tasks selecting execution_target: runpod. */
	runpodTarget: RunPodPlacementRequestSchema.optional(),
	/** Default machine workload grants selected by runs; identifiers only. */
	workloadSecretGrants: z
		.array(z.string().regex(/^[A-Za-z0-9._-]+$/))
		.optional(),
});

const configSchema = z.object({
	projects: z.array(projectSchema).default([]),
	supervisorIntervalMs: z.number().int().positive().optional(),
	schedulerIntervalMs: z.number().int().positive().optional(),
	/**
	 * Machine-wide master stop. Dispatch needs this AND the project's own switch,
	 * so per-project settings survive a pause. Absent means playing:
	 * `schedulerAutostart` already defaults to false.
	 */
	dispatchPaused: z.boolean().optional(),
	/** Machine-wide RunPod account policy. Enabled mode requires finite hard caps. */
	runpod: RunPodMachinePolicySchema.optional(),
});

export type DaemonConfig = z.infer<typeof configSchema>;
export type StoredProjectConfig = z.infer<typeof projectSchema>;
export type NotifyConfigInput = z.infer<typeof notifySchema>;

/** Operating defaults for a project entry; single source for the engine and the settings UI. */
export const PROJECT_DEFAULTS = {
	model: "sonnet",
	reasoningEffort: "medium" as const,
	approvalMode: "autonomous" as const,
	maxConcurrent: 2,
	maxConcurrentTriggers: 2,
	maxRepairs: 2,
	maxStalls: 3,
	maxResumes: 2,
	leaseMs: 15 * 60_000,
	schedulerAutostart: false,
	assistance: {
		failureDiagnosis: "assisted",
		conflictResolution: "assisted",
		changeReview: "off",
	} as RecoveryAssistance,
	// Bounded, board-neutral and verifier-gated; lets an autonomous project clear its own breaker.
	selfRepairMainRed: true,
	// On, unlike the spend-related defaults: it only publishes work already merged, to a
	// remote already configured. No remote means nothing is pushed.
	pushOnMerge: true,
	pushRemote: "origin",
	agentIsolation: "none",
	// Enough to rule out a blip without leaving a draft unusable through an outage.
	draftExpandMaxAttempts: 3,
	// Read-only planning; should not serialize a capture burst.
	maxConcurrentDraftExpansions: 3,
} as const;

export function effectiveAssistance(input: {
	assistance?: RecoveryAssistance;
}): RecoveryAssistance {
	return input.assistance ?? { ...PROJECT_DEFAULTS.assistance };
}

/** Minimal built-in merge policy; projects wanting lint/test/build gates set `mergeChecks`. */
export const FALLBACK_MERGE_CHECKS: VerificationPlan = {
	verifier: "deterministic",
	checks: [{ diff_against_base: true }],
};

const EMPTY: DaemonConfig = { projects: [] };

/** Load the config. A malformed file throws rather than reverting to defaults (which looks like a fresh install). */
export async function loadConfig(home = mfwHome()): Promise<DaemonConfig> {
	let raw: string;
	try {
		raw = await readFile(configPath(home), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return structuredClone(EMPTY); // absent file = fresh install
		}
		// Not absence: mutateConfig must never overwrite an unreadable file with an empty config.
		throw error;
	}
	const parsed = configSchema.parse(JSON.parse(raw));
	return {
		...parsed,
		projects: parsed.projects.map((p) => ({
			...p,
			root: normalizeRoot(p.root),
		})),
	};
}

export async function saveConfig(
	config: DaemonConfig,
	home = mfwHome(),
): Promise<void> {
	await mkdir(home, { recursive: true, mode: 0o700 });
	await writeFileAtomic(
		configPath(home),
		`${JSON.stringify(configSchema.parse(config), null, "\t")}\n`,
	);
}

/**
 * The only read/modify/write primitive for config.json. Serialized per resolved
 * MFW home (across services and duplicated bundle chunks) so each callback
 * sees the latest committed file.
 */
export function mutateConfig<T>(
	home: string,
	mutation: (config: DaemonConfig) => T | Promise<T>,
): Promise<T> {
	const resolvedHome = resolve(home);
	return serializeFileMutation(configPath(resolvedHome), async () => {
		const config = await loadConfig(resolvedHome);
		const result = await mutation(config);
		await saveConfig(config, resolvedHome);
		return result;
	});
}

/** Project entries as `boot()` wants them. */
export function toBootProjects(cfg: DaemonConfig): ProjectConfig[] {
	return cfg.projects;
}
