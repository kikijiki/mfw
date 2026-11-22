import {
	createCsrfMiddleware,
	createMiddleware,
	createStart,
} from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
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

export const startInstance = createStart(() => ({
	requestMiddleware: [csrfMiddleware, securityHeadersMiddleware],
}));
