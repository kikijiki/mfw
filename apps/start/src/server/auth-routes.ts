import {
	type AuthRefused,
	type AuthService,
	type AuthSource,
	isAuthRefused,
	type PasskeyChoice,
} from "@mfw/daemon/auth/service";
import {
	appBase,
	clearSessionCookie,
	type GuardResult,
	jsonResponse,
	sessionCookie,
	shadowCookieClears,
	withCookies,
} from "./auth-guard";
import { relyingPartyFor } from "./passkey-origin";
import { requestContext } from "./request-guard";

/**
 * `/api/auth/<action>`. The caller has already passed the guard. Setup and the
 * two sign-ins are public by necessity, so they also require a JSON body and a
 * custom header: a cross-site form cannot send either without a CORS
 * preflight, which this server never answers (login CSRF).
 */

/**
 * Every action this handler answers, and who may call it. `public` ones must
 * match `isPublicPath`; the rest need a session and its request key, which the
 * guard enforces before this handler runs. A test holds the two equal.
 */
export const AUTH_ACTIONS: Readonly<
	Record<string, { access: "public" | "session"; methods: readonly string[] }>
> = {
	state: { access: "public", methods: ["GET", "HEAD"] },
	setup: { access: "public", methods: ["POST"] },
	login: { access: "public", methods: ["POST"] },
	"passkey-login-options": { access: "public", methods: ["POST"] },
	"passkey-login": { access: "public", methods: ["POST"] },
	logout: { access: "session", methods: ["POST"] },
	"sign-out-everywhere": { access: "session", methods: ["POST"] },
	password: { access: "session", methods: ["POST"] },
	tokens: { access: "session", methods: ["GET", "POST"] },
	"token-revoke": { access: "session", methods: ["POST"] },
	"token-audit": { access: "session", methods: ["GET"] },
	passkeys: { access: "session", methods: ["GET"] },
	"passkey-register-options": { access: "session", methods: ["POST"] },
	"passkey-register": { access: "session", methods: ["POST"] },
	"passkey-revoke": { access: "session", methods: ["POST"] },
	"passkey-notices": { access: "session", methods: ["GET"] },
	"passkey-notice-ack": { access: "session", methods: ["POST"] },
};

export const AUTH_INTENT_HEADER = "x-mfw-auth";
const MAX_BODY = 8 * 1024;

const STATUS: Record<AuthRefused["code"], number> = {
	setup_required: 409,
	already_set_up: 409,
	invalid_token: 401,
	invalid_password: 401,
	weak_password: 400,
	locked: 429,
	busy: 429,
	invalid_token_request: 400,
	too_many_tokens: 409,
	invalid_request: 400,
	session_ended: 401,
	passkey_refused: 401,
	passkey_unavailable: 400,
	too_many_passkeys: 409,
};

function refusal(e: AuthRefused): Response {
	const retry = Math.ceil(e.retryAfterMs / 1000);
	return jsonResponse(
		STATUS[e.code],
		{ error: e.code, message: e.message, retryAfterSeconds: retry },
		retry > 0 ? { "Retry-After": String(retry) } : {},
	);
}

