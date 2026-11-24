import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { CEREMONY_TTL_MS, MAX_PASSKEYS } from "../src/auth/passkeys.ts";
import {
	AuthService,
	type AuthService as AuthServiceT,
	FREE_ATTEMPTS,
	type IssuedSession,
	isAuthRefused,
} from "../src/auth/service.ts";
import { AUTH_SCHEMA_VERSION, openAuthDb } from "../src/auth/store.ts";
import type { RelyingParty } from "../src/auth/webauthn.ts";
import {
	type CeremonyKnobs,
	SoftAuthenticator,
	type SoftCredential,
	UP,
} from "./support/soft-authenticator.ts";

const PASSWORD = "correct horse battery";
const RP: RelyingParty = {
	rpId: "localhost",
	origin: "http://localhost:7777",
};

let dir: string;
let path: string;
let clock: number;
let auth: AuthServiceT;
let owner: IssuedSession;
let soft: SoftAuthenticator;

const code = async (p: Promise<unknown>) => {
	try {
		await p;
		return "ok";
	} catch (e) {
		if (isAuthRefused(e)) return e.code;
		throw e;
	}
};

async function open(opts: Parameters<typeof AuthService.open>[1] = {}) {
	auth = await AuthService.open(path, {
		now: () => clock,
		passwordCheckIntervalMs: 0,
		...opts,
	});
	const token = (await auth.beginFirstRun()) as string;
	owner = await auth.setup(token, PASSWORD);
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "mfw-passkey-"));
	path = join(dir, "auth.db");
	clock = 1_000_000_000;
	soft = new SoftAuthenticator(RP.origin);
	await open();
});

afterEach(() => {
	auth.close();
	rmSync(dir, { recursive: true, force: true });
});

/** Register a passkey on the owner's session, proving the password. */
async function addPasskey(
	knobs: CeremonyKnobs & { alg?: "ES256" | "EdDSA" } = {},
	name = "laptop",
	session = owner,
): Promise<SoftCredential> {
	const begun = await auth.beginPasskeyRegistration(session.sessionId, RP, {
		password: PASSWORD,
	});
	const { json, credential } = soft.create(begun.publicKey, knobs);
	await auth.finishPasskeyRegistration(
		session.sessionId,
		RP,
		begun.ceremonyId,
		json,
		name,
	);
	return credential;
}

async function passkeyLogin(
	knobs: CeremonyKnobs & { use?: SoftCredential } = {},
	source?: string,
	rp: RelyingParty = RP,
): Promise<IssuedSession> {
	const begun = await auth.beginPasskeyLogin(rp, source);
	const json = soft.get(begun.publicKey, knobs);
	return auth.passkeyLogin(begun.ceremonyId, json, rp, undefined, source);
}

