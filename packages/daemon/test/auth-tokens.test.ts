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
	opts: {
		tokenStreamRecheckMs?: number;
		tokenAuditRetention?: { mutations: number; streams: number };
	} = {},
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

	const action = (tokenId: string, path = "tasks.update") => ({
		tokenId,
		name: "ci",
		path,
		project: "alpha",
	});

	test("refused calls cannot push a real action out of the log", async () => {
		const { a } = await setup(undefined, {
			tokenAuditRetention: { mutations: 5, streams: 5 },
		});
		const { info } = await a.createToken(read);
		await a.beginTokenAction(action(info.id, "tasks.create"));
		for (let i = 0; i < 300; i++)
			await a.recordTokenRefusal(action(info.id, "settings.update"));
		const rows = await a.listTokenAudit();
		expect(rows.map((r) => r.path)).toEqual(["tasks.create"]);
		expect(await a.tokenAuditCounters()).toMatchObject([
			{ tokenId: info.id, refused: 300, lastRefusedPath: "settings.update" },
		]);
	});

	test("stream opens cannot push a mutation out", async () => {
		const { a } = await setup(undefined, {
			tokenAuditRetention: { mutations: 5, streams: 3 },
		});
		const { info } = await a.createToken(read);
		await a.beginTokenAction(action(info.id, "tasks.create"));
		for (let i = 0; i < 40; i++)
			await a.beginTokenAction({
				...action(info.id, "live.events"),
				kind: "stream",
				outcome: "opened",
			});
		const rows = await a.listTokenAudit({ limit: 1000 });
		expect(rows.filter((r) => r.kind === "mutation")).toHaveLength(1);
		expect(rows.filter((r) => r.kind === "stream").length).toBeLessThanOrEqual(
			6,
		);
	});

	test("one token's volume cannot erase another's actions", async () => {
		const { a } = await setup(undefined, {
			tokenAuditRetention: { mutations: 4, streams: 4 },
		});
		const quiet = await a.createToken({ ...read, name: "quiet" });
		const noisy = await a.createToken({ ...read, name: "noisy" });
		await a.beginTokenAction(action(quiet.info.id, "tasks.create"));
		for (let i = 0; i < 40; i++)
			await a.beginTokenAction(action(noisy.info.id));
		const rows = await a.listTokenAudit({ limit: 1000 });
		expect(rows.some((r) => r.tokenId === quiet.info.id)).toBe(true);
	});

	test("anything dropped by retention is counted, so erasure is visible", async () => {
		const { a } = await setup(undefined, {
			tokenAuditRetention: { mutations: 4, streams: 4 },
		});
		const { info } = await a.createToken(read);
		for (let i = 0; i < 40; i++) await a.beginTokenAction(action(info.id));
		const [counter] = await a.tokenAuditCounters();
		const kept = (await a.listTokenAudit({ limit: 1000 })).length;
		expect(counter?.dropped).toBeGreaterThan(0);
		expect((counter?.dropped ?? 0) + kept).toBe(40);
	});

	test("retention holds for tokens writing in lockstep", async () => {
		const { a } = await setup(undefined, {
			tokenAuditRetention: { mutations: 4, streams: 4 },
		});
		const one = await a.createToken({ ...read, name: "one" });
		const two = await a.createToken({ ...read, name: "two" });
		for (let i = 0; i < 40; i++) {
			await a.beginTokenAction(action(one.info.id));
			await a.beginTokenAction(action(two.info.id));
		}
		for (const { info } of [one, two]) {
			const kept = await a.listTokenAudit({ tokenId: info.id, limit: 1000 });
			expect(kept.length).toBeLessThanOrEqual(8);
		}
	});

	test("it can be filtered to one token", async () => {
		const { a } = await setup();
		const one = await a.createToken({ ...read, name: "one" });
		const two = await a.createToken({ ...read, name: "two" });
		await a.beginTokenAction(action(one.info.id));
		await a.beginTokenAction(action(two.info.id));
		const rows = await a.listTokenAudit({ tokenId: two.info.id });
		expect(rows.map((r) => r.tokenId)).toEqual([two.info.id]);
	});

	test("an older database's refusals become the counter", async () => {
		const { a, path } = await setup();
		const { info } = await a.createToken(read);
		await a.beginTokenAction(action(info.id, "tasks.create"));
		a.close();
		auth = undefined;
		const { createClient } = await import("@libsql/client");
		const raw = createClient({ url: `file:${path}` });
		await raw.batch(
			[
				"DROP TABLE token_audit_counters",
				"DROP INDEX ix_token_audit_kind",
				"ALTER TABLE token_audit DROP COLUMN kind",
				{
					sql: "INSERT INTO token_audit (token_id, token_name, path, project, outcome, at) VALUES (?, 'ci', 'settings.get', NULL, 'refused', 5)",
					args: [info.id],
				},
				"PRAGMA user_version=4",
			],
			"write",
		);
		raw.close();
		auth = await AuthService.open(path);
		const rows = await auth.listTokenAudit();
		expect(rows.map((r) => [r.path, r.kind])).toEqual([
			["tasks.create", "mutation"],
		]);
		expect((await auth.tokenAuditCounters())[0]?.refused).toBe(1);
	});
});
