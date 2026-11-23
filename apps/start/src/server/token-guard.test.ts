import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService, type IssuedSession } from "@mfw/daemon/auth/service";
import { MAX_TOKEN_STREAMS, type TokenScope } from "@mfw/daemon/auth/tokens";
import type { Orchestrator } from "@mfw/daemon/services";
import {
	guardAppRequest,
	guardRequest,
	REQUEST_KEY_HEADER,
	setServerAuth,
} from "./auth-guard";
import { serveTrpc } from "./trpc-handler";

const ORIGIN = "http://localhost:7777";
const ENDPOINT = "/api/trpc";
const HEALTH = `${ORIGIN}${ENDPOINT}/system.health`;
const INPUT = `?input=${encodeURIComponent(JSON.stringify({ json: {} }))}`;

let dir: string;
let auth: AuthService;
let session: IssuedSession;
const clock = { t: 10_000_000 };

const orchestrator = (async () => ({
	bootId: "boot",
	startedAt: 0,
	list: () => [],
	get: () => {
		throw new Error("no project");
	},
})) as unknown as () => Promise<Orchestrator>;

const mint = async (
	scopes: TokenScope[] = ["status:read"],
	extra: { ttlMs?: number; project?: string } = {},
) => auth.createToken({ name: "test", scopes, ...extra });

const bearer = (token: string, more: Record<string, string> = {}) => ({
	host: "localhost:7777",
	authorization: `Bearer ${token}`,
	...more,
});

async function trpc(
	req: Request,
	handle?: (r: Request) => Promise<Response>,
): Promise<Response> {
	return serveTrpc(
		req,
		await guardRequest(req, {
			auth,
			base: "/",
			env: {},
			api: true,
			bearer: true,
		}),
		{
			auth,
			endpoint: ENDPOINT,
			orchestrator,
			...(handle ? { handle } : {}),
		},
	);
}

const get = (headers: Record<string, string>, url = `${HEALTH}${INPUT}`) =>
	new Request(url, { headers });

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "mfw-token-guard-"));
	auth = await AuthService.open(join(dir, "auth.db"), {
		now: () => clock.t,
		passwordCheckIntervalMs: 0,
	});
	const token = (await auth.beginFirstRun()) as string;
	session = await auth.setup(token, "correct horse battery");
});