describe("registration", () => {
	test("needs a fresh password; a wrong one is charged like a sign-in", async () => {
		expect(
			await code(
				auth.beginPasskeyRegistration(owner.sessionId, RP, {
					password: "not the password",
				}),
			),
		).toBe("invalid_password");
		// Same scope as password sign-in (no source here = 'unknown').
		for (let i = 1; i < FREE_ATTEMPTS; i++)
			await code(auth.login("nope nope nope"));
		expect(await code(auth.login(PASSWORD))).toBe("locked");
	});

	test("lists name, created and last used; never key material", async () => {
		clock += 1000;
		await addPasskey({}, "phone");
		const [info, ...rest] = await auth.listPasskeys();
		expect(rest).toEqual([]);
		expect(info?.name).toBe("phone");
		expect(info?.createdAt).toBe(clock);
		expect(info?.lastUsedAt).toBeNull();
		expect(info?.rpId).toBe("localhost");
		expect(info?.discoverable).toBe(true);
		expect(JSON.stringify(info)).not.toMatch(/public|credential_id|spki/i);
		clock += 5000;
		await passkeyLogin();
		expect((await auth.listPasskeys())[0]?.lastUsedAt).toBe(clock);
	});

	test("EdDSA passkeys work too", async () => {
		await addPasskey({ alg: "EdDSA" });
		expect((await passkeyLogin()).requestKey).toBeString();
	});

	test("user verification is required; 'discouraged' authenticators are refused", async () => {
		const begun = await auth.beginPasskeyRegistration(owner.sessionId, RP, {
			password: PASSWORD,
		});
		expect(begun.publicKey.authenticatorSelection.userVerification).toBe(
			"required",
		);
		expect(begun.publicKey.attestation).toBe("none");
		expect(begun.publicKey.authenticatorSelection.residentKey).toBe(
			"preferred",
		);
		const { json } = soft.create(begun.publicKey, { flags: UP | 0x40 });
		expect(
			await code(
				auth.finishPasskeyRegistration(
					owner.sessionId,
					RP,
					begun.ceremonyId,
					json,
					"x",
				),
			),
		).toBe("passkey_refused");
		expect(await auth.listPasskeys()).toEqual([]);
	});

	test("a registration ceremony is single use and bound to its session", async () => {
		const other = await auth.login(PASSWORD);
		const begun = await auth.beginPasskeyRegistration(owner.sessionId, RP, {
			password: PASSWORD,
		});
		const { json } = soft.create(begun.publicKey);
		// Another session cannot finish it, and trying spends it.
		expect(
			await code(
				auth.finishPasskeyRegistration(
					other.sessionId,
					RP,
					begun.ceremonyId,
					json,
					"x",
				),
			),
		).toBe("passkey_refused");
		expect(
			await code(
				auth.finishPasskeyRegistration(
					owner.sessionId,
					RP,
					begun.ceremonyId,
					json,
					"x",
				),
			),
		).toBe("passkey_refused");
		expect(await auth.listPasskeys()).toEqual([]);
	});

	test("a registration ceremony expires", async () => {
		const begun = await auth.beginPasskeyRegistration(owner.sessionId, RP, {
			password: PASSWORD,
		});
		const { json } = soft.create(begun.publicKey);
		clock += CEREMONY_TTL_MS + 1;
		expect(
			await code(
				auth.finishPasskeyRegistration(
					owner.sessionId,
					RP,
					begun.ceremonyId,
					json,
					"x",
				),
			),
		).toBe("passkey_refused");
	});

	test("a registration from another origin than it began on is refused", async () => {
		const tls: RelyingParty = {
			rpId: "localhost",
			origin: "https://localhost:7777",
		};
		const begun = await auth.beginPasskeyRegistration(owner.sessionId, RP, {
			password: PASSWORD,
		});
		const { json } = soft.create(begun.publicKey);
		expect(
			await code(
				auth.finishPasskeyRegistration(
					owner.sessionId,
					tls,
					begun.ceremonyId,
					json,
					"x",
				),
			),
		).toBe("passkey_refused");
	});

	test("a session that ends mid-registration stores nothing", async () => {
		const begun = await auth.beginPasskeyRegistration(owner.sessionId, RP, {
			password: PASSWORD,
		});
		const { json } = soft.create(begun.publicKey);
		await auth.revokeAll();
		expect(
			await code(
				auth.finishPasskeyRegistration(
					owner.sessionId,
					RP,
					begun.ceremonyId,
					json,
					"x",
				),
			),
		).toBe("passkey_refused");
		expect(await auth.listPasskeys()).toEqual([]);
	});

	test("a bare IP or plain-HTTP non-localhost origin cannot register", async () => {
		for (const rp of [
			{ rpId: "127.0.0.1", origin: "http://127.0.0.1:7777" },
			{ rpId: "box.example", origin: "http://box.example" },
		])
			expect(
				await code(
					auth.beginPasskeyRegistration(owner.sessionId, rp, {
						password: PASSWORD,
					}),
				),
			).toBe("passkey_unavailable");
	});

	test("the same credential cannot be registered twice, and the cap holds", async () => {
		const first = await auth.beginPasskeyRegistration(owner.sessionId, RP, {
			password: PASSWORD,
		});
		const { json } = soft.create(first.publicKey);
		await auth.finishPasskeyRegistration(
			owner.sessionId,
			RP,
			first.ceremonyId,
			json,
			"a",
		);
		const second = await auth.beginPasskeyRegistration(owner.sessionId, RP, {
			password: PASSWORD,
		});
		// The authenticator is told which credentials exist already.
		expect(second.publicKey.excludeCredentials.map((c) => c.id)).toEqual([
			json.rawId,
		]);
		// An authenticator that ignores the exclude list and reuses the id.
		const again = soft.create(second.publicKey, {
			credentialId: soft.credentials[0]?.id,
		});
		const refused = await auth
			.finishPasskeyRegistration(
				owner.sessionId,
				RP,
				second.ceremonyId,
				again.json,
				"b",
			)
			.catch((e) => e);
		expect(refused.code).toBe("passkey_refused");
		expect(refused.message).toMatch(/already registered/);
		expect(await auth.listPasskeys()).toHaveLength(1);
		for (let i = 1; i < MAX_PASSKEYS; i++) await addPasskey({}, `k${i}`);
		expect(
			await code(
				auth.beginPasskeyRegistration(owner.sessionId, RP, {
					password: PASSWORD,
				}),
			),
		).toBe("too_many_passkeys");
	});

	test("names are bounded and printable", async () => {
		const begun = await auth.beginPasskeyRegistration(owner.sessionId, RP, {
			password: PASSWORD,
		});
		const { json } = soft.create(begun.publicKey);
		expect(
			await code(
				auth.finishPasskeyRegistration(
					owner.sessionId,
					RP,
					begun.ceremonyId,
					json,
					"evil‮name",
				),
			),
		).toBe("invalid_request");
	});

	test("an existing passkey can be the re-verification", async () => {
		const first = await addPasskey();
		const reauth = await auth.beginPasskeyReauth(owner.sessionId, RP);
		const proof = soft.get(reauth.publicKey, { use: first });
		const begun = await auth.beginPasskeyRegistration(owner.sessionId, RP, {
			ceremonyId: reauth.ceremonyId,
			credential: proof,
		});
		const { json } = soft.create(begun.publicKey);
		await auth.finishPasskeyRegistration(
			owner.sessionId,
			RP,
			begun.ceremonyId,
			json,
			"second",
		);
		expect((await auth.listPasskeys()).map((p) => p.name)).toEqual([
			"laptop",
			"second",
		]);
		// A re-verification ceremony is this session's, and used once.
		const other = await auth.login(PASSWORD);
		const again = await auth.beginPasskeyReauth(owner.sessionId, RP);
		const proof2 = soft.get(again.publicKey, { use: first });
		expect(
			await code(
				auth.beginPasskeyRegistration(other.sessionId, RP, {
					ceremonyId: again.ceremonyId,
					credential: proof2,
				}),
			),
		).toBe("passkey_refused");
	});

	test("a sign-in ceremony is not a re-verification", async () => {
		const first = await addPasskey();
		const login = await auth.beginPasskeyLogin(RP);
		const proof = soft.get(login.publicKey, { use: first });
		expect(
			await code(
				auth.beginPasskeyRegistration(owner.sessionId, RP, {
					ceremonyId: login.ceremonyId,
					credential: proof,
				}),
			),
		).toBe("passkey_refused");
	});
});

