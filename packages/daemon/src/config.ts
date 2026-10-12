import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "@mfw/core/fsatomic";
import { z } from "zod";
import type { ProjectConfig } from "./boot.ts";
import { colorProblem, iconProblem } from "./project-appearance.ts";
import { DEFAULT_REVIEW_POLICY, type ReviewPolicy } from "./review-verdict.ts";
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

const ROUTE_ID = /^[A-Za-z0-9_-]+$/;

/** Which agent CLI this project runs. Credentials are per-machine; the tool is per-repo. */
const providerSchema = z.object({
	id: z.string().min(1),
	type: z.enum(["claude-cli", "codex-cli", "custom"]),
	command: z.array(z.string().min(1)).optional(),
	env: z.record(z.string(), z.string()).optional(),
	/** codex-cli only: id of a `routing.endpoints` entry to use as Codex's model provider. */
	endpoint: z.string().regex(ROUTE_ID).optional(),
});

const effortSchema = z.enum(["none", "low", "medium", "high", "xhigh", "max"]);
const routeTargetSchema = z.object({
	/** A catalogue harness id or an endpoint id. */
	provider: z.string().regex(ROUTE_ID),
	model: z.string().min(1).optional(),
	effort: effortSchema.optional(),
});

/** Routing (see `routing.ts`): OpenAI-compatible endpoints, fallbacks per tier, escalation. */
export const routingSchema = z.object({
	/** Default placement for task runs (`routing.ts` `placeRun`); absent = local. */
	placement: z
		.object({
			target: z.enum(["local", "ssh"]),
			host: z
				.string()
				.regex(/^[a-z0-9][a-z0-9_-]{0,62}$/)
				.optional(),
			labels: z.array(z.string().min(1)).optional(),
		})
		.optional(),
	endpoints: z
		.record(
			z.string().regex(ROUTE_ID),
			z.object({
				baseUrl: z.string().min(1),
				/** Env var Codex reads the key from; only a workload grant sets it. */
				envKey: z
					.string()
					.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
					.optional(),
				/** Workload secret grant id providing `envKey`. */
				grant: z
					.string()
					.regex(/^[A-Za-z0-9._-]+$/)
					.optional(),
				model: z.string().min(1).optional(),
				vendor: z.string().min(1).optional(),
			}),
		)
		.optional(),
	fallbacks: z
		.object({
			default: z.array(routeTargetSchema).optional(),
			light: z.array(routeTargetSchema).optional(),
			standard: z.array(routeTargetSchema).optional(),
			strong: z.array(routeTargetSchema).optional(),
		})
		.optional(),
	escalateOnRepair: z.boolean().optional(),
});

/**
 * The project brain (`brain-runtime/`). Off unless `routes` names at least one
 * route: the first is tried first, and the next is used when the first is held
 * (a harness change is a rollover, sessions being harness-specific).
 */
export const brainSchema = z.object({
	routes: z.array(routeTargetSchema).min(1),
	/** Wake with no event after this many minutes while any run is live or any task is ready. */
	heartbeatMin: z.number().int().positive().optional(),
	/** Roll the session over past this many context tokens. */
	rolloverTokens: z.number().int().positive().optional(),
	/** Wall clock for one turn. */
	turnTimeoutMs: z.number().int().positive().optional(),
	maxTurnsPerHour: z.number().int().positive().optional(),
	maxTurnsPerDay: z.number().int().positive().optional(),
});
export type StoredBrainConfig = z.infer<typeof brainSchema>;

/**
 * One budget: a spend limit over a window (`budgets.ts`). Exactly one limit
 * unit. A window is `hour`, `day`, `week`, `month` (UTC calendar) or `<n>m|h|d`
 * (epoch-aligned buckets of that length, so the reset instant is exact).
 */
export const BUDGET_WINDOW = /^(?:hour|day|week|month|[1-9][0-9]{0,3}[mhd])$/;
export const budgetEntrySchema = z
	.object({
		window: z.string().regex(BUDGET_WINDOW),
		limitUsd: z.number().positive().optional(),
		limitTokens: z.number().int().positive().optional(),
		limitSlotHours: z.number().positive().optional(),
		/** Fraction of the limit (0..1) at which `budget.threshold` fires once per window. */
		warnAt: z.number().gt(0).lte(1).optional(),
		/** Resource budgets only: what to do with runs already live on the resource. */
		liveRunPolicy: z.enum(["stop", "finish_turn"]).optional(),
	})
	.refine(
		(b) =>
			[b.limitUsd, b.limitTokens, b.limitSlotHours].filter(
				(v) => v !== undefined,
			).length === 1,
		{ message: "set exactly one of limitUsd, limitTokens, limitSlotHours" },
	);
