import type { ModelTier } from "../tasks/types.ts";
import type { ProviderConfig } from "./adapter.ts";

/**
 * The agent-CLI catalogue: which providers and models exist, as data.
 *
 * `drivable` is true only when a daemon adapter can run the CLI end to end
 * (Claude and Codex). The rest are detected and named in the UI as "found, not
 * yet drivable". `AdapterRegistry.invocation` throws for anything it cannot
 * drive and `SettingsService` refuses to store a non-drivable provider, so an
 * entry cannot over-promise.
 */

export type ProviderAuthKind = "subscription" | "api-key";

export interface ProviderAuthMethod {
	kind: ProviderAuthKind;
	/**
	 * Key in `~/.local/share/mfw/credentials.json` for an api-key method.
	 * Absent for subscription methods.
	 */
	credentialId?: string;
	/** Environment variables that also satisfy an api-key method. */
	envVars?: readonly string[];
	/**
	 * Files (relative to $HOME) that prove an interactive login already
	 * happened. First existing one wins.
	 */
	loginFiles?: readonly string[];
	/** Top-level JSON key that must be present in the login file to count. */
	loginMarker?: string;
	/** Shown verbatim; says how to get into this state. */
	hint: string;
}

export interface ProviderModelChoice {
	/** Exactly what goes on the wire / after `--model`. */
	id: string;
	label: string;
	/** "alias": the CLI resolves it, so it cannot go stale. "pinned": exact id copied on `MODEL_SNAPSHOT_CHECKED`, can go stale. */
	kind: "alias" | "pinned";
}

export interface ProviderEntry {
	id: string;
	name: string;
	description: string;
	/** Executable that detection looks for on PATH. */
	bin: string;
	/** Argv that makes the tool report its own version. Asked, never assumed. */
	versionArgs: readonly string[];
	/** True only when an adapter in this daemon can actually run it. */
	drivable: boolean;
	/** `ProviderConfig.type` this entry produces. Only set when drivable. */
	configType?: ProviderConfig["type"];
	/** Why it is not drivable. Rendered verbatim. Required when !drivable. */
	unsupportedReason?: string;
	auth: readonly ProviderAuthMethod[];
	models: readonly ProviderModelChoice[];
	/** Model selected when a project changes to this provider. */
	defaultModel: string;
	/**
	 * True when `models` is a hand-maintained snapshot rather than something
	 * the tool told us. Drives the "list is a convenience, not a gate" note.
	 */
	modelsAreSnapshot: boolean;
	docsUrl?: string;
	/**
	 * Model per task `model_tier`, used when a project has not overridden the
	 * tier itself. Aliases where the CLI has one, so this cannot go stale.
	 */
	tiers?: { light: string; standard: string; strong: string };
}

/**
 * When the pinned model ids below were last checked against the vendor's table.
 * If old, treat pinned ids as suspect; use an alias or the free-text override.
 */
export const MODEL_SNAPSHOT_CHECKED = "2026-08-10";

/**
 * The model list is a hint, never a validator: `settings.update` accepts any
 * non-empty `model` so a new vendor model works without an mfw release. The UI
 * renders the list and a free-text field.
 */
export const MODEL_LIST_IS_A_HINT = true;

/**
 * Claude Code's `--model` takes an alias or a full model name. Aliases are
 * listed first and recommended: the CLI resolves them, so they survive model
 * launches while a pinned id eventually names something retired.
 */
const CLAUDE_MODELS: readonly ProviderModelChoice[] = [
	{ id: "sonnet", label: "Sonnet (latest)", kind: "alias" },
	{ id: "opus", label: "Opus (latest)", kind: "alias" },
	{ id: "haiku", label: "Haiku (latest)", kind: "alias" },
	{ id: "fable", label: "Fable (latest)", kind: "alias" },
	{ id: "claude-opus-5", label: "Claude Opus 5", kind: "pinned" },
	{ id: "claude-sonnet-5", label: "Claude Sonnet 5", kind: "pinned" },
	{ id: "claude-opus-4-8", label: "Claude Opus 4.8", kind: "pinned" },
	{ id: "claude-haiku-4-5", label: "Claude Haiku 4.5", kind: "pinned" },
	{ id: "claude-fable-5", label: "Claude Fable 5", kind: "pinned" },
];

/**
 * The app server's `model/list` response is authoritative at runtime. This
 * small snapshot keeps first-time configuration useful before a Codex process
 * has been started, and remains a suggestion rather than validation.
 */
