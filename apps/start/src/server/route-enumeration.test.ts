import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appRouter } from "@mfw/api";
import { OWNER_ONLY_PROCEDURES, TOKEN_PROCEDURES } from "@mfw/api/token-access";
import { AuthService, type IssuedSession } from "@mfw/daemon/auth/service";
import { TOKEN_SCOPES } from "@mfw/daemon/auth/tokens";
import type { Orchestrator } from "@mfw/daemon/services";
import {
	guardRequest,
	isPublicPath,
	REQUEST_KEY_HEADER,
	setServerAuth,
} from "./auth-guard";
import { serveTrpc } from "./trpc-handler";

/**
 * Wave 3 exit criterion: every route, tRPC procedure and SSE endpoint refuses
 * an unauthenticated or cross-origin call. The lists are derived from the
 * route files and the router, so a new one is covered without editing this.
 */

const ROUTES_DIR = join(import.meta.dir, "..", "routes");
const ORIGIN = "http://localhost:7777";
const ENDPOINT = "/api/trpc";
const EVIL = "https://evil.example";

/** Public on purpose. Adding to this list is a security decision. */
const PUBLIC_ROUTES = new Set(["/login", "/api/health", "/api/auth/$action"]);

function routeIds(dir = ROUTES_DIR): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, e.name);
		if (e.isDirectory()) out.push(...routeIds(path));
		else if (/\.tsx?$/.test(e.name) && !e.name.includes(".test.")) {
			const m = /createFileRoute\("([^"]+)"\)/.exec(readFileSync(path, "utf8"));
			if (m?.[1]) out.push(m[1]);
		}
	}
	return out;
}

const concrete = (id: string) =>
	id
		.replace(/\$[A-Za-z]+/g, "x")
		.replace(/\/\$$/, "/x")
		.replace(/\/$/, "") || "/";

const procedures = Object.entries(
	(
		appRouter as unknown as {
			_def: { procedures: Record<string, { _def: { type: string } }> };
		}
	)._def.procedures,
).map(([path, p]) => ({ path, type: p._def.type }));

let dir: string;
let auth: AuthService;
let session: IssuedSession;
const orchestrator = (async () => {
	throw new Error("the orchestrator must not be reached");
}) as unknown as () => Promise<Orchestrator>;

const guardOnly = (req: Request) =>
	guardRequest(req, { auth, base: "/", env: {} });

const callTrpc = async (req: Request) =>
	serveTrpc(
		req,
		await guardRequest(req, { auth, base: "/", env: {}, api: true }),
		{
			auth,
			endpoint: ENDPOINT,
			orchestrator,
		},
	);

function procRequest(
	path: string,
	type: string,
	headers: Record<string, string> = {},
): Request {
	const url = `${ORIGIN}${ENDPOINT}/${path}`;
	const h = { host: "localhost:7777", ...headers };
	return type === "mutation"
		? new Request(url, {
				method: "POST",
				headers: { "content-type": "application/json", ...h },
				body: "{}",
			})
		: new Request(url, { headers: h });
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "mfw-enum-"));
	auth = await AuthService.open(join(dir, "auth.db"));
	setServerAuth(auth);
	const token = (await auth.beginFirstRun()) as string;
	session = await auth.setup(token, "correct horse battery");
});