export type BudgetEntry = z.infer<typeof budgetEntrySchema>;

const budgetKey = z.string().regex(/^[A-Za-z0-9._:@*-]{1,80}$/);
/** `agents` keyed by provider hold key, `resources` by `runpod:<acct>` / `host:<id>`, `brain` for the brain's own spend. */
export const budgetsSchema = z.object({
	agents: z.record(budgetKey, budgetEntrySchema).optional(),
	resources: z.record(budgetKey, budgetEntrySchema).optional(),
	brain: budgetEntrySchema.optional(),
});
export type StoredBudgets = z.infer<typeof budgetsSchema>;

/**
 * The one assistance policy left: the review floor. What happens to a failed
 * run, a parked merge or a worker's question is the project brain's decision
 * (audited), not a setting; the keys older configs stored for them are
 * dropped on parse.
 */
export const assistanceSchema = z.object({
	changeReview: z.enum(["off", "assisted", "human"]),
});
export type RecoveryAssistance = z.infer<typeof assistanceSchema>;

/**
 * - `mode`: `critic` (one call over the inlined diff) or `agent` (a read-only
 *   reviewer agent in its own checkout). A task opts into agent review alone
 *   with the label `review:agent`.
 * - `requireIndependent`: the reviewer must differ from the worker in model or
 *   harness; settings refuse an equal pair, runtime falls back or fails closed.
 * - `maxRounds`: `fix` verdicts auto-repaired before a human decides.
 * - `fallbackModels`: tried in order when the reviewer equals the worker.
 */
export const reviewSchema = z.object({
	mode: z.enum(["critic", "agent"]).optional(),
	requireIndependent: z.boolean().optional(),
	maxRounds: z.number().int().nonnegative().optional(),
	fallbackModels: z.array(z.string().min(1)).optional(),
});
export type StoredReviewPolicy = z.infer<typeof reviewSchema>;

/** Stored policy over the defaults. */
export function effectiveReview(input: {
	review?: StoredReviewPolicy;
}): ReviewPolicy {
	const r = input.review ?? {};
	return {
		mode: r.mode ?? DEFAULT_REVIEW_POLICY.mode,
		requireIndependent:
			r.requireIndependent ?? DEFAULT_REVIEW_POLICY.requireIndependent,
		maxRounds: r.maxRounds ?? DEFAULT_REVIEW_POLICY.maxRounds,
		fallbackModels: r.fallbackModels ?? [
			...DEFAULT_REVIEW_POLICY.fallbackModels,
		],
	};
}
/** Live-run watchdog limits; 0 turns a time/turn limit off. Shared with the API's settings input. */
export const watchdogSchema = z.object({
	idleMs: z.number().int().nonnegative().optional(),
	wallMs: z.number().int().nonnegative().optional(),
	maxTurns: z.number().int().nonnegative().optional(),
	scope: z
		.object({
			mode: z.enum(["off", "warn", "kill"]).optional(),
			maxFiles: z.number().int().positive().optional(),
			sampleMs: z.number().int().min(5_000).optional(),
			foreignOwned: z.enum(["warn", "kill"]).optional(),
			onFinish: z.enum(["off", "review"]).optional(),
		})
		.optional(),
});
export type WatchdogConfig = z.infer<typeof watchdogSchema>;

/**
 * A documentation directory the Docs page lists besides the board's own
 * documents (see `docs.ts`). `path` is relative to the repository root, or to
 * the board folder when `base` is `board`; it never leaves that base.
 */
