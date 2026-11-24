import {
	type AuthenticatedSession,
	type AuthService,
	authServiceFor,
	SESSION_ABSOLUTE_MS,
	type TokenPrincipal,
} from "@mfw/daemon/auth/service";
import { type BearerHeader, parseBearer } from "@mfw/daemon/auth/tokens";
import { mfwHome } from "@mfw/daemon/config";
import { relativePath } from "../lib/auth-paths";
import { checkRequest, requestContext } from "./request-guard";

/**
 * The session-aware front of every request: Host and Origin first
 * (`request-guard.ts`), then the session, then the per-session request key for
 * every API call and every non-safe method. The cookie alone only opens the
 * page shell, which carries no data: cookies are shared across localhost ports.
 *
 * It fails closed. A path is public only if `isPublicPath` names it, so a new
 * route is private without anyone remembering to protect it. There is no
 * development bypass: auth is always on, including on loopback.
 */

export const REQUEST_KEY_HEADER = "x-mfw-key";
const COOKIE_PLAIN = "mfw_session";
/** Browsers accept this name only with `Secure`, so plain HTTP cannot plant it. */
const COOKIE_TLS = "__Secure-mfw_session";

const SAFE_METHODS = new Set(["GET", "HEAD"]);
/**
 * One flat file name: no slash, no percent-encoding, nothing to traverse with.
 * The static handler serves real assets before the app runs, so one that gets
 * here does not exist.
 */
const ASSET = /^assets\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Exact paths (relative to the base) reachable without a session. */
const PUBLIC_PATHS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["login", SAFE_METHODS],
	["icon.svg", SAFE_METHODS],
	["api/health", SAFE_METHODS],
	["api/auth/state", SAFE_METHODS],
	["api/auth/setup", new Set(["POST"])],
	["api/auth/login", new Set(["POST"])],
	["api/auth/passkey-login-options", new Set(["POST"])],
	["api/auth/passkey-login", new Set(["POST"])],
]);

export function isPublicPath(rel: string | null, method: string): boolean {
	if (rel === null) return false;
	const m = method.toUpperCase();
	return PUBLIC_PATHS.get(rel)?.has(m) === true;
}

/** The app's base path, always with a trailing slash. */
export function appBase(): string {
	const raw = import.meta.env?.BASE_URL ?? "/";
	return `/${raw}/`.replace(/\/{2,}/g, "/");
}

/**
 * TLS as the browser sees it: this server's own, or reported by a peer named in
 * `MFW_TRUSTED_PROXIES`. `X-Forwarded-Proto` from anyone else means nothing.
 */
export function isTls(req: Request): boolean {
	return requestContext(req).scheme === "https:";
}

/** How many values of the session cookie are considered. */
const MAX_SESSION_COOKIES = 8;

/**
 * Every well-formed value of the session cookie, best candidate first. Another
 * localhost port can plant a cookie with this name on a longer Path, and
 * browsers send longer Paths first, so the real one comes LAST: reading from
 * the end means a pile of planted cookies cannot push it past the cap.
 */
export function readSessionTokens(req: Request): string[] {
	const name = isTls(req) ? COOKIE_TLS : COOKIE_PLAIN;
	const values: string[] = [];
	for (const part of (req.headers.get("cookie") ?? "").split(";")) {
		const at = part.indexOf("=");
		if (at <= 0 || part.slice(0, at).trim() !== name) continue;
		const value = part.slice(at + 1).trim();
		if (/^[A-Za-z0-9_-]{32,128}$/.test(value)) values.push(value);
	}
	return [...new Set(values.reverse())].slice(0, MAX_SESSION_COOKIES);
}

/** The value that authenticates and matches the key, else one that authenticates. */
async function resolveSession(
	auth: AuthService,
	tokens: readonly string[],
	key: string | null,
): Promise<{
	session: AuthenticatedSession | null;
	token: string | null;
	keyValid: boolean;
}> {
	let cookieOnly: { session: AuthenticatedSession; token: string } | null =
		null;
	for (const token of tokens) {
		const session = await auth.authenticate(token);
		if (!session) continue;
		if (auth.checkRequestKey(session, key))
			return { session, token, keyValid: true };
		cookieOnly ??= { session, token };
	}
	return cookieOnly
		? { ...cookieOnly, keyValid: false }
		: { session: null, token: null, keyValid: false };
}

function cookieAttributes(req: Request, base: string): string {
	const path = base === "/" ? "/" : base.replace(/\/$/, "");
	return `Path=${path}; HttpOnly; SameSite=Strict${isTls(req) ? "; Secure" : ""}`;
}