afterAll(() => {
	setServerAuth(null);
	auth.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("the enumeration is real", () => {
	test("it finds the routes and procedures", () => {
		const ids = routeIds();
		expect(ids).toContain("/api/trpc/$");
		expect(ids).toContain("/api/files/$project/$");
		expect(ids).toContain("/p/$project/board");
		expect(procedures.length).toBeGreaterThan(100);
		expect(procedures.some((p) => p.type === "subscription")).toBe(true);
		expect(procedures.some((p) => p.type === "mutation")).toBe(true);
	});

	test("it covers the direction, chat and held-decision procedures", () => {
		const names = procedures.map((p) => p.path);
		for (const name of [
			"brain.giveDirection",
			"brain.chatThread",
			"brain.chatAsk",
			"brain.chatGiveDirection",
			"brain.directions",
			"brain.decisions",
			"brain.resolveDecision",
			"brain.resetActBreaker",
		])
			expect(names).toContain(name);
	});

	test("the public list is exactly the allowlist", () => {
		const open = routeIds().filter((id) =>
			isPublicPath(concrete(id).slice(1), "GET"),
		);
		expect(open.sort()).toEqual(["/api/health", "/login"]);
		for (const id of PUBLIC_ROUTES) expect(routeIds()).toContain(id);
	});
});

describe("every route", () => {
	for (const id of routeIds().filter((r) => !PUBLIC_ROUTES.has(r))) {
		const url = `${ORIGIN}${concrete(id)}`;

		test(`${id}: unauthenticated is refused`, async () => {
			const r = await guardOnly(
				new Request(url, {
					headers: { host: "localhost:7777", accept: "text/html" },
				}),
			);
			expect(r.ok).toBe(false);
			if (r.ok) return;
			if (id.startsWith("/api/")) expect(r.response.status).toBe(401);
			else {
				expect(r.response.status).toBe(302);
				expect(r.response.headers.get("location")).toStartWith("/login?next=");
			}
		});

		test(`${id}: cross-origin is refused, even with a session`, async () => {
			const r = await guardOnly(
				new Request(url, {
					headers: {
						host: "localhost:7777",
						origin: EVIL,
						cookie: `mfw_session=${session.token}`,
					},
				}),
			);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.response.status).toBe(403);
		});
	}

	for (const id of PUBLIC_ROUTES)
		test(`${id}: public, but still refuses a foreign Origin`, async () => {
			const r = await guardOnly(
				new Request(`${ORIGIN}${concrete(id).replace("/x", "/state")}`, {
					headers: { host: "localhost:7777", origin: EVIL },
				}),
			);
			expect(r.ok).toBe(false);
		});
});

describe("every tRPC procedure and SSE stream", () => {
	for (const { path, type } of procedures) {
		test(`${type} ${path}: unauthenticated gets 401`, async () => {
			const res = await callTrpc(procRequest(path, type));
			expect(res.status).toBe(401);
		});

		test(`${type} ${path}: cross-origin gets 403`, async () => {
			const res = await callTrpc(
				procRequest(path, type, {
					origin: EVIL,
					cookie: `mfw_session=${session.token}`,
					[REQUEST_KEY_HEADER]: session.requestKey,
				}),
			);
			expect(res.status).toBe(403);
		});

		test(`${type} ${path}: the cookie without the request key gets 403`, async () => {
			const res = await callTrpc(
				procRequest(path, type, { cookie: `mfw_session=${session.token}` }),
			);
			expect(res.status).toBe(403);
		});

		test(`${type} ${path}: a same-site call with the key gets 403`, async () => {
			const res = await callTrpc(
				procRequest(path, type, {
					cookie: `mfw_session=${session.token}`,
					[REQUEST_KEY_HEADER]: session.requestKey,
					"sec-fetch-site": "same-site",
				}),
			);
			expect(res.status).toBe(403);
		});

		test(`${type} ${path}: a null principal is refused by the router itself`, async () => {
			const { fetchRequestHandler } = await import(
				"@trpc/server/adapters/fetch"
			);
			const res = await fetchRequestHandler({
				endpoint: ENDPOINT,
				router: appRouter,
				req: procRequest(path, type),
				createContext: () => ({
					orchestrator: {} as Orchestrator,
					principal: null,
				}),
			});
			if (type === "subscription") {
				const text = await res.text();
				expect(text).toContain("UNAUTHORIZED");
			} else {
				expect(res.status).toBe(401);
			}
		});
	}
});

describe("every route and procedure with an API token", () => {
	let tokens: AuthService;
	let tokenDir: string;
	let all: string;
	const stub = (async () => ({
		bootId: "boot",
		startedAt: 0,
		list: () => [],
		get: () => {
			throw new Error("no project");
		},
	})) as unknown as () => Promise<Orchestrator>;

	const callWithToken = async (req: Request) =>
		serveTrpc(
			req,
			await guardRequest(req, {
				auth: tokens,
				base: "/",
				env: {},
				api: true,
				bearer: true,
			}),
			{ auth: tokens, endpoint: ENDPOINT, orchestrator: stub },
		);

	beforeAll(async () => {
		tokenDir = mkdtempSync(join(tmpdir(), "mfw-enum-token-"));
		tokens = await AuthService.open(join(tokenDir, "auth.db"), {
			tokenRate: { perSecond: 1000, burst: 100_000 },
		});
		const setup = (await tokens.beginFirstRun()) as string;
		await tokens.setup(setup, "correct horse battery");
		all = (await tokens.createToken({ name: "all", scopes: [...TOKEN_SCOPES] }))
			.token;
	});

	afterAll(() => {
		tokens.close();
		rmSync(tokenDir, { recursive: true, force: true });
	});

	for (const { path, type } of procedures) {
		if (OWNER_ONLY_PROCEDURES.has(path))
			test(`${type} ${path}: owner-only, refused to a token with every scope`, async () => {
				const res = await callWithToken(
					procRequest(path, type, { authorization: `Bearer ${all}` }),
				);
				if (type === "subscription")
					expect(await res.text()).toContain("FORBIDDEN");
				else expect(res.status).toBe(403);
			});
		else
			test(`${type} ${path}: declared, and a bad token gets 401`, async () => {
				expect(TOKEN_PROCEDURES.has(path)).toBe(true);
				const res = await callWithToken(
					procRequest(path, type, {
						authorization: `Bearer mfwt_${"x".repeat(43)}`,
					}),
				);
				expect(res.status).toBe(401);
			});

		test(`${type} ${path}: a cross-site call with a valid token gets 403`, async () => {
			const res = await callWithToken(
				procRequest(path, type, {
					authorization: `Bearer ${all}`,
					origin: EVIL,
				}),
			);
			expect(res.status).toBe(403);
		});
	}

	for (const id of routeIds().filter((r) => r !== "/api/trpc/$")) {
		if (id === "/api/health") continue;
		test(`${id}: a token is not accepted`, async () => {
			const r = await guardRequest(
				new Request(`${ORIGIN}${concrete(id)}`, {
					headers: {
						host: "localhost:7777",
						authorization: `Bearer ${all}`,
					},
				}),
				{ auth: tokens, base: "/", env: {} },
			);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.response.status).toBe(403);
		});
	}
});