export const docSourceSchema = z.object({
	/** URL-safe handle, unique per project; never a board type name. */
	id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
	label: z.string().min(1).max(80),
	path: z.string().min(1).max(300),
	/** Absent = the repository root. */
	base: z.enum(["repo", "board"]).optional(),
	/** Globs relative to `path`. Absent = `DEFAULT_DOC_INCLUDE`. */
	include: z.array(z.string().min(1).max(200)).max(40).optional(),
	/** Globs relative to `path`, applied after `include`. */
	exclude: z.array(z.string().min(1).max(200)).max(40).optional(),
	/** A free hint (`adr`, `spec`, `journal`, `diagram`, `notes`, `reference`) the UI may group by. */
	kind: z.string().max(40).optional(),
});
export type DocSourceConfig = z.infer<typeof docSourceSchema>;

const projectSchema = z.object({
	name: z.string().min(1),
	root: z.string().min(1),
	/** Where the board (`board.yaml`, `tasks/`, `adrs/`, templates) lives at the root of this folder,
	 * if different from `root` — e.g. the repo is `~/dev/app` but its board is
	 * tracked in a separate docs checkout like `~/docs/projects/app`.
	 * Defaults to `root`. Irrelevant to the standalone `board` CLI, which only
	 * ever cares about wherever its `board.yaml` is; this only matters for the
	 * service, which also needs to know the code repo for worktrees/git. */
	boardRoot: z.string().min(1).optional(),
	integrationBranch: z.string().optional(),
	/** Display options: a curated icon key or a 1-2 character mark, and a swatch key (`project-appearance.ts`). Absent = derived from the name. */
	icon: z
		.string()
		.refine((v) => iconProblem(v) === null, { message: "invalid project icon" })
		.optional(),
	color: z
		.string()
		.refine((v) => colorProblem(v) === null, {
			message: "invalid project colour",
		})
		.optional(),
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
	/** Change review policy when `assistance.changeReview` is `assisted`. */
	review: reviewSchema.optional(),
	reasoningEffort: z
		.enum(["none", "low", "medium", "high", "xhigh", "max"])
		.optional(),
	approvalMode: z.enum(["autonomous", "interactive"]).optional(),
	provider: providerSchema.optional(),
	routing: routingSchema.optional(),
	/** The project brain; absent = off (nothing is dispatched: runs start only from its spawns). */
	brain: brainSchema.optional(),
	/** Spend ceilings for this project; each can only tighten a machine-level one. */
	budgets: budgetsSchema.optional(),
	maxConcurrent: z.number().int().positive().optional(),
	/** Semaphore for `action: script` triggers, separate from `maxConcurrent` (which limits LLM spend). */
	maxConcurrentTriggers: z.number().int().positive().optional(),
	schedulerAutostart: z.boolean().optional(),
	assistance: assistanceSchema.optional(),
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
	/**
	 * Live-run watchdog (`supervisor.ts`, `scope-watchdog.ts`). Every field is
	 * optional; an absent one takes `PROJECT_DEFAULTS.watchdog`. Applied live.
	 */
	watchdog: watchdogSchema.optional(),
	/** Dispatch preflight: refuse a local run while host MemAvailable is below this (MiB). 0 = off. */
	minFreeMemoryMb: z.number().int().nonnegative().optional(),
	/** A project may only narrow the process-global RunPod account policy. */
	runpod: RunPodProjectPolicySchema.optional(),
	/** Explicit placement used only by tasks selecting execution_target: runpod. */
	runpodTarget: RunPodPlacementRequestSchema.optional(),
	/** Extra documentation directories shown on the Docs page (not tracked by the board). */
	docs: z.array(docSourceSchema).max(40).optional(),
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
	/** Machine-wide budgets: account-wide keys, summed over every project's ledger. */
	budgets: budgetsSchema.optional(),
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
	leaseMs: 15 * 60_000,
	schedulerAutostart: false,
	assistance: {
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
	// Below this a fresh agent run (plus its toolchain) is likely to be OOM-killed
	// or to push the host into swap; refuse with a fix instead of starting it.
	minFreeMemoryMb: 512,
	// Kill after 5 min without output or 45 min of wall clock; scope: kill on
	// another claimed task's files or more than 150 files, review at finish
	// for files outside the task's own owns.
	watchdog: {
		idleMs: 5 * 60_000,
		wallMs: 45 * 60_000,
		maxTurns: 0,
		scope: {
			mode: "kill",
			maxFiles: 150,
			sampleMs: 30_000,
			foreignOwned: "kill",
			onFinish: "review",
		},
	},
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
