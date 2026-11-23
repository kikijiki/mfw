import { describe, expect, test } from "bun:test";
import { checkRequest } from "./request-guard";

const req = (
	headers: Record<string, string>,
	method = "GET",
	url = "http://localhost:7777/api/trpc/x",
) => new Request(url, { method, headers });
const run = (
	headers: Record<string, string>,
	env: Record<string, string | undefined> = {},
	method = "GET",
) => checkRequest(req(headers, method), env);
/** A listener with its own TLS: the one way to take a non-loopback Host directly. */
const TLS = { NITRO_SSL_CERT: "cert", NITRO_SSL_KEY: "key" };

describe("request guard: Host", () => {
	for (const host of [
		"localhost:7777",
		"localhost",
		"127.0.0.1:7777",
		"[::1]:7777",
		"LOCALHOST:7777",
	])
		test(`loopback '${host}' passes with no Origin`, () => {
			expect(run({ host })).toBeNull();
		});

	for (const host of [
		"evil.example",
		"evil.example:7777",
		"127.0.0.1.nip.io",
		"127.0.0.1.nip.io:7777",
		"localhost.evil.example",
		"0.0.0.0:7777",
		"127.0.0.2:7777",
		"2130706433",
		"localhost:0",
		"localhost:99999",
		"user@localhost",
		"localhost/x",
		"",
	])
		test(`'${host}' is refused`, async () => {
			const res = run({ host });
			expect(res?.status).toBe(403);
			expect(res?.headers.get("x-mfw-guard")).toBe("refused");
			expect(await res?.text()).toContain("MFW_ALLOWED_HOSTS");
		});

	test("a ts.net host passes only when listed", () => {
		const host = "box.tail1234.ts.net";
		const listed = (MFW_ALLOWED_HOSTS: string) => ({
			...TLS,
			MFW_ALLOWED_HOSTS,
		});
		expect(run({ host }, TLS)?.status).toBe(403);
		expect(run({ host }, listed("other.ts.net"))?.status).toBe(403);
		expect(run({ host }, listed(host))).toBeNull();
		expect(run({ host: `${host}:7777` }, listed(host))).toBeNull();
		expect(
			run({ host: `${host}:7777` }, listed(`a.b, ${host}:7777`)),
		).toBeNull();
		expect(run({ host: `${host}:8888` }, listed(`${host}:7777`))?.status).toBe(
			403,
		);
	});

	test("a trailing dot does not smuggle a host past the list", () => {
		expect(run({ host: "evil.example." })?.status).toBe(403);
		expect(run({ host: "localhost.:7777" })).toBeNull();
	});
});

describe("request guard: Origin and Sec-Fetch-Site", () => {
	const host = "localhost:7777";

	test("same-origin Origin passes", () => {
		expect(run({ host, origin: "http://localhost:7777" })).toBeNull();
	});
	test("foreign Origin is refused even with a loopback Host", () => {
		expect(run({ host, origin: "https://evil.example" })?.status).toBe(403);
	});
	test("another local app on a different port is refused", () => {
		expect(run({ host, origin: "http://localhost:3000" })?.status).toBe(403);
	});
	test("Origin null and garbage are refused", () => {
		expect(run({ host, origin: "null" })?.status).toBe(403);
		expect(run({ host, origin: "not a url" })?.status).toBe(403);
		expect(run({ host, origin: "file:///x" })?.status).toBe(403);
	});
	test("a listed host with a matching Origin passes", () => {
		const env = { ...TLS, MFW_ALLOWED_HOSTS: "box.ts.net" };
		const r = new Request("https://box.ts.net/api/trpc/x", {
			headers: { host: "box.ts.net", origin: "https://box.ts.net" },
		});
		expect(checkRequest(r, env)).toBeNull();
	});
	test("a listed Origin does not pass against a different Host", () => {
		const env = { MFW_ALLOWED_HOSTS: "box.ts.net" };
		expect(run({ host, origin: "https://box.ts.net" }, env)?.status).toBe(403);
	});
	test("cross-site state-changing request is refused, safe methods are not", () => {
		const h = { host, "sec-fetch-site": "cross-site" };
		expect(run(h, {}, "POST")?.status).toBe(403);
		expect(run(h, {}, "DELETE")?.status).toBe(403);
		expect(run(h, {}, "GET")).toBeNull();
	});
	test("same-origin and none Sec-Fetch-Site pass for POST", () => {
		expect(
			run({ host, "sec-fetch-site": "same-origin" }, {}, "POST"),
		).toBeNull();
		expect(run({ host, "sec-fetch-site": "none" }, {}, "POST")).toBeNull();
	});
	test("no Origin and a loopback Host passes for POST (MCP clients)", () => {
		expect(run({ host }, {}, "POST")).toBeNull();
	});
	test("with no Host header the URL authority is checked", () => {
		const r = new Request("http://evil.example/api/trpc/x");
		r.headers.delete("host");
		expect(checkRequest(r, {})?.status).toBe(403);
	});
});

describe("request guard: Origin scheme (reviewer m1)", () => {
	test("an https Origin is refused for a plain-HTTP loopback request", () => {
		expect(
			run({ host: "localhost:7777", origin: "https://localhost:7777" }),
		).not.toBeNull();
	});

	test("the matching scheme passes", () => {
		expect(
			run({ host: "localhost:7777", origin: "http://localhost:7777" }),
		).toBeNull();
	});

	test("an http Origin is refused on a TLS request", () => {
		const r = new Request("https://localhost:7777/api/trpc/x", {
			headers: { host: "localhost:7777", origin: "http://localhost:7777" },
		});
		expect(checkRequest(r, {})).not.toBeNull();
	});

	test("a listed host without TLS or a trusted proxy is refused", () => {
		expect(
			run(
				{
					host: "box.example",
					origin: "https://box.example",
					"x-forwarded-proto": "https",
				},
				{ MFW_ALLOWED_HOSTS: "box.example" },
			)?.status,
		).toBe(403);
	});
});
