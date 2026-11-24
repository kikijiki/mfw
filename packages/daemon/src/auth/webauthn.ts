import {
	createHash,
	createPublicKey,
	type KeyObject,
	timingSafeEqual,
	verify,
} from "node:crypto";

/**
 * WebAuthn verification for passkey sign-in, on `node:crypto` only: no
 * WebAuthn library is in the dependency tree, and this needs no network.
 *
 * Scope is deliberately narrow:
 * - Algorithms: ES256 (COSE -7, P-256) and EdDSA (COSE -8, Ed25519).
 * - Attestation is requested as "none" and never trusted. Registration is
 *   authorized by the owner's session plus a fresh re-verification, not by the
 *   authenticator's make, so the attestation statement is not checked.
 * - User verification is required on every ceremony.
 * - A signature counter that does not advance (when either value is nonzero)
 *   is refused as a possible cloned authenticator.
 *
 * Everything from the client is parsed strictly and bounded: definite-length
 * CBOR only, no tags, limited depth, and the authenticator data must be
 * consumed exactly.
 */

export const COSE_ES256 = -7;
export const COSE_EDDSA = -8;
export const SUPPORTED_ALGS: readonly number[] = [COSE_ES256, COSE_EDDSA];

/** The spec's upper bound on a credential id. */
export const MAX_CREDENTIAL_ID_BYTES = 1023;

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;
const FLAG_ED = 0x80;

export type WebAuthnFailure =
	| "malformed"
	| "client_data"
	| "challenge"
	| "origin"
	| "cross_origin"
	| "rp_id"
	| "user_presence"
	| "user_verification"
	| "algorithm"
	| "key"
	| "signature"
	| "counter"
	| "credential";

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

/** Strict base64url (no padding, canonical), or null. */
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

const sha256 = (data: Uint8Array | string) =>
	new Uint8Array(createHash("sha256").update(data).digest());

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && timingSafeEqual(a, b);
}

// --------------------------------------------------------------------- CBOR

export type CborValue =
	| number
	| string
	| boolean
	| null
	| undefined
	| Uint8Array
	| CborValue[]
	| Map<number | string, CborValue>;

const MAX_CBOR_DEPTH = 16;
const MAX_CBOR_ITEMS = 4096;

/**
 * Decode one CBOR item starting at `offset`, returning it and where it ends.
 * Definite lengths only; tags, indefinite lengths, non-integer or non-text map
 * keys, duplicate keys and integers beyond 2^53 are refused.
 */
export function decodeCbor(
	bytes: Uint8Array,
	offset = 0,
): { value: CborValue; end: number } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let pos = offset;
	let items = 0;
	const need = (n: number) => {
		if (n < 0 || pos + n > bytes.length)
			fail("malformed", "CBOR runs past its buffer");
	};
	const readLength = (info: number): number => {
		if (info < 24) return info;
		if (info === 24) {
			need(1);
			return bytes[pos++] as number;
		}
		if (info === 25) {
			need(2);
			const v = view.getUint16(pos);
			pos += 2;
			return v;
		}
		if (info === 26) {
			need(4);
			const v = view.getUint32(pos);
			pos += 4;
			return v;
		}
		if (info === 27) {
			need(8);
			const v = view.getBigUint64(pos);
			pos += 8;
			if (v > BigInt(Number.MAX_SAFE_INTEGER))
				fail("malformed", "CBOR integer too large");
			return Number(v);
		}
		return fail("malformed", "indefinite or reserved CBOR length");
	};
	const item = (depth: number): CborValue => {
		if (depth > MAX_CBOR_DEPTH) fail("malformed", "CBOR nested too deeply");
		if (++items > MAX_CBOR_ITEMS) fail("malformed", "CBOR has too many items");
		need(1);
		const head = bytes[pos++] as number;
		const major = head >> 5;
		const info = head & 0x1f;
		switch (major) {
			case 0:
				return readLength(info);
			case 1:
				return -1 - readLength(info);
			case 2: {
				const n = readLength(info);
				need(n);
				const out = bytes.slice(pos, pos + n);
				pos += n;
				return out;
			}
			case 3: {
				const n = readLength(info);
				need(n);
				let text: string;
				try {
					text = new TextDecoder("utf-8", { fatal: true }).decode(
						bytes.subarray(pos, pos + n),
					);
				} catch {
					return fail("malformed", "CBOR text is not UTF-8");
				}
				pos += n;
				return text;
			}
			case 4: {
				const n = readLength(info);
				// Each element is at least one byte: a cheap bound before allocating.
				need(n);
				const out: CborValue[] = [];
				for (let i = 0; i < n; i++) out.push(item(depth + 1));
				return out;
			}
			case 5: {
				const n = readLength(info);
				need(n * 2);
				const out = new Map<number | string, CborValue>();
				for (let i = 0; i < n; i++) {
					const key = item(depth + 1);
					if (typeof key !== "number" && typeof key !== "string")
						fail("malformed", "CBOR map key is not an integer or text");
					if (out.has(key as number | string))
						fail("malformed", "CBOR map has a duplicate key");
					out.set(key as number | string, item(depth + 1));
				}
				return out;
			}
			case 6:
				return fail("malformed", "CBOR tags are not accepted");
			default: {
				if (info === 20) return false;
				if (info === 21) return true;
				if (info === 22) return null;
				if (info === 23) return undefined;
				if (info === 25) {
					need(2);
					const half = view.getUint16(pos);
					pos += 2;
					return decodeHalf(half);
				}
				if (info === 26) {
					need(4);
					const v = view.getFloat32(pos);
					pos += 4;
					return v;
				}
				if (info === 27) {
					need(8);
					const v = view.getFloat64(pos);
					pos += 8;
					return v;
				}
				return fail("malformed", "unsupported CBOR simple value");
			}
		}
	};
	const value = item(0);
	return { value, end: pos };
}

