import type {
	AuthenticationResponseJSON,
	RegistrationResponseJSON,
} from "@simplewebauthn/server";

type Library = typeof import("@simplewebauthn/server");
type Helpers = typeof import("@simplewebauthn/server/helpers");
let loading: Promise<Library & Helpers> | null = null;

/**
 * The library, loaded on first use rather than with this module. The compiled
 * `mfw` CLI bundles everything that imports auth, and in that bundle the
 * library's `import 'reflect-metadata'` runs after tsyringe checks for it, so
 * an eager import breaks every compiled command that touches auth. The CLI
 * never verifies a passkey (`mfw server` runs the separate server build), so
 * loading it only for a ceremony keeps the CLI working.
 */
function webauthn(): Promise<Library & Helpers> {
	loading ??= Promise.all([
		import("@simplewebauthn/server"),
		import("@simplewebauthn/server/helpers"),
	]).then(([library, helpers]) => ({ ...helpers, ...library }));
	return loading;
}

/**
 * WebAuthn for passkey sign-in, around `@simplewebauthn/server`.
 *
 * The library does all parsing (CBOR, COSE, authenticator data, client data,
 * attestation) and all signature verification. Given mfw's options, it
 * enforces: the ceremony type, the exact challenge, the exact origin and RP ID
 * hash, user presence and user verification, the COSE `alg` label being ES256
 * or EdDSA (the label only), a consistent backup state, no trailing bytes, and
 * a valid statement for the attestation format it is sent.
 *
 * mfw enforces the rest, here unless noted:
 * - The RP ID and origin come from the server's own external origin, never
 *   from the client, and must be a DNS name over HTTPS or `localhost`
 *   (`relyingPartyError`).
 * - The whole key shape (`checkCredentialKey`, at registration and at every
 *   sign-in): ES256 is EC2 on P-256 with 32-byte x and y; EdDSA is OKP on
 *   Ed25519 with a 32-byte x that is canonical and not of small order (the
 *   library verifies signatures anyone can forge for those). No private part.
 *   The library picks its verifier by key type, not by the label, so this is
 *   what limits sign-in to ES256 and EdDSA.
 * - Only attestation `none`, or `packed` without `x5c`, reaches the library
 *   (`assertAttestationFormat`); none is trusted.
 * - No cross-origin frames on either ceremony (`assertTopLevel`).
 * - The id the client reports must be the one in the authenticator data.
 * - The signature counter, checked AFTER the signature verifies, so a counter
 *   refusal always means the key holder sent it (`verifyAssertion`).
 * - Discoverable credentials only: `credProps.rk` must be reported and true
 *   (the caller, `AuthService.finishPasskeyRegistration`; unsigned, so it is
 *   the browser's word), and sign-in options never list credentials.
 */

export const COSE_ES256 = -7;
export const COSE_EDDSA = -8;
export const SUPPORTED_ALGS: readonly number[] = [COSE_ES256, COSE_EDDSA];

/** The spec's upper bound on a credential id. */
export const MAX_CREDENTIAL_ID_BYTES = 1023;

export type WebAuthnFailure =
	/** The library refused it; `message` says why. */
	| "refused"
	| "malformed"
	| "attestation"
	| "cross_origin"
	| "credential"
	| "key"
	| "rp_id"
	| "signature"
	| "counter";

/** A refused ceremony. `reason` is for tests and the server, not for clients. */
export class WebAuthnError extends Error {
	override readonly name = "WebAuthnError";
	constructor(
		readonly reason: WebAuthnFailure,
		message: string,
	) {
		super(message);
	}
}

export function isWebAuthnError(e: unknown): e is WebAuthnError {
	return (
		e instanceof Error &&
		e.name === "WebAuthnError" &&
		typeof (e as { reason?: unknown }).reason === "string"
	);
}

const fail = (reason: WebAuthnFailure, message: string): never => {
	throw new WebAuthnError(reason, message);
};

// ---------------------------------------------------------------- base64url

const B64URL = /^[A-Za-z0-9_-]*$/;

