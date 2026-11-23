import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService, type IssuedSession } from "@mfw/daemon/auth/service";
import { guardRequest, REQUEST_KEY_HEADER } from "./auth-guard";
import { AUTH_INTENT_HEADER, handleAuthAction } from "./auth-routes";

const ORIGIN = "http://localhost:7777";
let dir: string;
let auth: AuthService;
let session: IssuedSession;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "mfw-token-routes-"));
	auth = await AuthService.open(join(dir, "auth.db"), {
		passwordCheckIntervalMs: 0,
	});
	session = await auth.setup(
		(await auth.beginFirstRun()) as string,
		"correct horse battery",
	);
});

afterEach(() => {
	auth.close();
	rmSync(dir, { recursive: true, force: true });
});

const owner = () => ({
	host: "localhost:7777",
	cookie: `mfw_session=${session.token}`,
	[REQUEST_KEY_HEADER]: session.requestKey,
});

async function route(
	action: string,
	method: string,
	headers: Record<string, string>,
	body?: unknown,
): Promise<Response> {
	const req = new Request(`${ORIGIN}/api/auth/${action}`, {
		method,
		headers: {
			...headers,
			...(body !== undefined
				? { "content-type": "application/json", [AUTH_INTENT_HEADER]: "1" }
				: {}),
		},
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	});
	const guarded = await guardRequest(req, {
		auth,
		base: "/",
		env: {},
		api: true,
	});
	if (!guarded.ok) return guarded.response;
	return handleAuthAction(action, req, guarded, auth, "/", "127.0.0.1");
}

const create = { name: "ci", scopes: ["board:read"] };

describe("the owner manages tokens", () => {
	test("create shows the secret once; list never does", async () => {
		const made = await route("tokens", "POST", owner(), create);
		expect(made.status).toBe(200);
		expect(made.headers.get("cache-control")).toBe("no-store");
		const { token, info } = (await made.json()) as {
			token: string;
			info: { id: string };
		};
		expect(token).toStartWith("mfwt_");
		const listed = await (await route("tokens", "GET", owner())).text();
		expect(listed).toContain(info.id);
		expect(listed).not.toContain(token);
		expect(listed).not.toContain("hash");
	});

	test("revoke takes effect at once", async () => {
		const { token, info } = await auth.createToken(create);
		const res = await route("token-revoke", "POST", owner(), { id: info.id });
		expect(await res.json()).toEqual({ revoked: true });
		expect(await auth.authenticateToken(token)).toBeNull();
	});

	test("the audit view returns actions and refusal counts, no secret", async () => {
		const { token, info } = await auth.createToken(create);
		await auth.beginTokenAction({
			tokenId: info.id,
			name: info.name,
			path: "tasks.create",
			project: "alpha",
		});
		await auth.recordTokenRefusal({
			tokenId: info.id,
			name: info.name,
			path: "settings.get",
		});
		const res = await route("token-audit", "GET", owner());
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).not.toContain(token);
		const body = JSON.parse(text) as {
			actions: { path: string }[];
			counters: { refused: number }[];
		};
		expect(body.actions.map((a) => a.path)).toEqual(["tasks.create"]);
		expect(body.counters[0]?.refused).toBe(1);
	});

	for (const [label, body] of [
		["an admin scope", { name: "x", scopes: ["admin"] }],
		["no expiry bound", { ...create, ttlMs: 10 ** 12 }],
		["no name", { scopes: ["board:read"] }],
	] as const)
		test(`refuses ${label}`, async () => {
			expect((await route("tokens", "POST", owner(), body)).status).toBe(400);
			expect(await auth.listTokens()).toHaveLength(0);
		});
});

describe("only an owner session can", () => {
	const anon = { host: "localhost:7777" };

	test("no credentials: 401", async () => {
		expect((await route("tokens", "GET", anon)).status).toBe(401);
		expect((await route("tokens", "POST", anon, create)).status).toBe(401);
	});

	test("the cookie without the request key: 403", async () => {
		const headers = { ...anon, cookie: `mfw_session=${session.token}` };
		expect((await route("tokens", "GET", headers)).status).toBe(403);
		expect((await route("tokens", "POST", headers, create)).status).toBe(403);
	});

	test("a cross-site page: 403", async () => {
		const res = await route(
			"tokens",
			"POST",
			{ ...owner(), origin: "https://evil.example" },
			create,
		);
		expect(res.status).toBe(403);
		expect(await auth.listTokens()).toHaveLength(0);
	});

	test("a form post without the intent header: 400", async () => {
		const req = new Request(`${ORIGIN}/api/auth/tokens`, {
			method: "POST",
			headers: { ...owner(), "content-type": "text/plain" },
			body: JSON.stringify(create),
		});
		const guarded = await guardRequest(req, {
			auth,
			base: "/",
			env: {},
			api: true,
		});
		if (!guarded.ok) throw new Error("guard refused");
		const res = await handleAuthAction("tokens", req, guarded, auth, "/");
		expect(res.status).toBe(400);
	});

	test("a token cannot mint, list or revoke tokens", async () => {
		const { token, info } = await auth.createToken({
			name: "all",
			scopes: ["status:read", "board:read", "board:write", "runs:act"],
		});
		const headers = { ...anon, authorization: `Bearer ${token}` };
		expect((await route("tokens", "POST", headers, create)).status).toBe(403);
		expect((await route("tokens", "GET", headers)).status).toBe(403);
		expect((await route("token-audit", "GET", headers)).status).toBe(403);
		expect(
			(await route("token-revoke", "POST", headers, { id: info.id })).status,
		).toBe(403);
		expect(await auth.listTokens()).toHaveLength(1);
	});

	test("a token cannot change the password, even beside a session", async () => {
		const { token } = await auth.createToken({
			name: "t",
			scopes: ["board:write"],
		});
		const res = await route(
			"password",
			"POST",
			{ ...owner(), authorization: `Bearer ${token}` },
			{ current: "correct horse battery", next: "another long passphrase" },
		);
		expect(res.status).toBe(403);
		expect((await auth.login("correct horse battery")).token).toBeTruthy();
	});
});
