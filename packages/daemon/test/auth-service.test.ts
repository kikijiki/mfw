import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AuthRefused,
	AuthService,
	assertPasswordPolicy,
	BACKOFF_MAX_MS,
	backoffMs,
	FREE_ATTEMPTS,
	isAuthRefused,
	LOOPBACK_SOURCE,
	SESSION_ABSOLUTE_MS,
	SESSION_IDLE_MS,
	SETUP_TOKEN_TTL_MS,
	throttleSource,
} from "../src/auth/service.ts";

const PASSWORD = "correct horse battery";

let dir: string;
let path: string;
let clock: number;
let auth: AuthService;

const loginFrom = (password: string, source: string) =>
	auth.login(password, undefined, source);

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
	auth = await AuthService.open(path, {
		now: () => clock,
		passwordCheckIntervalMs: 0,
	});
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
		expect(second.requestKey).not.toBe(first.requestKey);
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

	test("the request key is bound to its session and stored only hashed", async () => {
		const a = await owner();
		const b = await auth.login(PASSWORD);
		const sa = await auth.authenticate(a.token);
		if (!sa) throw new Error("no session");
		expect(auth.checkRequestKey(sa, a.requestKey)).toBe(true);
		expect(auth.checkRequestKey(sa, b.requestKey)).toBe(false);
		expect(auth.checkRequestKey(sa, a.token)).toBe(false);
		expect(auth.checkRequestKey(sa, "")).toBe(false);
		expect(auth.checkRequestKey(sa, null)).toBe(false);
		expect(sa.requestKeyHash).not.toBe(a.requestKey);
		expect(readFileSync(path).includes(Buffer.from(a.requestKey))).toBe(false);
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
		// One attempt per source at a time: the rest never reach the hash.
		expect(results.filter((r) => r === "invalid_password")).toHaveLength(1);
		expect(results.filter((r) => r === "locked")).toHaveLength(19);
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

describe("an attacker cannot lock the owner out (reviewer B2)", () => {
	const login = loginFrom;

	test("days of slow guesses from one source never block another", async () => {
		await owner();
		let ownerOk = 0;
		let ownerTries = 0;
		for (let i = 0; i < 2 * 24 * 4; i++) {
			await code(login("wrong password!", "10.0.0.66"));
			clock += 5 * 60 * 1000;
			// The owner tries every few hours, always mid-lock for the attacker.
			if (i % 8 === 0) {
				ownerTries++;
				if ((await code(login(PASSWORD, "10.0.0.1"))) === "ok") ownerOk++;
			}
			clock += 10 * 60 * 1000;
		}
		expect(ownerTries).toBeGreaterThan(10);
		expect(ownerOk).toBe(ownerTries);
	}, 30_000);

	test("a source locks only itself", async () => {
		await owner();
		for (let i = 0; i < FREE_ATTEMPTS; i++)
			await code(login("wrong password!", "10.0.0.66"));
		expect(await code(login(PASSWORD, "10.0.0.66"))).toBe("locked");
		expect(await code(login(PASSWORD, "10.0.0.1"))).toBe("ok");
	});

	test("a flood from one source still lets a correct password through", async () => {
		await owner();
		const flood = Array.from({ length: 30 }, () =>
			code(login("wrong password!", "10.0.0.66")),
		);
		const mine = code(login(PASSWORD, "10.0.0.1"));
		expect(await mine).toBe("ok");
		await Promise.all(flood);
	});

	test("a new setup token clears the setup throttle", async () => {
		await auth.beginFirstRun();
		for (let i = 0; i < FREE_ATTEMPTS; i++)
			await code(auth.setup("guess", PASSWORD, "10.0.0.66"));
		const fresh = (await auth.beginFirstRun()) as string;
		expect(await code(auth.setup(fresh, PASSWORD, "10.0.0.66"))).toBe("ok");
	});

	test("setup guesses from one source do not block another", async () => {
		const token = (await auth.beginFirstRun()) as string;
		for (let i = 0; i < FREE_ATTEMPTS + 2; i++)
			await code(auth.setup("guess", PASSWORD, "10.0.0.66"));
		expect(await code(auth.setup(token, PASSWORD, "10.0.0.1"))).toBe("ok");
	});

	test("unlock clears every throttle", async () => {
		await owner();
		for (let i = 0; i < FREE_ATTEMPTS; i++)
			await code(login("wrong password!", "127.0.0.1"));
		expect(await code(login(PASSWORD, "127.0.0.1"))).toBe("locked");
		await auth.unlock();
		expect(await code(login(PASSWORD, "127.0.0.1"))).toBe("ok");
	});

	test("addresses normalise to one source", () => {
		expect(throttleSource("::ffff:10.0.0.5")).toBe("10.0.0.5");
		expect(throttleSource("2001:db8:1:2:3:4:5:6")).toBe(
			throttleSource("2001:db8:1:2:ffff:ffff:ffff:ffff"),
		);
		expect(throttleSource("2001:db8:1:2::1")).not.toBe(
			throttleSource("2001:db8:1:3::1"),
		);
		// Tailnet nodes share a /64, so each is its own source (review F1).
		expect(throttleSource("fd7a:115c:a1e0::aaaa")).not.toBe(
			throttleSource("fd7a:115c:a1e0::bbbb"),
		);
		expect(throttleSource("FD7A:115C:A1E0:0::AAAA")).toBe(
			throttleSource("fd7a:115c:a1e0::aaaa"),
		);
		expect(throttleSource("fd7a:115c:a1e1::aaaa")).toBe(
			throttleSource("fd7a:115c:a1e1::bbbb"),
		);
		expect(throttleSource(undefined)).toBe("unknown");
		expect(throttleSource("")).toBe("unknown");
	});
});

describe("evicting a stolen session (reviewer M4)", () => {
	const NEXT = "a different long passphrase";

	test("a password change needs the current password", async () => {
		const s = await owner();
		expect(
			await code(auth.changePassword("wrong password!", NEXT, s.sessionId)),
		).toBe("invalid_password");
		expect(await code(auth.login(PASSWORD))).toBe("ok");
	});

	test("it revokes every other session and keeps this one", async () => {
		const mine = await owner();
		const stolen = await auth.login(PASSWORD);
		await auth.changePassword(PASSWORD, NEXT, mine.sessionId);
		expect(await auth.authenticate(stolen.token)).toBeNull();
		expect(await auth.authenticate(mine.token)).not.toBeNull();
		expect(await code(auth.login(PASSWORD))).toBe("invalid_password");
		expect(await code(auth.login(NEXT))).toBe("ok");
	});

	test("it ends the other sessions' open streams", async () => {
		const mine = await owner();
		const stolen = await auth.login(PASSWORD);
		let ended = 0;
		auth.watchSession(stolen.sessionId, () => ended++);
		await auth.changePassword(PASSWORD, NEXT, mine.sessionId);
		expect(ended).toBe(1);
	});

	test("the new password must meet the policy", async () => {
		const s = await owner();
		expect(
			await code(auth.changePassword(PASSWORD, "short", s.sessionId)),
		).toBe("weak_password");
		expect(await code(auth.login(PASSWORD))).toBe("ok");
	});

	test("wrong current passwords are throttled like logins", async () => {
		const s = await owner();
		for (let i = 0; i < FREE_ATTEMPTS; i++)
			await code(
				auth.changePassword("wrong password!", NEXT, s.sessionId, "10.0.0.9"),
			);
		expect(
			await code(auth.changePassword(PASSWORD, NEXT, s.sessionId, "10.0.0.9")),
		).toBe("locked");
	});

	test("sign out everywhere revokes every session", async () => {
		const a = await owner();
		const b = await auth.login(PASSWORD);
		await auth.revokeAll();
		expect(await auth.authenticate(a.token)).toBeNull();
		expect(await auth.authenticate(b.token)).toBeNull();
	});
});

describe("setup retries and the password policy (reviewer m4, m5)", () => {
	test("weak-password retries with a valid token are not throttled", async () => {
		const token = (await auth.beginFirstRun()) as string;
		for (let i = 0; i < FREE_ATTEMPTS + 3; i++)
			expect(await code(auth.setup(token, "short"))).toBe("weak_password");
		expect(await code(auth.setup(token, PASSWORD))).toBe("ok");
	});

	for (const bad of [
		"password1234",
		"PASSWORD1234",
		"123456789012",
		"qwertyuiop123",
		"correcthorsebatterystaple",
		"Correct Horse Battery Staple",
		"aaaaaaaaaaaaaaaa",
		"abababababababab",
	])
		test(`refuses the common password ${bad}`, () => {
			expect(() => assertPasswordPolicy(bad)).toThrow();
		});

	test("accepts a long uncommon passphrase", () => {
		expect(() => assertPasswordPolicy(PASSWORD)).not.toThrow();
	});
});

describe("loopback is one source (recheck N1)", () => {
	for (const address of [
		"127.0.0.1",
		"127.0.0.2",
		"127.66.0.9",
		"127.255.255.254",
		"::1",
		"0:0:0:0:0:0:0:1",
		"0000:0000:0000:0000:0000:0000:0000:0001",
		"[::1]",
		"::1%lo",
		"::ffff:127.0.0.1",
		"::ffff:127.9.8.7",
		"::ffff:7f00:1",
		"0:0:0:0:0:ffff:7f42:0102",
	])
		test(`${address} is loopback`, () => {
			expect(throttleSource(address)).toBe(LOOPBACK_SOURCE);
		});

	for (const address of ["128.0.0.1", "10.127.0.1", "::2", "::ffff:128.0.0.1"])
		test(`${address} is not loopback`, () => {
			expect(throttleSource(address)).not.toBe(LOOPBACK_SOURCE);
		});

	test("rotating loopback addresses does not escape the lock", async () => {
		await owner();
		for (let i = 1; i <= FREE_ATTEMPTS; i++)
			expect(
				await code(auth.login("wrong password!", undefined, `127.66.0.${i}`)),
			).toBe("invalid_password");
		expect(
			await code(auth.login("wrong password!", undefined, "127.66.0.99")),
		).toBe("locked");
		expect(await code(auth.login(PASSWORD, undefined, "::1"))).toBe("locked");
		await auth.unlock();
		expect(await code(auth.login(PASSWORD, undefined, "127.0.0.1"))).toBe("ok");
	});
});

describe("the password queue is bounded (recheck N1)", () => {
	test("a full queue refuses new attempts with a retry time, and queued ones finish", async () => {
		const small = await AuthService.open(join(dir, "queue.db"), {
			now: () => clock,
			passwordCheckIntervalMs: 20,
			maxQueuedPasswordChecks: 3,
		});
		try {
			await small.setup((await small.beginFirstRun()) as string, PASSWORD);
			const queued = [
				small.login(PASSWORD, undefined, "10.0.1.1"),
				small.login("wrong password!", undefined, "10.0.1.2"),
				small.login(PASSWORD, undefined, "10.0.1.3"),
			];
			let refused: unknown;
			await small.login(PASSWORD, undefined, "10.0.1.4").catch((e) => {
				refused = e;
			});
			expect(isAuthRefused(refused) && refused.code).toBe("busy");
			expect((refused as AuthRefused).retryAfterMs).toBeGreaterThan(0);
			expect(await code(queued[0] as Promise<unknown>)).toBe("ok");
			expect(await code(queued[1] as Promise<unknown>)).toBe(
				"invalid_password",
			);
			expect(await code(queued[2] as Promise<unknown>)).toBe("ok");
			expect(await code(small.login(PASSWORD, undefined, "10.0.1.4"))).toBe(
				"ok",
			);
		} finally {
			small.close();
		}
	});
});

describe("a login cannot outlive a credential change (recheck N3)", () => {
	const NEXT = "a different long passphrase";

	/** A service whose next password check pauses after verifying, until released. */
	async function paused() {
		let reached = () => {};
		let release = () => {};
		const atHook = new Promise<void>((r) => {
			reached = r;
		});
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let armed = false;
		const svc = await AuthService.open(join(dir, "race.db"), {
			now: () => clock,
			passwordCheckIntervalMs: 0,
			afterPasswordCheck: async () => {
				if (!armed) return;
				armed = false;
				reached();
				await gate;
			},
		});
		const first = await svc.setup(
			(await svc.beginFirstRun()) as string,
			PASSWORD,
		);
		return {
			svc,
			first,
			atHook,
			release,
			arm: () => {
				armed = true;
			},
		};
	}

	test("a verified login is refused if the password changed before it issued", async () => {
		const { svc, first, atHook, release, arm } = await paused();
		try {
			arm();
			const late = svc.login(PASSWORD, undefined, "10.0.2.1");
			await atHook;
			await svc.changePassword(PASSWORD, NEXT, first.sessionId, "10.0.2.2");
			release();
			expect(await code(late)).toBe("invalid_password");
			expect(await code(svc.login(PASSWORD, undefined, "10.0.2.3"))).toBe(
				"invalid_password",
			);
			expect(await code(svc.login(NEXT, undefined, "10.0.2.4"))).toBe("ok");
		} finally {
			svc.close();
		}
	});

	test("a verified login is refused if everyone was signed out before it issued", async () => {
		const { svc, atHook, release, arm } = await paused();
		try {
			arm();
			const late = svc.login(PASSWORD, undefined, "10.0.2.1");
			await atHook;
			await svc.revokeAll();
			release();
			expect(await code(late)).toBe("invalid_password");
			expect(await code(svc.login(PASSWORD, undefined, "10.0.2.3"))).toBe("ok");
		} finally {
			svc.close();
		}
	});

	test("a refused late login leaves no session behind", async () => {
		const { svc, first, atHook, release, arm } = await paused();
		try {
			arm();
			const late = svc.login(PASSWORD, undefined, "10.0.2.1");
			await atHook;
			await svc.changePassword(PASSWORD, NEXT, first.sessionId, "10.0.2.2");
			release();
			await code(late);
			const rows = await (
				svc as unknown as {
					db: { client: { execute(q: string): Promise<{ rows: unknown[] }> } };
				}
			).db.client.execute(
				"SELECT id FROM auth_sessions WHERE revoked_at IS NULL",
			);
			expect(rows.rows).toHaveLength(1);
		} finally {
			svc.close();
		}
	});

	test("two racing password changes: only one wins", async () => {
		const { svc, first, atHook, release, arm } = await paused();
		try {
			arm();
			const slow = svc.changePassword(
				PASSWORD,
				"the slower passphrase",
				first.sessionId,
				"10.0.2.1",
			);
			await atHook;
			await svc.changePassword(PASSWORD, NEXT, first.sessionId, "10.0.2.2");
			release();
			expect(await code(slow)).toBe("invalid_password");
			expect(await code(svc.login(NEXT, undefined, "10.0.2.3"))).toBe("ok");
		} finally {
			svc.close();
		}
	});

	test("a login overlapping a change never leaves a live session", async () => {
		const svc = await AuthService.open(join(dir, "queued.db"), {
			now: () => clock,
			passwordCheckIntervalMs: 30,
		});
		try {
			const first = await svc.setup(
				(await svc.beginFirstRun()) as string,
				PASSWORD,
			);
			const change = svc.changePassword(
				PASSWORD,
				NEXT,
				first.sessionId,
				"10.0.2.1",
			);
			// Either refused, or issued just before the change and revoked by it.
			const late = svc.login(PASSWORD, undefined, "10.0.2.2").catch(() => null);
			const [, session] = await Promise.all([change, late]);
			if (session) expect(await svc.authenticate(session.token)).toBeNull();
			expect(await code(svc.login(PASSWORD, undefined, "10.0.2.3"))).toBe(
				"invalid_password",
			);
		} finally {
			svc.close();
		}
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
