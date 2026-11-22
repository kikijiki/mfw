import { describe, expect, test } from "bun:test";
import {
	applySecurityHeaders,
	BASELINE_HEADERS,
	contentSecurityPolicy,
	newNonce,
	nonceFor,
	rememberNonce,
} from "./security-headers";

const directives = (csp: string) =>
	Object.fromEntries(
		csp.split(";").map((d) => {
			const [name, ...rest] = d.trim().split(/\s+/);
			return [name, rest];
		}),
	) as Record<string, string[]>;

describe("content security policy", () => {
	const d = directives(contentSecurityPolicy("abc"));

	test("scripts run only from this origin or with the response nonce", () => {
		expect(d["script-src"]).toEqual(["'self'", "'nonce-abc'"]);
	});
	test("no directive allows unsafe-eval, and only styles allow unsafe-inline", () => {
		for (const [name, values] of Object.entries(d)) {
			expect(values).not.toContain("'unsafe-eval'");
			if (name !== "style-src") expect(values).not.toContain("'unsafe-inline'");
		}
	});
	test("nothing may load from, or send to, another origin", () => {
		for (const name of ["img-src", "connect-src", "font-src", "style-src"])
			for (const v of d[name] ?? [])
				expect(v).toMatch(/^('self'|'unsafe-inline'|data:|blob:)$/);
		expect(d["default-src"]).toEqual(["'none'"]);
	});
	test("no plugins, frames, base tag, or framing by others", () => {
		expect(d["object-src"]).toEqual(["'none'"]);
		expect(d["frame-src"]).toEqual(["'none'"]);
		expect(d["base-uri"]).toEqual(["'none'"]);
		expect(d["frame-ancestors"]).toEqual(["'none'"]);
	});
});

describe("nonce", () => {
	test("is 128 random bits, different every time", () => {
		const a = newNonce();
		expect(atob(a).length).toBe(16);
		expect(newNonce()).not.toBe(a);
	});
	test("is remembered per request", () => {
		const r = new Request("http://localhost/");
		expect(nonceFor(r)).toBeUndefined();
		rememberNonce(r, "n1");
		expect(nonceFor(r)).toBe("n1");
		expect(nonceFor(new Request("http://localhost/"))).toBeUndefined();
	});
});

describe("applySecurityHeaders", () => {
	test("adds the baseline and the policy", () => {
		const res = applySecurityHeaders(new Response("x"), "abc");
		for (const [k, v] of Object.entries(BASELINE_HEADERS))
			expect(res.headers.get(k)).toBe(v);
		expect(res.headers.get("content-security-policy")).toContain("'nonce-abc'");
	});
	test("keeps a policy the route set itself (the sandboxed file routes)", () => {
		const res = applySecurityHeaders(
			new Response("x", { headers: { "Content-Security-Policy": "sandbox" } }),
			"abc",
		);
		expect(res.headers.get("content-security-policy")).toBe("sandbox");
		expect(res.headers.get("x-frame-options")).toBe("DENY");
	});
	test("skipCsp leaves the policy off but keeps the rest", () => {
		const res = applySecurityHeaders(new Response("x"), "abc", {
			skipCsp: true,
		});
		expect(res.headers.has("content-security-policy")).toBe(false);
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
	});
	test("a redirect with immutable headers is copied, not thrown on", () => {
		const res = applySecurityHeaders(
			Response.redirect("http://localhost/x", 302),
			"abc",
		);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("http://localhost/x");
		expect(res.headers.get("content-security-policy")).toContain("'self'");
	});
});
