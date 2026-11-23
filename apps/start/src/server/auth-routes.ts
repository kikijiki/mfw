import {
	type AuthRefused,
	type AuthService,
	isAuthRefused,
} from "@mfw/daemon/auth/service";
import {
	appBase,
	clearSessionCookie,
	type GuardResult,
	jsonResponse,
	sessionCookie,
} from "./auth-guard";

/**
 * `/api/auth/{state,setup,login,logout}`. The caller has already passed the
 * guard. Setup and login are public by necessity, so they also require a JSON
 * body and a custom header: a cross-site form cannot send either without a
 * CORS preflight, which this server never answers (login CSRF).
 */

export const AUTH_INTENT_HEADER = "x-mfw-auth";
const MAX_BODY = 8 * 1024;

const STATUS: Record<AuthRefused["code"], number> = {
	setup_required: 409,
	already_set_up: 409,
	invalid_token: 401,
	invalid_password: 401,
	weak_password: 400,
	locked: 429,
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

/**
 * The socket peer, as the server adapter reports it. Forwarded headers are
 * deliberately ignored: any client can send them.
 * TODO(C4): honour the forwarded address only from the configured trusted proxy.
 */
export function peerAddress(req: Request): string | undefined {
	const ip = (req as Request & { ip?: unknown }).ip;
	return typeof ip === "string" ? ip : undefined;
}

/** A JSON body and a custom header: a cross-site form can send neither. */
function hasAuthIntent(req: Request): boolean {
	return (
		req.headers.get(AUTH_INTENT_HEADER) === "1" &&
		/^application\/json\b/i.test(req.headers.get("content-type") ?? "")
	);
}

const badRequest = () =>
	jsonResponse(400, { error: "bad_request", message: "malformed request" });

export async function handleAuthAction(
	action: string,
	req: Request,
	guarded: Extract<GuardResult, { ok: true }>,
	auth: AuthService,
	base = appBase(),
): Promise<Response> {
	const method = req.method.toUpperCase();
	if (action === "state" && (method === "GET" || method === "HEAD")) {
		// A cookie without its key is not signed in, and the key is never echoed.
		if (guarded.keyValid) return jsonResponse(200, { state: "authenticated" });
		return jsonResponse(200, {
			state: (await auth.hasOwner()) ? "login" : "setup",
		});
	}

	if (action === "logout" && method === "POST") {
		if (guarded.token) await auth.logout(guarded.token);
		return jsonResponse(
			200,
			{ state: "login" },
			{ "Set-Cookie": clearSessionCookie(req, base) },
		);
	}

	if (action === "sign-out-everywhere" && method === "POST") {
		await auth.revokeAll();
		return jsonResponse(
			200,
			{ state: "login" },
			{ "Set-Cookie": clearSessionCookie(req, base) },
		);
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
				peerAddress(req),
			);
			return jsonResponse(200, { ok: true });
		} catch (e) {
			if (isAuthRefused(e)) return refusal(e);
			throw e;
		}
	}

	if ((action === "setup" || action === "login") && method === "POST") {
		if (!hasAuthIntent(req)) return badRequest();
		const body = await readJson(req);
		if (!body || typeof body.password !== "string") return badRequest();
		const peer = peerAddress(req);
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
			return jsonResponse(
				200,
				{ state: "authenticated", requestKey: issued.requestKey },
				{ "Set-Cookie": sessionCookie(req, issued.token, base) },
			);
		} catch (e) {
			if (isAuthRefused(e)) return refusal(e);
			throw e;
		}
	}

	return jsonResponse(404, { error: "not_found", message: "not found" });
}
