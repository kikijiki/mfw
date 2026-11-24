import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";
import {
	parseAssertionJSON,
	parseRegistrationJSON,
} from "../src/auth/passkeys.ts";
import {
	authenticationOptions,
	COSE_EDDSA,
	COSE_ES256,
	fromBase64url,
	isSafeEd25519Key,
	isWebAuthnError,
	type RelyingParty,
	registrationOptions,
	relyingPartyError,
	verifyAssertion,
	verifyRegistration,
	type WebAuthnFailure,
} from "../src/auth/webauthn.ts";
import {
	AT,
	BS,
	type CborIn,
	type CeremonyKnobs,
	coseKey,
	encodeCbor,
	type SoftAlg,
	SoftAuthenticator,
	UP,
	UV,
} from "./support/soft-authenticator.ts";

/**
 * The adapter around `@simplewebauthn/server`. The library's own parsing is
 * its business; these tests pin what mfw asks of it and, in "policy beyond the
 * library", each check mfw adds on top, shown against the library alone.
 */

const RP: RelyingParty = {
	rpId: "localhost",
	origin: "http://localhost:7777",
};
const CHALLENGE = Buffer.from("a challenge of thirty-two bytes!").toString(
	"base64url",
);
const USER = Buffer.from("owner-handle").toString("base64url");

function register(
	knobs: CeremonyKnobs & { alg?: SoftAlg } = {},
	expected: { challenge?: string; rp?: RelyingParty } = {},
) {
	const soft = new SoftAuthenticator(RP.origin);
	const { json, credential } = soft.create(
		{ challenge: CHALLENGE, rp: { id: RP.rpId }, user: { id: USER } },
		knobs,
	);
	const parsed = parseRegistrationJSON(json);
	if (!parsed) throw new Error("the soft authenticator sent malformed JSON");
	const want = {
		challenge: expected.challenge ?? CHALLENGE,
		rp: expected.rp ?? RP,
	};
	const run = () => verifyRegistration(parsed.response, want);
	/** The same response, verified by the library with mfw's options only. */
	const libraryAlone = () =>
		verifyRegistrationResponse({
			response: parsed.response,
			expectedChallenge: want.challenge,
			expectedOrigin: want.rp.origin,
			expectedRPID: want.rp.rpId,
			requireUserVerification: true,
			supportedAlgorithmIDs: [COSE_ES256, COSE_EDDSA],
		}).then((r) => r.verified);
	return { soft, json, credential, run, libraryAlone };
}

async function refusedWith(
	run: () => Promise<unknown>,
): Promise<WebAuthnFailure | "accepted"> {
	try {
		await run();
		return "accepted";
	} catch (e) {
		if (isWebAuthnError(e)) return e.reason;
		throw e;
	}
}

async function libraryVerdict(run: () => Promise<boolean>) {
	try {
		return (await run()) ? "accepted" : "unverified";
	} catch (e) {
		return `threw: ${(e as Error).message}`;
	}
}

const ed = (x: Uint8Array) =>
	new Map<number, CborIn>([
		[1, 1],
		[3, COSE_EDDSA],
		[-1, 6],
		[-2, x],
	]);
const hex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const IDENTITY =
	"0100000000000000000000000000000000000000000000000000000000000000";

async function setup(alg: SoftAlg = "ES256", signCount = 0) {
	const r = register({ alg, signCount });
	const reg = await r.run();
	const stored = {
		id: reg.credentialId,
		publicKey: reg.publicKey,
		signCount: reg.signCount,
	};
	const sign = (knobs: CeremonyKnobs = {}) => {
		const json = r.soft.get(
			{ challenge: CHALLENGE, rpId: RP.rpId },
			{ ...knobs, use: r.credential },
		);
		const parsed = parseAssertionJSON(json);
		if (!parsed) throw new Error("the soft authenticator sent malformed JSON");
		return parsed.response;
	};
	const assert =
		(
			knobs: CeremonyKnobs = {},
			expected: { challenge?: string; rp?: RelyingParty } = {},
		) =>
		() =>
			verifyAssertion(sign(knobs), stored, {
				challenge: expected.challenge ?? CHALLENGE,
				rp: expected.rp ?? RP,
			});
	return { stored, assert, sign, credential: r.credential };
}