/** The body as JSON, read with a hard cap whatever Content-Length claims. */
async function readJson(req: Request): Promise<Record<string, unknown> | null> {
	if (!req.body) return null;
	const reader = req.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_BODY) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	try {
		const parsed = JSON.parse(await new Blob(chunks as BlobPart[]).text());
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** The socket peer, as the server adapter reports it. Never a forwarded header. */
export function peerAddress(req: Request): string | undefined {
	const ip = (req as Request & { ip?: unknown }).ip;
	return typeof ip === "string" ? ip : undefined;
}

/**
 * Who a failed attempt counts against: the socket peer, or the client a trusted
 * proxy reported, marked so the service also charges the shared proxied budget.
 */
export function throttleIdentity(req: Request): AuthSource | undefined {
	const context = requestContext(req);
	if (context.proxied && context.client)
		return { address: context.client, viaProxy: true };
	return peerAddress(req);
}

/** A JSON body and a custom header: a cross-site form can send neither. */
function hasAuthIntent(req: Request): boolean {
	return (
		req.headers.get(AUTH_INTENT_HEADER) === "1" &&
		/^application\/json\b/i.test(req.headers.get("content-type") ?? "")
	);
}

/** The attached project names, or null when they cannot be read. */
async function projectNames(
	projects: (() => Promise<string[]>) | undefined,
): Promise<Set<string> | null> {
	if (!projects) return null;
	try {
		return new Set(await projects());
	} catch {
		return null;
	}
}

const badRequest = () =>
	jsonResponse(400, { error: "bad_request", message: "malformed request" });

/** A new session: the cookie, and the request key in the body (once). */
function signedIn(
	req: Request,
	issued: { token: string; requestKey: string },
	base: string,
): Response {
	return withCookies(
		jsonResponse(200, {
			state: "authenticated",
			requestKey: issued.requestKey,
		}),
		// The deletions first: the session cookie is the last word.
		[...shadowCookieClears(req, base), sessionCookie(req, issued.token, base)],
	);
}

const passkeyUnavailable = (message: string) =>
	jsonResponse(400, { error: "passkey_unavailable", message });

/** Passkey sign-in and management. Null when `action` is not one of them. */
async function handlePasskeyAction(
	action: string,
	method: string,
	req: Request,
	guarded: Extract<GuardResult, { ok: true }>,
	auth: AuthService,
	base: string,
	peer: AuthSource | undefined,
	env: Record<string, string | undefined>,
): Promise<Response | null> {
	if (!action.startsWith("passkey")) return null;
	const spec = AUTH_ACTIONS[action];
	if (!spec?.methods.includes(method))
		return jsonResponse(404, { error: "not_found", message: "not found" });
	const session = spec.access === "session" ? guarded.session : null;
	if (spec.access === "session" && !session)
		return jsonResponse(401, {
			error: "unauthenticated",
			message: "sign in to manage passkeys",
		});
	if (action === "passkeys")
		return jsonResponse(200, { passkeys: await auth.listPasskeys() });
	if (action === "passkey-notices")
		return jsonResponse(200, {
			notices: await auth.passkeyNotices(
				(session as NonNullable<typeof session>).sessionId,
			),
		});
	if (!hasAuthIntent(req)) return badRequest();
	const body = await readJson(req);
	if (!body) return badRequest();
	if (action === "passkey-revoke") {
		if (typeof body.id !== "string") return badRequest();
		return jsonResponse(200, {
			revoked: await auth.revokePasskey(body.id, {
				sessionId: (session as NonNullable<typeof session>).sessionId,
				source: peer,
			}),
		});
	}
	if (action === "passkey-notice-ack") {
		if (typeof body.id !== "number") return badRequest();
		return jsonResponse(200, {
			acknowledged: await auth.acknowledgePasskeyNotice(
				(session as NonNullable<typeof session>).sessionId,
				body.id,
			),
		});
	}
	const rp = relyingPartyFor(req, env);
	if ("error" in rp) return passkeyUnavailable(rp.error);
	try {
		switch (action) {
			case "passkey-login-options":
				return jsonResponse(200, await auth.beginPasskeyLogin(rp, peer));
			case "passkey-login":
				return signedIn(
					req,
					await auth.passkeyLogin(
						body.ceremonyId,
						body.credential,
						rp,
						guarded.token ?? undefined,
						peer,
					),
					base,
				);
			case "passkey-register-options": {
				// The password only: an existing passkey is not proof.
				if (typeof body.password !== "string") return badRequest();
				const proof = { password: body.password };
				return jsonResponse(
					200,
					await auth.beginPasskeyRegistration(
						(session as NonNullable<typeof session>).sessionId,
						rp,
						proof,
						peer,
					),
				);
			}
			case "passkey-register":
				return jsonResponse(200, {
					passkey: await auth.finishPasskeyRegistration(
						(session as NonNullable<typeof session>).sessionId,
						rp,
						body.ceremonyId,
						body.credential,
						body.name,
						peer,
					),
				});
		}
	} catch (e) {
		if (isAuthRefused(e)) return refusal(e);
		throw e;
	}
	return jsonResponse(404, { error: "not_found", message: "not found" });
}

export async function handleAuthAction(
	action: string,
	req: Request,
	guarded: Extract<GuardResult, { ok: true }>,
	auth: AuthService,
	base = appBase(),
	/** The throttle identity; injectable for tests. */
	peer: AuthSource | undefined = throttleIdentity(req),
	/** The attached projects, to validate a project-bound token. */
	projects?: () => Promise<string[]>,
	/** The server's settings, for the passkey origin (tests pass their own). */
	env: Record<string, string | undefined> = process.env,
): Promise<Response> {
	const method = req.method.toUpperCase();
	const passkey = await handlePasskeyAction(
		action,
		method,
		req,
		guarded,
		auth,
		base,
		peer,
		env,
	);
	if (passkey) return passkey;
	if (action === "state" && (method === "GET" || method === "HEAD")) {
		// A cookie without its key is not signed in, and the key is never echoed.
		if (guarded.keyValid) return jsonResponse(200, { state: "authenticated" });
		return jsonResponse(200, {
			state: (await auth.hasOwner()) ? "login" : "setup",
		});
	}

	if (action === "logout" && method === "POST") {
		if (guarded.token) await auth.logout(guarded.token);
		return withCookies(jsonResponse(200, { state: "login" }), [
			...shadowCookieClears(req, base),
			clearSessionCookie(req, base),
		]);
	}

	if (action === "sign-out-everywhere" && method === "POST") {
		await auth.revokeAll();
		return withCookies(jsonResponse(200, { state: "login" }), [
			...shadowCookieClears(req, base),
			clearSessionCookie(req, base),
		]);
	}

	if (action === "password" && method === "POST") {
		// Private path: the guard has already required the session and its key.
		if (!guarded.session)
			return jsonResponse(401, {
				error: "unauthenticated",
				message: "sign in to change the password",
			});
		if (!hasAuthIntent(req)) return badRequest();
		const body = await readJson(req);
		if (typeof body?.current !== "string" || typeof body.next !== "string")
			return badRequest();
		try {
			await auth.changePassword(
				body.current,
				body.next,
				guarded.session.sessionId,
				peer,
				// Absent means the default: delete every passkey.
				(body.passkeys ?? "revoke-all") as PasskeyChoice,
			);
			return jsonResponse(200, { ok: true });
		} catch (e) {
			if (isAuthRefused(e)) return refusal(e);
			throw e;
		}
	}

	// Token management: a private path, so the guard has required the session
	// and its request key. A bearer token never gets here (`guardBearer`).
	if (
		action === "tokens" ||
		action === "token-revoke" ||
		action === "token-audit"
	) {
		const session = guarded.session;
		if (!session)
			return jsonResponse(401, {
				error: "unauthenticated",
				message: "sign in to manage API tokens",
			});
		if (action === "tokens" && method === "GET") {
			const names = await projectNames(projects);
			const tokens = await auth.listTokens();
			return jsonResponse(200, {
				tokens: tokens.map((t) => ({
					...t,
					// It would gain access if a project of that name were attached later.
					unbound:
						names !== null && t.project !== null && !names.has(t.project),
				})),
			});
		}
		if (action === "token-audit")
			return method === "GET"
				? jsonResponse(200, {
						actions: await auth.listTokenAudit({ limit: 200 }),
						counters: await auth.tokenAuditCounters(),
					})
				: jsonResponse(404, { error: "not_found", message: "not found" });
		if (method !== "POST")
			return jsonResponse(404, { error: "not_found", message: "not found" });
		if (!hasAuthIntent(req)) return badRequest();
		const body = await readJson(req);
		if (!body) return badRequest();
		if (action === "token-revoke") {
			if (typeof body.id !== "string") return badRequest();
			return jsonResponse(200, { revoked: await auth.revokeToken(body.id) });
		}
		if (body.project !== undefined && body.project !== null) {
			const names = await projectNames(projects);
			if (typeof body.project !== "string" || !names?.has(body.project))
				return jsonResponse(400, {
					error: "invalid_token_request",
					message: "there is no project with that name",
				});
		}
		try {
			const { token, info } = await auth.createToken(
				{
					name: body.name,
					scopes: body.scopes,
					project: body.project,
					ttlMs: body.ttlMs,
				},
				{ sessionId: session.sessionId },
			);
			return jsonResponse(200, { token, info });
		} catch (e) {
			if (isAuthRefused(e)) return refusal(e);
			throw e;
		}
	}

	if ((action === "setup" || action === "login") && method === "POST") {
		if (!hasAuthIntent(req)) return badRequest();
		const body = await readJson(req);
		if (!body || typeof body.password !== "string") return badRequest();
		try {
			let issued: Awaited<ReturnType<AuthService["login"]>>;
			if (action === "setup") {
				if (typeof body.token !== "string") return badRequest();
				issued = await auth.setup(body.token.trim(), body.password, peer);
			} else {
				issued = await auth.login(
					body.password,
					guarded.token ?? undefined,
					peer,
				);
			}
			return signedIn(req, issued, base);
		} catch (e) {
			if (isAuthRefused(e)) return refusal(e);
			throw e;
		}
	}

	return jsonResponse(404, { error: "not_found", message: "not found" });
}
