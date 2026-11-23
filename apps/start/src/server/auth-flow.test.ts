import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService } from "@mfw/daemon/auth/service";
import type { Orchestrator } from "@mfw/daemon/services";
import { safeNext } from "../lib/auth-paths";
import { announceFirstRun } from "./auth-boot";
import { guardRequest, REQUEST_KEY_HEADER, sessionCookie } from "./auth-guard";
import {
	AUTH_INTENT_HEADER,
	handleAuthAction,
	peerAddress,
} from "./auth-routes";
import { serveTrpc } from "./trpc-handler";

const PASSWORD = "correct horse battery";
const ORIGIN = "http://localhost:7777";

let dir: string;
let auth: AuthService;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "mfw-flow-"));
	auth = await AuthService.open(join(dir, "auth.db"));
});

afterEach(() => {
	auth.close();
	rmSync(dir, { recursive: true, force: true });
});

async function action(
	name: string,
	body: unknown,
	headers: Record<string, string> = {},
	base = "/",
): Promise<Response> {
	const req = new Request(`${ORIGIN}${base}api/auth/${name}`, {
		method: "POST",
		headers: {
			host: "localhost:7777",
			"content-type": "application/json",
			[AUTH_INTENT_HEADER]: "1",
			...headers,
		},
		body: JSON.stringify(body),
	});
	const guarded = await guardRequest(req, { auth, base, env: {} });
	if (!guarded.ok) return guarded.response;
	return handleAuthAction(name, req, guarded, auth, base);
}

const cookieOf = (res: Response) =>
	(res.headers.get("set-cookie") ?? "").split(";")[0] as string;

describe("first run", () => {
	test("the token is printed once, and never once an owner exists", async () => {
		const lines: string[] = [];
		await announceFirstRun(auth, (l) => lines.push(l));
		const token = readFileSync(join(dir, "setup-token"), "utf8").trim();
		expect(token).toBeTruthy();
		expect((await action("setup", { token, password: PASSWORD })).status).toBe(
			200,
		);
		lines.length = 0;
		await announceFirstRun(auth, (l) => lines.push(l));
		expect(lines).toEqual([]);
	});
});

describe("the setup token never reaches a log (reviewer B3)", () => {
	test("only the path is printed; the token is in a 0600 file", async () => {
		const lines: string[] = [];
		await announceFirstRun(auth, (l) => lines.push(l));
		const file = join(dir, "setup-token");
		const token = readFileSync(file, "utf8").trim();
		expect(token.length).toBeGreaterThanOrEqual(43);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(lines.join("\n")).not.toContain(token);
		expect(lines.join("\n")).toContain(file);
		expect(lines.join("\n")).toContain("mfw auth setup-token");
	});

	test("the file goes away when setup completes", async () => {
		await announceFirstRun(auth, () => {});
		const file = join(dir, "setup-token");
		const token = readFileSync(file, "utf8").trim();
		await auth.setup(token, PASSWORD);
		expect(existsSync(file)).toBe(false);
	});
});

describe("cookies", () => {
	const issue = async (headers: Record<string, string>, base = "/") => {
		const token = (await auth.beginFirstRun()) as string;
		return action("setup", { token, password: PASSWORD }, headers, base);
	};

	test("HttpOnly and SameSite=Strict, not Secure on plain HTTP", async () => {
		const c = (await issue({})).headers.get("set-cookie") as string;
		expect(c).toStartWith("mfw_session=");
		expect(c).toContain("HttpOnly");
		expect(c).toContain("SameSite=Strict");
		expect(c).not.toContain("Secure");
		expect(c).toContain("Path=/;");
	});

	test("Secure with the __Secure- name behind TLS", async () => {
		const c = (await issue({ "x-forwarded-proto": "https" })).headers.get(
			"set-cookie",
		) as string;
		expect(c).toStartWith("__Secure-mfw_session=");
		expect(c).toContain("; Secure");
	});

	test("scoped to the base path", () => {
		const req = new Request(`${ORIGIN}/mfw/api/auth/login`);
		expect(sessionCookie(req, "t", "/mfw/")).toContain("Path=/mfw;");
	});
});

