import { safeNext } from "./auth-paths";

/**
 * The browser's side of auth. The session cookie is HttpOnly. The request key
 * lives in `localStorage` because that, unlike a cookie, is isolated per port:
 * a page on another localhost port receives the cookie but can never read the
 * key. The server returns the key only from setup and login.
 */

const STORAGE_KEY = "mfw:auth:request-key";
export const REQUEST_KEY_HEADER = "x-mfw-key";

const base = () =>
	`/${import.meta.env?.BASE_URL ?? "/"}/`.replace(/\/{2,}/g, "/");
const authUrl = (action: string) => `${base()}api/auth/${action}`;

/** Used only when storage is blocked: the session then lasts for this page. */
let memoryKey: string | null = null;

export function readRequestKey(): string | null {
	try {
		return globalThis.localStorage?.getItem(STORAGE_KEY) ?? memoryKey;
	} catch {
		return memoryKey;
	}
}

function writeRequestKey(key: string | null): void {
	memoryKey = key;
	try {
		if (key) globalThis.localStorage?.setItem(STORAGE_KEY, key);
		else globalThis.localStorage?.removeItem(STORAGE_KEY);
	} catch {
		// private mode: the in-memory copy is enough for this page
	}
}

const keyHeaders = (): Record<string, string> => {
	const key = readRequestKey();
	return key ? { [REQUEST_KEY_HEADER]: key } : {};
};

export type AuthState = "setup" | "login" | "authenticated";

export class AuthRequestError extends Error {
	constructor(
		message: string,
		readonly code: string,
		readonly retryAfterSeconds: number,
	) {
		super(message);
	}
}

export async function fetchAuthState(): Promise<{ state: AuthState }> {
	const res = await fetch(authUrl("state"), {
		credentials: "same-origin",
		headers: keyHeaders(),
	});
	if (!res.ok) throw new Error(`auth state failed (${res.status})`);
	return res.json();
}

/** Leave for the login page, coming back to where the user was. */
export function redirectToLogin(): void {
	if (typeof window === "undefined") return;
	const { pathname, search } = window.location;
	if (pathname === `${base()}login`) return;
	const next = encodeURIComponent(`${pathname}${search}`);
	window.location.assign(`${base()}login?next=${next}`);
}

/** `fetch` for the API: adds the request key and handles a lost session. */
export const authedFetch: typeof fetch = Object.assign(
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		const key = readRequestKey();
		if (key) headers.set(REQUEST_KEY_HEADER, key);
		const res = await fetch(input, {
			...init,
			headers,
			credentials: "same-origin",
		});
		// The stored key is left alone: a planted cookie can cause these answers,
		// and only signing in or out may replace it.
		let lost = res.status === 401;
		if (res.status === 403) {
			const body = (await res
				.clone()
				.json()
				.catch(() => null)) as { error?: string } | null;
			lost = body?.error === "request_key";
		}
		if (lost) redirectToLogin();
		return res;
	},
	{ preconnect: fetch.preconnect },
);

/** True for this app's own raw-bytes routes, which need the request key. */
export function isAuthedAssetUrl(url: string | undefined): url is string {
	return !!url && url.startsWith(`${base()}api/`);
}

/**
 * Save an API asset as a file. It is forced to a download with a generic type:
 * opening agent-authored bytes from a blob URL would run them in this origin.
 */
export async function downloadAsset(url: string, name?: string): Promise<void> {
	const res = await authedFetch(url);
	if (!res.ok) throw new Error(`download failed (${res.status})`);
	const bytes = await res.arrayBuffer();
	const blob = new Blob([bytes], { type: "application/octet-stream" });
	const objectUrl = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = objectUrl;
	a.download =
		name ??
		decodeURIComponent(
			new URL(url, "http://x").pathname.split("/").pop() ?? "",
		);
	a.click();
	setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
}

/** A link handler that downloads API assets and leaves other links alone. */
export function downloadOnClick(url: string | undefined, name?: string) {
	return (event: { preventDefault(): void }) => {
		if (!isAuthedAssetUrl(url)) return;
		event.preventDefault();
		void downloadAsset(url, name).catch((e) => console.error(e));
	};
}

async function submit(
	action: "setup" | "login",
	body: Record<string, string>,
): Promise<void> {
	const res = await fetch(authUrl(action), {
		method: "POST",
		credentials: "same-origin",
		headers: { "content-type": "application/json", "x-mfw-auth": "1" },
		body: JSON.stringify(body),
	});
	const data = (await res.json().catch(() => null)) as {
		error?: string;
		message?: string;
		retryAfterSeconds?: number;
		requestKey?: string;
	} | null;
	if (!res.ok)
		throw new AuthRequestError(
			data?.message ?? `request failed (${res.status})`,
			data?.error ?? "error",
			data?.retryAfterSeconds ?? 0,
		);
	writeRequestKey(data?.requestKey ?? null);
}

export const submitSetup = (token: string, password: string) =>
	submit("setup", { token, password });
export const submitLogin = (password: string) => submit("login", { password });

export function afterLogin(search: string): void {
	const next = new URLSearchParams(search).get("next");
	window.location.assign(safeNext(next, base()));
}