afterAll(() => {
	auth.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("a bearer token on the tRPC API", () => {
	test("works with no Origin, cookie or request key", async () => {
		const { token } = await mint();
		expect((await trpc(get(bearer(token)))).status).toBe(200);
	});

	test("works from a same-origin page", async () => {
		const { token } = await mint();
		const res = await trpc(
			get(bearer(token, { origin: ORIGIN, "sec-fetch-site": "same-origin" })),
		);
		expect(res.status).toBe(200);
	});

	test("is refused outside its scope", async () => {
		const { token } = await mint(["board:read"]);
		expect((await trpc(get(bearer(token)))).status).toBe(403);
	});

	test("cannot reach an owner-only procedure", async () => {
		const { token } = await mint([
			"status:read",
			"board:read",
			"board:write",
			"runs:act",
		]);
		const res = await trpc(
			new Request(`${ORIGIN}${ENDPOINT}/settings.update`, {
				method: "POST",
				headers: bearer(token, { "content-type": "application/json" }),
				body: JSON.stringify({ json: { project: "alpha" } }),
			}),
		);
		expect(res.status).toBe(403);
	});
});

describe("cross-site and host rules still apply", () => {
	for (const [label, headers] of [
		["a foreign Origin", { origin: "https://evil.example" }],
		["a sibling localhost port", { origin: "http://localhost:9999" }],
		["Origin: null", { origin: "null" }],
		["Sec-Fetch-Site: cross-site", { "sec-fetch-site": "cross-site" }],
		["Sec-Fetch-Site: same-site", { "sec-fetch-site": "same-site" }],
		["a rebinding Host", { host: "evil.example" }],
	] as const)
		test(`${label} is refused with a valid token`, async () => {
			const { token } = await mint();
			expect((await trpc(get(bearer(token, headers)))).status).toBe(403);
		});
});

describe("bearer only", () => {
	test("a token in a cookie is not a credential", async () => {
		const { token } = await mint();
		const res = await trpc(
			get({ host: "localhost:7777", cookie: `mfw_session=${token}` }),
		);
		expect(res.status).toBe(401);
	});

	for (const param of ["token", "access_token", "authorization", "bearer"])
		test(`a token in ?${param}= is not a credential`, async () => {
			const { token } = await mint();
			const res = await trpc(
				get(
					{ host: "localhost:7777" },
					`${HEALTH}${INPUT}&${param}=${encodeURIComponent(token)}`,
				),
			);
			expect(res.status).toBe(401);
		});

	test("a bad bearer never falls back to a valid session", async () => {
		const res = await trpc(
			get({
				host: "localhost:7777",
				authorization: "Bearer not-a-token",
				cookie: `mfw_session=${session.token}`,
				[REQUEST_KEY_HEADER]: session.requestKey,
			}),
		);
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toBe("Bearer");
	});

	test("a good bearer does not gain the session riding beside it", async () => {
		const { token } = await mint(["board:read"]);
		const res = await trpc(
			get(
				bearer(token, {
					cookie: `mfw_session=${session.token}`,
					[REQUEST_KEY_HEADER]: session.requestKey,
				}),
			),
		);
		expect(res.status).toBe(403);
	});

	test("another Authorization scheme leaves session auth untouched", async () => {
		const res = await trpc(
			get({
				host: "localhost:7777",
				authorization: "Basic dXNlcjpwYXNz",
				cookie: `mfw_session=${session.token}`,
				[REQUEST_KEY_HEADER]: session.requestKey,
			}),
		);
		expect(res.status).toBe(200);
	});

	test("the session's request key is not a token", async () => {
		const res = await trpc(get(bearer(session.requestKey)));
		expect(res.status).toBe(401);
	});
});

describe("tokens stop working", () => {
	test("on expiry", async () => {
		const { token } = await mint(["status:read"], { ttlMs: 60_000 });
		expect((await trpc(get(bearer(token)))).status).toBe(200);
		clock.t += 60_000;
		expect((await trpc(get(bearer(token)))).status).toBe(401);
	});

	test("on revocation, at the next request", async () => {
		const { token, info } = await mint();
		expect((await trpc(get(bearer(token)))).status).toBe(200);
		await auth.revokeToken(info.id);
		expect((await trpc(get(bearer(token)))).status).toBe(401);
	});
});

describe("batches", () => {
	test("?batch=1 is refused", async () => {
		const { token } = await mint();
		const res = await trpc(
			get(
				bearer(token),
				`${HEALTH}?batch=1&input=${encodeURIComponent('{"0":{"json":{}}}')}`,
			),
		);
		expect(res.status).toBe(400);
	});

	test("a comma-joined path is refused", async () => {
		const { token } = await mint();
		const res = await trpc(
			get(bearer(token), `${HEALTH},system.health${INPUT}`),
		);
		expect(res.status).toBe(400);
	});
});

describe("rate limit", () => {
	test("is per token and answers 429 with Retry-After", async () => {
		const noisy = await mint();
		const quiet = await mint();
		let limited: Response | undefined;
		for (let i = 0; i < 200 && !limited; i++) {
			const res = await trpc(get(bearer(noisy.token)));
			if (res.status === 429) limited = res;
		}
		expect(limited?.status).toBe(429);
		expect(Number(limited?.headers.get("retry-after"))).toBeGreaterThan(0);
		expect((await trpc(get(bearer(quiet.token)))).status).toBe(200);
		clock.t += 60_000;
		expect((await trpc(get(bearer(noisy.token)))).status).toBe(200);
	});
});

describe("streams", () => {
	const sse = async (_r: Request) =>
		new Response(
			new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(new TextEncoder().encode("data: 1\n\n"));
				},
			}),
			{ headers: { "content-type": "text/event-stream" } },
		);

	async function drained(res: Response): Promise<boolean> {
		const reader = res.body?.getReader();
		if (!reader) return false;
		await reader.read();
		const next = await Promise.race([
			reader.read().then((r) => r.done),
			Bun.sleep(2000).then(() => false),
		]);
		return next;
	}

	test("end when the token is revoked", async () => {
		const { token, info } = await mint();
		const res = await trpc(get(bearer(token)), sse);
		const closed = drained(res);
		await Bun.sleep(10);
		await auth.revokeToken(info.id);
		expect(await closed).toBe(true);
		expect(auth.tokenStreamAvailable(info.id)).toBe(true);
	});

	test("are capped per token", async () => {
		const { token, info } = await mint();
		const open: Response[] = [];
		for (let i = 0; i < MAX_TOKEN_STREAMS; i++) {
			const res = await trpc(get(bearer(token)), sse);
			expect(res.headers.get("content-type")).toContain("event-stream");
			open.push(res);
		}
		const over = await trpc(get(bearer(token)), sse);
		expect(over.status).toBe(429);
		await auth.revokeToken(info.id);
		await Promise.all(open.map((r) => r.body?.cancel().catch(() => {})));
	});
});