function decodeHalf(half: number): number {
	const exp = (half >> 10) & 0x1f;
	const mant = half & 0x3ff;
	const sign = half & 0x8000 ? -1 : 1;
	if (exp === 0) return sign * 2 ** -14 * (mant / 1024);
	if (exp === 31) return mant ? Number.NaN : sign * Number.POSITIVE_INFINITY;
	return sign * 2 ** (exp - 15) * (1 + mant / 1024);
}

/** Decode exactly one item that fills the whole buffer. */
export function decodeCborExact(bytes: Uint8Array): CborValue {
	const { value, end } = decodeCbor(bytes);
	if (end !== bytes.length) fail("malformed", "trailing bytes after CBOR");
	return value;
}

// --------------------------------------------------------- authenticator data

export interface AttestedCredential {
	aaguid: Uint8Array;
	credentialId: Uint8Array;
	/** The COSE key as decoded. */
	publicKey: Map<number | string, CborValue>;
}

export interface AuthenticatorData {
	rpIdHash: Uint8Array;
	flags: {
		up: boolean;
		uv: boolean;
		be: boolean;
		bs: boolean;
		at: boolean;
		ed: boolean;
	};
	signCount: number;
	attested: AttestedCredential | null;
	extensions: Map<number | string, CborValue> | null;
}

export function parseAuthenticatorData(data: Uint8Array): AuthenticatorData {
	if (data.length < 37) fail("malformed", "authenticator data is too short");
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const flagsByte = data[32] as number;
	const flags = {
		up: (flagsByte & FLAG_UP) !== 0,
		uv: (flagsByte & FLAG_UV) !== 0,
		be: (flagsByte & FLAG_BE) !== 0,
		bs: (flagsByte & FLAG_BS) !== 0,
		at: (flagsByte & FLAG_AT) !== 0,
		ed: (flagsByte & FLAG_ED) !== 0,
	};
	if (flags.bs && !flags.be)
		fail("malformed", "backed up but not backup eligible");
	let pos = 37;
	let attested: AttestedCredential | null = null;
	if (flags.at) {
		if (data.length < pos + 18)
			fail("malformed", "attested credential data is too short");
		const aaguid = data.slice(pos, pos + 16);
		const idLength = view.getUint16(pos + 16);
		pos += 18;
		if (idLength === 0 || idLength > MAX_CREDENTIAL_ID_BYTES)
			fail("credential", "credential id length is out of range");
		if (data.length < pos + idLength)
			fail("malformed", "credential id runs past the data");
		const credentialId = data.slice(pos, pos + idLength);
		pos += idLength;
		const key = decodeCbor(data, pos);
		if (!(key.value instanceof Map))
			fail("key", "the credential public key is not a COSE map");
		pos = key.end;
		attested = {
			aaguid,
			credentialId,
			publicKey: key.value as Map<number | string, CborValue>,
		};
	}
	let extensions: Map<number | string, CborValue> | null = null;
	if (flags.ed) {
		const ext = decodeCbor(data, pos);
		if (!(ext.value instanceof Map))
			fail("malformed", "extension data is not a map");
		extensions = ext.value as Map<number | string, CborValue>;
		pos = ext.end;
	}
	if (pos !== data.length)
		fail("malformed", "trailing bytes after authenticator data");
	return {
		rpIdHash: data.slice(0, 32),
		flags,
		signCount: view.getUint32(33),
		attested,
		extensions,
	};
}