/** Strict base64url (no padding, canonical), or null. Bounds client input. */
export function fromBase64url(value: unknown, maxBytes = 16 * 1024) {
	if (typeof value !== "string" || !B64URL.test(value)) return null;
	if (value.length % 4 === 1) return null;
	if (value.length > Math.ceil((maxBytes * 4) / 3)) return null;
	const bytes = Buffer.from(value, "base64url");
	// Non-canonical trailing bits would let two strings name one credential.
	if (bytes.toString("base64url") !== value) return null;
	return new Uint8Array(bytes);
}

export const toBase64url = (bytes: Uint8Array): string =>
	Buffer.from(bytes).toString("base64url");

// ---------------------------------------------------------- relying party

/** Where a ceremony runs: derived by the server, never taken from the client. */
export interface RelyingParty {
	rpId: string;
	origin: string;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const DNS_NAME =
	/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * Null when this pair is one passkeys may use, else why not. The RP ID must be
 * a DNS name (browsers refuse IP addresses), and the origin must be HTTPS on
 * exactly that name, or plain HTTP only on `localhost`.
 */
export function relyingPartyError(rp: RelyingParty): string | null {
	const { rpId, origin } = rp;
	if (!DNS_NAME.test(rpId) || IPV4.test(rpId))
		return "passkeys need a DNS name, not an IP address";
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return "the origin is not a URL";
	}
	if (url.origin !== origin) return "the origin is not canonical";
	if (url.hostname !== rpId) return "the origin is not on the RP ID";
	if (url.protocol === "https:") return null;
	if (url.protocol === "http:" && rpId === "localhost") return null;
	return "passkeys need HTTPS (or http://localhost)";
}

function assertRelyingParty(rp: RelyingParty): void {
	const why = relyingPartyError(rp);
	if (why) fail("rp_id", why);
}

/**
 * The library allows `crossOrigin: true` without a `topOrigin` (for Safari),
 * and checks neither on registration. mfw is never framed, so both are refused.
 */
async function assertTopLevel(clientDataJSON: string): Promise<void> {
	const { decodeClientDataJSON } = await webauthn();
	let parsed: unknown = null;
	try {
		parsed = decodeClientDataJSON(clientDataJSON);
	} catch {
		// Refused just below.
	}
	if (!parsed || typeof parsed !== "object")
		fail("malformed", "client data is not JSON");
	const c = parsed as { crossOrigin?: unknown; topOrigin?: unknown };
	if (c.crossOrigin !== undefined && c.crossOrigin !== false)
		fail("cross_origin", "the ceremony ran in a cross-origin frame");
	if (c.topOrigin !== undefined)
		fail("cross_origin", "the ceremony ran in a frame");
}

/**
 * Only `none`, or `packed` without a certificate chain (self-attestation,
 * which some browsers keep even when "none" is requested). mfw trusts no
 * attestation, and the library cannot be told to restrict formats, so the
 * others would only feed attacker-shaped bytes to its X.509 and ASN.1
 * parsers. Decoded with the library's own helper, before it verifies.
 */
async function assertAttestationFormat(
	attestationObject: string,
): Promise<void> {
	const { decodeAttestationObject } = await webauthn();
	const raw = fromBase64url(attestationObject);
	let decoded: { fmt: unknown; x5c: unknown } | null = null;
	try {
		if (raw) {
			const att = decodeAttestationObject(new Uint8Array(raw));
			const stmt: unknown = att.get("attStmt");
			decoded = {
				fmt: att.get("fmt"),
				x5c: stmt instanceof Map ? stmt.get("x5c") : undefined,
			};
		}
	} catch {
		// Refused just below.
	}
	if (!decoded) fail("malformed", "the attestation is not valid CBOR");
	const { fmt, x5c } = decoded as { fmt: unknown; x5c: unknown };
	if (fmt !== "none" && !(fmt === "packed" && x5c === undefined))
		fail("attestation", "unsupported attestation format");
}

/** Run a library call, turning its refusals into ours. */
async function library<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (e) {
		if (isWebAuthnError(e)) throw e;
		return fail("refused", e instanceof Error ? e.message : String(e));
	}
}

// ------------------------------------------------------- Ed25519 key checks

/** p = 2^255 - 19, little-endian. */
const ED_P = (() => {
	const b = new Uint8Array(32).fill(0xff);
	b[0] = 0xed;
	b[31] = 0x7f;
	return b;
})();

