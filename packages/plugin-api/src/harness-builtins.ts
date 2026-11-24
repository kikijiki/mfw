import type { HarnessManifestInput } from "./harness.ts";
import { UNATTESTED_CONFIG_MARKER } from "./harness-markers.ts";

/**
 * The harnesses mfw ships, as data. Every value here was moved from the
 * hand-written maps it replaces; `harness-equivalence.test.ts` compares the
 * result with a snapshot of what those maps produced.
 *
 * This module imports no validator, because the ACP bridge bundles it and a
 * host script keeps a small import graph. The daemon validates this same data
 * through the registry before it launches any bridge.
 *
 * The egress lists come from the sandbox experiments and the vendors' network
 * documentation. Left out on purpose:
 * - `claude.ai`: account login, which the owner does outside a run. The
 *   vendor's documentation does not expect it at runtime with a stored login;
 * - `mcp-proxy.anthropic.com`: claude.ai connectors;
 * - plugin and update hosts, including the package registries and GitHub;
 * - `*.oaiusercontent.com`: optional for Codex in the experiments, and it has
 *   no exact host to list.
 *
 * The fleet `writable` lists are TEMPORARY until P4 supplies the versioned
 * per-CLI allowlist: they are the provisional directories from the sandbox
 * experiments, not attested for an authenticated CLI, and carry the
 * `unattested-config` marker. Files in the config root (`.claude.json`,
 * `auth.json`, Codex's sqlite state) stay read-only, so a CLI that must rewrite
 * them fails rather than gaining a writable config root. `plugins/store` is
 * left out because a CLI loads code from it.
 */

/** The pi-acp release mfw launches (adapter) and installs (RunPod). */
export const PI_ACP_VERSION = "0.0.34";

const OBSERVED_CLAUDE =
	"observed: the only host an unauthenticated CLI contacted (2.1.330)";
const CLAUDE_DOCS = "vendor network configuration page; not observed";
const OBSERVED_CODEX = "observed: the only host three runs needed (0.170.0)";

const NO_AUTONOMY = {
	flags: [],
	values: [],
	config: [],
	configOptions: [],
	launchFlags: [],
};

/** As the ACP bridge declares them in its `initialize` answer. */
const ACP_CAPABILITIES = {
	steer: false,
	interrupt: true,
	resume: true,
	mcp: false,
	approvals: true,
	plan: true,
	fileChanges: true,
	commandProgress: true,
	streaming: true,
	tools: true,
};

const ACP_RESUME = {
	method: "acp-session",
	detail: "session/resume when the agent offers it, else session/load",
} as const;

const ACP_COMPLETION = { signal: "session/prompt stopReason" };

/** ACP agents own their model list; `default` leaves the agent's own choice. */
const ACP_MODELS = {
	choices: [{ id: "default", label: "Agent default", kind: "alias" as const }],
	default: "default",
	isSnapshot: false,
};

const CLAUDE_STREAM_ARGV = [
	"claude",
	"--print",
	"--input-format",
	"stream-json",
	"--output-format",
	"stream-json",
	"--verbose",
	"--include-partial-messages",
	"--replay-user-messages",
];