describe("sign-in", () => {
	test("issues the same kind of session and request key as a password", async () => {
		await addPasskey();
		const s = await passkeyLogin();
		const session = await auth.authenticate(s.token);
		expect(session?.principal.kind).toBe("owner");
		expect(session?.principal.id).toBe(owner.principal.id);
		expect(auth.checkRequestKey(session as never, s.requestKey)).toBe(true);
		expect(auth.checkRequestKey(session as never, owner.requestKey)).toBe(
			false,
		);
	});

	test("discoverable credentials get an empty allow list; others are listed", async () => {
		await addPasskey();
		expect(
			(await auth.beginPasskeyLogin(RP)).publicKey.allowCredentials,
		).toEqual([]);
		await addPasskey({ rk: false }, "key");
		const listed = (await auth.beginPasskeyLogin(RP)).publicKey
			.allowCredentials;
		expect(listed).toHaveLength(2);
		expect((await auth.beginPasskeyLogin(RP)).publicKey.userVerification).toBe(
			"required",
		);
	});

	test("a ceremony is single use, even after success", async () => {
		await addPasskey();
		const begun = await auth.beginPasskeyLogin(RP);
		const json = soft.get(begun.publicKey);
		await auth.passkeyLogin(begun.ceremonyId, json, RP);
		expect(await code(auth.passkeyLogin(begun.ceremonyId, json, RP))).toBe(
			"passkey_refused",
		);
	});

	test("an expired ceremony is refused", async () => {
		await addPasskey();
		const begun = await auth.beginPasskeyLogin(RP);
		const json = soft.get(begun.publicKey);
		clock += CEREMONY_TTL_MS + 1;
		expect(await code(auth.passkeyLogin(begun.ceremonyId, json, RP))).toBe(
			"passkey_refused",
		);
	});

	test("a counter regression (a clone) is refused", async () => {
		const cred = await addPasskey({ signCount: 10 });
		await passkeyLogin({ use: cred, signCount: 11 });
		expect(await code(passkeyLogin({ use: cred, signCount: 11 }))).toBe(
			"passkey_refused",
		);
		expect(await code(passkeyLogin({ use: cred, signCount: 3 }))).toBe(
			"passkey_refused",
		);
		expect(
			(await passkeyLogin({ use: cred, signCount: 12 })).token,
		).toBeString();
	});

	test("no user verification, a bad signature or another origin is refused", async () => {
		const cred = await addPasskey();
		expect(await code(passkeyLogin({ use: cred, flags: UP }))).toBe(
			"passkey_refused",
		);
		expect(await code(passkeyLogin({ use: cred, badSignature: true }))).toBe(
			"passkey_refused",
		);
		expect(
			await code(
				passkeyLogin({
					use: cred,
					clientData: { origin: "http://localhost:7778" },
				}),
			),
		).toBe("passkey_refused");
	});

	test("a credential registered for another RP ID is refused here", async () => {
		await addPasskey();
		const other: RelyingParty = {
			rpId: "box.example",
			origin: "https://box.example",
		};
		const elsewhere = new SoftAuthenticator(other.origin);
		const begun = await auth.beginPasskeyLogin(other);
		const json = elsewhere.get(
			{ ...begun.publicKey, rpId: other.rpId },
			{ use: soft.credentials[0] },
		);
		expect(await code(auth.passkeyLogin(begun.ceremonyId, json, other))).toBe(
			"passkey_refused",
		);
	});

	test("a wrong user handle is refused", async () => {
		const cred = await addPasskey();
		expect(
			await code(
				passkeyLogin({ use: cred, userHandle: new Uint8Array([1, 2, 3]) }),
			),
		).toBe("passkey_refused");
	});

	test("failures share the password's per-source throttle; other sources are unaffected", async () => {
		const cred = await addPasskey();
		for (let i = 0; i < FREE_ATTEMPTS; i++)
			await code(passkeyLogin({ use: cred, badSignature: true }, "10.0.0.9"));
		// The flooding source is locked for passwords AND new passkey challenges.
		expect(await code(auth.login(PASSWORD, undefined, "10.0.0.9"))).toBe(
			"locked",
		);
		expect(await code(auth.beginPasskeyLogin(RP, "10.0.0.9"))).toBe("locked");
		// The owner elsewhere signs in either way.
		expect(await code(auth.login(PASSWORD, undefined, "10.0.0.1"))).toBe("ok");
		expect(await code(passkeyLogin({ use: cred }, "10.0.0.1"))).toBe("ok");
		await auth.unlock();
		expect(await code(passkeyLogin({ use: cred }, "10.0.0.9"))).toBe("ok");
	});

	test("a flood of challenges from one source does not crowd out another", async () => {
		const cred = await addPasskey();
		for (let i = 0; i < 500; i++) await auth.beginPasskeyLogin(RP, "10.0.0.9");
		expect(auth.pendingPasskeyCeremonies).toBeLessThanOrEqual(5);
		expect(await code(passkeyLogin({ use: cred }, "10.0.0.1"))).toBe("ok");
	});

	test("forged proxied sources are capped as a pool and paced like passwords", async () => {
		const cred = await addPasskey();
		let busy = 0;
		for (let i = 0; i < 300; i++) {
			const r = await code(
				auth.beginPasskeyLogin(RP, {
					address: `10.1.${i >> 8}.${i & 255}`,
					viaProxy: true,
				} as never),
			);
			if (r === "busy") busy++;
		}
		expect(busy).toBeGreaterThan(0);
		// A direct source still has its own room.
		expect(await code(passkeyLogin({ use: cred }, "10.0.0.1"))).toBe("ok");
	});
});

