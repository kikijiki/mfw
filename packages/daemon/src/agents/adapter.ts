import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RateLimitInfo } from "../rate-limit.ts";
import { parseClaudeRateLimit } from "./rate-limit-claude.ts";

/**
 * Adapters are pure configuration: argv/env/driver-script/capabilities. All
 * translation lives in the driver processes; a run is steerable only after
 * its driver's verified `hello` (the triple gate, §5.5).
 *
 * `parseRateLimit` is the one hook that interprets provider output rather
 * than launching it.
 */

export interface Invocation {
	driverScript: string; // absolute path: every run goes through a driver
	agentArgv: string[]; // provider argv recorded on the run row (compatibility)
	bridgeArgv: string[]; // canonical mfw.app-server/v1 bridge
	providerArgv: string[]; // native CLI process spawned by the bridge
	env: Record<string, string>;
	declaredCapabilities: { steer: boolean };
}

export interface ProviderConfig {
	/** A `PROVIDER_CATALOGUE` id. Only ids with an adapter below can run. */
	id: string;
	type: "claude-cli" | "codex-cli" | "custom";
	/** Reserved for a future pty adapter. Nothing reads it: `type: "custom"` has no adapter and `AdapterRegistry.invocation` throws. */
	command?: string[];
	env?: Record<string, string>;
}

export interface AgentAdapter {
	readonly id: string;
	invocation(
		cfg: ProviderConfig,
		model: string,
		prompt: string,
		opts: { steer: boolean; disallowBackgroundAgents?: boolean },
	): Invocation;
	/**
	 * Parse this provider's rate-limit wire format from raw output. Optional;
	 * callers fall back to `rate-limit.ts`'s text heuristic. Returns `null`
	 * when there is no verdict ("not limited" is a real `RateLimitInfo`).
	 */
	parseRateLimit?(output: string): RateLimitInfo | null;
}

// ---------- driver path resolution (bundled-build safe, see v1 scripts.ts) ----------

/**
 * Driver location relative to the repo root for the bundled build, where
 * `import.meta.url` points into `.output/server/` and the colocated lookup
 * misses. Source runs never read this, so it can rot unnoticed;
 * `test/driver-path.test.ts` asserts these paths name real files.
 */
export const FROM_ROOT = {
	appServerDriver: join(
		"packages",
		"daemon",
		"src",
		"agents",
		"drivers",
		"app-server-driver.ts",
	),
	claudeBridge: join(
		"packages",
		"daemon",
		"src",
		"agents",
		"bridges",
		"claude-app-server.ts",
	),
	codexBridge: join(
		"packages",
		"daemon",
		"src",
		"agents",
		"bridges",
		"codex-app-server-bridge.ts",
	),
} as const;

