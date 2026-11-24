import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService, type IssuedSession } from "@mfw/daemon/auth/service";
import { SoftAuthenticator } from "../../../../packages/daemon/test/support/soft-authenticator";
import { guardRequest, isPublicPath, REQUEST_KEY_HEADER } from "./auth-guard";
import {
	AUTH_ACTIONS,
	AUTH_INTENT_HEADER,
	handleAuthAction,
} from "./auth-routes";
import { relyingPartyFor } from "./passkey-origin";
import { requestContext } from "./request-guard";

const PASSWORD = "correct horse battery";
const ORIGIN = "http://localhost:7777";
const EXTERNAL = "box.tail1234.ts.net:8443";
const PROXY_ENV = {
	MFW_TRUSTED_PROXIES: "127.0.0.1",
	MFW_ALLOWED_HOSTS: EXTERNAL,
};

let dir: string;
let auth: AuthService;
let owner: IssuedSession;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "mfw-passkey-routes-"));
	auth = await AuthService.open(join(dir, "auth.db"), {
		passwordCheckIntervalMs: 0,
	});
	const token = (await auth.beginFirstRun()) as string;
	owner = await auth.setup(token, PASSWORD);
});

afterEach(() => {
	auth.close();
	rmSync(dir, { recursive: true, force: true });
});

interface Call {
	method?: string;
	body?: unknown;
	session?: { token: string; requestKey?: string } | null;
	headers?: Record<string, string>;
	env?: Record<string, string | undefined>;
	/** Scheme and authority the request is sent to. */
	base?: string;
	peer?: string;
}

async function call(action: string, c: Call = {}): Promise<Response> {
	const method = c.method ?? (c.body === undefined ? "GET" : "POST");
	const session = c.session === undefined ? owner : c.session;
	const req = new Request(`${c.base ?? ORIGIN}/api/auth/${action}`, {
		method,
		headers: {
			host: "localhost:7777",
			...(method === "POST"
				? { "content-type": "application/json", [AUTH_INTENT_HEADER]: "1" }
				: {}),
			...(session ? { cookie: `mfw_session=${session.token}` } : {}),
			...(session?.requestKey
				? { [REQUEST_KEY_HEADER]: session.requestKey }
				: {}),
			...c.headers,
		},
		...(c.body === undefined ? {} : { body: JSON.stringify(c.body) }),
	});
	if (c.peer) Object.defineProperty(req, "ip", { value: c.peer });
	const env = c.env ?? {};
	const guarded = await guardRequest(req, { auth, base: "/", env, api: true });
	if (!guarded.ok) return guarded.response;
	return handleAuthAction(
		action,
		req,
		guarded,
		auth,
		"/",
		c.peer,
		undefined,
		env,
	);
}

async function register(
	soft: SoftAuthenticator,
	c: Call = {},
): Promise<Response> {
	const options = await call("passkey-register-options", {
		...c,
		body: { password: PASSWORD },
	});
	expect(options.status).toBe(200);
	const begun = (await options.json()) as {
		ceremonyId: string;
		publicKey: Parameters<SoftAuthenticator["create"]>[0];
	};
	const { json } = soft.create(begun.publicKey);
	return call("passkey-register", {
		...c,
		body: { ceremonyId: begun.ceremonyId, credential: json, name: "laptop" },
	});
}

async function login(soft: SoftAuthenticator, c: Call = {}) {
	const options = await call("passkey-login-options", {
		...c,
		session: null,
		body: {},
	});
	expect(options.status).toBe(200);
	const begun = (await options.json()) as {
		ceremonyId: string;
		publicKey: Parameters<SoftAuthenticator["get"]>[0];
	};
	return call("passkey-login", {
		...c,
		session: null,
		body: {
			ceremonyId: begun.ceremonyId,
			credential: soft.get(begun.publicKey),
		},
	});
}

const cookieOf = (res: Response) =>
	res.headers
		.getSetCookie()
		.map((c) => /^mfw_session=([^;]+)/.exec(c)?.[1])
		.find((v) => !!v) as string;

