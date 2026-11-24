import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
	COSE_EDDSA,
	COSE_ES256,
	decodeCbor,
	decodeCborExact,
	fromBase64url,
	isWebAuthnError,
	parseAuthenticatorData,
	type RelyingParty,
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
	ED,
	encodeCbor,
	type SoftAlg,
	SoftAuthenticator,
	UP,
	UV,
} from "./support/soft-authenticator.ts";

const RP: RelyingParty = {
	rpId: "localhost",
	origin: "http://localhost:7777",
};
const CHALLENGE = Buffer.from("a challenge of thirty-two bytes!").toString(
	"base64url",
);
const USER = Buffer.from("owner-handle").toString("base64url");

const bytes = (s: string) => fromBase64url(s) as Uint8Array;

function register(
	knobs: CeremonyKnobs & { alg?: SoftAlg } = {},
	rp: RelyingParty = RP,
	expected: { challenge?: string; rp?: RelyingParty } = {},
) {
	const soft = new SoftAuthenticator(rp.origin);
	const { json, credential } = soft.create(
		{ challenge: CHALLENGE, rp: { id: rp.rpId }, user: { id: USER } },
		knobs,
	);
	const run = () =>
		verifyRegistration(
			{
				clientDataJSON: bytes(json.response.clientDataJSON),
				attestationObject: bytes(json.response.attestationObject),
				rawId: bytes(json.rawId),
			},
			{ challenge: expected.challenge ?? CHALLENGE, rp: expected.rp ?? rp },
		);
	return { soft, json, credential, run };
}

function refusedWith(run: () => unknown): WebAuthnFailure | "accepted" {
	try {
		run();
		return "accepted";
	} catch (e) {
		if (isWebAuthnError(e)) return e.reason;
		throw e;
	}
}

describe("registration", () => {
	for (const alg of ["ES256", "EdDSA"] as const)
		test(`${alg}: a none-attestation registration verifies`, () => {
			const { run, credential } = register({ alg });
			const out = run();
			expect(out.alg).toBe(alg === "ES256" ? COSE_ES256 : COSE_EDDSA);
			expect([...out.credentialId]).toEqual([...credential.id]);
			expect(out.signCount).toBe(0);
			expect(out.publicKeySpki.length).toBeGreaterThan(30);
		});

	const cases: [string, CeremonyKnobs, WebAuthnFailure][] = [
		[
			"wrong client data type",
			{ clientData: { type: "webauthn.get" } },
			"client_data",
		],
		["another challenge", { clientData: { challenge: "AAAA" } }, "challenge"],
		[
			"another origin",
			{ clientData: { origin: "http://localhost:7778" } },
			"origin",
		],
		[
			"a cross-origin frame",
			{ clientData: { crossOrigin: true } },
			"cross_origin",
		],
		[
			"a top origin",
			{ clientData: { topOrigin: "https://evil.example" } },
			"cross_origin",
		],
		["another RP ID hash", { rpId: "evil.example" }, "rp_id"],
		["no user presence", { flags: UV | AT }, "user_presence"],
		// "discouraged" user verification produces exactly this.
		["no user verification", { flags: UP | AT }, "user_verification"],
		["no attested credential", { flags: UP | UV }, "malformed"],
		["backed up but not eligible", { flags: UP | UV | AT | BS }, "malformed"],
		["trailing bytes", { trailing: new Uint8Array([0]) }, "malformed"],
		[
			"a raw id that is not the credential's",
			{ rawId: new Uint8Array(32).fill(7) },
			"credential",
		],
		[
			"an extension flag without extensions",
			{ flags: UP | UV | AT | ED },
			"malformed",
		],
	];
	for (const [name, knobs, reason] of cases)
		test(`refused: ${name}`, () => {
			expect(refusedWith(register(knobs).run)).toBe(reason);
		});

	test("extensions after the key are parsed and accepted", () => {
		const ext = encodeCbor(new Map([["credProtect", 2]]));
		expect(
			refusedWith(register({ flags: UP | UV | AT | ED, trailing: ext }).run),
		).toBe("accepted");
	});

	test("RS256 and other algorithms are refused", () => {
		const rsa = new Map<number, CborIn>([
			[1, 3],
			[3, -257],
			[-1, new Uint8Array(256)],
			[-2, new Uint8Array([1, 0, 1])],
		]);
		expect(refusedWith(register({ cose: rsa }).run)).toBe("algorithm");
	});

	test("a key whose alg and curve disagree is refused", () => {
		const ed = generateKeyPairSync("ed25519").publicKey;
		const cose = coseKey(ed, "EdDSA");
		cose.set(3, -7);
		expect(refusedWith(register({ cose }).run)).toBe("key");
	});

	test("a point off the curve is refused", () => {
		const p = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey;
		const cose = coseKey(p, "ES256");
		cose.set(-3, cose.get(-2) as Uint8Array);
		expect(refusedWith(register({ cose }).run)).toBe("key");
	});

	test("a key carrying a private component is refused", () => {
		const p = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey;
		const cose = coseKey(p, "ES256");
		cose.set(-4, new Uint8Array(32));
		expect(refusedWith(register({ cose }).run)).toBe("key");
	});

	test("any attestation format is accepted, its statement ignored", () => {
		const packed = new Map<string, CborIn>([
			["alg", -7],
			["sig", new Uint8Array(70)],
		]);
		expect(refusedWith(register({ fmt: "packed", attStmt: packed }).run)).toBe(
			"accepted",
		);
	});

	test("the expected RP must be a secure, named origin", () => {
		const { run } = register({}, RP, {
			rp: { rpId: "127.0.0.1", origin: "http://127.0.0.1:7777" },
		});
		expect(refusedWith(run)).toBe("rp_id");
	});
});

