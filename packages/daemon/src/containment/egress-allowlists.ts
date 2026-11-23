/**
 * What each harness may reach (design "Egress"). Hand-written from the sandbox
 * experiments and the vendors' network documentation, and held as data so the
 * harness manifests can replace this module.
 *
 * Deny by default, exact host and port, no wildcards and no IP literals: the
 * proxy's allowlist refuses all of those. Streaming and websockets use the same
 * host as inference, inside the CONNECT tunnel.
 *
 * Left out on purpose:
 * - `claude.ai`: account login, which the owner does outside a run. The
 *   vendor's documentation does not expect it at runtime with a stored login;
 * - `mcp-proxy.anthropic.com`: claude.ai connectors;
 * - plugin and update hosts, including the package registries and GitHub;
 * - `*.oaiusercontent.com`: optional for Codex in the experiments, and it has
 *   no exact host to list.
 */

import type { AllowEntry } from "./egress-policy.ts";

export type EgressPurpose = "inference" | "auth" | "telemetry";

export interface HarnessEgressEntry {
	host: string;
	port: number;
	purpose: EgressPurpose;
	/** Where the entry comes from, so the owner can check it. */
	source: string;
	/**
	 * Only for a run authenticating with an API key. An API host accepts any
	 * caller's key, so a subscription run reaching one has an upload channel to
	 * an account of the agent's choosing.
	 */
	requiresApiKey?: boolean;
}

export interface HarnessEgress {
	entries: readonly HarnessEgressEntry[];
	/** Set unless the owner opts in to telemetry. Names are on the sandbox env allowlist. */
	telemetryOffEnv: Readonly<Record<string, string>>;
}

const OBSERVED_CLAUDE =
	"observed: the only host an unauthenticated CLI contacted (2.1.330)";
const CLAUDE_DOCS = "vendor network configuration page; not observed";
const OBSERVED_CODEX = "observed: the only host three runs needed (0.170.0)";

export const HARNESS_EGRESS = {
	claude: {
		entries: [
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
		telemetryOffEnv: {
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			DISABLE_TELEMETRY: "1",
			DISABLE_ERROR_REPORTING: "1",
		},
	},
	codex: {
		entries: [
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
		telemetryOffEnv: {},
	},
} as const satisfies Record<string, HarnessEgress>;

export type EgressHarness = keyof typeof HARNESS_EGRESS;

export interface HarnessEgressOptions {
	/** Owner opt-in. Off by default. */
	telemetry?: boolean;
	/** The run authenticates with an API key; see {@link usesApiKeyAuth}. */
	apiKeyAuth?: boolean;
}

/** The variable that carries each harness's API key, when it uses one. */
const API_KEY_ENV: Readonly<Record<EgressHarness, string | null>> = {
	// Claude uses one host for both kinds of auth, so nothing depends on this.
	claude: null,
	codex: "OPENAI_API_KEY",
};

/**
 * Whether this run was launched with its harness's API key. Decided from the
 * names in the launch environment: mfw never reads the CLI's stored login, so
 * a key saved with the CLI's own login command does not count.
 */
export function usesApiKeyAuth(
	harness: EgressHarness,
	envNames: readonly string[],
): boolean {
	const name = API_KEY_ENV[harness];
	return name !== null && envNames.includes(name);
}

/** The exact `(host, port)` pairs a harness's run may reach. */
export function harnessAllowlist(
	harness: EgressHarness,
	opts: HarnessEgressOptions = {},
): (AllowEntry & { host: string; port: number })[] {
	const entries: readonly HarnessEgressEntry[] =
		HARNESS_EGRESS[harness].entries;
	return entries
		.filter((e) => opts.telemetry === true || e.purpose !== "telemetry")
		.filter((e) => opts.apiKeyAuth === true || e.requiresApiKey !== true)
		.map((e) => ({ host: e.host, port: e.port }));
}

/** The environment that matches the allowlist: telemetry off unless opted in. */
export function harnessEgressEnv(
	harness: EgressHarness,
	opts: HarnessEgressOptions = {},
): Record<string, string> {
	return opts.telemetry === true
		? {}
		: { ...HARNESS_EGRESS[harness].telemetryOffEnv };
}