/**
 * The y coordinates (little-endian, sign bit clear) of the eight points of
 * small order: 0 (order 4), 1 (the identity), p - 1 (order 2) and the two of
 * order 8. The same list libsodium refuses in `crypto_sign_verify`.
 */
const ED_SMALL_ORDER_Y = [
	"0000000000000000000000000000000000000000000000000000000000000000",
	"0100000000000000000000000000000000000000000000000000000000000000",
	"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
	"26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
	"c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
];

/**
 * False for a key anyone can sign for: one of small order, or one whose y is
 * not reduced below p (two encodings of one key). A pure byte comparison;
 * the curve arithmetic stays in the library and the runtime.
 */
export function isSafeEd25519Key(x: Uint8Array): boolean {
	if (x.length !== 32) return false;
	const y = Uint8Array.from(x);
	y[31] = (y[31] as number) & 0x7f;
	let reduced = false;
	for (let i = 31; i >= 0; i--) {
		if (y[i] === ED_P[i]) continue;
		reduced = (y[i] as number) < (ED_P[i] as number);
		break;
	}
	if (!reduced) return false;
	const hex = Buffer.from(y).toString("hex");
	return !ED_SMALL_ORDER_Y.includes(hex);
}

const COSE_KTY_OKP = 1;
const COSE_KTY_EC2 = 2;
const COSE_CRV_P256 = 1;
const COSE_CRV_ED25519 = 6;

const bytes32 = (v: unknown): v is Uint8Array =>
	v instanceof Uint8Array && v.length === 32;

/**
 * The COSE key's algorithm, after mfw's checks on its WHOLE shape. The library
 * checks only the `alg` label at registration, but at sign-in picks its
 * verifier by `kty` and `crv`: an OKP key labelled ES256 would be verified as
 * Ed25519 (with no small-order check), and an EC2 key of any curve as ECDSA.
 * So each label must come with exactly its key type, curve and sizes:
 * ES256 is EC2 on P-256 with 32-byte x and y, EdDSA is OKP on Ed25519 with a
 * safe 32-byte x. Run on registration and again on every sign-in.
 */
async function checkCredentialKey(cose: Uint8Array): Promise<number> {
	const { decodeCredentialPublicKey } = await webauthn();
	let key: Map<number, unknown>;
	try {
		key = decodeCredentialPublicKey(new Uint8Array(cose)) as unknown as Map<
			number,
			unknown
		>;
	} catch {
		return fail("key", "the public key is not valid COSE");
	}
	// A private component must never be sent; refuse rather than ignore it.
	if (key.has(-4)) fail("key", "the key carries a private component");
	const alg = key.get(3);
	const kty = key.get(1);
	const crv = key.get(-1);
	const x = key.get(-2);
	const y = key.get(-3);
	const es256 =
		alg === COSE_ES256 &&
		kty === COSE_KTY_EC2 &&
		crv === COSE_CRV_P256 &&
		bytes32(x) &&
		bytes32(y);
	const eddsa =
		alg === COSE_EDDSA &&
		kty === COSE_KTY_OKP &&
		crv === COSE_CRV_ED25519 &&
		y === undefined &&
		bytes32(x) &&
		isSafeEd25519Key(x);
	if (!es256 && !eddsa) fail("key", "unsupported credential key");
	return alg as number;
}

// --------------------------------------------------------------- options

export async function registrationOptions(opts: {
	rp: RelyingParty;
	/** base64url, from the ceremony store. */
	challenge: string;
	/** base64url user handle. */
	userHandle: string;
	exclude: { id: string; transports?: string[] }[];
	timeout: number;
}) {
	const { generateRegistrationOptions } = await webauthn();
	return generateRegistrationOptions({
		rpName: "mfw",
		rpID: opts.rp.rpId,
		userName: "owner",
		userDisplayName: "mfw owner",
		userID: new Uint8Array(Buffer.from(opts.userHandle, "base64url")),
		// Bytes, not a string: the library would encode a string as UTF-8.
		challenge: new Uint8Array(Buffer.from(opts.challenge, "base64url")),
		timeout: opts.timeout,
		attestationType: "none",
		// Discoverable only: sign-in then needs no credential list, so the public
		// options call reveals nothing about the owner's passkeys.
		authenticatorSelection: {
			residentKey: "required",
			requireResidentKey: true,
			userVerification: "required",
		},
		excludeCredentials: opts.exclude,
		supportedAlgorithmIDs: [...SUPPORTED_ALGS],
	});
}