describe("the app-wide middleware", () => {
	const app = (path: string, token: string) =>
		guardAppRequest(
			new Request(`${ORIGIN}${path}`, { headers: bearer(token) }),
		);

	test("admits a token on the tRPC mount without charging it", async () => {
		setServerAuth(auth);
		try {
			const { token, info } = await mint();
			for (let i = 0; i < 300; i++)
				expect((await app("/api/trpc/system.health", token)).ok).toBe(true);
			expect(auth.takeTokenRate(info.id)).toBe(0);
		} finally {
			setServerAuth(null);
		}
	});

	for (const path of [
		"/api/files/alpha/x",
		"/api/auth/tokens",
		"/API/trpc/system.health",
		"/api/trpcx/system.health",
		"/settings",
	])
		test(`refuses a token on ${path}`, async () => {
			setServerAuth(auth);
			try {
				const { token } = await mint();
				const r = await app(path, token);
				expect(r.ok).toBe(false);
				if (!r.ok) expect(r.response.status).toBe(403);
			} finally {
				setServerAuth(null);
			}
		});
});

describe("a token cannot reach anything but tRPC", () => {
	for (const [method, path] of [
		["GET", "/api/files/alpha/README.md"],
		["GET", "/api/docs/alpha/src/x.md"],
		["GET", "/api/attachments/alpha/T1/a.png"],
		["GET", "/api/auth/state"],
		["GET", "/api/auth/tokens"],
		["POST", "/api/auth/tokens"],
		["POST", "/api/auth/token-revoke"],
		["POST", "/api/auth/password"],
		["POST", "/api/auth/login"],
		["POST", "/api/auth/setup"],
		["POST", "/api/auth/logout"],
		["POST", "/api/auth/sign-out-everywhere"],
		["GET", "/settings"],
		["GET", "/p/alpha/board"],
	] as const)
		test(`${method} ${path} is refused`, async () => {
			const { token } = await mint([
				"status:read",
				"board:read",
				"board:write",
				"runs:act",
			]);
			const r = await guardRequest(
				new Request(`${ORIGIN}${path}`, {
					method,
					headers: bearer(token, {
						cookie: `mfw_session=${session.token}`,
						[REQUEST_KEY_HEADER]: session.requestKey,
					}),
				}),
				{ auth, base: "/", env: {} },
			);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.response.status).toBe(403);
		});

	test("the public health probe still answers with a token set", async () => {
		const { token } = await mint();
		const r = await guardRequest(
			new Request(`${ORIGIN}/api/health`, { headers: bearer(token) }),
			{ auth, base: "/", env: {} },
		);
		expect(r.ok).toBe(true);
	});
});