export function sessionCookie(
	req: Request,
	token: string,
	base: string,
): string {
	const name = isTls(req) ? COOKIE_TLS : COOKIE_PLAIN;
	const maxAge = Math.floor(SESSION_ABSOLUTE_MS / 1000);
	return `${name}=${token}; ${cookieAttributes(req, base)}; Max-Age=${maxAge}`;
}

export function clearSessionCookie(req: Request, base: string): string {
	const name = isTls(req) ? COOKIE_TLS : COOKIE_PLAIN;
	return `${name}=; ${cookieAttributes(req, base)}; Max-Age=0`;
}

/**
 * Deletions for shadow cookies a sibling port may have planted: one per Path a
 * request to this app can match, except the session's own. A browser removes a
 * cookie only when name and Path both match.
 */
export function shadowCookieClears(req: Request, base: string): string[] {
	const name = isTls(req) ? COOKIE_TLS : COOKIE_PLAIN;
	const root = base.replace(/\/$/, "");
	const own = root || "/";
	const paths = new Set(["/", root, `${root}/`]);
	for (const sub of [
		"api",
		"api/",
		"api/auth",
		"api/trpc",
		"api/files",
		"api/docs",
		"api/attachments",
		"login",
		"settings",
		"p",
	])
		paths.add(`${root}/${sub}`);
	paths.delete("");
	paths.delete(own);
	const secure = isTls(req) ? "; Secure" : "";
	return [...paths].map(
		(path) =>
			`${name}=; Path=${path}; HttpOnly; SameSite=Strict${secure}; Max-Age=0`,
	);
}

/** Add Set-Cookie headers; each must stay a separate header. */
export function withCookies(
	res: Response,
	cookies: readonly string[],
): Response {
	for (const cookie of cookies) res.headers.append("Set-Cookie", cookie);
	return res;
}

export function jsonResponse(
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
			...headers,
		},
	});
}

function unauthenticated(
	req: Request,
	url: URL,
	rel: string | null,
	base: string,
): Response {
	const isPage =
		SAFE_METHODS.has(req.method.toUpperCase()) &&
		rel !== null &&
		!rel.startsWith("api/") &&
		!rel.startsWith("_serverFn") &&
		(req.headers.get("accept") ?? "").includes("text/html");
	if (isPage) {
		const next = encodeURIComponent(`${url.pathname}${url.search}`);
		return new Response(null, {
			status: 302,
			headers: {
				Location: `${base}login?next=${next}`,
				"Cache-Control": "no-store",
			},
		});
	}
	return jsonResponse(401, {
		error: "unauthenticated",
		message: "sign in to use the mfw API",
	});
}

export type GuardResult =
	| {
			ok: true;
			session: AuthenticatedSession | null;
			token: string | null;
			/** The request carried this session's request key. */
			keyValid: boolean;
			/** A verified API token. Then `session` is null: cookies were not read. */
			apiToken?: TokenPrincipal;
	  }
	| { ok: false; response: Response };

export interface GuardDeps {
	auth: AuthService;
	base?: string;
	env?: Record<string, string | undefined>;
	/**
	 * The caller is an API handler, so the key is required whatever the path
	 * looks like (the router also matches spellings such as `/API/...`).
	 */
	api?: boolean;
	/** This handler serves API tokens. Only the tRPC mount sets it. */
	bearer?: boolean;
	/**
	 * Charge this request to the token's rate limit (default). The app-wide
	 * middleware passes false: the route handler guards the same request again
	 * and is the one that charges it.
	 */
	chargeRate?: boolean;
}

/**
 * A request presenting `Authorization: Bearer` is a token request and nothing
 * else: it never falls back to a cookie, so a bad token cannot ride on a
 * session and a good one cannot pick up the owner's rights. Host, Origin and
 * Sec-Fetch-Site have already been checked, so a browser page on another
 * origin is refused here even with a valid token.
 */