export async function authenticationOptions(opts: {
	rp: RelyingParty;
	challenge: string;
	timeout: number;
}) {
	const { generateAuthenticationOptions } = await webauthn();
	return generateAuthenticationOptions({
		rpID: opts.rp.rpId,
		challenge: new Uint8Array(Buffer.from(opts.challenge, "base64url")),
		timeout: opts.timeout,
		userVerification: "required",
		// Always empty: credentials are discoverable, and a list would tell anyone
		// who asks whether passkeys exist.
		allowCredentials: [],
	});
}

// ---------------------------------------------------------------- ceremonies

export interface VerifiedRegistration {
	/** base64url, as stored and as browsers report it. */
	credentialId: string;
	alg: number;
	/** The COSE public key, as the library verifies with it. */
	publicKey: Uint8Array;
	signCount: number;
	backupEligible: boolean;
	backedUp: boolean;
}

/** Registration: the library's checks, then mfw's. */
export async function verifyRegistration(
	response: RegistrationResponseJSON,
	expected: { challenge: string; rp: RelyingParty },
): Promise<VerifiedRegistration> {
	assertRelyingParty(expected.rp);
	await assertTopLevel(response.response.clientDataJSON);
	await assertAttestationFormat(response.response.attestationObject);
	const { verifyRegistrationResponse } = await webauthn();
	const out = await library(() =>
		verifyRegistrationResponse({
			response,
			expectedChallenge: expected.challenge,
			expectedOrigin: expected.rp.origin,
			expectedRPID: expected.rp.rpId,
			requireUserPresence: true,
			requireUserVerification: true,
			supportedAlgorithmIDs: [...SUPPORTED_ALGS],
		}),
	);
	if (!out.verified) return fail("refused", "the attestation did not verify");
	const info = out.registrationInfo;
	// The library takes the id from the authenticator data and does not compare
	// it with the one the client reports.
	if (info.credential.id !== response.rawId)
		fail("credential", "the credential id does not match");
	const alg = await checkCredentialKey(info.credential.publicKey);
	return {
		credentialId: info.credential.id,
		alg,
		publicKey: info.credential.publicKey,
		signCount: info.credential.counter,
		backupEligible: info.credentialDeviceType === "multiDevice",
		backedUp: info.credentialBackedUp,
	};
}

export interface StoredCredential {
	/** base64url. */
	id: string;
	/** COSE. */
	publicKey: Uint8Array;
	signCount: number;
}

export interface VerifiedAssertion {
	signCount: number;
	backedUp: boolean;
}

/**
 * Authentication, UV required. The library is given a counter of 0, so its
 * own counter check (which runs before the signature) never fires; mfw's runs
 * after a verified signature instead. A counter that does not advance, when
 * either value is nonzero, is refused: two authenticators hold this key, so
 * one of them is a copy. Synced passkeys report 0 every time, which passes.
 */
export async function verifyAssertion(
	response: AuthenticationResponseJSON,
	stored: StoredCredential,
	expected: { challenge: string; rp: RelyingParty },
): Promise<VerifiedAssertion> {
	assertRelyingParty(expected.rp);
	await assertTopLevel(response.response.clientDataJSON);
	await checkCredentialKey(stored.publicKey);
	const { verifyAuthenticationResponse } = await webauthn();
	const out = await library(() =>
		verifyAuthenticationResponse({
			response,
			expectedChallenge: expected.challenge,
			expectedOrigin: expected.rp.origin,
			expectedRPID: expected.rp.rpId,
			credential: {
				id: stored.id,
				publicKey: new Uint8Array(stored.publicKey),
				counter: 0,
			},
			requireUserVerification: true,
		}),
	);
	if (!out.verified) fail("signature", "the signature does not verify");
	const counter = out.authenticationInfo.newCounter;
	if ((counter !== 0 || stored.signCount !== 0) && counter <= stored.signCount)
		fail(
			"counter",
			"the signature counter did not advance: possibly a cloned authenticator",
		);
	return {
		signCount: counter,
		backedUp: out.authenticationInfo.credentialBackedUp,
	};
}
