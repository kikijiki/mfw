import {
	type AuthenticatedSession,
	type AuthService,
	authServiceFor,
	SESSION_ABSOLUTE_MS,
} from "@mfw/daemon/auth/service";
import { mfwHome } from "@mfw/daemon/config";
import { relativePath } from "../lib/auth-paths";
import { checkRequest } from "./request-guard";

/**
 * The session-aware front of every request: Host and Origin first
 * (`request-guard.ts`), then the session, then CSRF for anything that is not
 * a safe method.
 *
 * It fails closed. A path is public only if `isPublicPath` names it, so a new
 * route is private without anyone remembering to protect it. There is no
 * development bypass: auth is always on, including on loopback.
 */

export const CSRF_HEADER = "x-mfw-csrf";
const COOKIE_PLAIN = "mfw_session";
/** Browsers accept this name only with `Secure`, so plain HTTP cannot plant it. */
const COOKIE_TLS = "__Secure-mfw_session";

const SAFE_METHODS = new Set(["GET", "HEAD"]);
/** One flat file name: no slash, no percent-encoding, nothing to traverse with. */
const ASSET = /^assets\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Exact paths (relative to the base) reachable without a session. */
const PUBLIC_PATHS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["login", SAFE_METHODS],
	["icon.svg", SAFE_METHODS],
	["api/health", SAFE_METHODS],
	["api/auth/state", SAFE_METHODS],
	["api/auth/setup", new Set(["POST"])],
	["api/auth/login", new Set(["POST"])],
]);

export function isPublicPath(rel: string | null, method: string): boolean {
	if (rel === null) return false;
	const m = method.toUpperCase();
	if (PUBLIC_PATHS.get(rel)?.has(m)) return true;
	return SAFE_METHODS.has(m) && ASSET.test(rel);
}

/** The app's base path, always with a trailing slash. */
export function appBase(): string {
	const raw = import.meta.env?.BASE_URL ?? "/";
	return `/${raw}/`.replace(/\/{2,}/g, "/");
}

/**
 * TLS as the browser sees it. A forged `X-Forwarded-Proto` can only make the
 * cookie stricter (`Secure`, which a plain-HTTP browser then refuses to store).
 */
export function isTls(req: Request): boolean {
	if (new URL(req.url).protocol === "https:") return true;
	const forwarded = req.headers.get("x-forwarded-proto");
	return forwarded?.split(",")[0]?.trim().toLowerCase() === "https";
}

export function readSessionToken(req: Request): string | null {
	const name = isTls(req) ? COOKIE_TLS : COOKIE_PLAIN;
	for (const part of (req.headers.get("cookie") ?? "").split(";")) {
		const at = part.indexOf("=");
		if (at > 0 && part.slice(0, at).trim() === name) {
			const value = part.slice(at + 1).trim();
			return /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : null;
		}
	}
	return null;
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
	  }
	| { ok: false; response: Response };

export interface GuardDeps {
	auth: AuthService;
	base?: string;
	env?: Record<string, string | undefined>;
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
	const token = readSessionToken(req);
	if (isPublicPath(rel, req.method)) {
		const session = await deps.auth.authenticate(token);
		return { ok: true, session, token: session ? token : null };
	}

	const session = await deps.auth.authenticate(token);
	if (!session || !token)
		return { ok: false, response: unauthenticated(req, url, rel, base) };
	if (
		!SAFE_METHODS.has(req.method.toUpperCase()) &&
		!deps.auth.checkCsrf(token, req.headers.get(CSRF_HEADER))
	)
		return {
			ok: false,
			response: jsonResponse(403, {
				error: "csrf",
				message: "missing or invalid CSRF token; reload the page",
			}),
		};
	return { ok: true, session, token };
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
export async function guard(req: Request): Promise<GuardResult> {
	try {
		return await guardRequest(req, { auth: await serverAuth() });
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

/** For raw routes: null when a signed-in caller may proceed, else the refusal. */
export async function requireSession(req: Request): Promise<Response | null> {
	const result = await guard(req);
	if (!result.ok) return result.response;
	if (!result.session)
		return jsonResponse(401, {
			error: "unauthenticated",
			message: "sign in to use the mfw API",
		});
	return null;
}
