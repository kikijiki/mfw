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
		let lost = res.status === 401;
		if (res.status === 403) {
			const body = (await res
				.clone()
				.json()
				.catch(() => null)) as { error?: string } | null;
			lost = body?.error === "request_key";
		}
		if (lost) {
			writeRequestKey(null);
			redirectToLogin();
		}
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
