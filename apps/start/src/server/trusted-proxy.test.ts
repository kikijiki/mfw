import { describe, expect, test } from "bun:test";
import {
	isLoopbackAddress,
	MAX_FORWARDED_HOPS,
	MAX_FORWARDED_LENGTH,
	parseTrustedProxies,
	resolveForwarded,
} from "./trusted-proxy";

const proxies = (value: string) => {
	const parsed = parseTrustedProxies(value);
	expect(parsed.errors).toEqual([]);
	return parsed.proxies;
};
const LOCAL = proxies("127.0.0.1");
const headers = (h: Record<string, string>) => new Headers(h);
const proxied = (h: Record<string, string>, list = LOCAL, peer = "127.0.0.1") =>
	resolveForwarded(headers(h), peer, list);
const XF = { "x-forwarded-proto": "https", "x-forwarded-host": "box.ts.net" };

describe("trusted proxy list", () => {
	test("is empty by default: loopback is not implicitly trusted", () => {
		expect(parseTrustedProxies(undefined).proxies).toEqual([]);
		const r = resolveForwarded(
			headers({ ...XF, "x-forwarded-for": "203.0.113.9" }),
			"127.0.0.1",
			[],
		);
		expect(r.kind).toBe("direct");
	});

	test("accepts addresses and CIDRs of both families", () => {
		expect(
			parseTrustedProxies("127.0.0.1, 10.1.0.0/16 ::1 fd7a:115c:a1e0::/48")
				.errors,
		).toEqual([]);
	});

	for (const bad of [
		"*",
		"0.0.0.0/0",
		"::/0",
		"10.0.0.0/7",
		"2001::/31",
		"10.0.0.1/33",
		"::1/129",
		"10.0.0.1/",
		"10.0.0.256",
		"010.0.0.1",
		"proxy.example",
		"fe80::1%eth0",
		"127.0.0.1:8080",
	])
		test(`refuses '${bad}'`, () => {
			expect(parseTrustedProxies(bad).errors.length).toBe(1);
			expect(parseTrustedProxies(bad).proxies).toEqual([]);
		});
});

describe("forwarded headers from an untrusted peer", () => {
	for (const h of [
		{ "x-forwarded-for": "203.0.113.9" },
		{ "x-forwarded-proto": "https" },
		{ "x-forwarded-host": "box.ts.net" },
		{ forwarded: "for=203.0.113.9;proto=https;host=box.ts.net" },
		{ "x-forwarded-for": "not an address" },
	] as Record<string, string>[])
		test(`ignores ${Object.keys(h)[0]}`, () => {
			expect(resolveForwarded(headers(h), "198.51.100.7", LOCAL).kind).toBe(
				"direct",
			);
		});

	test("a missing peer is never trusted", () => {
		expect(
			resolveForwarded(
				headers({ ...XF, "x-forwarded-for": "203.0.113.9" }),
				undefined,
				LOCAL,
			).kind,
		).toBe("direct");
	});

	test("an IPv4-mapped peer matches its IPv4 entry", () => {
		const r = proxied(
			{ ...XF, "x-forwarded-for": "203.0.113.9" },
			LOCAL,
			"::ffff:127.0.0.1",
		);
		expect(r.kind).toBe("proxied");
	});
});

describe("rightmost-untrusted client address", () => {
	const client = (xff: string, list = LOCAL) => {
		const r = proxied({ ...XF, "x-forwarded-for": xff }, list);
		if (r.kind !== "proxied") throw new Error(JSON.stringify(r));
		return r.client;
	};

	test("a single hop", () => {
		expect(client("203.0.113.9")).toBe("203.0.113.9");
	});
	test("a forged left entry is not the client", () => {
		expect(client("1.2.3.4, 203.0.113.9")).toBe("203.0.113.9");
	});
	test("trusted hops on the right are skipped", () => {
		const list = proxies("127.0.0.1 10.0.0.0/8");
		expect(client("1.2.3.4, 203.0.113.9, 10.0.0.2, 10.9.9.9", list)).toBe(
			"203.0.113.9",
		);
	});
	test("every hop trusted: the leftmost is the client", () => {
		const list = proxies("127.0.0.1 10.0.0.0/8");
		expect(client("10.0.0.3, 10.0.0.2", list)).toBe("10.0.0.3");
	});
	test("IPv6 clients, canonical and mixed case", () => {
		expect(client("2001:DB8::1")).toBe("2001:db8::1");
	});
	test("an IPv4-mapped client is its IPv4 address", () => {
		expect(client("::ffff:203.0.113.9")).toBe("203.0.113.9");
	});
});

