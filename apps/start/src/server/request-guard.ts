/**
 * Host and Origin checks for every HTTP route the app serves (tRPC, which also
 * carries SSE, and the raw file routes). They stop DNS rebinding and
 * cross-site requests from a browser on the owner's machine. They are not
 * authentication: `auth-guard.ts` runs this first, then requires a session.
 *
 * Rules:
 * - The `Host` must be a loopback name or IP (`localhost`, `127.0.0.1`,
 *   `[::1]`, any port) or listed in `MFW_ALLOWED_HOSTS`. Names that merely
 *   resolve to loopback (`127.0.0.1.nip.io`) are not loopback names.
 * - A present `Origin` must be same-origin with the `Host`: same authority,
 *   and an allowed one. This also refuses another local app on a different
 *   port. `Origin: null` is refused.
 * - A state-changing request marked `Sec-Fetch-Site: cross-site` is refused.
 * - A request with no `Origin` (curl, a non-browser client) passes this check
 *   on the Host alone, and still needs a session from `auth-guard.ts`.
 *
 * - Forwarded headers count only from a peer in `MFW_TRUSTED_PROXIES`
 *   (`trusted-proxy.ts`). They then define the external host and scheme.
 * - A non-loopback peer or Host needs TLS: the server's own, or a trusted proxy.
 *
 * `MFW_ALLOWED_HOSTS` is a comma or space separated list of exact `host` or
 * `host:port` entries. On a direct TLS listener a bare host matches any port.
 * Through a proxy it means the default HTTPS port only.
 */

import {
	type Authority,
	bindIsExposed,
	hasNativeTls,
	parseAllowedHosts,
	parseAuthority,
} from "./exposure";
import {
	isLoopbackAddress,
	isUnixPeer,
	parseTrustedProxies,
	resolveForwarded,
} from "./trusted-proxy";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const FIX =
	"Open the app through localhost or 127.0.0.1, or add this host to MFW_ALLOWED_HOSTS (comma separated, for example MFW_ALLOWED_HOSTS=mybox.tail1234.ts.net:8443, with the port unless it is 443) and restart the server.";

const PROXY_FIX =
	"Reach it through a TLS proxy named in MFW_TRUSTED_PROXIES, or configure TLS on the server.";

function isAllowed(a: Authority, extra: Authority[]): boolean {
	if (LOOPBACK.has(a.host)) return true;
	return extra.some(
		(e) => e.host === a.host && (e.port === null || e.port === a.port),
	);
}

/** The HTTPS default port is the same origin as no port. */
const withoutDefaultPort = (a: Authority): Authority =>
	a.port === "443" ? { host: a.host, port: null } : a;

/**
 * A proxied host must be listed exactly, port included: a bare entry means the
 * default HTTPS port only, because a sibling port is a different origin.
 */
function isListedExactly(a: Authority, extra: Authority[]): boolean {
	const wanted = withoutDefaultPort(a);
	return extra.some((entry) => {
		const e = withoutDefaultPort(entry);
		return e.host === wanted.host && e.port === wanted.port;
	});
}

export interface RequestContext {
	/** The socket peer, as the server adapter reports it. */
	peer: string | undefined;
	/** The forwarded client when a trusted proxy spoke for it, else the peer. */
	client: string | undefined;
	proxied: boolean;
	/** The scheme the browser used. */
	scheme: "http:" | "https:";
	/** The external authority: forwarded from a trusted proxy, else `Host`. */
	authority: Authority | null;
	authorityRaw: string | null;
	/** Forwarded headers from a trusted peer that could not be used. */
	refusal: string | null;
}

const contexts = new WeakMap<
	Request,
	{ env: Record<string, string | undefined>; context: RequestContext }
>();