describe("login", () => {
	beforeEach(async () => {
		const token = (await auth.beginFirstRun()) as string;
		await auth.setup(token, PASSWORD);
	});

	test("needs the custom header and a JSON body (login CSRF)", async () => {
		expect(
			(
				await action(
					"login",
					{ password: PASSWORD },
					{ [AUTH_INTENT_HEADER]: "" },
				)
			).status,
		).toBe(400);
		expect(
			(
				await action(
					"login",
					{ password: PASSWORD },
					{ "content-type": "text/plain" },
				)
			).status,
		).toBe(400);
	});

	test("rotates the session and rejects the previous cookie", async () => {
		const first = await action("login", { password: PASSWORD });
		const firstCookie = cookieOf(first);
		const second = await action(
			"login",
			{ password: PASSWORD },
			{ cookie: firstCookie },
		);
		expect(cookieOf(second)).not.toBe(firstCookie);
		const stale = await guardRequest(
			new Request(`${ORIGIN}/api/files/x/y`, {
				headers: { host: "localhost:7777", cookie: firstCookie },
			}),
			{ auth, base: "/", env: {} },
		);
		expect(stale.ok).toBe(false);
	});

	test("lockout answers 429 with Retry-After", async () => {
		for (let i = 0; i < 5; i++)
			expect(
				(await action("login", { password: "wrong password!" })).status,
			).toBe(401);
		const locked = await action("login", { password: PASSWORD });
		expect(locked.status).toBe(429);
		expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
	});

	test("logout needs the key, then clears the cookie and revokes", async () => {
		const res = await action("login", { password: PASSWORD });
		const cookie = cookieOf(res);
		const { requestKey } = (await res.json()) as { requestKey: string };
		expect((await action("logout", {}, { cookie })).status).toBe(403);
		const out = await action(
			"logout",
			{},
			{ cookie, [REQUEST_KEY_HEADER]: requestKey },
		);
		expect(out.status).toBe(200);
		expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
		expect(
			await auth.authenticate(cookie.slice("mfw_session=".length)),
		).toBeNull();
	});
});

