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
 * `MFW_ALLOWED_HOSTS` is a comma or space separated list of `host` or
 * `host:port` entries. A bare host matches any port, including none (a TLS
 * front such as `tailscale serve` sends the Host without a port).
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const AUTHORITY = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?$/;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const FIX =
	"Open the app through localhost or 127.0.0.1, or add this host to MFW_ALLOWED_HOSTS (comma separated, for example MFW_ALLOWED_HOSTS=mybox.tail1234.ts.net) and restart the server.";

type Authority = { host: string; port: string | null };

function parseAuthority(raw: string | null | undefined): Authority | null {
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

function parseAllowed(value: string | undefined): Authority[] {
	const out: Authority[] = [];
	for (const entry of (value ?? "").split(/[\s,]+/)) {
		if (!entry) continue;
		const a = parseAuthority(entry);
		if (a) out.push(a);
	}
	return out;
}

function isAllowed(a: Authority, extra: Authority[]): boolean {
	if (LOOPBACK.has(a.host)) return true;
	return extra.some(
		(e) => e.host === a.host && (e.port === null || e.port === a.port),
	);
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
	const extra = parseAllowed(env.MFW_ALLOWED_HOSTS);

	const hostHeader = req.headers.get("host");
	let hostRaw = hostHeader;
	if (hostRaw === null) {
		try {
			hostRaw = new URL(req.url).host;
		} catch {
			hostRaw = null;
		}
	}
	const host = parseAuthority(hostRaw);
	if (!host) return refuse("missing or malformed Host header");
	if (!isAllowed(host, extra))
		return refuse(`Host '${hostRaw}' is not allowed`);

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
	}

	if (
		!SAFE_METHODS.has(req.method.toUpperCase()) &&
		req.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site"
	)
		return refuse("cross-site state-changing request");

	return null;
}