async function guardBearer(
	bearer: Exclude<BearerHeader, { kind: "none" }>,
	deps: GuardDeps,
): Promise<GuardResult> {
	if (!deps.bearer)
		return {
			ok: false,
			response: jsonResponse(403, {
				error: "token_not_accepted",
				message: "API tokens are accepted on the tRPC API only",
			}),
		};
	const invalid = (): GuardResult => ({
		ok: false,
		response: jsonResponse(
			401,
			{
				error: "invalid_token",
				message: "unknown, expired or revoked API token",
			},
			{ "WWW-Authenticate": "Bearer" },
		),
	});
	if (bearer.kind === "malformed") return invalid();
	const apiToken = await deps.auth.authenticateToken(bearer.value);
	if (!apiToken) return invalid();
	const waitMs =
		deps.chargeRate === false ? 0 : deps.auth.takeTokenRate(apiToken.tokenId);
	if (waitMs > 0) {
		const retry = Math.ceil(waitMs / 1000);
		return {
			ok: false,
			response: jsonResponse(
				429,
				{
					error: "rate_limited",
					message: "too many requests for this token",
					retryAfterSeconds: retry,
				},
				{ "Retry-After": String(retry) },
			),
		};
	}
	return { ok: true, session: null, token: null, keyValid: false, apiToken };
}

function isApiPath(rel: string | null): boolean {
	if (rel === null) return false;
	const lower = rel.toLowerCase();
	return (
		lower === "api" || lower.startsWith("api/") || lower.startsWith("_serverfn")
	);
}

export async function guardRequest(
	req: Request,
	deps: GuardDeps,
): Promise<GuardResult> {
	const refused = checkRequest(req, deps.env ?? process.env);
	if (refused) return { ok: false, response: refused };

	const base = deps.base ?? appBase();
	const url = new URL(req.url);
	const rel = relativePath(url.pathname, base);
	if (
		rel !== null &&
		ASSET.test(rel) &&
		SAFE_METHODS.has(req.method.toUpperCase())
	)
		return {
			ok: false,
			response: jsonResponse(404, { error: "not_found", message: "not found" }),
		};
	const isApi = deps.api === true || isApiPath(rel);

	// Sibling localhost ports are "same-site", so SameSite does not stop them.
	const site = req.headers.get("sec-fetch-site")?.toLowerCase();
	if (isApi && (site === "same-site" || site === "cross-site"))
		return {
			ok: false,
			response: jsonResponse(403, {
				error: "cross_site",
				message: "the API only answers the app's own origin",
			}),
		};

	const bearer = parseBearer(req.headers.get("authorization"));
	// The health probe is public and reads no credential, so monitors may keep one set.
	if (
		bearer.kind !== "none" &&
		!(rel === "api/health" && SAFE_METHODS.has(req.method.toUpperCase()))
	)
		return guardBearer(bearer, deps);

	const { session, token, keyValid } = await resolveSession(
		deps.auth,
		readSessionTokens(req),
		req.headers.get(REQUEST_KEY_HEADER),
	);
	if (isPublicPath(rel, req.method))
		return { ok: true, session, token, keyValid };

	if (!session || !token)
		return { ok: false, response: unauthenticated(req, url, rel, base) };
	if ((isApi || !SAFE_METHODS.has(req.method.toUpperCase())) && !keyValid)
		return {
			ok: false,
			response: jsonResponse(403, {
				error: "request_key",
				message: "missing or invalid request key; sign in again",
			}),
		};
	return { ok: true, session, token, keyValid };
}

let override: Promise<AuthService> | null = null;

/** Tests inject a service over a temp dir, so they never open the real home. */
export function setServerAuth(auth: AuthService | null): void {
	override = auth ? Promise.resolve(auth) : null;
}

export function serverAuth(): Promise<AuthService> {
	return override ?? authServiceFor(mfwHome());
}

/** The guard with the server's own service. An auth failure is a refusal. */
export async function guard(
	req: Request,
	opts: { api?: boolean; bearer?: boolean; chargeRate?: boolean } = {},
): Promise<GuardResult> {
	try {
		return await guardRequest(req, { auth: await serverAuth(), ...opts });
	} catch (e) {
		console.error("[mfw] auth check failed:", (e as Error).message);
		return {
			ok: false,
			response: jsonResponse(503, {
				error: "auth_unavailable",
				message: "the auth store is unavailable",
			}),
		};
	}
}

/**
 * The app-wide middleware's guard. It admits a bearer token on the exact tRPC
 * mount only; the route handler then guards again and enforces the rest.
 */
export function guardAppRequest(req: Request): Promise<GuardResult> {
	const rel = relativePath(new URL(req.url).pathname, appBase());
	return rel?.startsWith("api/trpc/")
		? guard(req, { bearer: true, chargeRate: false })
		: guard(req);
}

/** For raw routes: null when a signed-in caller may proceed, else the refusal. */
export async function requireSession(req: Request): Promise<Response | null> {
	const result = await guard(req, { api: true });
	if (!result.ok) return result.response;
	if (!result.session)
		return jsonResponse(401, {
			error: "unauthenticated",
			message: "sign in to use the mfw API",
		});
	return null;
}