describe("malformed forwarded headers from a trusted peer", () => {
	for (const xff of [
		"",
		"unknown",
		"_hidden",
		"203.0.113.9:1234",
		"[2001:db8::1]:1234",
		"[2001:db8::1]",
		"fe80::1%eth0",
		"203.0.113.256",
		"203.0.113.09",
		"203.0.113.9,",
		",203.0.113.9",
		"203.0.113.9,,198.51.100.1",
		"203.0.113.9 198.51.100.1",
		"1:2:3:4:5:6:7:8:9",
	])
		test(`refuses X-Forwarded-For '${xff}'`, () => {
			expect(proxied({ ...XF, "x-forwarded-for": xff }).kind).toBe("invalid");
		});

	test("refuses too many hops", () => {
		const list = Array(MAX_FORWARDED_HOPS + 1)
			.fill("203.0.113.9")
			.join(",");
		expect(proxied({ ...XF, "x-forwarded-for": list }).kind).toBe("invalid");
	});
	test("accepts exactly the hop limit", () => {
		const list = Array(MAX_FORWARDED_HOPS).fill("203.0.113.9").join(",");
		expect(proxied({ ...XF, "x-forwarded-for": list }).kind).toBe("proxied");
	});
	test("refuses an over-long header", () => {
		// Valid but for its length: inner padding survives header trimming.
		const long = `203.0.113.9${" ".repeat(MAX_FORWARDED_LENGTH)},198.51.100.1`;
		expect(proxied({ ...XF, "x-forwarded-for": long }).kind).toBe("invalid");
	});

	for (const proto of ["http", "HTTP", "https,http", "https, https", "ftp", ""])
		test(`refuses X-Forwarded-Proto '${proto}'`, () => {
			expect(
				proxied({
					"x-forwarded-for": "203.0.113.9",
					"x-forwarded-proto": proto,
				}).kind,
			).toBe("invalid");
		});

	for (const host of ["a.example,b.example", "a b", "user@a.example", ""])
		test(`refuses X-Forwarded-Host '${host}'`, () => {
			expect(
				proxied({
					"x-forwarded-for": "203.0.113.9",
					"x-forwarded-proto": "https",
					"x-forwarded-host": host,
				}).kind,
			).toBe("invalid");
		});

	test("a partial set is refused", () => {
		expect(proxied({ "x-forwarded-for": "203.0.113.9" }).kind).toBe("invalid");
		expect(proxied({ "x-forwarded-proto": "https" }).kind).toBe("invalid");
		expect(proxied({ "x-forwarded-host": "box.ts.net" }).kind).toBe("invalid");
	});

	test("both header families at once are ambiguous", () => {
		expect(
			proxied({
				...XF,
				"x-forwarded-for": "203.0.113.9",
				forwarded: "for=198.51.100.1;proto=https",
			}).kind,
		).toBe("invalid");
	});
});

describe("the Forwarded header", () => {
	const one = (forwarded: string, list = LOCAL) => proxied({ forwarded }, list);

	test("a single element", () => {
		expect(one("for=203.0.113.9;proto=https;host=box.ts.net")).toEqual({
			kind: "proxied",
			client: "203.0.113.9",
			proto: "https",
			host: "box.ts.net",
		});
	});
	test("quoted IPv6 with a port", () => {
		const r = one('for="[2001:db8::1]:4711";proto=https');
		expect(r.kind === "proxied" && r.client).toBe("2001:db8::1");
	});
	test("parameter names are case-insensitive", () => {
		expect(one("For=203.0.113.9;PROTO=https").kind).toBe("proxied");
	});
	test("rightmost-untrusted across elements, proto from the nearest", () => {
		const list = proxies("127.0.0.1 10.0.0.0/8");
		const r = one(
			"for=1.2.3.4;proto=http, for=203.0.113.9;proto=http, for=10.0.0.2;proto=https;host=box.ts.net",
			list,
		);
		expect(r).toEqual({
			kind: "proxied",
			client: "203.0.113.9",
			proto: "https",
			host: "box.ts.net",
		});
	});
	test("a comma inside quotes does not split an element", () => {
		expect(one('for="1.2.3.4,5.6.7.8";proto=https').kind).toBe("invalid");
	});

	for (const bad of [
		"for=203.0.113.9",
		"proto=https",
		"for=unknown;proto=https",
		"for=_hidden;proto=https",
		"for=203.0.113.9;for=198.51.100.1;proto=https",
		"for=203.0.113.9;proto=https;proto=https",
		"for=203.0.113.9;proto=http",
		"for=203.0.113.9;proto=https;secret=1",
		'for="203.0.113.9;proto=https',
		'for="\\203.0.113.9";proto=https',
		"for=2001:db8::1;proto=https",
		"for=203.0.113.9;;proto=https",
		"for=203.0.113.9;proto=https,",
	])
		test(`refuses '${bad}'`, () => {
			expect(one(bad).kind).toBe("invalid");
		});
});

describe("loopback addresses", () => {
	for (const a of ["127.0.0.1", "127.9.9.9", "::1", "::ffff:127.0.0.1"])
		test(`${a} is loopback`, () => expect(isLoopbackAddress(a)).toBe(true));
	for (const a of ["10.0.0.1", "::2", "::ffff:10.0.0.1", "", "localhost"])
		test(`'${a}' is not`, () => expect(isLoopbackAddress(a)).toBe(false));
});