describe("passkey sign-in over HTTP", () => {
	test("register from a session, then sign in with the same session shape", async () => {
		const soft = new SoftAuthenticator(ORIGIN);
		expect((await register(soft)).status).toBe(200);
		const listed = (await (await call("passkeys")).json()) as {
			passkeys: { name: string; lastUsedAt: number | null }[];
		};
		expect(listed.passkeys.map((p) => p.name)).toEqual(["laptop"]);

		const res = await login(soft);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { state: string; requestKey: string };
		expect(body.state).toBe("authenticated");
		const session = { token: cookieOf(res), requestKey: body.requestKey };
		expect(session.token).toBeString();
		// The new cookie and key read a private route, like a password session.
		expect((await call("passkeys", { session })).status).toBe(200);
		// The cookie alone is not enough.
		expect(
			(await call("passkeys", { session: { token: session.token } })).status,
		).toBe(403);
	});

	test("the public actions are exactly the guard's public paths", () => {
		for (const [action, spec] of Object.entries(AUTH_ACTIONS))
			for (const method of ["GET", "HEAD", "POST"])
				expect(isPublicPath(`api/auth/${action}`, method)).toBe(
					spec.access === "public" && spec.methods.includes(method),
				);
	});

	for (const [action, spec] of Object.entries(AUTH_ACTIONS).filter(
		([a, s]) => a.startsWith("passkey") && s.access === "session",
	))
		test(`${action}: needs a session, its key, and refuses tokens`, async () => {
			const method = spec.methods[0] as string;
			const body = method === "POST" ? {} : undefined;
			expect((await call(action, { method, body, session: null })).status).toBe(
				401,
			);
			expect(
				(
					await call(action, {
						method,
						body,
						session: { token: owner.token },
					})
				).status,
			).toBe(403);
			const { token } = await auth.createToken({
				name: "t",
				scopes: ["status:read", "board:read", "board:write", "runs:act"],
			});
			const bearer = await call(action, {
				method,
				body,
				session: null,
				headers: { authorization: `Bearer ${token}` },
			});
			expect(bearer.status).toBe(403);
		});

	test("posts need the auth intent header and JSON", async () => {
		const r = await call("passkey-login-options", {
			session: null,
			body: {},
			headers: { [AUTH_INTENT_HEADER]: "0" },
		});
		expect(r.status).toBe(400);
	});

	test("a foreign origin is refused before the handler", async () => {
		const r = await call("passkey-login-options", {
			session: null,
			body: {},
			headers: { origin: "https://evil.example" },
		});
		expect(r.status).toBe(403);
	});

	test("a bare IP origin cannot use passkeys", async () => {
		const r = await call("passkey-login-options", {
			base: "http://127.0.0.1:7777",
			session: null,
			body: {},
			headers: { host: "127.0.0.1:7777" },
		});
		expect(r.status).toBe(400);
		expect(((await r.json()) as { error: string }).error).toBe(
			"passkey_unavailable",
		);
	});

	test("registration without a password or a passkey proof is refused", async () => {
		expect((await call("passkey-register-options", { body: {} })).status).toBe(
			400,
		);
		const wrong = await call("passkey-register-options", {
			body: { password: "not it at all" },
		});
		expect(wrong.status).toBe(401);
		expect(((await wrong.json()) as { error: string }).error).toBe(
			"invalid_password",
		);
	});

	test("sign out everywhere over HTTP deletes every passkey, whatever the body says", async () => {
		const soft = new SoftAuthenticator(ORIGIN);
		await register(soft);
		const r = await call("sign-out-everywhere", {
			body: { keepPasskeys: true },
		});
		expect(r.status).toBe(200);
		expect(await auth.listPasskeys()).toEqual([]);
		expect((await login(soft)).status).toBe(401);
	});

	test("a password change over HTTP deletes passkeys unless told which to keep", async () => {
		const soft = new SoftAuthenticator(ORIGIN);
		await register(soft);
		await register(soft);
		const [keep] = await auth.listPasskeys();
		const kept = await call("password", {
			body: {
				current: PASSWORD,
				next: "a second long password",
				passkeys: [keep?.id],
			},
		});
		expect(kept.status).toBe(200);
		expect((await auth.listPasskeys()).map((p) => p.id)).toEqual([
			keep?.id as string,
		]);
		const bad = await call("password", {
			body: {
				current: "a second long password",
				next: "a third long password!",
				passkeys: "maybe",
			},
		});
		expect(bad.status).toBe(400);
		const plain = await call("password", {
			body: {
				current: "a second long password",
				next: "a third long password!",
			},
		});
		expect(plain.status).toBe(200);
		expect(await auth.listPasskeys()).toEqual([]);
	});

	test("revoke over HTTP ends that passkey's sessions", async () => {
		const soft = new SoftAuthenticator(ORIGIN);
		await register(soft);
		const res = await login(soft);
		const viaPasskey = {
			token: cookieOf(res),
			requestKey: ((await res.json()) as { requestKey: string }).requestKey,
		};
		const pk = (await auth.listPasskeys())[0] as { id: string };
		const revoked = await call("passkey-revoke", { body: { id: pk.id } });
		expect(await revoked.json()).toEqual({ revoked: true });
		expect((await call("passkeys", { session: viaPasskey })).status).toBe(401);
		expect((await login(soft)).status).toBe(401);
	});
});

