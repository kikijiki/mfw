import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AuthRefused,
	AuthService,
	BACKOFF_MAX_MS,
	backoffMs,
	FREE_ATTEMPTS,
	isAuthRefused,
	SESSION_ABSOLUTE_MS,
	SESSION_IDLE_MS,
	SETUP_TOKEN_TTL_MS,
} from "../src/auth/service.ts";

const PASSWORD = "correct horse battery";

let dir: string;
let path: string;
let clock: number;
let auth: AuthService;

const code = async (p: Promise<unknown>) => {
	try {
		await p;
		return "ok";
	} catch (e) {
		if (e instanceof AuthRefused) return e.code;
		throw e;
	}
};

async function owner() {
	const token = (await auth.beginFirstRun()) as string;
	return auth.setup(token, PASSWORD);
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "mfw-auth-"));
	path = join(dir, "auth.db");
	clock = 1_000_000_000;
	auth = await AuthService.open(path, { now: () => clock });
});

afterEach(() => {
	auth.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("setup token", () => {
	test("is stored only as a digest, in a private file", async () => {
		const token = (await auth.beginFirstRun()) as string;
		expect(token.length).toBeGreaterThanOrEqual(43);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readFileSync(path).includes(Buffer.from(token))).toBe(false);
	});

	test("is one-time, and none is issued once an owner exists", async () => {
		const token = (await auth.beginFirstRun()) as string;
		await auth.setup(token, PASSWORD);
		expect(await code(auth.setup(token, PASSWORD))).toBe("already_set_up");
		expect(await auth.beginFirstRun()).toBeNull();
	});

	test("a restart before setup invalidates the previous token", async () => {
		const first = (await auth.beginFirstRun()) as string;
		const second = (await auth.beginFirstRun()) as string;
		expect(second).not.toBe(first);
		expect(await code(auth.setup(first, PASSWORD))).toBe("invalid_token");
		expect(await code(auth.setup(second, PASSWORD))).toBe("ok");
	});

	test("expires", async () => {
		const token = (await auth.beginFirstRun()) as string;
		clock += SETUP_TOKEN_TTL_MS + 1;
		expect(await code(auth.setup(token, PASSWORD))).toBe("invalid_token");
	});

	test("a weak password does not burn the token", async () => {
		const token = (await auth.beginFirstRun()) as string;
		expect(await code(auth.setup(token, "short"))).toBe("weak_password");
		expect(await code(auth.setup(token, PASSWORD))).toBe("ok");
	});

	test("concurrent setups create exactly one owner", async () => {
		const token = (await auth.beginFirstRun()) as string;
		const results = await Promise.all([
			code(auth.setup(token, PASSWORD)),
			code(auth.setup(token, `${PASSWORD} two`)),
			code(auth.setup(token, `${PASSWORD} three`)),
		]);
		expect(results.filter((r) => r === "ok")).toHaveLength(1);
	});
});

describe("login and sessions", () => {
	test("the password is hashed with argon2id", async () => {
		await owner();
		const row = await (
			auth as unknown as {
				db: { client: { execute(s: string): Promise<{ rows: unknown[] }> } };
			}
		).db.client.execute("SELECT password_hash FROM principals");
		const hash = (row.rows[0] as { password_hash: string }).password_hash;
		expect(hash.startsWith("$argon2id$")).toBe(true);
	});

	test("login before setup is refused", async () => {
		expect(await code(auth.login(PASSWORD))).toBe("setup_required");
	});

	test("login rotates: the presented session dies, a new token is issued", async () => {
		const first = await owner();
		const second = await auth.login(PASSWORD, first.token);
		expect(second.token).not.toBe(first.token);
		expect(second.csrfToken).not.toBe(first.csrfToken);
		expect(await auth.authenticate(first.token)).toBeNull();
		expect((await auth.authenticate(second.token))?.principal.kind).toBe(
			"owner",
		);
	});

	test("a planted, unknown session id is never adopted", async () => {
		await owner();
		const planted = "attacker-chosen-value";
		const issued = await auth.login(PASSWORD, planted);
		expect(issued.token).not.toBe(planted);
		expect(await auth.authenticate(planted)).toBeNull();
	});

	test("logout revokes server-side", async () => {
		const s = await owner();
		await auth.logout(s.token);
		expect(await auth.authenticate(s.token)).toBeNull();
	});

	test("idle and absolute expiry both end a session", async () => {
		const s = await owner();
		clock += SESSION_IDLE_MS + 1;
		expect(await auth.authenticate(s.token)).toBeNull();

		const t = await auth.login(PASSWORD);
		for (let at = 0; at < SESSION_ABSOLUTE_MS; at += SESSION_IDLE_MS / 2) {
			clock += SESSION_IDLE_MS / 2;
			await auth.authenticate(t.token);
		}
		clock += 1;
		expect(await auth.authenticate(t.token)).toBeNull();
	});

	test("the CSRF token is bound to its session", async () => {
		const a = await owner();
		const b = await auth.login(PASSWORD);
		expect(auth.checkCsrf(a.token, a.csrfToken)).toBe(true);
		expect(auth.checkCsrf(a.token, b.csrfToken)).toBe(false);
		expect(auth.checkCsrf(a.token, "")).toBe(false);
		expect(auth.checkCsrf(a.token, null)).toBe(false);
	});
});

describe("brute force", () => {
	test("backoff grows and is capped", () => {
		expect(backoffMs(FREE_ATTEMPTS - 1)).toBe(0);
		expect(backoffMs(FREE_ATTEMPTS)).toBe(1000);
		expect(backoffMs(FREE_ATTEMPTS + 1)).toBe(2000);
		expect(backoffMs(FREE_ATTEMPTS + 100)).toBe(BACKOFF_MAX_MS);
	});

	test("locks after repeated failures, even for the right password", async () => {
		await owner();
		for (let i = 0; i < FREE_ATTEMPTS; i++)
			expect(await code(auth.login("wrong password!"))).toBe(
				"invalid_password",
			);
		expect(await code(auth.login(PASSWORD))).toBe("locked");
		clock += backoffMs(FREE_ATTEMPTS) + 1;
		expect(await code(auth.login(PASSWORD))).toBe("ok");
	});

	test("parallel guesses cannot outrun the lock", async () => {
		await owner();
		const results = await Promise.all(
			Array.from({ length: 20 }, () => code(auth.login("wrong password!"))),
		);
		expect(results.filter((r) => r === "invalid_password")).toHaveLength(
			FREE_ATTEMPTS,
		);
		expect(results.filter((r) => r === "locked")).toHaveLength(
			20 - FREE_ATTEMPTS,
		);
	});

	test("the lock survives a restart", async () => {
		await owner();
		for (let i = 0; i < FREE_ATTEMPTS; i++)
			await code(auth.login("wrong password!"));
		auth.close();
		auth = await AuthService.open(path, { now: () => clock });
		expect(await code(auth.login(PASSWORD))).toBe("locked");
	});

	test("setup token guesses are throttled too", async () => {
		await auth.beginFirstRun();
		for (let i = 0; i < FREE_ATTEMPTS; i++)
			expect(await code(auth.setup("guess", PASSWORD))).toBe("invalid_token");
		expect(await code(auth.setup("guess", PASSWORD))).toBe("locked");
	});
});

describe("isAuthRefused", () => {
	test("recognises a copy of the class from another bundle chunk", () => {
		class CopiedChunkError extends Error {
			override readonly name = "AuthRefused";
			readonly code = "locked";
		}
		const copy = new CopiedChunkError("locked");
		expect(copy instanceof AuthRefused).toBe(false);
		expect(isAuthRefused(copy)).toBe(true);
		expect(isAuthRefused(new AuthRefused("locked", "x"))).toBe(true);
		expect(isAuthRefused(new Error("other"))).toBe(false);
		expect(isAuthRefused(null)).toBe(false);
	});
});

describe("session watch", () => {
	test("ends at once on logout, and stops watching", async () => {
		const s = await owner();
		let ended = 0;
		auth.watchSession(s.sessionId, () => ended++);
		expect(auth.watchedStreams).toBe(1);
		await auth.logout(s.token);
		expect(ended).toBe(1);
		expect(auth.watchedStreams).toBe(0);
	});

	test("release stops the watch without ending it", async () => {
		const s = await owner();
		let ended = 0;
		const release = auth.watchSession(s.sessionId, () => ended++);
		release();
		await auth.logout(s.token);
		expect(ended).toBe(0);
		expect(auth.watchedStreams).toBe(0);
	});

	test("ends when the session expires", async () => {
		const quick = await AuthService.open(join(dir, "quick.db"), {
			now: () => clock,
			streamRecheckMs: 5,
		});
		try {
			const token = (await quick.beginFirstRun()) as string;
			const s = await quick.setup(token, PASSWORD);
			const ended = new Promise<boolean>((done) =>
				quick.watchSession(s.sessionId, () => done(true)),
			);
			clock += SESSION_IDLE_MS + 1;
			expect(
				await Promise.race([ended, Bun.sleep(2000).then(() => false)]),
			).toBe(true);
		} finally {
			quick.close();
		}
	});
});
