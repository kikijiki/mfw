import { randomBytes } from "node:crypto";
import {
	type AssertionInput,
	fromBase64url,
	MAX_CREDENTIAL_ID_BYTES,
	type RegistrationInput,
	type RelyingParty,
	SUPPORTED_ALGS,
} from "./webauthn.ts";

/**
 * Passkey ceremonies: their server-side state and the shapes the browser sends.
 * The verification itself is in `webauthn.ts`; the rules (throttle, sessions,
 * credential epoch) are in `service.ts`.
 *
 * A ceremony is a random challenge held only in this process, used once, and
 * gone after `CEREMONY_TTL_MS`. A sign-in ceremony belongs to the source that
 * asked for it; a registration or re-verification belongs to one session.
 */

/** What the browser is told to wait. */
export const CEREMONY_TIMEOUT_MS = 2 * 60 * 1000;
/** A little longer than the browser's timeout, never more. */
export const CEREMONY_TTL_MS = CEREMONY_TIMEOUT_MS + 30 * 1000;
/** Pending sign-in ceremonies per throttle source; a new one drops its oldest. */
const PER_SOURCE = 4;
/**
 * Per IPv6 /48 across its /64 sources, the same way: one routed /48 has 65,536
 * throttle sources, enough to fill the pool on its own.
 */
const PER_PREFIX48 = 16;
/** Ceremonies from forwarded clients, which can be forged (see `AuthSource`). */
const MAX_PROXIED = 128;
const MAX_TOTAL = 1024;
export const MAX_PASSKEYS = 16;
export const PASSKEY_NAME_MAX = 64;

export type CeremonyKind = "login" | "register";

export interface Ceremony {
	id: string;
	kind: CeremonyKind;
	challenge: string;
	rp: RelyingParty;
	expiresAt: number;
	/** The throttle scope of a sign-in ceremony. */
	scope: string | null;
	proxied: boolean;
	/** The session a registration or re-verification belongs to. */
	sessionId: string | null;
}

export class CeremonyFull extends Error {
	override readonly name = "CeremonyFull";
	constructor(readonly retryAfterMs: number) {
		super("too many passkey sign-ins are pending; try again shortly");
	}
}

/**
 * The ceremony is of this kind, belongs to this owner (the session for a
 * registration, the throttle source for a sign-in), and was started on the
 * same RP ID and origin it is being finished on.
 */
export function ceremonyFits(
	c: Ceremony | null,
	kind: CeremonyKind,
	owner: { sessionId: string } | { scope: string },
	rp: RelyingParty,
): c is Ceremony {
	const ownerFits =
		"sessionId" in owner
			? c?.sessionId === owner.sessionId
			: c?.sessionId === null && c.scope === owner.scope;
	return (
		ownerFits &&
		c?.kind === kind &&
		c.rp.rpId === rp.rpId &&
		c.rp.origin === rp.origin
	);
}

/** Not `instanceof`: the bundle can emit this module more than once. */
export const isCeremonyFull = (e: unknown): e is CeremonyFull =>
	e instanceof Error && e.name === "CeremonyFull";

export class CeremonyStore {
	private readonly all = new Map<string, Ceremony>();

	constructor(private readonly now: () => number) {}

	get size(): number {
		return this.all.size;
	}

	/** The /48 of an IPv6 /64 throttle scope; null for anything else. */
	private static prefix48(scope: string | null): string | null {
		return (
			/^[a-z]+:([0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}):[0-9a-f]{1,4}::\/64$/.exec(
				scope ?? "",
			)?.[1] ?? null
		);
	}

	private prune(): void {
		const now = this.now();
		for (const [id, c] of this.all) if (c.expiresAt <= now) this.all.delete(id);
	}

	/**
	 * A new ceremony. A source or session over its share loses its own oldest,
	 * never someone else's; a full store refuses the new one instead of evicting.
	 */
	begin(
		kind: CeremonyKind,
		rp: RelyingParty,
		owner: { scope: string; proxied: boolean } | { sessionId: string },
	): Ceremony {
		this.prune();
		const isSession = "sessionId" in owner;
		const mine = [...this.all.values()].filter((c) =>
			isSession
				? c.sessionId === owner.sessionId && c.kind === kind
				: c.scope === owner.scope && !c.sessionId,
		);
		const share = isSession ? 1 : PER_SOURCE;
		for (const c of mine.slice(0, Math.max(0, mine.length - share + 1)))
			this.all.delete(c.id);
		const prefix = isSession ? null : CeremonyStore.prefix48(owner.scope);
		if (prefix) {
			const group = [...this.all.values()].filter(
				(c) => CeremonyStore.prefix48(c.scope) === prefix,
			);
			for (const c of group.slice(
				0,
				Math.max(0, group.length - PER_PREFIX48 + 1),
			))
				this.all.delete(c.id);
		}
		const proxied = !isSession && owner.proxied;
		const proxiedCount = [...this.all.values()].filter((c) => c.proxied).length;
		if (
			this.all.size >= MAX_TOTAL ||
			(proxied && proxiedCount >= MAX_PROXIED)
		) {
			const oldest = Math.min(
				...[...this.all.values()].map((c) => c.expiresAt),
			);
			throw new CeremonyFull(Math.max(1000, oldest - this.now()));
		}
		const ceremony: Ceremony = {
			id: randomBytes(32).toString("base64url"),
			kind,
			challenge: randomBytes(32).toString("base64url"),
			rp,
			expiresAt: this.now() + CEREMONY_TTL_MS,
			scope: isSession ? null : owner.scope,
			proxied,
			sessionId: isSession ? owner.sessionId : null,
		};
		this.all.set(ceremony.id, ceremony);
		return ceremony;
	}