describe("guard edges", () => {
	const unauth = async (path: string, method = "GET") =>
		guardRequest(
			new Request(`${ORIGIN}${path}`, {
				method,
				headers: { host: "localhost:7777" },
			}),
			{ auth, base: "/", env: {} },
		);

	for (const path of [
		"/assets/..%2fapi%2ftrpc%2fsettings.update",
		"/assets/a/b.js",
		"/login/../api/trpc/system.projects",
		"/API/health/x",
		"/login/x",
		"/_serverFn/anything",
	])
		test(`${path} is not public`, async () => {
			expect((await unauth(path)).ok).toBe(false);
		});

	test("an asset that reaches the app does not exist: 404, not the router", async () => {
		const r = await unauth("/assets/missing.map");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.response.status).toBe(404);
	});

	test("a public GET path is not public for POST", async () => {
		expect((await unauth("/login", "POST")).ok).toBe(false);
		expect((await unauth("/api/health", "POST")).ok).toBe(false);
	});

	test("a revoked session is refused", async () => {
		const extra = await auth.login("correct horse battery");
		await auth.logout(extra.token);
		const r = await guardOnly(
			new Request(`${ORIGIN}/api/files/x/y`, {
				headers: {
					host: "localhost:7777",
					cookie: `mfw_session=${extra.token}`,
				},
			}),
		);
		expect(r.ok).toBe(false);
	});

	test("over TLS the plain cookie name is ignored", async () => {
		const r = await guardOnly(
			new Request("https://localhost:7777/api/files/x/y", {
				headers: {
					host: "localhost:7777",
					cookie: `mfw_session=${session.token}`,
					// The valid key: only the cookie's name can cause this refusal.
					[REQUEST_KEY_HEADER]: session.requestKey,
				},
			}),
		);
		expect(r.ok).toBe(false);
	});
});
