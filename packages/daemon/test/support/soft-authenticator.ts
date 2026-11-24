import {
	createHash,
	generateKeyPairSync,
	type KeyObject,
	randomBytes,
	sign,
} from "node:crypto";

/**
 * A software WebAuthn authenticator for tests: no browser, no hardware. It
 * produces the same bytes a platform authenticator would (attestation "none"),
 * and exposes knobs to produce the malformed or hostile variants the verifier
 * must refuse.
 */

// ---------------------------------------------------------------- CBOR encode

export type CborIn =
	| number
	| string
	| boolean
	| null
	| Uint8Array
	| CborIn[]
	| Map<number | string, CborIn>;

function head(major: number, n: number): number[] {
	if (n < 24) return [(major << 5) | n];
	if (n < 0x100) return [(major << 5) | 24, n];
	if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 255];
	return [
		(major << 5) | 26,
		(n >>> 24) & 255,
		(n >>> 16) & 255,
		(n >>> 8) & 255,
		n & 255,
	];
}

export function encodeCbor(v: CborIn): Uint8Array {
	const out: number[] = [];
	const put = (x: CborIn) => {
		if (typeof x === "number") {
			if (!Number.isInteger(x)) throw new Error("integers only");
			if (x >= 0) out.push(...head(0, x));
			else out.push(...head(1, -1 - x));
		} else if (typeof x === "string") {
			const b = new TextEncoder().encode(x);
			out.push(...head(3, b.length), ...b);
		} else if (typeof x === "boolean") out.push(x ? 0xf5 : 0xf4);
		else if (x === null) out.push(0xf6);
		else if (x instanceof Uint8Array) out.push(...head(2, x.length), ...x);
		else if (Array.isArray(x)) {
			out.push(...head(4, x.length));
			for (const e of x) put(e);
		} else {
			out.push(...head(5, x.size));
			for (const [k, e] of x) {
				put(k);
				put(e);
			}
		}
	};
	put(v);
	return new Uint8Array(out);
}

// ------------------------------------------------------------- authenticator

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const sha = (d: Uint8Array | string) =>
	new Uint8Array(createHash("sha256").update(d).digest());

export type SoftAlg = "ES256" | "EdDSA";

export interface SoftCredential {
	id: Uint8Array;
	alg: SoftAlg;
	privateKey: KeyObject;
	publicKey: KeyObject;
	rpId: string;
	userHandle: Uint8Array;
	signCount: number;
}

export interface CeremonyKnobs {
	/** Override any client data field (or `undefined` to drop it). */
	clientData?: Record<string, unknown>;
	/** Flag byte, default UP|UV (plus AT on create). */
	flags?: number;
	/** The RP ID hashed into authenticator data. */
	rpId?: string;
	/** Counter to report instead of incrementing. */
	signCount?: number;
	/** Corrupt the signature. */
	badSignature?: boolean;
	/** Bytes appended after the authenticator data. */
	trailing?: Uint8Array;
	/** Replace the COSE key. */
	cose?: Map<number | string, CborIn>;
	/** Attestation format and statement. */
	fmt?: string;
	attStmt?: Map<number | string, CborIn>;
	/** Report a different raw id than the one in the authenticator data. */
	rawId?: Uint8Array;
	/** Report this user handle (default: the credential's). */
	userHandle?: Uint8Array | null;
	/** The `credProps.rk` client extension result. */
	rk?: boolean;
	/** Create a credential with this id (a second registration of one key). */
	credentialId?: Uint8Array;
}

export const UP = 0x01;
export const UV = 0x04;
export const BE = 0x08;
export const BS = 0x10;
export const AT = 0x40;
export const ED = 0x80;

export function coseKey(publicKey: KeyObject, alg: SoftAlg) {
	const jwk = publicKey.export({ format: "jwk" }) as {
		x: string;
		y?: string;
	};
	const x = new Uint8Array(Buffer.from(jwk.x, "base64url"));
	if (alg === "ES256")
		return new Map<number, CborIn>([
			[1, 2],
			[3, -7],
			[-1, 1],
			[-2, x],
			[-3, new Uint8Array(Buffer.from(jwk.y as string, "base64url"))],
		]);
	return new Map<number, CborIn>([
		[1, 1],
		[3, -8],
		[-1, 6],
		[-2, x],
	]);
}