// ------------------------------------------------------------------ COSE keys

export interface CredentialKey {
	alg: number;
	key: KeyObject;
}

const bytesOf = (
	v: CborValue | undefined,
	length: number,
): Uint8Array | null =>
	v instanceof Uint8Array && v.length === length ? v : null;

/** A COSE public key as a verified `KeyObject`. Points are checked on the curve. */
export function coseToKey(
	cose: Map<number | string, CborValue>,
	allowedAlgs: readonly number[] = SUPPORTED_ALGS,
): CredentialKey {
	const kty = cose.get(1);
	const alg = cose.get(3);
	if (typeof alg !== "number" || !allowedAlgs.includes(alg))
		fail("algorithm", "unsupported credential algorithm");
	// A private component must never be sent; refuse rather than ignore it.
	if (cose.has(-4)) fail("key", "the key carries a private component");
	const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
	try {
		if (alg === COSE_ES256) {
			const x = bytesOf(cose.get(-2), 32);
			const y = bytesOf(cose.get(-3), 32);
			if (kty !== 2 || cose.get(-1) !== 1 || !x || !y)
				fail("key", "not a P-256 EC2 key");
			const key = createPublicKey({
				key: {
					kty: "EC",
					crv: "P-256",
					x: b64(x as Uint8Array),
					y: b64(y as Uint8Array),
				},
				format: "jwk",
			});
			return { alg, key };
		}
		if (alg !== COSE_EDDSA)
			fail("algorithm", "unsupported credential algorithm");
		const x = bytesOf(cose.get(-2), 32);
		if (kty !== 1 || cose.get(-1) !== 6 || !x)
			fail("key", "not an Ed25519 OKP key");
		const key = createPublicKey({
			key: { kty: "OKP", crv: "Ed25519", x: b64(x as Uint8Array) },
			format: "jwk",
		});
		return { alg: alg as number, key };
	} catch (e) {
		if (isWebAuthnError(e)) throw e;
		return fail("key", "the public key is not valid");
	}
}

/** The stored form: SPKI DER. */
export const keyToSpki = (key: KeyObject): Uint8Array =>
	new Uint8Array(key.export({ format: "der", type: "spki" }));

export function spkiToKey(spki: Uint8Array, alg: number): KeyObject {
	const key = createPublicKey({
		key: Buffer.from(spki),
		format: "der",
		type: "spki",
	});
	const type = key.asymmetricKeyType;
	if (
		(alg === COSE_ES256 &&
			(type !== "ec" ||
				key.asymmetricKeyDetails?.namedCurve !== "prime256v1")) ||
		(alg === COSE_EDDSA && type !== "ed25519") ||
		!SUPPORTED_ALGS.includes(alg)
	)
		throw new WebAuthnError("key", "stored key does not match its algorithm");
	return key;
}

function verifySignature(
	alg: number,
	key: KeyObject,
	data: Uint8Array,
	signature: Uint8Array,
): boolean {
	try {
		if (alg === COSE_ES256)
			return verify("sha256", data, { key, dsaEncoding: "der" }, signature);
		if (alg === COSE_EDDSA)
			return signature.length === 64 && verify(null, data, key, signature);
	} catch {
		return false;
	}
	return false;
}

// ---------------------------------------------------------------- ceremonies

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

interface ClientData {
	type: string;
	challenge: string;
	origin: string;
	crossOrigin?: boolean;
	topOrigin?: string;
	tokenBinding?: { status?: string };
}

function parseClientData(
	raw: Uint8Array,
	type: "webauthn.create" | "webauthn.get",
	challenge: string,
	rp: RelyingParty,
): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
	} catch {
		fail("client_data", "client data is not JSON");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		fail("client_data", "client data is not an object");
	const c = parsed as ClientData;
	if (c.type !== type) fail("client_data", `client data type is not ${type}`);
	if (
		typeof c.challenge !== "string" ||
		!bytesEqual(Buffer.from(c.challenge), Buffer.from(challenge))
	)
		fail("challenge", "the challenge does not match");
	if (c.origin !== rp.origin) fail("origin", "the origin does not match");
	if (c.crossOrigin !== undefined && c.crossOrigin !== false)
		fail("cross_origin", "the ceremony ran in a cross-origin frame");
	if (c.topOrigin !== undefined)
		fail("cross_origin", "the ceremony ran in a frame");
	if (c.tokenBinding?.status === "present")
		fail("client_data", "token binding is not supported");
}