describe("options handed to the browser", () => {
	test("registration: none, UV and a discoverable credential required, ES256 and EdDSA only", async () => {
		const o = await registrationOptions({
			rp: RP,
			challenge: CHALLENGE,
			userHandle: USER,
			exclude: [{ id: "AQID", transports: ["internal"] }],
			timeout: 1000,
		});
		expect(o.challenge).toBe(CHALLENGE);
		expect(o.user.id).toBe(USER);
		expect(o.rp.id).toBe("localhost");
		expect(o.attestation).toBe("none");
		expect(o.authenticatorSelection).toEqual({
			residentKey: "required",
			requireResidentKey: true,
			userVerification: "required",
		});
		// RS256 (-257), the library's default third algorithm, is not offered.
		expect(o.pubKeyCredParams.map((p) => p.alg)).toEqual([
			COSE_ES256,
			COSE_EDDSA,
		]);
		expect(o.extensions?.credProps).toBe(true);
		expect(o.excludeCredentials?.map((c) => c.id)).toEqual(["AQID"]);
	});

	test("sign-in: UV required and never a credential list", async () => {
		const o = await authenticationOptions({
			rp: RP,
			challenge: CHALLENGE,
			timeout: 1000,
		});
		expect(o.challenge).toBe(CHALLENGE);
		expect(o.rpId).toBe("localhost");
		expect(o.userVerification).toBe("required");
		expect(o.allowCredentials).toEqual([]);
	});
});

describe("registration", () => {
	for (const alg of ["ES256", "EdDSA"] as const)
		test(`${alg}: a none-attestation registration verifies`, async () => {
			const { run, credential, json } = register({ alg });
			const out = await run();
			expect(out.alg).toBe(alg === "ES256" ? COSE_ES256 : COSE_EDDSA);
			expect(out.credentialId).toBe(json.rawId);
			expect([...(fromBase64url(out.credentialId) as Uint8Array)]).toEqual([
				...credential.id,
			]);
			expect(out.signCount).toBe(0);
			expect(out.publicKey.length).toBeGreaterThan(30);
		});

	// Refused by the library with the options mfw passes it.
	const cases: [string, CeremonyKnobs][] = [
		["wrong client data type", { clientData: { type: "webauthn.get" } }],
		["another challenge (a replay)", { clientData: { challenge: "AAAA" } }],
		["another origin", { clientData: { origin: "http://localhost:7778" } }],
		["another RP ID hash", { rpId: "evil.example" }],
		["no user presence", { flags: UV | AT }],
		// "discouraged" user verification produces exactly this.
		["no user verification", { flags: UP | AT }],
		["no attested credential", { flags: UP | UV }],
		["backed up but not eligible", { flags: UP | UV | AT | BS }],
		["trailing bytes", { trailing: new Uint8Array([0]) }],
		[
			"a packed statement that does not verify",
			{
				fmt: "packed",
				attStmt: new Map<string, CborIn>([
					["alg", -7],
					["sig", new Uint8Array(70)],
				]),
			},
		],
	];
	for (const [name, knobs] of cases)
		test(`refused: ${name}`, async () => {
			expect(await refusedWith(register(knobs).run)).toBe("refused");
		});

	test("RS256 is refused", async () => {
		const rsa = new Map<number, CborIn>([
			[1, 3],
			[3, -257],
			[-1, new Uint8Array(256)],
			[-2, new Uint8Array([1, 0, 1])],
		]);
		expect(await refusedWith(register({ cose: rsa }).run)).toBe("refused");
	});

	test("the expected RP must be a secure, named origin", async () => {
		const { run } = register(
			{},
			{ rp: { rpId: "127.0.0.1", origin: "http://127.0.0.1:7777" } },
		);
		expect(await refusedWith(run)).toBe("rp_id");
	});
});