const CODEX_MODELS: readonly ProviderModelChoice[] = [
	{ id: "gpt-5.6", label: "GPT-5.6 (Sol alias)", kind: "alias" },
	{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", kind: "pinned" },
	{ id: "gpt-5.6-terra", label: "GPT-5.6-Terra", kind: "pinned" },
	{ id: "gpt-5.6-luna", label: "GPT-5.6-Luna", kind: "pinned" },
];

/** A non-drivable entry carries no model list (nothing to verify it against). Detection still reports the installed version. */
const NO_MODELS: readonly ProviderModelChoice[] = [];

export const PROVIDER_CATALOGUE: readonly ProviderEntry[] = [
	{
		id: "claude-cli",
		name: "Claude Code",
		description:
			"Anthropic's Claude Code CLI, driven in stream-json mode through mfw's compatibility server.",
		bin: "claude",
		versionArgs: ["--version"],
		drivable: true,
		configType: "claude-cli",
		auth: [
			{
				kind: "subscription",
				loginFiles: [".claude/.credentials.json"],
				loginMarker: "claudeAiOauth",
				hint: "Run `claude` once and sign in, or `claude setup-token`. A Claude subscription needs no API key: this is how most operators run mfw.",
			},
			{
				kind: "api-key",
				credentialId: "anthropic",
				envVars: ["ANTHROPIC_API_KEY"],
				hint: "Pay-per-token instead of a subscription. NOTE: mfw does not yet inject a stored key into the agent's environment: export ANTHROPIC_API_KEY for the daemon until it does.",
			},
		],
		models: CLAUDE_MODELS,
		defaultModel: "sonnet",
		modelsAreSnapshot: true,
		docsUrl: "https://code.claude.com/docs/en/cli-reference",
		tiers: { light: "haiku", standard: "sonnet", strong: "opus" },
	},
	{
		id: "codex-cli",
		name: "OpenAI Codex CLI",
		description:
			"OpenAI's Codex CLI, driven through its app-server protocol with structured lifecycle events, steering, interruption and approvals.",
		bin: "codex",
		versionArgs: ["--version"],
		drivable: true,
		configType: "codex-cli",
		auth: [
			{
				kind: "subscription",
				loginFiles: [".codex/auth.json"],
				hint: "Sign in through the Codex CLI itself.",
			},
		],
		models: CODEX_MODELS,
		defaultModel: "gpt-5.6-sol",
		modelsAreSnapshot: true,
		docsUrl: "https://developers.openai.com/codex/app-server",
		tiers: {
			light: "gpt-5.6-luna",
			standard: "gpt-5.6-terra",
			strong: "gpt-5.6-sol",
		},
	},
	{
		id: "gemini-cli",
		name: "Gemini CLI",
		description:
			"Detected so you can see whether it is installed. mfw cannot drive it yet.",
		bin: "gemini",
		versionArgs: ["--version"],
		drivable: false,
		unsupportedReason:
			"No mfw adapter: its output is not the stream-json protocol the daemon's only driver parses.",
		auth: [
			{
				kind: "api-key",
				credentialId: "google",
				envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
				hint: "Set GEMINI_API_KEY, or sign in through the Gemini CLI.",
			},
		],
		models: NO_MODELS,
		defaultModel: "",
		modelsAreSnapshot: false,
	},
	{
		id: "cursor-agent",
		name: "Cursor Agent",
		description:
			"Detected so you can see whether it is installed. mfw cannot drive it yet.",
		bin: "cursor-agent",
		versionArgs: ["--version"],
		drivable: false,
		unsupportedReason:
			"No mfw adapter: its output is not the stream-json protocol the daemon's only driver parses.",
		auth: [
			{
				kind: "subscription",
				loginFiles: [".cursor/cli-config.json"],
				hint: "Sign in through the Cursor agent CLI itself.",
			},
		],
		models: NO_MODELS,
		defaultModel: "",
		modelsAreSnapshot: false,
	},
	{
		id: "opencode",
		name: "opencode",
		description:
			"Detected so you can see whether it is installed. mfw cannot drive it yet.",
		bin: "opencode",
		versionArgs: ["--version"],
		drivable: false,
		unsupportedReason:
			"No mfw adapter: its output is not the stream-json protocol the daemon's only driver parses.",
		auth: [
			{
				kind: "api-key",
				credentialId: "opencode",
				envVars: ["OPENCODE_API_KEY"],
				hint: "Configure a provider inside opencode itself.",
			},
		],
		models: NO_MODELS,
		defaultModel: "",
		modelsAreSnapshot: false,
	},
];

/** The id a project gets when it has never been configured. */
export const DEFAULT_PROVIDER_ID = "claude-cli";

export function findProvider(id: string): ProviderEntry | undefined {
	return PROVIDER_CATALOGUE.find((p) => p.id === id);
}

/** The catalogue's model for a provider's tier, or undefined for an unknown provider or one with no tiers. */
export function tierModel(
	providerId: string,
	tier: ModelTier,
): string | undefined {
	return findProvider(providerId)?.tiers?.[tier];
}

/** The subset a picker may actually offer as a project's provider. */
export function drivableProviders(): ProviderEntry[] {
	return PROVIDER_CATALOGUE.filter((p) => p.drivable);
}

/** Credential ids any catalogue entry knows how to use. */
export function catalogueCredentialIds(): string[] {
	const ids = new Set<string>();
	for (const p of PROVIDER_CATALOGUE) {
		for (const a of p.auth) if (a.credentialId) ids.add(a.credentialId);
	}
	return [...ids].sort();
}

/** Resolve a stored provider id into runtime config. Throws for anything no adapter can run. */
export function providerConfigFor(
	id: string,
	env?: Record<string, string>,
): ProviderConfig {
	const entry = findProvider(id);
	if (!entry) {
		const known = drivableProviders()
			.map((p) => p.id)
			.join(", ");
		throw new Error(`unknown provider '${id}', mfw can run: ${known}`);
	}
	if (!entry.drivable || !entry.configType) {
		throw new Error(
			`provider '${id}' (${entry.name}) cannot be run by mfw: ${entry.unsupportedReason ?? "no adapter"}`,
		);
	}
	return { id: entry.id, type: entry.configType, ...(env ? { env } : {}) };
}