export async function signOut(): Promise<void> {
	await fetch(authUrl("logout"), {
		method: "POST",
		credentials: "same-origin",
		headers: keyHeaders(),
	});
	writeRequestKey(null);
	window.location.assign(`${base()}login`);
}

/** Revokes every session, this one included. */
export async function signOutEverywhere(): Promise<void> {
	await fetch(authUrl("sign-out-everywhere"), {
		method: "POST",
		credentials: "same-origin",
		headers: keyHeaders(),
	});
	writeRequestKey(null);
	window.location.assign(`${base()}login`);
}

/** A scoped API token as the owner sees it. Never its secret. */
export interface ApiToken {
	id: string;
	name: string;
	scopes: string[];
	project: string | null;
	createdAt: number;
	expiresAt: number;
	lastUsedAt: number | null;
	status: "active" | "expired" | "revoked";
	/** Names a project this install does not have. */
	unbound?: boolean;
}

export interface ApiTokenAudit {
	actions: {
		id: number;
		name: string;
		path: string;
		project: string | null;
		kind: "mutation" | "stream";
		outcome: string;
		at: number;
	}[];
	counters: {
		tokenId: string;
		name: string;
		refused: number;
		lastRefusedPath: string | null;
		dropped: number;
	}[];
}

async function tokenCall<T>(
	action: "tokens" | "token-revoke" | "token-audit",
	body?: unknown,
): Promise<T> {
	const res = await authedFetch(authUrl(action), {
		method: body === undefined ? "GET" : "POST",
		headers:
			body === undefined
				? {}
				: { "content-type": "application/json", "x-mfw-auth": "1" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const data = (await res.json().catch(() => null)) as
		| (T & { error?: string; message?: string; retryAfterSeconds?: number })
		| null;
	if (!res.ok || data === null)
		throw new AuthRequestError(
			data?.message ?? `request failed (${res.status})`,
			data?.error ?? "error",
			data?.retryAfterSeconds ?? 0,
		);
	return data;
}

export const readApiTokenAudit = (): Promise<ApiTokenAudit> =>
	tokenCall<ApiTokenAudit>("token-audit");

export const listApiTokens = async (): Promise<ApiToken[]> =>
	(await tokenCall<{ tokens: ApiToken[] }>("tokens")).tokens;

/** Returns the secret. The server shows it this once. */
export const createApiToken = async (draft: {
	name: string;
	scopes: string[];
	project?: string;
	ttlMs: number;
}): Promise<string> =>
	(await tokenCall<{ token: string }>("tokens", draft)).token;

export const revokeApiToken = async (id: string): Promise<void> => {
	await tokenCall("token-revoke", { id });
};

/** Change the password. Every other session is revoked by the server. */
export async function changePassword(
	current: string,
	next: string,
): Promise<void> {
	const res = await fetch(authUrl("password"), {
		method: "POST",
		credentials: "same-origin",
		headers: {
			...keyHeaders(),
			"content-type": "application/json",
			"x-mfw-auth": "1",
		},
		body: JSON.stringify({ current, next }),
	});
	if (res.ok) return;
	const data = (await res.json().catch(() => null)) as {
		error?: string;
		message?: string;
		retryAfterSeconds?: number;
	} | null;
	throw new AuthRequestError(
		data?.message ?? `request failed (${res.status})`,
		data?.error ?? "error",
		data?.retryAfterSeconds ?? 0,
	);
}

// ------------------------------------------------------------------ passkeys

/** A registered passkey as the owner sees it. Never its key. */
export interface Passkey {
	id: string;
	name: string;
	rpId: string;
	createdAt: number;
	lastUsedAt: number | null;
	backedUp: boolean;
	discoverable: boolean | null;
}

export function passkeysSupported(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof window.PublicKeyCredential === "function" &&
		!!navigator.credentials
	);
}

const fromB64url = (s: string): ArrayBuffer => {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out.buffer;
};

const toB64url = (buf: ArrayBuffer | ArrayBufferView): string => {
	const bytes =
		buf instanceof ArrayBuffer
			? new Uint8Array(buf)
			: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

interface DescriptorJSON {
	type: "public-key";
	id: string;
	transports?: string[];
}

const descriptors = (list: DescriptorJSON[] | undefined) =>
	(list ?? []).map((d) => ({
		type: d.type,
		id: fromB64url(d.id),
		transports: d.transports as AuthenticatorTransport[] | undefined,
	}));

interface CreationJSON
	extends Omit<
		PublicKeyCredentialCreationOptions,
		"challenge" | "user" | "excludeCredentials"
	> {
	challenge: string;
	user: { id: string; name: string; displayName: string };
	excludeCredentials?: DescriptorJSON[];
}

interface RequestJSON
	extends Omit<
		PublicKeyCredentialRequestOptions,
		"challenge" | "allowCredentials"
	> {
	challenge: string;
	allowCredentials?: DescriptorJSON[];
}

interface Begun<T> {
	ceremonyId: string;
	publicKey: T;
}

function assertionJSON(cred: PublicKeyCredential) {
	const r = cred.response as AuthenticatorAssertionResponse;
	return {
		id: cred.id,
		rawId: toB64url(cred.rawId),
		type: cred.type,
		response: {
			clientDataJSON: toB64url(r.clientDataJSON),
			authenticatorData: toB64url(r.authenticatorData),
			signature: toB64url(r.signature),
			userHandle: r.userHandle ? toB64url(r.userHandle) : null,
		},
	};
}

function registrationJSON(cred: PublicKeyCredential) {
	const r = cred.response as AuthenticatorAttestationResponse;
	const ext = cred.getClientExtensionResults() as {
		credProps?: { rk?: boolean };
	};
	return {
		id: cred.id,
		rawId: toB64url(cred.rawId),
		type: cred.type,
		response: {
			clientDataJSON: toB64url(r.clientDataJSON),
			attestationObject: toB64url(r.attestationObject),
			transports: r.getTransports?.() ?? [],
		},
		clientExtensionResults: ext.credProps ? { credProps: ext.credProps } : {},
	};
}

/**
 * A passkey call. Plain `fetch`, as for the password change: a refused
 * passkey answers 401 and must not bounce the owner to the login page.
 */
async function passkeyCall<T>(
	action: string,
	body?: unknown,
	withKey = true,
): Promise<T> {
	const res = await fetch(authUrl(action), {
		method: body === undefined ? "GET" : "POST",
		credentials: "same-origin",
		headers: {
			...(withKey ? keyHeaders() : {}),
			...(body === undefined
				? {}
				: { "content-type": "application/json", "x-mfw-auth": "1" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const data = (await res.json().catch(() => null)) as
		| (T & { error?: string; message?: string; retryAfterSeconds?: number })
		| null;
	if (!res.ok || data === null)
		throw new AuthRequestError(
			data?.message ?? `request failed (${res.status})`,
			data?.error ?? "error",
			data?.retryAfterSeconds ?? 0,
		);
	return data;
}

/** The browser's own refusal (cancelled, timed out) as an `AuthRequestError`. */
function browserRefusal(e: unknown): never {
	if (e instanceof AuthRequestError) throw e;
	const name = (e as { name?: string })?.name;
	throw new AuthRequestError(
		name === "NotAllowedError"
			? "The passkey request was cancelled or timed out."
			: name === "InvalidStateError"
				? "This authenticator already holds a passkey for mfw."
				: name === "SecurityError"
					? "Passkeys are not available on this address."
					: "The browser could not use a passkey.",
		"passkey_browser",
		0,
	);
}

async function getAssertion(begun: Begun<RequestJSON>) {
	const cred = (await navigator.credentials
		.get({
			publicKey: {
				...begun.publicKey,
				challenge: fromB64url(begun.publicKey.challenge),
				allowCredentials: descriptors(begun.publicKey.allowCredentials),
			},
		})
		.catch(browserRefusal)) as PublicKeyCredential | null;
	if (!cred) browserRefusal(null);
	return assertionJSON(cred as PublicKeyCredential);
}

/** Sign in with a passkey: the same session and request key as a password. */
export async function signInWithPasskey(): Promise<void> {
	const begun = await passkeyCall<Begun<RequestJSON>>(
		"passkey-login-options",
		{},
		false,
	);
	const credential = await getAssertion(begun);
	const data = await passkeyCall<{ requestKey?: string }>(
		"passkey-login",
		{ ceremonyId: begun.ceremonyId, credential },
		false,
	);
	writeRequestKey(data.requestKey ?? null);
}

export const listPasskeys = async (): Promise<Passkey[]> =>
	(await passkeyCall<{ passkeys: Passkey[] }>("passkeys")).passkeys;

export const revokePasskey = async (id: string): Promise<void> => {
	await passkeyCall("passkey-revoke", { id });
};

/**
 * Add a passkey. The server wants a fresh proof first: the password, or an
 * existing passkey (`"passkey"`).
 */
export async function addPasskey(
	name: string,
	proof: { password: string } | "passkey",
): Promise<void> {
	let body: unknown = proof;
	if (proof === "passkey") {
		const reauth = await passkeyCall<Begun<RequestJSON>>(
			"passkey-reauth-options",
			{},
		);
		body = {
			ceremonyId: reauth.ceremonyId,
			credential: await getAssertion(reauth),
		};
	}
	const begun = await passkeyCall<Begun<CreationJSON>>(
		"passkey-register-options",
		body,
	);
	const cred = (await navigator.credentials
		.create({
			publicKey: {
				...begun.publicKey,
				challenge: fromB64url(begun.publicKey.challenge),
				user: {
					...begun.publicKey.user,
					id: fromB64url(begun.publicKey.user.id),
				},
				excludeCredentials: descriptors(begun.publicKey.excludeCredentials),
			},
		})
		.catch(browserRefusal)) as PublicKeyCredential | null;
	if (!cred) browserRefusal(null);
	await passkeyCall("passkey-register", {
		ceremonyId: begun.ceremonyId,
		credential: registrationJSON(cred as PublicKeyCredential),
		name,
	});
}