function computeContext(
	req: Request,
	env: Record<string, string | undefined>,
): RequestContext {
	const ip = (req as Request & { ip?: unknown }).ip;
	const peer = typeof ip === "string" ? ip : undefined;
	const viaUnix = isUnixPeer(req);
	const forwarded = resolveForwarded(
		req.headers,
		peer,
		parseTrustedProxies(env.MFW_TRUSTED_PROXIES).proxies,
		viaUnix,
	);
	let url: URL | null = null;
	try {
		url = new URL(req.url);
	} catch {
		url = null;
	}
	const hostHeader = req.headers.get("host") ?? url?.host ?? null;
	if (forwarded.kind === "proxied") {
		const authorityRaw = forwarded.host ?? hostHeader;
		// Exact names only: the general parser folds a trailing dot away.
		const parsed = /\.(:\d+)?$/.test(authorityRaw ?? "")
			? null
			: parseAuthority(authorityRaw);
		return {
			peer,
			client: forwarded.client,
			proxied: true,
			scheme: "https:",
			authority: parsed && withoutDefaultPort(parsed),
			authorityRaw,
			refusal: null,
		};
	}
	return {
		peer,
		client: peer,
		proxied: false,
		scheme: url?.protocol === "https:" ? "https:" : "http:",
		authority: parseAuthority(hostHeader),
		authorityRaw: hostHeader,
		refusal:
			forwarded.kind === "invalid"
				? `bad forwarded headers from the proxy: ${forwarded.reason}`
				: viaUnix
					? "the private socket only serves its proxy, which must send forwarded headers"
					: null,
	};
}

/** The request as the browser made it. Computed once per request and env. */
export function requestContext(
	req: Request,
	env?: Record<string, string | undefined>,
): RequestContext {
	const known = contexts.get(req);
	if (known && (env === undefined || known.env === env)) return known.context;
	const used = env ?? process.env;
	const context = computeContext(req, used);
	contexts.set(req, { env: used, context });
	return context;
}

export function refuse(reason: string): Response {
	return new Response(`mfw-request-refused: ${reason}\n${FIX}\n`, {
		status: 403,
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"X-Mfw-Guard": "refused",
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": "no-store",
		},
	});
}

/** Null when the request may proceed, else the 403 to return. */
export function checkRequest(
	req: Request,
	env: Record<string, string | undefined> = process.env,
): Response | null {
	const extra = parseAllowedHosts(env.MFW_ALLOWED_HOSTS).hosts;
	const context = requestContext(req, env);
	if (context.refusal) return refuse(context.refusal);

	const hostRaw = context.authorityRaw;
	const host = context.authority;
	if (!host) return refuse("missing or malformed Host header");
	if (context.proxied) {
		if (!isListedExactly(host, extra))
			return refuse(`forwarded host '${hostRaw}' is not listed exactly`);
	} else {
		if (!isAllowed(host, extra))
			return refuse(`Host '${hostRaw}' is not allowed`);
		// An unknown peer counts as remote whenever the listener can be reached
		// from elsewhere. A loopback name is only ever honoured from loopback.
		const local = context.peer
			? isLoopbackAddress(context.peer)
			: !bindIsExposed(env);
		const tls = hasNativeTls(env);
		if (!local && (!tls || LOOPBACK.has(host.host)))
			return refuse(`direct request from a non-loopback peer. ${PROXY_FIX}`);
		if (!tls && !LOOPBACK.has(host.host))
			return refuse(`Host '${hostRaw}' needs TLS. ${PROXY_FIX}`);
	}

	const origin = req.headers.get("origin");
	if (origin !== null) {
		let originAuthority: Authority | null = null;
		try {
			const u = new URL(origin);
			if (u.protocol === "http:" || u.protocol === "https:")
				originAuthority = parseAuthority(u.host);
		} catch {
			originAuthority = null;
		}
		if (!originAuthority) return refuse(`Origin '${origin}' is not valid`);
		if (!isAllowed(originAuthority, extra))
			return refuse(`Origin '${origin}' is not allowed`);
		// Compare ports too: another local app on a different port is cross-origin.
		if (
			originAuthority.host !== host.host ||
			originAuthority.port !== host.port
		)
			return refuse(`Origin '${origin}' does not match Host '${hostRaw}'`);
		if (new URL(origin).protocol !== context.scheme)
			return refuse(`Origin '${origin}' has the wrong scheme`);
	}

	if (
		!SAFE_METHODS.has(req.method.toUpperCase()) &&
		req.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site"
	)
		return refuse("cross-site state-changing request");

	return null;
}