function findUp(start: string, relFromRoot: string): string | null {
	let dir = start;
	for (;;) {
		const candidate = join(dir, relFromRoot);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function resolveScript(
	colocatedUrl: string,
	relFromRoot: string,
	envVar: string,
): string {
	const override = process.env[envVar];
	if (override) {
		if (existsSync(override)) return override;
		throw new Error(
			`${envVar}="${override}" does not exist: unset it or point it at the real script`,
		);
	}
	const colocated = fileURLToPath(colocatedUrl);
	if (existsSync(colocated)) return colocated;
	for (const start of [dirname(colocated), process.cwd()]) {
		const found = findUp(start, relFromRoot);
		if (found) return found;
	}
	throw new Error(
		`cannot locate ${relFromRoot}; set ${envVar} to its absolute path`,
	);
}

let appServerDriverCached: string | null = null;
export function appServerDriverScript(): string {
	appServerDriverCached ??= resolveScript(
		new URL("./drivers/app-server-driver.ts", import.meta.url).href,
		FROM_ROOT.appServerDriver,
		"MFW_APP_SERVER_DRIVER_SCRIPT",
	);
	return appServerDriverCached;
}

function bridgeScript(name: "claude" | "codex"): string {
	const rel =
		name === "claude" ? FROM_ROOT.claudeBridge : FROM_ROOT.codexBridge;
	const file =
		name === "claude" ? "claude-app-server.ts" : "codex-app-server-bridge.ts";
	return resolveScript(
		new URL(`./bridges/${file}`, import.meta.url).href,
		rel,
		`MFW_${name.toUpperCase()}_BRIDGE_SCRIPT`,
	);
}

// ---------- adapters ----------

/**
 * Tools that depend on a later turn the run never gets (async agents,
 * scheduled wakeups): the model ends its turn without the JSON the caller
 * needs, see https://github.com/anthropics/claude-code/issues/94392. Passed
 * via `--disallowedTools` for `disallowBackgroundAgents` runs (draft
 * expansion) so the model works inline.
 */
const BACKGROUND_AGENT_TOOLS = [
	"Agent",
	"ScheduleWakeup",
	"ListAgents",
	"Workflow",
];

/** Default: claude CLI in stream-json mode via the driver. The prompt goes over the driver's stdin protocol, never argv. */
export const claudeAdapter: AgentAdapter = {
	id: "claude-cli",
	invocation(cfg, model, _prompt, opts) {
		const providerArgv = [
			"claude",
			"--print",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--replay-user-messages",
			"--dangerously-skip-permissions",
			"--model",
			model,
			...(opts.disallowBackgroundAgents
				? ["--disallowedTools", BACKGROUND_AGENT_TOOLS.join(",")]
				: []),
		];
		return {
			driverScript: appServerDriverScript(),
			agentArgv: providerArgv,
			bridgeArgv: ["bun", "run", bridgeScript("claude")],
			providerArgv,
			env: { ...(cfg.env ?? {}) },
			declaredCapabilities: { steer: opts.steer },
		};
	},
	parseRateLimit: parseClaudeRateLimit,
};

export const codexAdapter: AgentAdapter = {
	id: "codex-cli",
	invocation(cfg, _model, _prompt, opts) {
		const providerArgv = ["codex", "app-server"];
		return {
			driverScript: appServerDriverScript(),
			agentArgv: providerArgv,
			bridgeArgv: ["bun", "run", bridgeScript("codex")],
			providerArgv,
			env: { ...(cfg.env ?? {}) },
			declaredCapabilities: { steer: opts.steer },
		};
	},
};

/** Every adapter the daemon actually has, keyed by provider id. */
const ADAPTERS: ReadonlyMap<string, AgentAdapter> = new Map([
	[claudeAdapter.id, claudeAdapter],
	[codexAdapter.id, codexAdapter],
]);

/** Adapter by provider id, or `undefined` for one no longer run. Callers that only interpret output treat that as "no opinion". */
export function adapterFor(
	id: string | null | undefined,
): AgentAdapter | undefined {
	return id ? ADAPTERS.get(id) : undefined;
}

export class AdapterRegistry {
	/** Test seam: override the argv builder without faking a whole provider. */
	buildArgv: ((model: string) => string[]) | null = null;
	/** Test seam: override the driver script path. */
	driverOverride: string | null = null;

	/** Throws for an unknown provider (run ends start_failed) rather than silently substituting the claude adapter. */
	invocation(
		cfg: ProviderConfig,
		model: string,
		prompt: string,
		opts: { steer: boolean; disallowBackgroundAgents?: boolean },
	): Invocation {
		const adapter = ADAPTERS.get(cfg.id);
		if (!adapter) {
			throw new Error(
				`no adapter can drive provider '${cfg.id}' (type '${cfg.type}'), mfw runs: ${[...ADAPTERS.keys()].join(", ")}`,
			);
		}
		const inv = adapter.invocation(cfg, model, prompt, opts);
		if (this.buildArgv) {
			inv.agentArgv = this.buildArgv(model);
			inv.providerArgv = inv.agentArgv;
		}
		if (this.driverOverride) inv.driverScript = this.driverOverride;
		return inv;
	}
}