describe("assertion", () => {
	for (const alg of ["ES256", "EdDSA"] as const)
		test(`${alg}: a signed assertion verifies`, async () => {
			const { assert } = await setup(alg);
			expect((await assert()()).signCount).toBe(0);
		});

	test("a bad signature is refused", async () => {
		const es = await setup("ES256");
		expect(await refusedWith(es.assert({ badSignature: true }))).toBe(
			"signature",
		);
		const edd = await setup("EdDSA");
		expect(await refusedWith(edd.assert({ badSignature: true }))).toBe(
			"signature",
		);
	});

	const cases: [string, CeremonyKnobs][] = [
		["a create client data", { clientData: { type: "webauthn.create" } }],
		["another challenge (a replay)", { clientData: { challenge: "AAAA" } }],
		["another origin", { clientData: { origin: "https://evil.example" } }],
		["another RP ID", { rpId: "evil.example" }],
		["no user presence", { flags: UV }],
		["no user verification", { flags: UP }],
		["trailing bytes", { trailing: new Uint8Array([1]) }],
	];
	for (const [name, knobs] of cases)
		test(`refused: ${name}`, async () => {
			expect(await refusedWith((await setup()).assert(knobs))).toBe("refused");
		});

	test("the expected RP must be a secure, named origin", async () => {
		const { assert } = await setup();
		expect(
			await refusedWith(
				assert({}, { rp: { rpId: "box.ts.net", origin: "http://box.ts.net" } }),
			),
		).toBe("rp_id");
	});
});

