import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
	ipLiteral,
	isLoopbackAddress,
	parseTrustedProxies,
	trustsLoopback,
} from "./trusted-proxy";

/**
 * What this server may be exposed to, decided from configuration alone. A
 * listener beyond loopback needs TLS, either its own or from a named trusted
 * proxy. There is deliberately no override: the fix is always to bind loopback
 * or to configure TLS.
 */

type Env = Record<string, string | undefined>;

export type Authority = { host: string; port: string | null };

const AUTHORITY = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?$/;
const WILDCARD_BINDS = new Set(["0.0.0.0", "::", "[::]", "*", "0"]);

export function parseAuthority(
	raw: string | null | undefined,
): Authority | null {
	if (!raw) return null;
	const m = AUTHORITY.exec(raw.trim().toLowerCase());
	if (!m) return null;
	let host = m[1] as string;
	if (host.endsWith(".") && !host.startsWith("[")) host = host.slice(0, -1);
	if (!host || host.startsWith(".") || host.includes("..")) return null;
	const port = m[2] ?? null;
	if (port !== null && (Number(port) < 1 || Number(port) > 65535)) return null;
	return { host, port };
}

/**
 * `MFW_ALLOWED_HOSTS`: exact `host` or `host:port` entries. Wildcards and
 * leading-dot suffixes are errors rather than ignored, so a mistaken entry
 * stops the server instead of silently meaning something else.
 */
export function parseAllowedHosts(value: string | undefined): {
	hosts: Authority[];
	errors: string[];
} {
	const hosts: Authority[] = [];
	const errors: string[] = [];
	for (const entry of (value ?? "").split(/[\s,]+/)) {
		if (!entry) continue;
		const authority = parseAuthority(entry);
		if (authority && !WILDCARD_BINDS.has(authority.host)) hosts.push(authority);
		else errors.push(entry);
	}
	return { hosts, errors };
}

/** The address the Bun server binds: the same precedence as its runtime. */
export const bindHost = (env: Env): string | undefined =>
	env.NITRO_HOST || env.HOST || undefined;

export const hasNativeTls = (env: Env): boolean =>
	!!env.NITRO_SSL_CERT && !!env.NITRO_SSL_KEY;

/** Only the exact name and canonical literals: anything else may resolve elsewhere. */
function isLoopbackBind(host: string): boolean {
	if (host === "localhost") return true;
	return ipLiteral(host)?.canonical === true && isLoopbackAddress(host);
}

/** True when this listener can be reached from beyond loopback. */
export function bindIsExposed(env: Env): boolean {
	const host = bindHost(env);
	return host !== undefined && !isLoopbackBind(host);
}

const BIND_FIX =
	"Fix: set HOST=127.0.0.1 and publish it through a TLS proxy on a private socket (MFW_LISTEN_SOCKET, with MFW_ALLOWED_HOSTS=<its exact name>), or name a remote proxy in MFW_TRUSTED_PROXIES. See docs/exposure.md.";

/** Longest path a Linux unix socket can bind (`sun_path` less its NUL). */
const MAX_SOCKET_PATH = 107;

export const homeFor = (env: Env): string =>
	env.MFW_HOME ?? join(homedir(), ".local", "share", "mfw");

/**
 * The socket must sit in a subdirectory of `$MFW_HOME`: that is the one tree
 * every sandbox masks, and agents share this uid, so anywhere else they could
 * connect and speak as the proxy.
 */
function socketPathError(path: string, home: string): string | null {
	if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0"))
		return "must be a normalized absolute path";
	if (Buffer.byteLength(path) > MAX_SOCKET_PATH)
		return `is longer than ${MAX_SOCKET_PATH} bytes`;
	const parts = relative(resolve(home), path).split(sep);
	if (parts[0] === ".." || parts.length < 2 || isAbsolute(parts.join(sep)))
		return "must be in a subdirectory of MFW_HOME, which sandboxes cannot see";
	return null;
}

/** Safe to run, but the owner must know. Printed at start-up. */
export function exposureWarnings(env: Env): string[] {
	if (!trustsLoopback(parseTrustedProxies(env.MFW_TRUSTED_PROXIES).proxies))
		return [];
	return [
		"MFW_TRUSTED_PROXIES trusts a loopback address: ANY LOCAL PROCESS, including a sandboxed agent that shares host loopback, can forge client addresses, evade per-client sign-in limits and slow the owner's sign-in until agents get their own network namespace. Use MFW_LISTEN_SOCKET instead (docs/exposure.md).",
	];
}

/** Null when the configuration is safe to serve, else why it is not and the fix. */
export function checkExposure(env: Env): string | null {
	const proxies = parseTrustedProxies(env.MFW_TRUSTED_PROXIES);
	if (proxies.errors.length)
		return `MFW_TRUSTED_PROXIES has invalid entries: ${proxies.errors.join(", ")}. Fix: use exact addresses or CIDRs no wider than /8 (IPv4) or /32 (IPv6).`;
	const allowed = parseAllowedHosts(env.MFW_ALLOWED_HOSTS);
	if (allowed.errors.length)
		return `MFW_ALLOWED_HOSTS has invalid entries: ${allowed.errors.join(", ")}. Fix: list exact names as host or host:port, with no wildcards or leading dots.`;
	if (!!env.NITRO_SSL_CERT !== !!env.NITRO_SSL_KEY)
		return "TLS is half configured. Fix: set both NITRO_SSL_CERT and NITRO_SSL_KEY, or neither.";
	if (env.MFW_LISTEN_SOCKET) {
		const why = socketPathError(env.MFW_LISTEN_SOCKET, homeFor(env));
		if (why)
			return `MFW_LISTEN_SOCKET ${why}. Fix: use a path such as $MFW_HOME/serve/mfw.sock.`;
		if (allowed.hosts.length === 0)
			return "MFW_LISTEN_SOCKET needs the proxy's exact external name. Fix: set MFW_ALLOWED_HOSTS=<host:port>.";
	}

	const host = bindHost(env);
	if (host === undefined)
		return `HOST is not set, so the server would listen on every interface. ${BIND_FIX}`;
	const literal = ipLiteral(host);
	if (literal?.unspecified)
		return `HOST=${host} listens on every interface, which mfw never does. ${BIND_FIX}`;
	if (host !== "localhost" && !literal?.canonical)
		return `HOST=${host} is not 'localhost' or a canonical IP address. ${BIND_FIX}`;
	if (isLoopbackBind(host) || hasNativeTls(env)) return null;
	if (proxies.proxies.length > 0 && allowed.hosts.length > 0) return null;
	return `HOST=${host} is not loopback and has no TLS. ${BIND_FIX}`;
}
