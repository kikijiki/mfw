/**
 * What each harness may reach (design "Egress"), read from its manifest, which
 * also says why each entry is there and what was left out.
 *
 * Deny by default, exact host and port, no wildcards and no IP literals: the
 * manifest validation and then the proxy's allowlist refuse all of those.
 * Streaming and websockets use the same host as inference, inside the CONNECT
 * tunnel.
 */

import type { HarnessManifest } from "@mfw/plugin-api/harness";
import { builtinHarnessRegistry } from "@mfw/plugin-api/harness-registry";
import type { FleetCli } from "./agent-profile.ts";
import type { AllowEntry } from "./egress-policy.ts";

/** Every shipped entry says where it comes from, so the owner can check it. */
export type HarnessEgressEntry = HarnessManifest["egress"][number] & {
	source: string;
};
export type EgressPurpose = HarnessEgressEntry["purpose"];

export interface HarnessEgress {
	entries: readonly HarnessEgressEntry[];
	/** Set unless the owner opts in to telemetry. Names are on the sandbox env allowlist. */
	telemetryOffEnv: Readonly<Record<string, string>>;
}

function egressOf(cli: FleetCli): HarnessEgress {
	const m = builtinHarnessRegistry().byFleetCli(cli);
	const entries = m.egress.map((e) => {
		if (!e.source) throw new Error(`${m.id}: ${e.host} names no source`);
		return { ...e, source: e.source };
	});
	return { entries, telemetryOffEnv: m.telemetryOff?.env ?? {} };
}

export const HARNESS_EGRESS: Readonly<Record<FleetCli, HarnessEgress>> = {
	claude: egressOf("claude"),
	codex: egressOf("codex"),
};

export type EgressHarness = keyof typeof HARNESS_EGRESS;

export interface HarnessEgressOptions {
	/** Owner opt-in. Off by default. */
	telemetry?: boolean;
	/** The run authenticates with an API key; see {@link usesApiKeyAuth}. */
	apiKeyAuth?: boolean;
}

/**
 * Whether this run was launched with its harness's API key. Decided from the
 * names in the launch environment: mfw never reads the CLI's stored login, so
 * a key saved with the CLI's own login command does not count.
 */
export function usesApiKeyAuth(
	harness: EgressHarness,
	envNames: readonly string[],
): boolean {
	// Claude uses one host for both kinds of auth, so it declares no variable.
	const name = builtinHarnessRegistry().byFleetCli(harness).auth.apiKeyEnv;
	return name !== undefined && envNames.includes(name);
}

/** The exact `(host, port)` pairs a harness's run may reach. */
export function harnessAllowlist(
	harness: EgressHarness,
	opts: HarnessEgressOptions = {},
): (AllowEntry & { host: string; port: number })[] {
	return HARNESS_EGRESS[harness].entries
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