describe("credential epoch and revocation", () => {
	test("a password change revokes passkey sessions and keeps the passkeys", async () => {
		await addPasskey();
		const viaPasskey = await passkeyLogin();
		await auth.changePassword(
			PASSWORD,
			"another long password",
			owner.sessionId,
		);
		expect(await auth.authenticate(viaPasskey.token)).toBeNull();
		expect(await auth.listPasskeys()).toHaveLength(1);
		expect((await passkeyLogin()).token).toBeString();
	});

	test("sign out everywhere revokes passkey sessions and keeps the passkeys", async () => {
		await addPasskey();
		const viaPasskey = await passkeyLogin();
		await auth.revokeAll();
		expect(await auth.authenticate(viaPasskey.token)).toBeNull();
		expect(await auth.listPasskeys()).toHaveLength(1);
		expect((await passkeyLogin()).token).toBeString();
	});

	test("a passkey sign-in racing a password change does not outlive it", async () => {
		auth.close();
		rmSync(dir, { recursive: true, force: true });
		dir = mkdtempSync(join(tmpdir(), "mfw-passkey-"));
		path = join(dir, "auth.db");
		let race: (() => Promise<void>) | null = null;
		await open({
			afterPasswordCheck: async () => {
				const run = race;
				race = null;
				await run?.();
			},
		});
		await addPasskey();
		// Fires once, inside the passkey sign-in, after verification.
		race = () => auth.revokeAll();
		expect(await code(passkeyLogin())).toBe("invalid_password");
		const live = await createClient({ url: `file:${path}` }).execute(
			"SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NULL",
		);
		expect(Number(live.rows[0]?.n)).toBe(0);
	});

	test("revoking a passkey ends its sessions only, and it can no longer sign in", async () => {
		const cred = await addPasskey();
		const viaPasskey = await passkeyLogin({ use: cred });
		const [info] = await auth.listPasskeys();
		expect(await auth.revokePasskey(info?.id as string)).toBe(true);
		expect(await auth.revokePasskey(info?.id as string)).toBe(false);
		expect(await auth.authenticate(viaPasskey.token)).toBeNull();
		expect(await auth.authenticate(owner.token)).not.toBeNull();
		expect(await code(passkeyLogin({ use: cred }))).toBe("passkey_refused");
	});

	test("ending a session drops its pending ceremonies", async () => {
		await auth.beginPasskeyRegistration(owner.sessionId, RP, {
			password: PASSWORD,
		});
		expect(auth.pendingPasskeyCeremonies).toBe(1);
		await auth.logout(owner.token);
		expect(auth.pendingPasskeyCeremonies).toBe(0);
	});

	test("reset removes passkeys", async () => {
		await addPasskey();
		await auth.resetOwner();
		const raw = createClient({ url: `file:${path}` });
		const r = await raw.execute("SELECT COUNT(*) AS n FROM passkeys");
		raw.close();
		expect(Number(r.rows[0]?.n)).toBe(0);
	});
});