function checkAuthenticatorFlags(
	auth: AuthenticatorData,
	rp: RelyingParty,
): void {
	if (!bytesEqual(auth.rpIdHash, sha256(rp.rpId)))
		fail("rp_id", "the RP ID hash does not match");
	if (!auth.flags.up) fail("user_presence", "the user was not present");
	if (!auth.flags.uv) fail("user_verification", "the user was not verified");
}

export interface RegistrationInput {
	clientDataJSON: Uint8Array;
	attestationObject: Uint8Array;
	/** The id the client reports; must match the one in the authenticator data. */
	rawId: Uint8Array;
}

export interface VerifiedRegistration {
	credentialId: Uint8Array;
	alg: number;
	publicKeySpki: Uint8Array;
	signCount: number;
	backupEligible: boolean;
	backedUp: boolean;
}

/** Registration (WebAuthn L3 §7.1), with attestation "none" and UV required. */
export function verifyRegistration(
	input: RegistrationInput,
	expected: { challenge: string; rp: RelyingParty },
	allowedAlgs: readonly number[] = SUPPORTED_ALGS,
): VerifiedRegistration {
	const rpError = relyingPartyError(expected.rp);
	if (rpError) fail("rp_id", rpError);
	parseClientData(
		input.clientDataJSON,
		"webauthn.create",
		expected.challenge,
		expected.rp,
	);
	const att = decodeCborExact(input.attestationObject);
	if (!(att instanceof Map)) fail("malformed", "attestation is not a map");
	const map = att as Map<number | string, CborValue>;
	const fmt = map.get("fmt");
	const authDataRaw = map.get("authData");
	if (
		typeof fmt !== "string" ||
		!(map.get("attStmt") instanceof Map) ||
		!(authDataRaw instanceof Uint8Array)
	)
		fail("malformed", "attestation is missing fmt, attStmt or authData");
	// Any format is accepted and its statement ignored: nothing here trusts it.
	const auth = parseAuthenticatorData(authDataRaw as Uint8Array);
	checkAuthenticatorFlags(auth, expected.rp);
	if (!auth.attested)
		fail("credential", "no attested credential in the registration");
	const attested = auth.attested as AttestedCredential;
	if (!bytesEqual(attested.credentialId, input.rawId))
		fail("credential", "the credential id does not match");
	const { alg, key } = coseToKey(attested.publicKey, allowedAlgs);
	return {
		credentialId: attested.credentialId,
		alg,
		publicKeySpki: keyToSpki(key),
		signCount: auth.signCount,
		backupEligible: auth.flags.be,
		backedUp: auth.flags.bs,
	};
}

export interface AssertionInput {
	clientDataJSON: Uint8Array;
	authenticatorData: Uint8Array;
	signature: Uint8Array;
}

export interface StoredCredential {
	alg: number;
	publicKeySpki: Uint8Array;
	signCount: number;
}

export interface VerifiedAssertion {
	signCount: number;
	backedUp: boolean;
}

/**
 * Authentication (WebAuthn L3 §7.2), UV required. A counter that does not
 * advance, when either value is nonzero, is refused: two authenticators hold
 * this key, so one of them is a copy.
 */
export function verifyAssertion(
	input: AssertionInput,
	stored: StoredCredential,
	expected: { challenge: string; rp: RelyingParty },
): VerifiedAssertion {
	const rpError = relyingPartyError(expected.rp);
	if (rpError) fail("rp_id", rpError);
	parseClientData(
		input.clientDataJSON,
		"webauthn.get",
		expected.challenge,
		expected.rp,
	);
	const auth = parseAuthenticatorData(input.authenticatorData);
	if (auth.attested)
		fail("malformed", "an assertion must not carry a credential");
	checkAuthenticatorFlags(auth, expected.rp);
	const key = spkiToKey(stored.publicKeySpki, stored.alg);
	const signed = new Uint8Array(input.authenticatorData.length + 32);
	signed.set(input.authenticatorData, 0);
	signed.set(sha256(input.clientDataJSON), input.authenticatorData.length);
	if (!verifySignature(stored.alg, key, signed, input.signature))
		fail("signature", "the signature does not verify");
	if (
		(auth.signCount !== 0 || stored.signCount !== 0) &&
		auth.signCount <= stored.signCount
	)
		fail(
			"counter",
			"the signature counter did not advance: possibly a cloned authenticator",
		);
	return { signCount: auth.signCount, backedUp: auth.flags.bs };
}
