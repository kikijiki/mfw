import {
	createCsrfMiddleware,
	createMiddleware,
	createStart,
} from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { guardAppRequest } from "./server/auth-guard";
import {
	applySecurityHeaders,
	newNonce,
	rememberNonce,
} from "./server/security-headers";

/**
 * Registering a start instance replaces Start's default request middleware, so
 * the CSRF check for server functions is listed again here.
 */
const csrfMiddleware = createCsrfMiddleware({
	filter: (ctx) => ctx.handlerType === "serverFn",
});

/**
 * Stamps every response with the security headers. The nonce lives in the
 * request context so `getRouter` can hand it to the router, which puts it on
 * the inline scripts it emits; the CSP header carries the same value.
 */
const securityHeadersMiddleware = createMiddleware().server(async (ctx) => {
	const nonce = newNonce();
	rememberNonce(getRequest(), nonce);
	const result = await ctx.next({ context: { nonce } });
	return {
		...result,
		response: applySecurityHeaders(result.response, nonce, {
			skipCsp: import.meta.env.DEV,
		}),
	};
});

/**
 * Every request the app handles passes the session guard: pages get a login
 * redirect, everything else a 401. It sits inside the headers middleware so a
 * refusal carries the security headers too. Route handlers guard again, because
 * they need the session and must stay safe if this list ever changes.
 */
const authMiddleware = createMiddleware().server(async (ctx) => {
	const guarded = await guardAppRequest(getRequest());
	if (!guarded.ok) return guarded.response as never;
	return ctx.next();
});

export const startInstance = createStart(() => ({
	requestMiddleware: [
		csrfMiddleware,
		securityHeadersMiddleware,
		authMiddleware,
	],
}));
