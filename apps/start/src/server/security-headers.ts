/**
 * Security headers for every response the app's request handlers produce (pages,
 * tRPC, SSE and the raw file routes), attached by the request middleware in
 * `src/start.ts`. Static build assets (`/assets/*`, fonts, `public/`) are served
 * by the nitro file server before that middleware and carry none of them; the
 * CSP nonce is per request, so it cannot apply to them in any case.
 *
 * Why it exists: the UI renders agent-authored markdown, mermaid diagrams and
 * file contents inside a session that can approve widening a sandbox, so an
 * injected script must not be able to run. The policy is the second line; the
 * first is that nothing is rendered as raw HTML (see the review in
 * `securityReview.test.ts`).
 *
 * The policy:
 * - `script-src 'self' 'nonce-…'`: only our own bundle and the inline scripts
 *   the server stamps with this response's random nonce (the router's
 *   hydration data and the theme bootstrap). No `unsafe-inline`, no
 *   `unsafe-eval`, so an `onerror=` attribute or a `<script>` in injected
 *   markup is inert.
 * - `style-src 'self' 'unsafe-inline'`: React `style` props and mermaid's
 *   inline `<style>` need it. Styles cannot run code, and with `img-src` and
 *   `connect-src` limited to this origin they cannot send data out either.
 * - `img-src 'self' data: blob:`: a document or spec that embeds an external
 *   image (a tracking pixel) shows a broken image instead of a request.
 * - `connect-src 'self'` covers tRPC and SSE. `object-src 'none'`,
 *   `frame-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`,
 *   `form-action 'self'`.
 *
 * Routes that already send their own `Content-Security-Policy` (the file,
 * docs and attachment routes send `sandbox`) keep it: it is stricter, and a
 * header already present is never overwritten.
 */

/** A fresh 128-bit nonce, base64. One per response, never reused. */
export function newNonce(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return btoa(String.fromCharCode(...bytes));
}

/** The policy for one response. */
export function contentSecurityPolicy(nonce: string): string {
	return [
		"default-src 'none'",
		`script-src 'self' 'nonce-${nonce}'`,
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"font-src 'self' data:",
		"connect-src 'self'",
		"manifest-src 'self'",
		"worker-src 'self' blob:",
		"object-src 'none'",
		"frame-src 'none'",
		"base-uri 'none'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	].join("; ");
}

/** Headers set on every response, whatever the route. */
export const BASELINE_HEADERS: Readonly<Record<string, string>> = {
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "no-referrer",
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Permissions-Policy":
		"camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
};

export interface SecurityHeaderOptions {
	/**
	 * Skip the CSP only. `vite dev` injects un-nonced inline scripts for hot
	 * reload, which a strict policy would break; the other headers still apply.
	 */
	skipCsp?: boolean;
}

/**
 * Add the security headers to `response`, keeping any the route already set.
 * Returns the response to send: the same object when its headers are mutable,
 * a copy when they are not (a `Response.redirect`).
 */
export function applySecurityHeaders(
	response: Response,
	nonce: string,
	opts: SecurityHeaderOptions = {},
): Response {
	const wanted: [string, string][] = Object.entries(BASELINE_HEADERS);
	if (!opts.skipCsp)
		wanted.push(["Content-Security-Policy", contentSecurityPolicy(nonce)]);
	const set = (res: Response) => {
		for (const [name, value] of wanted)
			if (!res.headers.has(name)) res.headers.set(name, value);
	};
	try {
		set(response);
		return response;
	} catch {
		const copy = new Response(response.body, response);
		set(copy);
		return copy;
	}
}

/**
 * The nonce chosen for each in-flight request. The middleware sets it, and
 * `getRouter` reads it, because Start gives the router factory no request
 * context. Keyed by the `Request` object (what `getRequest()` returns in both
 * places), so it is collected with the request.
 */
const nonces = new WeakMap<Request, string>();
export const rememberNonce = (req: Request, nonce: string) =>
	void nonces.set(req, nonce);
export const nonceFor = (req: Request): string | undefined => nonces.get(req);