describe("the RP comes from the trusted external origin", () => {
	const proxied = (extra: Record<string, string> = {}) => ({
		host: EXTERNAL,
		"x-forwarded-for": "100.64.0.9",
		"x-forwarded-proto": "https",
		"x-forwarded-host": EXTERNAL,
		...extra,
	});
	const req = (peer: string, headers: Record<string, string>) => {
		const r = new Request("http://127.0.0.1:7777/api/auth/x", { headers });
		Object.defineProperty(r, "ip", { value: peer });
		return r;
	};

	test("behind the trusted proxy: the forwarded HTTPS name", () => {
		const r = req("127.0.0.1", proxied());
		requestContext(r, PROXY_ENV);
		expect(relyingPartyFor(r, PROXY_ENV)).toEqual({
			rpId: "box.tail1234.ts.net",
			origin: "https://box.tail1234.ts.net:8443",
		});
	});

	test("direct loopback: localhost over HTTP, never 127.0.0.1", () => {
		const local = req("127.0.0.1", { host: "localhost:7777" });
		requestContext(local, {});
		expect(relyingPartyFor(local, {})).toEqual({
			rpId: "localhost",
			origin: "http://localhost:7777",
		});
		const ip = req("127.0.0.1", { host: "127.0.0.1:7777" });
		requestContext(ip, {});
		expect("error" in relyingPartyFor(ip, {})).toBe(true);
	});

	test("forwarded headers from an untrusted peer are not used", () => {
		const r = req("198.51.100.7", proxied({ host: "localhost:7777" }));
		requestContext(r, PROXY_ENV);
		// The forged name is ignored: what is left is the plain Host.
		expect(relyingPartyFor(r, PROXY_ENV)).toEqual({
			rpId: "localhost",
			origin: "http://localhost:7777",
		});
	});

	test("a name that is not listed is refused", () => {
		const r = req("127.0.0.1", proxied());
		requestContext(r, PROXY_ENV);
		expect("error" in relyingPartyFor(r, { MFW_ALLOWED_HOSTS: "" })).toBe(true);
	});

	test("full flow through the proxy", async () => {
		const soft = new SoftAuthenticator("https://box.tail1234.ts.net:8443");
		const through = {
			base: "http://127.0.0.1:7777",
			peer: "127.0.0.1",
			env: PROXY_ENV,
			headers: proxied(),
		};
		const cookieName = "__Secure-mfw_session";
		// Sign in by password through the proxy to get a TLS cookie.
		const pw = new Request("http://127.0.0.1:7777/api/auth/login", {
			method: "POST",
			headers: {
				...proxied(),
				"content-type": "application/json",
				[AUTH_INTENT_HEADER]: "1",
			},
			body: JSON.stringify({ password: PASSWORD }),
		});
		Object.defineProperty(pw, "ip", { value: "127.0.0.1" });
		const g = await guardRequest(pw, { auth, base: "/", env: PROXY_ENV });
		if (!g.ok) throw new Error("guard refused the proxied login");
		const signed = await handleAuthAction("login", pw, g, auth, "/");
		const key = ((await signed.json()) as { requestKey: string }).requestKey;
		const cookie = signed.headers
			.getSetCookie()
			.map((c) => new RegExp(`^${cookieName}=([^;]+)`).exec(c)?.[1])
			.find(Boolean) as string;
		const withSession = {
			...through,
			session: null,
			headers: {
				...proxied(),
				cookie: `${cookieName}=${cookie}`,
				[REQUEST_KEY_HEADER]: key,
			},
		};
		const options = await call("passkey-register-options", {
			...withSession,
			body: { password: PASSWORD },
		});
		expect(options.status).toBe(200);
		const begun = (await options.json()) as {
			ceremonyId: string;
			publicKey: Parameters<SoftAuthenticator["create"]>[0];
		};
		expect(begun.publicKey.rp.id).toBe("box.tail1234.ts.net");
		const { json } = soft.create(begun.publicKey);
		const done = await call("passkey-register", {
			...withSession,
			body: { ceremonyId: begun.ceremonyId, credential: json, name: "p" },
		});
		expect(done.status).toBe(200);
		const res = await login(soft, through);
		expect(res.status).toBe(200);
		expect(res.headers.getSetCookie().join("\n")).toContain(`${cookieName}=`);
		// The same credential is not accepted on the loopback origin.
		const local = await call("passkey-login-options", {
			session: null,
			body: {},
		});
		const lbegun = (await local.json()) as {
			ceremonyId: string;
			publicKey: { challenge: string; rpId: string };
		};
		const elsewhere = soft.get(
			{ ...lbegun.publicKey, rpId: "box.tail1234.ts.net" },
			{ clientData: { origin: ORIGIN } },
		);
		const refused = await call("passkey-login", {
			session: null,
			body: { ceremonyId: lbegun.ceremonyId, credential: elsewhere },
		});
		expect(refused.status).toBe(401);
	});
});
