import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	BrainMcpServer,
	BrainTurnLaunch,
} from "../brain-runtime/turn-run.ts";
import type { RateLimitInfo } from "../rate-limit.ts";
import { nativeSessionUuid } from "./native-session.ts";
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
	/**
	 * Codex only: an OpenAI-compatible endpoint (routing `endpoints`) to use
	 * as Codex's model provider instead of OpenAI. Names, a URL and the env
	 * var that holds the key; never a key.
	 */
	endpoint?: {
		id: string;
		baseUrl: string;
		envKey?: string;
	};
}

export interface InvocationOpts {
	steer: boolean;
	disallowBackgroundAgents?: boolean;
	/** The run this invocation launches; Claude's native session id is derived from it. */
	runId?: string;
	/**
	 * A project-brain turn: native `--session-id` / `--resume` (Claude) or
	 * `exec` / `exec resume` (Codex) with the brain MCP server and a read-only
	 * tool set. The harness does not restore per-wake flags from its session,
	 * so they are rebuilt for every turn.
	 */
	brain?: BrainTurnLaunch;
}

export interface AgentAdapter {
	readonly id: string;
	invocation(
		cfg: ProviderConfig,
		model: string,
		prompt: string,
		opts: InvocationOpts,
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
	codexExecBridge: join(
		"packages",
		"daemon",
		"src",
		"agents",
		"bridges",
		"codex-exec-bridge.ts",
	),
	/** The MCP server a brain turn is given (`@mfw/mcp --brain`). */
	mcpMain: join("packages", "mcp", "src", "main.ts"),
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

export function resolveScript(
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

const BRIDGES = {
	claude: {
		rel: FROM_ROOT.claudeBridge,
		file: "claude-app-server.ts",
		env: "MFW_CLAUDE_BRIDGE_SCRIPT",
	},
	codex: {
		rel: FROM_ROOT.codexBridge,
		file: "codex-app-server-bridge.ts",
		env: "MFW_CODEX_BRIDGE_SCRIPT",
	},
	"codex-exec": {
		rel: FROM_ROOT.codexExecBridge,
		file: "codex-exec-bridge.ts",
		env: "MFW_CODEX_EXEC_BRIDGE_SCRIPT",
	},
} as const;

function bridgeScript(name: keyof typeof BRIDGES): string {
	const b = BRIDGES[name];
	return resolveScript(
		new URL(`./bridges/${b.file}`, import.meta.url).href,
		b.rel,
		b.env,
	);
}

/** The `@mfw/mcp` entry a brain turn spawns; `MFW_MCP_SCRIPT` overrides. */
export function mcpMainScript(): string {
	return resolveScript(
		new URL("../../../mcp/src/main.ts", import.meta.url).href,
		FROM_ROOT.mcpMain,
		"MFW_MCP_SCRIPT",
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

/** What a Claude brain turn may use: its own MCP tools and read-only file tools. Never agents, shell or writes. */
const BRAIN_ALLOWED_TOOLS = (server: string) =>
	`mcp__${server}__*,Read,Grep,Glob`;
const BRAIN_DISALLOWED_TOOLS = [
	...BACKGROUND_AGENT_TOOLS,
	"Bash",
	"Edit",
	"Write",
	"NotebookEdit",
];

/**
 * A Claude brain turn: the first turn passes `--session-id <minted uuid>`,
 * later turns `--resume <id>`. `--mcp-config` and the tool gates ride on EVERY
 * turn because the CLI does not restore them from the session.
 */
export function claudeBrainArgv(
	model: string,
	brain: BrainTurnLaunch,
): string[] {
	const session = brain.resumeSessionId
		? ["--resume", brain.resumeSessionId]
		: brain.sessionId
			? ["--session-id", brain.sessionId]
			: [];
	return [
		"claude",
		"--print",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--verbose",
		"--include-partial-messages",
		"--replay-user-messages",
		"--model",
		model,
		...session,
		"--mcp-config",
		brain.mcpConfigPath,
		"--strict-mcp-config",
		"--allowedTools",
		BRAIN_ALLOWED_TOOLS(brain.mcp.name),
		"--disallowedTools",
		BRAIN_DISALLOWED_TOOLS.join(","),
	];
}

/** `-c` overrides that register one stdio MCP server with Codex (values are TOML). */
export function codexMcpArgs(server: BrainMcpServer): string[] {
	const key = `mcp_servers.${server.name}`;
	const env = Object.entries(server.env)
		.map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
		.join(", ");
	return [
		"-c",
		`${key}.command=${JSON.stringify(server.command)}`,
		"-c",
		`${key}.args=${JSON.stringify(server.args)}`,
		"-c",
		`${key}.env={ ${env} }`,
	];
}

/** A Codex brain turn: `exec` first, `exec resume <thread>` after; read-only, never asks. */
export function codexBrainArgv(
	brain: BrainTurnLaunch,
	endpoint?: ProviderConfig["endpoint"],
): string[] {
	return [
		"codex",
		"exec",
		...(brain.resumeSessionId ? ["resume", brain.resumeSessionId] : []),
		"--json",
		"--skip-git-repo-check",
		"-c",
		'sandbox_mode="read-only"',
		"-c",
		'approval_policy="never"',
		...codexMcpArgs(brain.mcp),
		...(endpoint ? codexEndpointArgs(endpoint) : []),
	];
}

/** Default: claude CLI in stream-json mode via the driver. The prompt goes over the driver's stdin protocol, never argv. */
export const claudeAdapter: AgentAdapter = {
	id: "claude-cli",
	invocation(cfg, model, _prompt, opts) {
		if (cfg.endpoint) {
			throw new Error(
				`claude-cli cannot use OpenAI-compatible endpoint '${cfg.endpoint.id}': route it through codex-cli`,
			);
		}
		if (opts.brain) {
			const providerArgv = claudeBrainArgv(model, opts.brain);
			return {
				driverScript: appServerDriverScript(),
				agentArgv: providerArgv,
				bridgeArgv: ["bun", "run", bridgeScript("claude")],
				providerArgv,
				env: {
					...(cfg.env ?? {}),
					// A fixed cwd plus a pinned project dir keeps the transcript where resume looks for it.
					...(opts.brain.projectDirName
						? { CLAUDE_CODE_PROJECT_DIR_NAME: opts.brain.projectDirName }
						: {}),
				},
				declaredCapabilities: { steer: opts.steer },
			};
		}
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
			// A known uuid up front: the session is resumable even if the first
			// turn crashes, and nothing has to be parsed back out of the output.
			...(opts.runId ? ["--session-id", nativeSessionUuid(opts.runId)] : []),
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

/**
 * Codex config overrides that make an OpenAI-compatible endpoint its model
 * provider (`codex app-server -c …`, values parsed as TOML). Codex only
 * speaks the Responses API to custom providers (`wire_api = "chat"` is
 * rejected), so the endpoint must serve `POST {baseUrl}/responses`. The key,
 * if any, is read by Codex from `envKey`, which only a workload grant sets.
 */
export function codexEndpointArgs(
	endpoint: NonNullable<ProviderConfig["endpoint"]>,
): string[] {
	if (!/^[A-Za-z0-9_-]+$/.test(endpoint.id)) {
		throw new Error(`endpoint id '${endpoint.id}' is not a valid Codex key`);
	}
	const key = `mfw-${endpoint.id}`;
	const fields = [
		`name = ${JSON.stringify(`mfw ${endpoint.id}`)}`,
		`base_url = ${JSON.stringify(endpoint.baseUrl)}`,
		`wire_api = "responses"`,
		...(endpoint.envKey
			? [`env_key = ${JSON.stringify(endpoint.envKey)}`]
			: []),
	];
	return [
		"-c",
		`model_provider=${JSON.stringify(key)}`,
		"-c",
		`model_providers.${key}={ ${fields.join(", ")} }`,
	];
}

export const codexAdapter: AgentAdapter = {
	id: "codex-cli",
	invocation(cfg, _model, _prompt, opts) {
		if (opts.brain) {
			const providerArgv = codexBrainArgv(opts.brain, cfg.endpoint);
			return {
				driverScript: appServerDriverScript(),
				agentArgv: providerArgv,
				bridgeArgv: ["bun", "run", bridgeScript("codex-exec")],
				providerArgv,
				env: { ...(cfg.env ?? {}) },
				declaredCapabilities: { steer: false },
			};
		}
		const providerArgv = [
			"codex",
			"app-server",
			...(cfg.endpoint ? codexEndpointArgs(cfg.endpoint) : []),
		];
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
	/** Test seam: swap the provider CLI (argv[0]) for a fake, keeping every real flag. */
	providerCommand: string[] | null = null;

	/** Throws for an unknown provider (run ends start_failed) rather than silently substituting the claude adapter. */
	invocation(
		cfg: ProviderConfig,
		model: string,
		prompt: string,
		opts: InvocationOpts,
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
		if (this.providerCommand) {
			inv.providerArgv = [
				...this.providerCommand,
				...inv.providerArgv.slice(1),
			];
			inv.agentArgv = inv.providerArgv;
		}
		if (this.driverOverride) inv.driverScript = this.driverOverride;
		return inv;
	}
}