describe("schema", () => {
	test("schema 5 upgrades to 6 with owner, sessions and tokens intact", async () => {
		auth.close();
		const old = join(dir, "old.db");
		const db = await openAuthDb(old, { version: 5 });
		const sha = (s: string) => createHash("sha256").update(s).digest("hex");
		const cookie = "c".repeat(43);
		const key = "k".repeat(43);
		const hash = await Bun.password.hash(PASSWORD, { algorithm: "argon2id" });
		await db.client.batch(
			[
				{
					sql: "INSERT INTO principals (id, kind, display_name, password_hash, created_at, updated_at, credential_epoch) VALUES ('p1', 'owner', 'Owner', ?, 1, 1, 3)",
					args: [hash],
				},
				{
					sql: "INSERT INTO auth_sessions (id, token_hash, principal_id, created_at, last_seen_at, expires_at, request_key_hash) VALUES ('s1', ?, 'p1', ?, ?, ?, ?)",
					args: [sha(cookie), clock, clock, clock + 1e9, sha(key)],
				},
				{
					sql: "INSERT INTO api_tokens (id, name, token_hash, principal_id, scopes, created_at, expires_at) VALUES ('tok_1', 'ci', 'h', 'p1', '[\"status:read\"]', 1, ?)",
					args: [clock + 1e9],
				},
			],
			"write",
		);
		db.close();
		auth = await AuthService.open(old, {
			now: () => clock,
			passwordCheckIntervalMs: 0,
		});
		const session = await auth.authenticate(cookie);
		expect(session?.principal.id).toBe("p1");
		expect(auth.checkRequestKey(session as never, key)).toBe(true);
		expect((await auth.listTokens()).map((t) => t.id)).toEqual(["tok_1"]);
		expect(await auth.listPasskeys()).toEqual([]);
		expect(await code(auth.login(PASSWORD))).toBe("ok");
		const raw = createClient({ url: `file:${old}` });
		const v = await raw.execute("PRAGMA user_version");
		const epoch = await raw.execute("SELECT credential_epoch FROM principals");
		raw.close();
		expect(Number(v.rows[0]?.user_version)).toBe(AUTH_SCHEMA_VERSION);
		expect(AUTH_SCHEMA_VERSION).toBe(6);
		expect(Number(epoch.rows[0]?.credential_epoch)).toBe(3);
		// Passkeys work on the upgraded database.
		owner = session as unknown as IssuedSession;
		const begun = await auth.beginPasskeyRegistration("s1", RP, {
			password: PASSWORD,
		});
		const { json } = soft.create(begun.publicKey);
		await auth.finishPasskeyRegistration("s1", RP, begun.ceremonyId, json, "k");
		expect((await passkeyLogin()).token).toBeString();
	});

	test("a newer schema is refused", async () => {
		auth.close();
		const raw = createClient({ url: `file:${path}` });
		await raw.execute(`PRAGMA user_version=${AUTH_SCHEMA_VERSION + 1}`);
		raw.close();
		await expect(AuthService.open(path)).rejects.toThrow(
			/newer than this build/,
		);
		auth = await AuthService.open(join(dir, "fresh.db"));
	});
});