export const BUILTIN_HARNESS_MANIFESTS: readonly HarnessManifestInput[] = [
	{
		schemaVersion: 1,
		manifestVersion: 1,
		id: "claude-cli",
		displayName: "Claude Code",
		description:
			"Anthropic's Claude Code CLI, driven in stream-json mode through mfw's compatibility server.",
		docsUrl: "https://code.claude.com/docs/en/cli-reference",
		detect: { bin: "claude", versionArgs: ["--version"] },
		dialect: "claude-stream-json",
		modes: {
			task: [
				...CLAUDE_STREAM_ARGV,
				"--dangerously-skip-permissions",
				"--model",
				"{model}",
			],
			brain: [...CLAUDE_STREAM_ARGV, "--model", "{model}"],
			inference: [
				"claude",
				"-p",
				"{prompt}",
				"--model",
				"{model}",
				"--output-format",
				"json",
				"--tools",
				"",
				"--strict-mcp-config",
				"--no-session-persistence",
			],
		},
		readOnly: {
			mechanism: "argv",
			value: [
				"--disallowedTools",
				"Agent,ScheduleWakeup,ListAgents,Workflow,Bash,Edit,Write,NotebookEdit",
			],
		},
		capabilities: {
			steer: true,
			interrupt: true,
			resume: true,
			mcp: false,
			approvals: false,
			plan: false,
			fileChanges: false,
			commandProgress: false,
			streaming: true,
			tools: true,
		},
		resume: {
			method: "session-id-flag",
			detail: "--session-id on the first turn, --resume <id> after",
		},
		completion: { signal: "result" },
		sandbox: { needsUserns: false, executables: ["claude"] },
		fleet: {
			cli: "claude",
			env: "CLAUDE_CONFIG_DIR",
			writable: ["backups", "projects", "sessions"],
			transcriptDir: "projects",
			attestation: UNATTESTED_CONFIG_MARKER,
		},
		egress: [
			{
				host: "api.anthropic.com",
				port: 443,
				purpose: "inference",
				source: OBSERVED_CLAUDE,
			},
			{
				host: "platform.claude.com",
				port: 443,
				purpose: "auth",
				source: `${CLAUDE_DOCS} (OAuth token exchange and refresh)`,
			},
			{
				host: "http-intake.logs.us5.datadoghq.com",
				port: 443,
				purpose: "telemetry",
				source: CLAUDE_DOCS,
			},
			{
				host: "browser-intake-us5-datadoghq.com",
				port: 443,
				purpose: "telemetry",
				source: `${CLAUDE_DOCS} (error reports)`,
			},
		],
		telemetryOff: {
			env: {
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
				DISABLE_TELEMETRY: "1",
				DISABLE_ERROR_REPORTING: "1",
			},
		},
		autonomy: {
			flags: [
				"--dangerously-skip-permissions",
				"--allow-dangerously-skip-permissions",
			],
			values: [
				{ option: "--permission-mode", value: "bypassPermissions" },
				{ option: "--permission-mode", value: "auto" },
				{ option: "--permission-mode", value: "acceptEdits" },
			],
			config: [],
			configOptions: [],
			launchFlags: ["--dangerously-skip-permissions"],
		},
		usage: { source: "rate-limit-event" },
		auth: {
			kinds: ["subscription", "api-key"],
			methods: [
				{
					kind: "subscription",
					loginFiles: [".claude/.credentials.json"],
					hint: "Run `claude` once and sign in, or `claude setup-token`. A Claude subscription needs no API key: this is how most operators run mfw.",
				},
				{
					kind: "api-key",
					credentialId: "anthropic",
					envVars: ["ANTHROPIC_API_KEY"],
					hint: "Pay-per-token instead of a subscription. NOTE: mfw does not yet inject a stored key into the agent's environment: export ANTHROPIC_API_KEY for the server until it does.",
				},
			],
			remoteLoginFiles: [".claude/.credentials.json"],
		},
		models: {
			tiers: { light: "haiku", standard: "sonnet", strong: "opus" },
			choices: [
				{ id: "sonnet", label: "Sonnet (latest)", kind: "alias" },
				{ id: "opus", label: "Opus (latest)", kind: "alias" },
				{ id: "haiku", label: "Haiku (latest)", kind: "alias" },
				{ id: "fable", label: "Fable (latest)", kind: "alias" },
				{ id: "claude-opus-5", label: "Claude Opus 5", kind: "pinned" },
				{ id: "claude-sonnet-5", label: "Claude Sonnet 5", kind: "pinned" },
				{ id: "claude-opus-4-8", label: "Claude Opus 4.8", kind: "pinned" },
				{ id: "claude-haiku-4-5", label: "Claude Haiku 4.5", kind: "pinned" },
				{ id: "claude-fable-5", label: "Claude Fable 5", kind: "pinned" },
			],
			default: "sonnet",
			isSnapshot: true,
		},
		install: {
			projectConfig: [
				".claude/settings.json",
				".claude.json",
				".mcp.json",
				"CLAUDE.md",
				"CLAUDE.local.md",
			],
			projectDirs: [".claude"],
			skills: ".claude/skills",
		},
	},
	{
		schemaVersion: 1,
		manifestVersion: 1,
		id: "codex-cli",
		displayName: "OpenAI Codex CLI",
		description:
			"OpenAI's Codex CLI, driven through its app-server protocol with structured lifecycle events, steering, interruption and approvals.",
		docsUrl: "https://developers.openai.com/codex/app-server",
		detect: { bin: "codex", versionArgs: ["--version"] },
		dialect: "codex-app-server",
		modes: {
			task: ["codex", "app-server"],
			brain: ["codex", "exec"],
			inference: [
				"codex",
				"exec",
				"--ephemeral",
				"--sandbox",
				"read-only",
				"--color",
				"never",
				"-m",
				"{model}",
				"{effort_argv}",
				"{prompt}",
			],
		},
		readOnly: {
			mechanism: "argv",
			value: [
				"-c",
				'sandbox_mode="read-only"',
				"-c",
				'approval_policy="never"',
			],
		},
		capabilities: {
			steer: true,
			interrupt: true,
			resume: true,
			mcp: true,
			approvals: true,
			plan: true,
			fileChanges: true,
			commandProgress: true,
			streaming: true,
			tools: true,
		},
		resume: {
			method: "thread-arg",
			detail: "exec on the first turn, exec resume <thread> after",
		},
		completion: { signal: "turn.completed" },
		// mfw's sandbox is the boundary; the bridge asks for this mode over RPC.
		innerSandbox: {
			disableArgv: [],
			mode: "workspace-write",
			via: "app-server-rpc",
			refused: ["danger-full-access"],
		},
		sandbox: { needsUserns: false, executables: ["codex"] },
		fleet: {
			cli: "codex",
			env: "CODEX_HOME",
			writable: [
				"cache",
				"sessions",
				"shell_snapshots",
				"thread-writer-locks",
				"tmp",
			],
			transcriptDir: "sessions",
			attestation: UNATTESTED_CONFIG_MARKER,
		},
		egress: [
			{
				host: "chatgpt.com",
				port: 443,
				purpose: "inference",
				source: OBSERVED_CODEX,
			},
			{
				host: "api.openai.com",
				port: 443,
				purpose: "inference",
				source: "string in the 0.170.0 binary, for API-key mode; not observed",
				requiresApiKey: true,
			},
			{
				host: "auth.openai.com",
				port: 443,
				purpose: "auth",
				source:
					"expected for token refresh; never contacted in the experiments",
			},
			{
				host: "ab.chatgpt.com",
				port: 443,
				purpose: "telemetry",
				source: "observed: telemetry, gone with telemetry disabled",
			},
		],
		// Codex has config keys for this and no environment variable. Its
		// telemetry is refused at the proxy and shows up as a denied attempt.
		telemetryOff: { env: {} },
		autonomy: {
			flags: [
				"--dangerously-bypass-approvals-and-sandbox",
				"--full-auto",
				"--yolo",
				"--approve-for-me",
			],
			values: [
				{ option: "--ask-for-approval", value: "never" },
				{ option: "-a", value: "never" },
				{ option: "--sandbox", value: "danger-full-access" },
				{ option: "-s", value: "danger-full-access" },
			],
			config: [
				{ key: "approval_policy", value: "never" },
				{ key: "sandbox_mode", value: "danger-full-access" },
			],
			configOptions: ["-c", "--config"],
			// A brain turn cannot prompt anyone; it runs in a read-only sandbox.
			launchFlags: ['-c approval_policy="never"'],
		},
		usage: { source: "app-server-rpc" },
		auth: {
			kinds: ["subscription", "api-key"],
			methods: [
				{
					kind: "subscription",
					loginFiles: [".codex/auth.json"],
					hint: "Sign in through the Codex CLI itself.",
				},
			],
			apiKeyEnv: "OPENAI_API_KEY",
			remoteLoginFiles: [".codex/auth.json"],
		},
		models: {
			tiers: {
				light: "gpt-5.6-luna",
				standard: "gpt-5.6-terra",
				strong: "gpt-5.6-sol",
			},
			choices: [
				{ id: "gpt-5.6", label: "GPT-5.6 (Sol alias)", kind: "alias" },
				{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", kind: "pinned" },
				{ id: "gpt-5.6-terra", label: "GPT-5.6-Terra", kind: "pinned" },
				{ id: "gpt-5.6-luna", label: "GPT-5.6-Luna", kind: "pinned" },
			],
			default: "gpt-5.6-sol",
			isSnapshot: true,
		},
		acceptsEndpoints: true,
		install: {
			projectConfig: [".codex/config.toml", "AGENTS.md", "AGENTS.override.md"],
			projectDirs: [".codex"],
			skills: ".agents/skills",
		},
	},
	{
		schemaVersion: 1,
		manifestVersion: 1,
		id: "gemini-cli",
		displayName: "Gemini CLI",
		description:
			"Google's Gemini CLI, driven over the Agent Client Protocol (`gemini --acp`). Runs tasks, project-brain turns (read-only plan mode) and critic calls; no custom endpoints.",
		docsUrl: "https://google-gemini.github.io/gemini-cli/",
		detect: { bin: "gemini", versionArgs: ["--version"] },
		dialect: "acp",
		modes: {
			task: ["gemini", "--acp", "{model_argv}"],
			brain: ["gemini", "--acp", "{model_argv}", "--approval-mode", "plan"],
			inference: ["gemini", "--acp", "{model_argv}", "--approval-mode", "plan"],
			modelArgv: ["--model", "{model}"],
		},
		readOnly: { mechanism: "argv", value: ["--approval-mode", "plan"] },
		capabilities: ACP_CAPABILITIES,
		resume: ACP_RESUME,
		completion: ACP_COMPLETION,
		sandbox: { needsUserns: false, executables: ["gemini"] },
		fleet: {},
		autonomy: {
			...NO_AUTONOMY,
			flags: ["--yolo", "-y"],
			values: [
				{ option: "--approval-mode", value: "yolo" },
				{ option: "--approval-mode", value: "auto_edit" },
			],
		},
		usage: { source: "none" },
		auth: {
			kinds: ["api-key"],
			methods: [
				{
					kind: "api-key",
					credentialId: "google",
					envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
					hint: "Set GEMINI_API_KEY, or sign in through the Gemini CLI.",
				},
			],
			remoteLoginFiles: [".gemini/oauth_creds.json"],
		},
		models: ACP_MODELS,
		// Plan mode is selected on the argv (`--approval-mode plan`).
		acp: { label: "Gemini CLI", modelOnArgv: true, brainEligible: true },
		install: {
			projectConfig: [".gemini/settings.json", "GEMINI.md"],
			projectDirs: [".gemini"],
		},
	},
	{
		schemaVersion: 1,
		manifestVersion: 1,
		id: "cursor-agent",
		displayName: "Cursor Agent",
		description:
			"Cursor's agent CLI, driven over the Agent Client Protocol (`agent acp`). Runs tasks, project-brain turns (read-only plan mode) and critic calls; no custom endpoints.",
		docsUrl: "https://cursor.com/docs/cli/acp",
		detect: {
			bin: "agent",
			versionArgs: ["--version"],
			identity: {
				kind: "symlink-target",
				basename: "cursor-agent",
				describe: "Cursor's CLI (installed as a link to .../cursor-agent)",
			},
		},
		dialect: "acp",
		modes: {
			// Root flags go before the `acp` subcommand.
			task: ["agent", "acp"],
			brain: ["agent", "--mode", "plan", "--approve-mcps", "acp"],
			inference: ["agent", "--mode", "plan", "acp"],
		},
		readOnly: { mechanism: "argv", value: ["--mode", "plan"] },
		capabilities: ACP_CAPABILITIES,
		resume: ACP_RESUME,
		completion: ACP_COMPLETION,
		sandbox: { needsUserns: false, executables: ["agent"] },
		fleet: {},
		autonomy: {
			...NO_AUTONOMY,
			flags: ["--force", "-f", "--yolo", "--approve-mcps"],
			// A brain turn approves only the MCP servers mfw wrote for it.
			launchFlags: ["--approve-mcps"],
		},
		usage: { source: "none" },
		auth: {
			kinds: ["subscription", "api-key"],
			methods: [
				{
					kind: "subscription",
					loginFiles: [".cursor/cli-config.json"],
					hint: "Sign in through the Cursor agent CLI itself.",
				},
				{
					kind: "api-key",
					envVars: ["CURSOR_API_KEY"],
					hint: "Export CURSOR_API_KEY for the server instead of signing in.",
				},
			],
			remoteLoginFiles: [".cursor/cli-config.json"],
		},
		models: ACP_MODELS,
		acp: {
			label: "Cursor Agent",
			// Without this Cursor advertises exploded model ids pinned to a fast tier.
			capabilityMeta: { parameterizedModelPicker: true },
			readOnlyMode: "plan",
			brainEligible: true,
		},
		install: {
			projectConfig: [".cursor/mcp.json", ".cursor/cli.json", ".cursorrules"],
			projectDirs: [".cursor"],
		},
	},
	{
		schemaVersion: 1,
		manifestVersion: 1,
		id: "opencode",
		displayName: "opencode",
		description:
			"opencode, driven over the Agent Client Protocol (`opencode acp`). Runs tasks, project-brain turns and critic calls with permissions denied for edits and shell; can use an OpenAI-compatible endpoint.",
		docsUrl: "https://opencode.ai/docs/",
		detect: { bin: "opencode", versionArgs: ["--version"] },
		dialect: "acp",
		// Read-only enforcement is config the bridge injects, not argv.
		modes: {
			task: ["opencode", "acp"],
			brain: ["opencode", "acp"],
			inference: ["opencode", "acp"],
		},
		readOnly: { mechanism: "config", value: [] },
		capabilities: ACP_CAPABILITIES,
		resume: ACP_RESUME,
		completion: ACP_COMPLETION,
		sandbox: { needsUserns: false, executables: ["opencode"] },
		fleet: {},
		autonomy: { ...NO_AUTONOMY, flags: ["--dangerously-skip-permissions"] },
		usage: { source: "none" },
		auth: {
			kinds: ["api-key"],
			methods: [
				{
					kind: "api-key",
					credentialId: "opencode",
					envVars: ["OPENCODE_API_KEY"],
					hint: "Configure a provider inside opencode itself.",
				},
			],
			remoteLoginFiles: [".local/share/opencode/auth.json"],
		},
		models: ACP_MODELS,
		acceptsEndpoints: true,
		acp: { label: "OpenCode", readOnlyMode: "plan", brainEligible: true },
		install: {
			projectConfig: [
				"opencode.json",
				"opencode.jsonc",
				".opencode/opencode.json",
			],
			projectDirs: [".opencode"],
			skills: ".opencode/skills",
		},
	},
	{
		schemaVersion: 1,
		manifestVersion: 1,
		id: "pi",
		displayName: "pi",
		description:
			"The pi coding agent, driven over the Agent Client Protocol through pi-acp (an MVP adapter; needs pi >= 0.81 and Node >= 22). Runs tasks, project-brain turns and critic calls; can use an OpenAI-compatible endpoint. Models are `provider/id` from your own pi configuration.",
		docsUrl: "https://github.com/svkozak/pi-acp",
		detect: {
			bin: "pi",
			versionArgs: ["--version"],
			versionRange: ">=0.81",
			identity: {
				kind: "help-text",
				args: ["--help"],
				pattern: "^pi\\b.*\\bcoding (assistant|agent)\\b",
				flags: "im",
				describe: "the pi coding agent (`pi --help` names it)",
			},
		},
		dialect: "acp",
		// pi-acp takes no pi flags; the bridge wraps pi itself for those.
		modes: {
			task: ["bunx", `pi-acp@${PI_ACP_VERSION}`],
			brain: ["bunx", `pi-acp@${PI_ACP_VERSION}`],
			inference: ["bunx", `pi-acp@${PI_ACP_VERSION}`],
		},
		readOnly: { mechanism: "config", value: [] },
		capabilities: ACP_CAPABILITIES,
		resume: ACP_RESUME,
		completion: ACP_COMPLETION,
		sandbox: { needsUserns: false, executables: ["bunx", "pi"] },
		fleet: {},
		// The bridge's wrapper passes this for a read-only turn, never on this argv.
		autonomy: { ...NO_AUTONOMY, flags: ["--approve"] },
		usage: { source: "none" },
		auth: {
			kinds: ["subscription"],
			methods: [
				{
					kind: "subscription",
					loginFiles: [".pi/agent/auth.json", ".pi/agent/models.json"],
					hint: "Configure a provider in pi itself: `pi auth login <provider>`, or add one to ~/.pi/agent/models.json.",
				},
			],
			remoteLoginFiles: [".pi/agent/auth.json", ".pi/agent/models.json"],
		},
		models: ACP_MODELS,
		acceptsEndpoints: true,
		// pi-acp's `modes` are thinking levels, so there is no read-only mode: pi's
		// own flags (the wrapper script) restrict it.
		acp: {
			label: "pi",
			brainEligible: true,
			readOnlyOtherTitles: ["grep", "find", "ls"],
		},
		install: {
			projectConfig: [".pi/mcp.json", ".pi/settings.json"],
			projectDirs: [".pi"],
			skills: ".pi/skills",
		},
	},
];