describe("authenticated SSE", () => {
	test("the stream is served to a session and closes on logout", async () => {
		const token = (await auth.beginFirstRun()) as string;
		const session = await auth.setup(token, PASSWORD);
		const orchestrator = {
			usage: {
				snapshot: () => [],
				onChange: () => () => {},
				subscribe: () => () => {},
			},
		} as unknown as Orchestrator;
		const req = new Request(`${ORIGIN}/api/trpc/usage.changes`, {
			headers: {
				host: "localhost:7777",
				cookie: `mfw_session=${session.token}`,
				[REQUEST_KEY_HEADER]: session.requestKey,
			},
		});
		const res = await serveTrpc(
			req,
			await guardRequest(req, { auth, base: "/", env: {} }),
			{
				auth,
				endpoint: "/api/trpc",
				orchestrator: async () => orchestrator,
			},
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		await reader.read();
		await auth.logout(session.token);
		const closed = (async () => {
			for (;;) if ((await reader.read()).done) return true;
		})();
		const outcome = await Promise.race([
			closed,
			Bun.sleep(3000).then(() => false),
		]);
		expect(outcome).toBe(true);
		expect(auth.watchedStreams).toBe(0);
	});

	test("a client that disconnects releases the session watch", async () => {
		const token = (await auth.beginFirstRun()) as string;
		const session = await auth.setup(token, PASSWORD);
		const orchestrator = {
			usage: { subscribe: () => () => {} },
		} as unknown as Orchestrator;
		const req = new Request(`${ORIGIN}/api/trpc/usage.changes`, {
			headers: {
				host: "localhost:7777",
				cookie: `mfw_session=${session.token}`,
				[REQUEST_KEY_HEADER]: session.requestKey,
			},
		});
		const res = await serveTrpc(
			req,
			await guardRequest(req, { auth, base: "/", env: {} }),
			{
				auth,
				endpoint: "/api/trpc",
				orchestrator: async () => orchestrator,
			},
		);
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		await reader.read();
		expect(auth.watchedStreams).toBe(1);
		await reader.cancel();
		expect(auth.watchedStreams).toBe(0);
	});
});

describe("the throttle source (reviewer B2)", () => {
	test("is the socket peer, never a forwarded header", () => {
		const req = new Request(`${ORIGIN}/api/auth/login`, {
			headers: { "x-forwarded-for": "203.0.113.9", "x-real-ip": "203.0.113.9" },
		});
		expect(peerAddress(req)).toBeUndefined();
		Object.defineProperty(req, "ip", { value: "10.0.0.7" });
		expect(peerAddress(req)).toBe("10.0.0.7");
	});
});

describe("a stolen cookie is not enough (reviewer B1)", () => {
	const signedIn = async () => {
		const token = (await auth.beginFirstRun()) as string;
		const res = await action("setup", { token, password: PASSWORD });
		return {
			cookie: cookieOf(res),
			body: (await res.json()) as Record<string, string>,
		};
	};
	const api = (
		cookie: string,
		headers: Record<string, string> = {},
		method = "GET",
	) =>
		guardRequest(
			new Request(`${ORIGIN}/api/files/x/y.png`, {
				method,
				headers: { host: "localhost:7777", cookie, ...headers },
			}),
			{ auth, base: "/", env: {}, api: true },
		);

	test("the cookie alone cannot read the API", async () => {
		const { cookie } = await signedIn();
		expect((await api(cookie)).ok).toBe(false);
	});

	test("the cookie alone cannot obtain the key from /api/auth/state", async () => {
		const { cookie, body } = await signedIn();
		const req = new Request(`${ORIGIN}/api/auth/state`, {
			headers: { host: "localhost:7777", cookie },
		});
		const guarded = await guardRequest(req, { auth, base: "/", env: {} });
		if (!guarded.ok) throw new Error("state is public");
		const state = (await (
			await handleAuthAction("state", req, guarded, auth, "/")
		).json()) as Record<string, unknown>;
		expect(JSON.stringify(state)).not.toContain(String(body.requestKey));
		expect(state.state).toBe("login");
	});

	test("the key is not derived from the cookie", async () => {
		const { cookie, body } = await signedIn();
		const value = cookie.slice("mfw_session=".length);
		const { createHmac } = await import("node:crypto");
		const derived = createHmac("sha256", value)
			.update("mfw-csrf-v1")
			.digest("base64url");
		expect(body.requestKey).toBeString();
		expect(body.requestKey).not.toBe(derived);
	});

	test("an API call marked same-site is refused even with the key", async () => {
		const { cookie, body } = await signedIn();
		const r = await api(cookie, {
			"x-mfw-key": String(body.requestKey),
			"sec-fetch-site": "same-site",
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.response.status).toBe(403);
	});

	test("cookie plus key is accepted", async () => {
		const { cookie, body } = await signedIn();
		expect(
			(await api(cookie, { "x-mfw-key": String(body.requestKey) })).ok,
		).toBe(true);
	});
});

describe("password change and sign out everywhere over HTTP (reviewer M4)", () => {
	const signedIn = async () => {
		const token = (await auth.beginFirstRun()) as string;
		const res = await action("setup", { token, password: PASSWORD });
		const { requestKey } = (await res.json()) as { requestKey: string };
		return { cookie: cookieOf(res), key: requestKey };
	};
	const NEXT = "a different long passphrase";

	test("a stolen cookie without the key cannot change the password", async () => {
		const { cookie } = await signedIn();
		const res = await action(
			"password",
			{ current: PASSWORD, next: NEXT },
			{ cookie },
		);
		expect(res.status).toBe(403);
	});

	test("the owner can change it, and other sessions die", async () => {
		const { cookie, key } = await signedIn();
		const other = await action("login", { password: PASSWORD });
		const otherCookie = cookieOf(other);
		const res = await action(
			"password",
			{ current: PASSWORD, next: NEXT },
			{ cookie, [REQUEST_KEY_HEADER]: key },
		);
		expect(res.status).toBe(200);
		expect(await auth.authenticate(otherCookie.split("=")[1])).toBeNull();
		expect(await auth.authenticate(cookie.split("=")[1])).not.toBeNull();
	});

	test("a wrong current password is a 401 and changes nothing", async () => {
		const { cookie, key } = await signedIn();
		const res = await action(
			"password",
			{ current: "wrong password!", next: NEXT },
			{ cookie, [REQUEST_KEY_HEADER]: key },
		);
		expect(res.status).toBe(401);
		expect((await action("login", { password: PASSWORD })).status).toBe(200);
	});

	test("sign out everywhere ends this session too and clears the cookie", async () => {
		const { cookie, key } = await signedIn();
		const other = await action("login", { password: PASSWORD });
		const res = await action(
			"sign-out-everywhere",
			{},
			{
				cookie,
				[REQUEST_KEY_HEADER]: key,
			},
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
		expect(await auth.authenticate(cookie.split("=")[1])).toBeNull();
		expect(await auth.authenticate(cookieOf(other).split("=")[1])).toBeNull();
	});
});

describe("stream lifetime (reviewer M1)", () => {
	const orchestrator = {
		usage: { subscribe: () => () => {}, snapshot: () => [] },
	} as unknown as Orchestrator;
	const open = async (path: string, cookie: string, key: string) => {
		const req = new Request(`${ORIGIN}${path}`, {
			headers: { host: "localhost:7777", cookie, [REQUEST_KEY_HEADER]: key },
		});
		return serveTrpc(
			req,
			await guardRequest(req, { auth, base: "/", env: {} }),
			{
				auth,
				endpoint: "/api/trpc",
				orchestrator: async () => orchestrator,
			},
		);
	};

	for (const path of [
		"/api/trpc/usage.changes/",
		"/api/TRPC/usage.changes",
		"/API/trpc/usage.changes",
		"/api/trpc/usage%2Echanges",
		"/api/trpc//usage.changes",
	])
		test(`refuses the non-canonical spelling ${path}`, async () => {
			const token = (await auth.beginFirstRun()) as string;
			const s = await auth.setup(token, PASSWORD);
			const res = await open(path, `mfw_session=${s.token}`, s.requestKey);
			await res.body?.cancel();
			expect(res.status).toBe(404);
		});

	test("any event-stream response ends on logout, whatever its URL", async () => {
		const token = (await auth.beginFirstRun()) as string;
		const s = await auth.setup(token, PASSWORD);
		const req = new Request(`${ORIGIN}/api/trpc/system.projects`, {
			headers: {
				host: "localhost:7777",
				cookie: `mfw_session=${s.token}`,
				[REQUEST_KEY_HEADER]: s.requestKey,
			},
		});
		const res = await serveTrpc(
			req,
			await guardRequest(req, { auth, base: "/", env: {} }),
			{
				auth,
				endpoint: "/api/trpc",
				orchestrator: async () => orchestrator,
				handle: async () =>
					new Response(
						new ReadableStream({
							start(c) {
								c.enqueue(new TextEncoder().encode(": open\n\n"));
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					),
			},
		);
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toBe(": open\n\n");
		await auth.logout(s.token);
		const closed = await Promise.race([
			reader.read().then((r) => r.done),
			Bun.sleep(1500).then(() => false),
		]);
		expect(closed).toBe(true);
	});
});

describe("safeNext", () => {
	for (const bad of [
		null,
		"",
		"https://evil.example/",
		"//evil.example/",
		"/\\evil.example",
		"/other/app",
		"/mfw/login",
		"/mfw/\nx",
		"/mfw/x/../..//evil.example",
	])
		test(`refuses ${JSON.stringify(bad)}`, () => {
			expect(safeNext(bad, "/mfw/")).toBe("/mfw/");
		});

	// The reviewer's M3: dot segments normalise into a protocol-relative URL.
	for (const bad of ["/x/..//evil.example", "/x/../..//evil.example/a?b=1"])
		test(`at base / refuses ${bad}`, () => {
			expect(safeNext(bad, "/")).toBe("/");
		});

	test("keeps a path inside the app", () => {
		expect(safeNext("/mfw/p/demo/board?x=1", "/mfw/")).toBe(
			"/mfw/p/demo/board?x=1",
		);
	});
});