describe("assertion", () => {
	function setup(alg: SoftAlg = "ES256", signCount = 0) {
		const r = register({ alg, signCount });
		const reg = r.run();
		const stored = {
			alg: reg.alg,
			publicKeySpki: reg.publicKeySpki,
			signCount: reg.signCount,
		};
		const assert = (
			knobs: CeremonyKnobs = {},
			expected: { challenge?: string; rp?: RelyingParty } = {},
		) => {
			const json = r.soft.get(
				{ challenge: CHALLENGE, rpId: RP.rpId },
				{ ...knobs, use: r.credential },
			);
			return () =>
				verifyAssertion(
					{
						clientDataJSON: bytes(json.response.clientDataJSON),
						authenticatorData: bytes(json.response.authenticatorData),
						signature: bytes(json.response.signature),
					},
					stored,
					{ challenge: expected.challenge ?? CHALLENGE, rp: expected.rp ?? RP },
				);
		};
		return { stored, assert, credential: r.credential };
	}

	for (const alg of ["ES256", "EdDSA"] as const)
		test(`${alg}: a signed assertion verifies`, () => {
			const { assert } = setup(alg);
			expect(assert()().signCount).toBe(0);
		});

	test("a bad signature is refused", () => {
		const { assert } = setup("ES256");
		expect(refusedWith(assert({ badSignature: true }))).toBe("signature");
		const ed = setup("EdDSA");
		expect(refusedWith(ed.assert({ badSignature: true }))).toBe("signature");
	});

	test("the counter must advance; zero on both sides is allowed", () => {
		const { assert, stored } = setup("ES256", 5);
		expect(assert({ signCount: 6 })().signCount).toBe(6);
		stored.signCount = 6;
		// A clone replays an old or equal counter.
		expect(refusedWith(assert({ signCount: 6 }))).toBe("counter");
		expect(refusedWith(assert({ signCount: 2 }))).toBe("counter");
		expect(refusedWith(assert({ signCount: 0 }))).toBe("counter");
		const zero = setup("ES256", 0);
		expect(zero.assert({ signCount: 0 })().signCount).toBe(0);
	});

	const cases: [string, CeremonyKnobs, WebAuthnFailure][] = [
		[
			"a create client data",
			{ clientData: { type: "webauthn.create" } },
			"client_data",
		],
		["another challenge", { clientData: { challenge: "AAAA" } }, "challenge"],
		[
			"another origin",
			{ clientData: { origin: "https://evil.example" } },
			"origin",
		],
		[
			"a cross-origin frame",
			{ clientData: { crossOrigin: true } },
			"cross_origin",
		],
		["another RP ID", { rpId: "evil.example" }, "rp_id"],
		["no user presence", { flags: UV }, "user_presence"],
		["no user verification", { flags: UP }, "user_verification"],
		["an attested credential flag", { flags: UP | UV | AT }, "malformed"],
		["trailing bytes", { trailing: new Uint8Array([1]) }, "malformed"],
		[
			"a token binding",
			{ clientData: { tokenBinding: { status: "present", id: "x" } } },
			"client_data",
		],
	];
	for (const [name, knobs, reason] of cases)
		test(`refused: ${name}`, () => {
			expect(refusedWith(setup().assert(knobs))).toBe(reason);
		});

	test("a stored key used under the wrong algorithm is refused", () => {
		const { stored, assert } = setup("ES256");
		stored.alg = COSE_EDDSA;
		expect(refusedWith(assert())).toBe("key");
	});
});