describe("policy beyond the library", () => {
	test("a cross-origin registration: the library accepts it, mfw refuses", async () => {
		for (const clientData of [
			{ crossOrigin: true },
			{ crossOrigin: true, topOrigin: "https://evil.example" },
			{ topOrigin: "https://evil.example" },
		]) {
			const r = register({ clientData });
			expect(await libraryVerdict(r.libraryAlone)).toBe("accepted");
			expect(await refusedWith(r.run)).toBe("cross_origin");
		}
	});

	test("a cross-origin assertion without a top origin: the library accepts it, mfw refuses", async () => {
		const r = register();
		const reg = await r.run();
		const json = parseAssertionJSON(
			r.soft.get(
				{ challenge: CHALLENGE, rpId: RP.rpId },
				{ use: r.credential, clientData: { crossOrigin: true } },
			),
		)?.response;
		if (!json) throw new Error("malformed");
		const alone = () =>
			verifyAuthenticationResponse({
				response: json,
				expectedChallenge: CHALLENGE,
				expectedOrigin: RP.origin,
				expectedRPID: RP.rpId,
				credential: {
					id: reg.credentialId,
					publicKey: new Uint8Array(reg.publicKey),
					counter: 0,
				},
				requireUserVerification: true,
			}).then((v) => v.verified);
		expect(await libraryVerdict(alone)).toBe("accepted");
		expect(
			await refusedWith(() =>
				verifyAssertion(
					json,
					{ id: reg.credentialId, publicKey: reg.publicKey, signCount: 0 },
					{ challenge: CHALLENGE, rp: RP },
				),
			),
		).toBe("cross_origin");
	});

	test("a reported id that is not the credential's: the library accepts it, mfw refuses", async () => {
		const r = register({ rawId: new Uint8Array(32).fill(7) });
		expect(await libraryVerdict(r.libraryAlone)).toBe("accepted");
		expect(await refusedWith(r.run)).toBe("credential");
	});

	test("a key carrying a private component: the library accepts it, mfw refuses", async () => {
		const p = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey;
		const cose = coseKey(p, "ES256");
		cose.set(-4, new Uint8Array(32));
		const r = register({ cose });
		expect(await libraryVerdict(r.libraryAlone)).toBe("accepted");
		expect(await refusedWith(r.run)).toBe("key");
	});

	test("the Ed25519 identity key: the library verifies a forged signature, mfw refuses the key", async () => {
		const r = register({ cose: ed(hex(IDENTITY)), alg: "EdDSA" });
		expect(await libraryVerdict(r.libraryAlone)).toBe("accepted");
		expect(await refusedWith(r.run)).toBe("key");
		// The forgery: R = the identity, S = 0 holds for any message under A = 0.
		const publicKey = encodeCbor(ed(hex(IDENTITY)));
		const forged = {
			id: "AQID",
			rawId: "AQID",
			type: "public-key" as const,
			clientExtensionResults: {},
			response: {
				clientDataJSON: Buffer.from(
					JSON.stringify({
						type: "webauthn.get",
						challenge: CHALLENGE,
						origin: RP.origin,
						crossOrigin: false,
					}),
				).toString("base64url"),
				authenticatorData: Buffer.concat([
					new Bun.CryptoHasher("sha256").update(RP.rpId).digest(),
					Buffer.from([UP | UV, 0, 0, 0, 0]),
				]).toString("base64url"),
				signature: Buffer.concat([
					Buffer.from(IDENTITY, "hex"),
					Buffer.alloc(32),
				]).toString("base64url"),
			},
		};
		const alone = () =>
			verifyAuthenticationResponse({
				response: forged,
				expectedChallenge: CHALLENGE,
				expectedOrigin: RP.origin,
				expectedRPID: RP.rpId,
				credential: {
					id: "AQID",
					publicKey: new Uint8Array(publicKey),
					counter: 0,
				},
				requireUserVerification: true,
			}).then((v) => v.verified);
		expect(await libraryVerdict(alone)).toBe("accepted");
		expect(
			await refusedWith(() =>
				verifyAssertion(
					forged,
					{ id: "AQID", publicKey, signCount: 0 },
					{ challenge: CHALLENGE, rp: RP },
				),
			),
		).toBe("key");
	});

	const P_LE =
		"edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f";
	const unsafe: [string, string][] = [
		["the identity point", IDENTITY],
		[
			"the point of order 2 (y = -1)",
			"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
		],
		[
			"a point of order 4 (y = 0)",
			"0000000000000000000000000000000000000000000000000000000000000000",
		],
		[
			"a point of order 8",
			"26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
		],
		[
			"the other point of order 8, sign bit set",
			"c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
		],
		["a non-canonical y (y = p)", P_LE],
		[
			"a non-canonical y (y = p + 1, the identity again)",
			"eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
		],
		[
			"x = 0 with the sign bit set",
			"0100000000000000000000000000000000000000000000000000000000000080",
		],
	];
	for (const [name, x] of unsafe)
		test(`an unsafe Ed25519 key is refused: ${name}`, async () => {
			expect(isSafeEd25519Key(hex(x))).toBe(false);
			expect(
				await refusedWith(register({ cose: ed(hex(x)), alg: "EdDSA" }).run),
			).toBe("key");
		});

	test("the small-order list is the eight points of order 1, 2, 4 and 8", () => {
		// Little-endian y of each, from the decimal values (libsodium's list).
		const P = 2n ** 255n - 19n;
		const le = (v: bigint) => {
			const b = new Uint8Array(32);
			for (let i = 0; i < 32; i++) {
				b[i] = Number(v & 255n);
				v >>= 8n;
			}
			return b;
		};
		const a =
			2707385501144840649318225287225658788936804267575313519463743609750303402022n;
		const b =
			55188659117513257062467267217118295137698188065244968500265048394206261417927n;
		expect(a + b).toBe(P);
		for (const y of [0n, 1n, P - 1n, a, b])
			expect(isSafeEd25519Key(le(y))).toBe(false);
	});

	test("real Ed25519 keys are not refused", async () => {
		for (let i = 0; i < 200; i++) {
			const k = generateKeyPairSync("ed25519").publicKey.export({
				format: "jwk",
			}) as { x: string };
			expect(
				isSafeEd25519Key(new Uint8Array(Buffer.from(k.x, "base64url"))),
			).toBe(true);
		}
		expect(await refusedWith(register({ alg: "EdDSA" }).run)).toBe("accepted");
	});

	test("the counter must advance; zero on both sides (synced passkeys) is allowed", async () => {
		const { assert, stored } = await setup("ES256", 5);
		expect((await assert({ signCount: 6 })()).signCount).toBe(6);
		stored.signCount = 6;
		// A clone replays an old or equal counter.
		for (const signCount of [6, 2, 0])
			expect(await refusedWith(assert({ signCount }))).toBe("counter");
		const zero = await setup("ES256", 0);
		for (let i = 0; i < 3; i++)
			expect((await zero.assert({ signCount: 0 })()).signCount).toBe(0);
	});

	test("a counter refusal always means a valid signature: the library alone would say 'counter' for a forgery", async () => {
		const { sign, stored } = await setup("ES256", 5);
		stored.signCount = 6;
		const bad = sign({ signCount: 2, badSignature: true });
		// The library checks the counter before the signature.
		const alone = () =>
			verifyAuthenticationResponse({
				response: bad,
				expectedChallenge: CHALLENGE,
				expectedOrigin: RP.origin,
				expectedRPID: RP.rpId,
				credential: {
					id: stored.id,
					publicKey: new Uint8Array(stored.publicKey),
					counter: stored.signCount,
				},
				requireUserVerification: true,
			}).then((v) => v.verified);
		expect(await libraryVerdict(alone)).toMatch(/threw: .*counter/);
		// mfw: a bad signature is a bad signature, charged like a wrong password.
		expect(
			await refusedWith(() =>
				verifyAssertion(bad, stored, { challenge: CHALLENGE, rp: RP }),
			),
		).toBe("signature");
	});

	test("user verification absent, wrong origin, wrong RP ID: refused on both ceremonies", async () => {
		for (const knobs of [
			{ flags: UP | AT },
			{ clientData: { origin: "https://evil.example" } },
			{ rpId: "evil.example" },
		])
			expect(await refusedWith(register(knobs).run)).toBe("refused");
		const { assert } = await setup();
		for (const knobs of [
			{ flags: UP },
			{ clientData: { origin: "https://evil.example" } },
			{ rpId: "evil.example" },
		])
			expect(await refusedWith(assert(knobs))).toBe("refused");
	});
});

