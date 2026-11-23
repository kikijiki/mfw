import { safeNext } from "./auth-paths";

/**
 * The browser's side of auth. The session cookie is HttpOnly, so script never
 * sees it; the CSRF token is held in memory only and fetched from the
 * same-origin state endpoint, which another site cannot read.
 */

const base = () =>
	`/${import.meta.env.BASE_URL ?? "/"}/`.replace(/\/{2,}/g, "/");
const authUrl = (action: string) => `${base()}api/auth/${action}`;

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

let csrf: Promise<string | null> | null = null;

export async function fetchAuthState(): Promise<{
	state: AuthState;
	csrfToken?: string;
}> {
	const res = await fetch(authUrl("state"), { credentials: "same-origin" });
	if (!res.ok) throw new Error(`auth state failed (${res.status})`);
	return res.json();
}

function csrfToken(): Promise<string | null> {
	csrf ??= fetchAuthState()
		.then((s) => s.csrfToken ?? null)
		.catch(() => {
			csrf = null;
			return null;
		});
	return csrf;
}

/** Leave for the login page, coming back to where the user was. */
export function redirectToLogin(): void {
	if (typeof window === "undefined") return;
	const { pathname, search } = window.location;
	if (pathname === `${base()}login`) return;
	const next = encodeURIComponent(`${pathname}${search}`);
	window.location.assign(`${base()}login?next=${next}`);
}

/** `fetch` for tRPC: adds the CSRF token to writes and handles a lost session. */
export const authedFetch: typeof fetch = Object.assign(
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const method = (init?.method ?? "GET").toUpperCase();
		const send = async () => {
			const headers = new Headers(init?.headers);
			if (method !== "GET" && method !== "HEAD") {
				const token = await csrfToken();
				if (token) headers.set("x-mfw-csrf", token);
			}
			return fetch(input, { ...init, headers, credentials: "same-origin" });
		};
		let res = await send();
		if (res.status === 403 && method === "POST") {
			const body = (await res
				.clone()
				.json()
				.catch(() => null)) as { error?: string } | null;
			if (body?.error === "csrf") {
				csrf = null;
				res = await send();
			}
		}
		if (res.status === 401) {
			csrf = null;
			redirectToLogin();
		}
		return res;
	},
	{ preconnect: fetch.preconnect },
);

/**
 * An EventSource that notices a lost session. The server ends the stream on
 * logout or expiry; the reconnect then gets a 401, which closes the source.
 */
export function sessionAwareEventSource(): typeof EventSource | undefined {
	if (typeof EventSource === "undefined") return undefined;
	return class SessionEventSource extends EventSource {
		constructor(url: string | URL, init?: EventSourceInit) {
			super(url, init);
			this.addEventListener("error", () => {
				if (this.readyState !== EventSource.CLOSED) return;
				fetchAuthState()
					.then((s) => {
						if (s.state !== "authenticated") redirectToLogin();
					})
					.catch(() => undefined);
			});
		}
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
	} | null;
	if (!res.ok)
		throw new AuthRequestError(
			data?.message ?? `request failed (${res.status})`,
			data?.error ?? "error",
			data?.retryAfterSeconds ?? 0,
		);
	csrf = null;
}

export const submitSetup = (token: string, password: string) =>
	submit("setup", { token, password });
export const submitLogin = (password: string) => submit("login", { password });

export function afterLogin(search: string): void {
	const next = new URLSearchParams(search).get("next");
	window.location.assign(safeNext(next, base()));
}

export async function signOut(): Promise<void> {
	const token = await csrfToken();
	await fetch(authUrl("logout"), {
		method: "POST",
		credentials: "same-origin",
		headers: token ? { "x-mfw-csrf": token } : {},
	});
	csrf = null;
	window.location.assign(`${base()}login`);
}
