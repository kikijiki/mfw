import type { HarnessDialect, HarnessManifest } from "@mfw/plugin-api/harness";
import { builtinHarnessRegistry } from "@mfw/plugin-api/harness-registry";
import type { ModelTier } from "../tasks/types.ts";
import type { ProviderConfig } from "./adapter.ts";
import {
	type BinaryIdentity,
	harnessBinaryIdentity,
} from "./agent-identity.ts";

/**
 * The agent-CLI catalogue: the harness manifests in the shape the settings,
 * routing and detection code reads.
 *
 * `drivable` is true only when a daemon adapter can run the CLI end to end
 * (Claude, Codex, and the ACP agents). Any other entry would be detected and
 * named in the UI as "found, not yet drivable". `AdapterRegistry.invocation`
 * throws for anything it cannot drive and `SettingsService` refuses to store
 * a non-drivable provider, so an entry cannot over-promise.
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
	 * happened. Presence only (never opened). First existing one wins.
	 */
	loginFiles?: readonly string[];
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
	/** Extra proof that a generically named `bin` on PATH is the CLI mfw means; a failed check reports the tool as not installed. */
	identity?: BinaryIdentity;
	/** True only when an adapter in this daemon can actually run it. */
	drivable: boolean;
	/** `ProviderConfig.type` this entry produces. Only set when drivable. */
	configType?: ProviderConfig["type"];
	/**
	 * True when the adapter can run on an OpenAI-compatible routing endpoint
	 * (Codex via model providers, opencode via an injected provider config).
	 * Cursor and Gemini CLI have no such mechanism.
	 */
	acceptsEndpoints?: boolean;
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

const CONFIG_TYPE: Readonly<Record<HarnessDialect, ProviderConfig["type"]>> = {
	"claude-stream-json": "claude-cli",
	"codex-app-server": "codex-cli",
	"codex-exec": "codex-cli",
	acp: "acp",
};

function providerEntry(m: HarnessManifest): ProviderEntry {
	const models = m.models;
	if (!models?.default) throw new Error(`${m.id}: no default model`);
	const identity = harnessBinaryIdentity(m.id);
	return {
		id: m.id,
		name: m.displayName,
		description: m.description,
		bin: m.detect.bin,
		versionArgs: m.detect.versionArgs,
		...(identity ? { identity } : {}),
		// Every manifest names a dialect, and each dialect has a core bridge.
		drivable: true,
		configType: CONFIG_TYPE[m.dialect],
		...(m.acceptsEndpoints ? { acceptsEndpoints: true } : {}),
		auth: m.auth.methods,
		models: models.choices,
		defaultModel: models.default,
		modelsAreSnapshot: models.isSnapshot,
		...(m.docsUrl ? { docsUrl: m.docsUrl } : {}),
		...(models.tiers ? { tiers: models.tiers } : {}),
	};
}

export const PROVIDER_CATALOGUE: readonly ProviderEntry[] =
	builtinHarnessRegistry().list().map(providerEntry);

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