describe("CBOR", () => {
	const fails = (b: number[]) =>
		refusedWith(() => decodeCborExact(new Uint8Array(b)));

	test("round trips what the test encoder writes", () => {
		const v = new Map<number | string, CborIn>([
			[1, -7],
			["a", new Uint8Array([1, 2])],
			["l", [true, false, null, "x"]],
		]);
		const out = decodeCborExact(encodeCbor(v)) as Map<unknown, unknown>;
		expect(out.get(1)).toBe(-7);
		expect([...(out.get("a") as Uint8Array)]).toEqual([1, 2]);
		expect(out.get("l")).toEqual([true, false, null, "x"]);
	});

	test("refuses tags, indefinite lengths, duplicates, overruns and depth", () => {
		expect(fails([0xc0, 0x00])).toBe("malformed"); // tag 0
		expect(fails([0x5f, 0xff])).toBe("malformed"); // indefinite bytes
		expect(fails([0xa2, 0x01, 0x00, 0x01, 0x00])).toBe("malformed"); // dup key
		expect(fails([0x44, 0x01])).toBe("malformed"); // short byte string
		expect(fails([0x9b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])).toBe(
			"malformed",
		);
		expect(fails(Array(40).fill(0x81).concat([0x00]))).toBe("malformed");
		expect(fails([0xa1, 0x40, 0x00])).toBe("malformed"); // bytes as key
		expect(fails([0x00, 0x00])).toBe("malformed"); // trailing
		expect(fails([0x62, 0xff, 0xfe])).toBe("malformed"); // bad UTF-8
	});

	test("decodeCbor reports where an item ends", () => {
		expect(decodeCbor(new Uint8Array([0x01, 0x02]), 0).end).toBe(1);
	});

	test("authenticator data shorter than its header is refused", () => {
		expect(refusedWith(() => parseAuthenticatorData(new Uint8Array(36)))).toBe(
			"malformed",
		);
	});

	test("half floats decode", () => {
		expect(decodeCborExact(new Uint8Array([0xf9, 0x3c, 0x00]))).toBe(1);
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
	});

	test("the RP ID hash is SHA-256 of the RP ID", () => {
		const r = register();
		const att = decodeCborExact(
			bytes(r.json.response.attestationObject),
		) as Map<string, Uint8Array>;
		const auth = parseAuthenticatorData(att.get("authData") as Uint8Array);
		expect(Buffer.from(auth.rpIdHash).toString("hex")).toBe(
			createHash("sha256").update("localhost").digest("hex"),
		);
	});
});

describe("L4: Ed25519 keys anyone could sign for", () => {
	const hex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
	const ed = (x: Uint8Array) =>
		new Map<number, CborIn>([
			[1, 1],
			[3, -8],
			[-1, 6],
			[-2, x],
		]);
	const P_LE =
		"edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f";
	const cases: [string, string][] = [
		[
			"the identity point",
			"0100000000000000000000000000000000000000000000000000000000000000",
		],
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
	for (const [name, x] of cases)
		test(`refused: ${name}`, () => {
			expect(
				refusedWith(register({ cose: ed(hex(x)), alg: "EdDSA" }).run),
			).toBe("key");
		});

	test("a real Ed25519 key still registers", () => {
		expect(refusedWith(register({ alg: "EdDSA" }).run)).toBe("accepted");
	});
});