describe("relying party and encoding", () => {
	test("only secure, named origins", () => {
		expect(relyingPartyError(RP)).toBeNull();
		expect(
			relyingPartyError({
				rpId: "box.ts.net",
				origin: "https://box.ts.net:8443",
			}),
		).toBeNull();
		expect(
			relyingPartyError({ rpId: "box.ts.net", origin: "http://box.ts.net" }),
		).not.toBeNull();
		expect(
			relyingPartyError({ rpId: "10.0.0.1", origin: "https://10.0.0.1" }),
		).not.toBeNull();
		expect(
			relyingPartyError({ rpId: "box.ts.net", origin: "https://other.ts.net" }),
		).not.toBeNull();
		expect(
			relyingPartyError({
				rpId: "localhost",
				origin: "http://localhost:7777/",
			}),
		).not.toBeNull();
	});

	test("base64url is strict and canonical", () => {
		expect(fromBase64url("AQID")).toEqual(new Uint8Array([1, 2, 3]));
		expect(fromBase64url("AQ==")).toBeNull();
		expect(fromBase64url("AR")).toBeNull(); // non-zero trailing bits
		expect(fromBase64url("A+/")).toBeNull();
		expect(fromBase64url(42)).toBeNull();
		expect(fromBase64url("A".repeat(100), 10)).toBeNull();
		expect(fromBase64url(randomBytes(9).toString("base64url"))).not.toBeNull();
	});
});