function u32(n: number): number[] {
	return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

/** The JSON a browser's `PublicKeyCredential.toJSON()` would send. */
export interface RegistrationJSON {
	id: string;
	rawId: string;
	type: "public-key";
	response: {
		clientDataJSON: string;
		attestationObject: string;
		transports?: string[];
	};
	clientExtensionResults?: { credProps?: { rk?: boolean } };
}

export interface AssertionJSON {
	id: string;
	rawId: string;
	type: "public-key";
	response: {
		clientDataJSON: string;
		authenticatorData: string;
		signature: string;
		userHandle: string | null;
	};
}

export class SoftAuthenticator {
	readonly credentials: SoftCredential[] = [];

	constructor(readonly origin: string) {}

	private clientData(
		type: string,
		challenge: string,
		knobs: CeremonyKnobs,
	): Uint8Array {
		const data: Record<string, unknown> = {
			type,
			challenge,
			origin: this.origin,
			crossOrigin: false,
			...knobs.clientData,
		};
		for (const k of Object.keys(data))
			if (data[k] === undefined) delete data[k];
		return new TextEncoder().encode(JSON.stringify(data));
	}

	/** `navigator.credentials.create()` for these options. */
	create(
		options: {
			challenge: string;
			rp: { id?: string };
			user: { id: string };
			pubKeyCredParams?: { alg: number }[];
		},
		knobs: CeremonyKnobs & { alg?: SoftAlg } = {},
	): { json: RegistrationJSON; credential: SoftCredential } {
		const rpId = options.rp.id;
		if (!rpId) throw new Error("soft authenticator: the options name no RP ID");
		const alg = knobs.alg ?? "ES256";
		const pair =
			alg === "ES256"
				? generateKeyPairSync("ec", { namedCurve: "P-256" })
				: generateKeyPairSync("ed25519");
		const id = knobs.credentialId ?? new Uint8Array(randomBytes(32));
		const credential: SoftCredential = {
			id,
			alg,
			privateKey: pair.privateKey,
			publicKey: pair.publicKey,
			rpId,
			userHandle: new Uint8Array(Buffer.from(options.user.id, "base64url")),
			signCount: knobs.signCount ?? 0,
		};
		const cose = encodeCbor(knobs.cose ?? coseKey(pair.publicKey, alg));
		const authData = new Uint8Array([
			...sha(knobs.rpId ?? rpId),
			knobs.flags ?? UP | UV | AT,
			...u32(credential.signCount),
			...new Uint8Array(16),
			id.length >> 8,
			id.length & 255,
			...id,
			...cose,
			...(knobs.trailing ?? []),
		]);
		const attestationObject = encodeCbor(
			new Map<string, CborIn>([
				["fmt", knobs.fmt ?? "none"],
				["attStmt", knobs.attStmt ?? new Map()],
				["authData", authData],
			]),
		);
		const clientDataJSON = this.clientData(
			"webauthn.create",
			options.challenge,
			knobs,
		);
		this.credentials.push(credential);
		return {
			credential,
			json: {
				id: b64u(knobs.rawId ?? id),
				rawId: b64u(knobs.rawId ?? id),
				type: "public-key",
				response: {
					clientDataJSON: b64u(clientDataJSON),
					attestationObject: b64u(attestationObject),
					transports: ["internal"],
				},
				clientExtensionResults: { credProps: { rk: knobs.rk ?? true } },
			},
		};
	}

	/** `navigator.credentials.get()`: the first usable credential, or `use`. */
	get(
		options: {
			challenge: string;
			rpId?: string;
			allowCredentials?: { id: string }[];
		},
		knobs: CeremonyKnobs & { use?: SoftCredential } = {},
	): AssertionJSON {
		const allowed = options.allowCredentials?.map((c) => c.id) ?? [];
		const credential =
			knobs.use ??
			this.credentials.find(
				(c) =>
					c.rpId === options.rpId &&
					(allowed.length === 0 || allowed.includes(b64u(c.id))),
			);
		if (!credential) throw new Error("soft authenticator: no credential");
		if (knobs.signCount !== undefined) credential.signCount = knobs.signCount;
		else if (credential.signCount > 0) credential.signCount++;
		const authData = new Uint8Array([
			...sha(knobs.rpId ?? options.rpId ?? ""),
			knobs.flags ?? UP | UV,
			...u32(credential.signCount),
			...(knobs.trailing ?? []),
		]);
		const clientDataJSON = this.clientData(
			"webauthn.get",
			options.challenge,
			knobs,
		);
		const signed = new Uint8Array([...authData, ...sha(clientDataJSON)]);
		const signature = new Uint8Array(
			credential.alg === "ES256"
				? sign("sha256", signed, {
						key: credential.privateKey,
						dsaEncoding: "der",
					})
				: sign(null, signed, credential.privateKey),
		);
		if (knobs.badSignature)
			signature[signature.length - 1] =
				(signature[signature.length - 1] as number) ^ 1;
		const userHandle =
			knobs.userHandle === undefined ? credential.userHandle : knobs.userHandle;
		return {
			id: b64u(knobs.rawId ?? credential.id),
			rawId: b64u(knobs.rawId ?? credential.id),
			type: "public-key",
			response: {
				clientDataJSON: b64u(clientDataJSON),
				authenticatorData: b64u(authData),
				signature: b64u(signature),
				userHandle: userHandle === null ? null : b64u(userHandle),
			},
		};
	}
}
