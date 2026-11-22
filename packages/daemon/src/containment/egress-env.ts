/**
 * Client environment for a sandboxed run, pointing every proxy-aware client
 * at the in-sandbox relay (DESIGN "Egress", client env; the sandbox
 * experiments, E4).
 *
 * - Both cases of every variable: curl ignores an uppercase `HTTP_PROXY`, and
 *   with only `HTTPS_PROXY` set an http redirect would go direct.
 * - `NO_PROXY` and `no_proxy` are empty, so nothing (not even loopback names a
 *   client special-cases) bypasses the relay.
 * - `NODE_USE_ENV_PROXY=1`: with it Node 22 `https.get`/`request`,
 *   `http.request` and `fetch` use the proxy; without it they go direct and the
 *   netns fails them closed.
 *
 * Clients that ignore all of this still fail closed, because the sandbox has
 * no route out. The proxy allowlist is the gate.
 */

import { RELAY_HOST, RELAY_PORT } from "./egress-relay.ts";

export interface EgressEnvOptions {
	host?: string;
	port?: number;
}

/** The proxy URL clients should use. */
export function egressProxyUrl(opts: EgressEnvOptions = {}): string {
	return `http://${opts.host ?? RELAY_HOST}:${opts.port ?? RELAY_PORT}`;
}

/** Variables that must be set, in both cases, to the proxy URL. */
export const PROXY_VARS = [
	"https_proxy",
	"HTTPS_PROXY",
	"http_proxy",
	"HTTP_PROXY",
	"ALL_PROXY",
	"all_proxy",
] as const;

/** The env to add to the sandboxed process, over a minimal base env. */
export function egressClientEnv(
	opts: EgressEnvOptions = {},
): Record<string, string> {
	const url = egressProxyUrl(opts);
	const env: Record<string, string> = {};
	for (const name of PROXY_VARS) env[name] = url;
	env.NO_PROXY = "";
	env.no_proxy = "";
	env.NODE_USE_ENV_PROXY = "1";
	return env;
}