	/** Remove and return a live ceremony. A second take of the same id is null. */
	take(id: unknown): Ceremony | null {
		if (typeof id !== "string" || id.length > 64) return null;
		const c = this.all.get(id);
		if (!c) return null;
		this.all.delete(id);
		return c.expiresAt > this.now() ? c : null;
	}

	/** Every ceremony of a session (it ended). */
	dropSession(sessionId: string): void {
		for (const [id, c] of this.all)
			if (c.sessionId === sessionId) this.all.delete(id);
	}

	clear(): void {
		this.all.clear();
	}
}

// -------------------------------------------------------------- browser JSON

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const TRANSPORTS = new Set([
	"ble",
	"hybrid",
	"internal",
	"nfc",
	"smart-card",
	"usb",
]);

export interface RegistrationRequest extends RegistrationInput {
	transports: string[];
	/** `credProps.rk`: whether the authenticator stored a discoverable credential. */
	discoverable: boolean | null;
}

/** A `PublicKeyCredential.toJSON()` from `create()`, or null. */
export function parseRegistrationJSON(v: unknown): RegistrationRequest | null {
	if (!isRecord(v) || v.type !== "public-key" || !isRecord(v.response))
		return null;
	if (v.id !== v.rawId) return null;
	const rawId = fromBase64url(v.rawId, MAX_CREDENTIAL_ID_BYTES);
	const clientDataJSON = fromBase64url(v.response.clientDataJSON, 4096);
	const attestationObject = fromBase64url(v.response.attestationObject, 6144);
	if (!rawId?.length || !clientDataJSON || !attestationObject) return null;
	const transports = Array.isArray(v.response.transports)
		? [
				...new Set(
					v.response.transports.filter(
						(t): t is string => typeof t === "string" && TRANSPORTS.has(t),
					),
				),
			]
		: [];
	const ext = isRecord(v.clientExtensionResults)
		? v.clientExtensionResults
		: {};
	const rk = isRecord(ext.credProps) ? ext.credProps.rk : undefined;
	return {
		rawId,
		clientDataJSON,
		attestationObject,
		transports,
		discoverable: typeof rk === "boolean" ? rk : null,
	};
}

export interface AssertionRequest extends AssertionInput {
	rawId: Uint8Array;
	userHandle: Uint8Array | null;
}

/** A `PublicKeyCredential.toJSON()` from `get()`, or null. */
export function parseAssertionJSON(v: unknown): AssertionRequest | null {
	if (!isRecord(v) || v.type !== "public-key" || !isRecord(v.response))
		return null;
	if (v.id !== v.rawId) return null;
	const rawId = fromBase64url(v.rawId, MAX_CREDENTIAL_ID_BYTES);
	const clientDataJSON = fromBase64url(v.response.clientDataJSON, 4096);
	const authenticatorData = fromBase64url(v.response.authenticatorData, 2048);
	const signature = fromBase64url(v.response.signature, 512);
	const handle = v.response.userHandle;
	const userHandle =
		handle === null || handle === undefined || handle === ""
			? null
			: fromBase64url(handle, 64);
	if (
		!rawId?.length ||
		!clientDataJSON ||
		!authenticatorData ||
		!signature?.length ||
		(handle !== null && handle !== undefined && handle !== "" && !userHandle)
	)
		return null;
	return { rawId, clientDataJSON, authenticatorData, signature, userHandle };
}

/** A display name: trimmed, printable, bounded. Null when unusable. */
export function normalizePasskeyName(v: unknown): string | null {
	if (v === undefined || v === null || v === "") return "Passkey";
	if (typeof v !== "string") return null;
	const name = v.trim().replace(/\s+/g, " ");
	if (!name || name.length > PASSKEY_NAME_MAX) return null;
	// No control or bidirectional-override characters.
	if (/[\p{Cc}\p{Cf}]/u.test(name)) return null;
	return name;
}

// ---------------------------------------------------------- browser options

export interface CredentialDescriptor {
	type: "public-key";
	id: string;
	transports?: string[];
}

export function creationOptions(
	ceremony: Ceremony,
	user: { id: string },
	exclude: CredentialDescriptor[],
) {
	return {
		challenge: ceremony.challenge,
		rp: { id: ceremony.rp.rpId, name: "mfw" },
		user: { id: user.id, name: "owner", displayName: "mfw owner" },
		pubKeyCredParams: SUPPORTED_ALGS.map((alg) => ({
			type: "public-key" as const,
			alg,
		})),
		timeout: CEREMONY_TIMEOUT_MS,
		attestation: "none" as const,
		// Discoverable only: sign-in then needs no credential list, so the public
		// options call reveals nothing about the owner's passkeys.
		authenticatorSelection: {
			residentKey: "required" as const,
			requireResidentKey: true,
			userVerification: "required" as const,
		},
		excludeCredentials: exclude,
		extensions: { credProps: true },
	};
}

export function requestOptions(
	ceremony: Ceremony,
	allow: CredentialDescriptor[],
) {
	return {
		challenge: ceremony.challenge,
		rpId: ceremony.rp.rpId,
		timeout: CEREMONY_TIMEOUT_MS,
		userVerification: "required" as const,
		allowCredentials: allow,
	};
}
