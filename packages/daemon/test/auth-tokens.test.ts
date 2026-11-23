import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService, type IssuedSession } from "../src/auth/service.ts";
import {
	MAX_LIVE_TOKENS,
	normalizeTokenRequest,
	parseBearer,
	TOKEN_DEFAULT_TTL_MS,
	TOKEN_MAX_TTL_MS,
	TokenRateLimiter,
} from "../src/auth/tokens.ts";

const PASSWORD = "correct horse battery";
const NEXT_PASSWORD = "a different long passphrase";

let dir: string | undefined;
let auth: AuthService | undefined;
afterEach(() => {
	auth?.close();
	if (dir) rmSync(dir, { recursive: true, force: true });
	auth = dir = undefined;
});

async function setup(
	clock = { t: 1_000_000 },
	opts: { tokenStreamRecheckMs?: number } = {},
): Promise<{
	a: AuthService;
	session: IssuedSession;
	clock: { t: number };
	path: string;
}> {
	dir = mkdtempSync(join(tmpdir(), "mfw-tokens-"));
	const path = join(dir, "auth.db");
	auth = await AuthService.open(path, {
		now: () => clock.t,
		passwordCheckIntervalMs: 0,
		...opts,
	});
	const setupToken = (await auth.beginFirstRun()) as string;
	const session = await auth.setup(setupToken, PASSWORD);
	return { a: auth, session, clock, path };
}

const read = { name: "ci", scopes: ["board:read"] as const };

describe("parseBearer", () => {
	const good = `mfwt_${"a".repeat(43)}`;
	test("reads one well-formed token, any scheme case", () => {
		expect(parseBearer(`Bearer ${good}`)).toEqual({
			kind: "token",
			value: good,
		});
		expect(parseBearer(`bearer ${good}`).kind).toBe("token");
	});
	test("another scheme is not ours", () => {
		expect(parseBearer(null).kind).toBe("none");
		expect(parseBearer("Basic dXNlcjpwYXNz").kind).toBe("none");
	});
	for (const bad of [
		"Bearer",
		"Bearer ",
		"Bearer short",
		`Bearer ${good}x`,
		`Bearer ${good}, Bearer ${good}`,
		`Bearer ${good} extra`,
	])
		test(`malformed: ${bad.slice(0, 24)}`, () => {
			expect(parseBearer(bad).kind).toBe("malformed");
		});
});

describe("normalizeTokenRequest", () => {
	test("defaults to a short expiry and orders scopes", () => {
		expect(
			normalizeTokenRequest({
				name: " ci ",
				scopes: ["board:write", "board:read", "board:read"],
			}),
		).toEqual({
			name: "ci",
			scopes: ["board:read", "board:write"],
			project: null,
			ttlMs: TOKEN_DEFAULT_TTL_MS,
		});
	});
	for (const [label, input] of [
		["no name", { scopes: ["board:read"] }],
		["control characters", { name: "a\nb", scopes: ["board:read"] }],
		["no scopes", { name: "x", scopes: [] }],
		["admin scope", { name: "x", scopes: ["admin"] }],
		["wildcard", { name: "x", scopes: ["*"] }],
		["non-array", { name: "x", scopes: "board:read" }],
		["bad project", { name: "x", scopes: ["board:read"], project: "a/b" }],
		["zero ttl", { name: "x", scopes: ["board:read"], ttlMs: 0 }],
		[
			"ttl over the cap",
			{ name: "x", scopes: ["board:read"], ttlMs: TOKEN_MAX_TTL_MS + 1 },
		],
		["ttl not a number", { name: "x", scopes: ["board:read"], ttlMs: "1" }],
	] as const)
		test(`refuses ${label}`, () => {
			expect(typeof normalizeTokenRequest(input)).toBe("string");
		});
});

describe("token lifecycle", () => {
	test("is shown once and stored only as a digest", async () => {
		const { a, path } = await setup();
		const { token, info } = await a.createToken(read);
		expect(token).toMatch(/^mfwt_[A-Za-z0-9_-]{43}$/);
		expect(JSON.stringify(await a.listTokens())).not.toContain(token);
		expect(JSON.stringify(info)).not.toContain(token);
		a.close();
		auth = undefined;
		for (const suffix of ["", "-wal"]) {
			let bytes = "";
			try {
				bytes = readFileSync(`${path}${suffix}`, "latin1");
			} catch {}
			expect(bytes).not.toContain(token);
		}
	});

	test("authenticates to a token principal with its scopes and project", async () => {
		const { a } = await setup();
		const { token, info } = await a.createToken({
			name: "ci",
			scopes: ["board:read", "status:read"],
			project: "alpha",
		});
		const p = await a.authenticateToken(token);
		expect(p).toMatchObject({
			kind: "token",
			id: `token:${info.id}`,
			tokenId: info.id,
			name: "ci",
			scopes: ["status:read", "board:read"],
			project: "alpha",
		});
	});

	test("an unknown token is refused", async () => {
		const { a } = await setup();
		expect(await a.authenticateToken(`mfwt_${"b".repeat(43)}`)).toBeNull();
	});

	test("a session cookie value is not a token, and a token is not a session", async () => {
		const { a, session } = await setup();
		const { token } = await a.createToken(read);
		expect(await a.authenticateToken(session.token)).toBeNull();
		expect(await a.authenticate(token)).toBeNull();
	});

	test("expires", async () => {
		const { a, clock } = await setup();
		const { token } = await a.createToken({ ...read, ttlMs: 60_000 });
		clock.t += 59_999;
		expect(await a.authenticateToken(token)).not.toBeNull();
		clock.t += 1;
		expect(await a.authenticateToken(token)).toBeNull();
	});

	test("expiry is mandatory: the default is applied and stored", async () => {
		const { a, clock } = await setup();
		const { info } = await a.createToken(read);
		expect(info.expiresAt).toBe(clock.t + TOKEN_DEFAULT_TTL_MS);
	});

	test("revocation is immediate and idempotent", async () => {
		const { a } = await setup();
		const { token, info } = await a.createToken(read);
		expect(await a.revokeToken(info.id)).toBe(true);
		expect(await a.authenticateToken(token)).toBeNull();
		expect(await a.revokeToken(info.id)).toBe(false);
		expect((await a.listTokens())[0]?.status).toBe("revoked");
	});

	test("a stored scope outside the closed set fails closed", async () => {
		const { a, path } = await setup();
		const { token, info } = await a.createToken(read);
		const { createClient } = await import("@libsql/client");
		const raw = createClient({ url: `file:${path}` });
		await raw.execute({
			sql: "UPDATE api_tokens SET scopes = ? WHERE id = ?",
			args: ['["board:read","admin"]', info.id],
		});
		raw.close();
		expect(await a.authenticateToken(token)).toBeNull();
	});

	test("the number of live tokens is capped", async () => {
		const { a } = await setup();
		for (let i = 0; i < MAX_LIVE_TOKENS; i++)
			await a.createToken({ ...read, name: `t${i}` });
		await expect(a.createToken(read)).rejects.toMatchObject({
			name: "AuthRefused",
		});
	});

	test("a request from a revoked session cannot mint", async () => {
		const { a, session } = await setup();
		await a.revokeAll();
		await expect(
			a.createToken(read, { sessionId: session.sessionId }),
		).rejects.toMatchObject({ name: "AuthRefused" });
		expect(await a.listTokens()).toHaveLength(0);
	});
});

describe("evicting an attacker also evicts their tokens", () => {
	test("sign-out-everywhere revokes every token", async () => {
		const { a } = await setup();
		const { token } = await a.createToken(read);
		await a.revokeAll();
		expect(await a.authenticateToken(token)).toBeNull();
	});

	test("a password change revokes every token", async () => {
		const { a, session } = await setup();
		const { token } = await a.createToken(read);
		await a.changePassword(PASSWORD, NEXT_PASSWORD, session.sessionId);
		expect(await a.authenticateToken(token)).toBeNull();
	});

	test("a failed password change leaves tokens alone", async () => {
		const { a, session } = await setup();
		const { token } = await a.createToken(read);
		await expect(
			a.changePassword("wrong password here", NEXT_PASSWORD, session.sessionId),
		).rejects.toBeDefined();
		expect(await a.authenticateToken(token)).not.toBeNull();
	});

	test("an owner reset removes every token", async () => {
		const { a } = await setup();
		const { token } = await a.createToken(read);
		await a.resetOwner();
		expect(await a.authenticateToken(token)).toBeNull();
		expect(await a.listTokens()).toHaveLength(0);
	});
});

describe("open streams", () => {
	test("end at once on revocation", async () => {
		const { a } = await setup();
		const { info } = await a.createToken(read);
		let ended = 0;
		a.watchToken(info.id, () => ended++);
		await a.revokeToken(info.id);
		expect(ended).toBe(1);
		expect(a.watchedStreams).toBe(0);
	});

	test("end on sign-out-everywhere", async () => {
		const { a } = await setup();
		const { info } = await a.createToken(read);
		let ended = 0;
		a.watchToken(info.id, () => ended++);
		await a.revokeAll();
		expect(ended).toBe(1);
	});

	test("end within a recheck when another process revokes", async () => {
		const { a, path } = await setup(undefined, { tokenStreamRecheckMs: 10 });
		const { info } = await a.createToken(read);
		let ended = 0;
		a.watchToken(info.id, () => ended++);
		const other = await AuthService.open(path);
		await other.revokeToken(info.id);
		other.close();
		for (let i = 0; i < 100 && ended === 0; i++) await Bun.sleep(10);
		expect(ended).toBe(1);
	});

	test("end within a recheck on expiry", async () => {
		const { a, clock } = await setup(undefined, { tokenStreamRecheckMs: 10 });
		const { info } = await a.createToken({ ...read, ttlMs: 60_000 });
		let ended = 0;
		a.watchToken(info.id, () => ended++);
		clock.t += 60_000;
		for (let i = 0; i < 100 && ended === 0; i++) await Bun.sleep(10);
		expect(ended).toBe(1);
	});
});

describe("rate limit", () => {
	test("a bucket per token, refilled over time", () => {
		const limiter = new TokenRateLimiter(2, 3);
		expect(limiter.take("a", 0)).toBe(0);
		expect(limiter.take("a", 0)).toBe(0);
		expect(limiter.take("a", 0)).toBe(0);
		expect(limiter.take("a", 0)).toBeGreaterThan(0);
		expect(limiter.take("b", 0)).toBe(0);
		expect(limiter.take("a", 500)).toBe(0);
	});
});

describe("the token audit log", () => {
	test("records the principal and outcome, never the secret", async () => {
		const { a } = await setup();
		const { token, info } = await a.createToken(read);
		const id = await a.beginTokenAction({
			tokenId: info.id,
			name: info.name,
			path: "tasks.create",
			project: "alpha",
		});
		await a.finishTokenAction(id, "ok");
		const [row] = await a.listTokenAudit();
		expect(row).toMatchObject({
			tokenId: info.id,
			path: "tasks.create",
			project: "alpha",
			outcome: "ok",
		});
		expect(JSON.stringify(row)).not.toContain(token);
	});
});
