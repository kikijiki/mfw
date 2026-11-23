/**
 * Pure policy for the per-run egress proxy (the sandbox experiments, E4
 * "Exact rules" 2-7 and 11). No sockets and no clocks: everything here is a
 * function of its inputs, so the adversarial table runs anywhere.
 *
 * The proxy is deny-by-default: only `CONNECT <host>:<port>` for an exact
 * allowlisted pair, only to globally routable addresses, and only to the one
 * IP that was resolved once. A deny-list over string forms cannot be made
 * safe (decimal, hex, octal and short IPv4 encodings), so numeric hosts are
 * rejected outright instead of classified.
 */

import { isIP } from "node:net";

/** Largest request head (request line plus headers) the proxy will buffer. */
export const MAX_HEAD_BYTES = 8 * 1024;

/** Why a request or target was refused, and with which HTTP status. */
export interface EgressDenial {
	ok: false;
	status: 400 | 403 | 405 | 408 | 429 | 431 | 502 | 504;
	reason: string;
}

export type ParsedConnect =
	| { ok: true; host: string; port: number }
	| EgressDenial;

const AUTHORITY = /^[A-Za-z0-9.-]+:[1-9][0-9]{0,4}$/;
const HTTP2_PREFACE = "PRI * HTTP/2.0";

/**
 * Parse one request head (everything up to, excluding, the blank line).
 *
 * Only the exact request line `CONNECT <authority> HTTP/1.1` or `HTTP/1.0`
 * is accepted. Malformed input is 400; a well-formed request for anything
 * other than CONNECT (absolute-form GET, a websocket upgrade, a lowercase
 * method, HTTP/0.9) is 405. There is no plain-HTTP forwarding at all.
 */
export function parseRequestHead(head: string): ParsedConnect {
	// ASCII only, and no control byte except the CRLF between lines.
	for (let i = 0; i < head.length; i++) {
		const c = head.charCodeAt(i);
		if (c === 0x0d) {
			if (head.charCodeAt(i + 1) !== 0x0a) return bad("control-byte");
			i++;
			continue;
		}
		if (c === 0x0a) return bad("control-byte");
		if (c < 0x20 || c > 0x7e) {
			if (c === 0x09) continue; // a tab is legal in header values
			return bad(c > 0x7e ? "non-ascii" : "control-byte");
		}
	}
	const eol = head.indexOf("\r\n");
	const line = eol === -1 ? head : head.slice(0, eol);
	if (line.startsWith(HTTP2_PREFACE)) return bad("http2-preface");
	const parts = line.split(" ");
	const method = parts[0] ?? "";
	// A real request line has exactly three single-space-separated fields.
	if (parts.length !== 3 || parts.some((p) => p === "")) {
		return /^[A-Za-z]+$/.test(method)
			? notAllowed("not-connect")
			: bad("request-line");
	}
	const version = parts[2];
	if (method !== "CONNECT") return notAllowed("not-connect");
	if (version !== "HTTP/1.1" && version !== "HTTP/1.0")
		return notAllowed("http-version");
	return parseAuthority(parts[1] ?? "");
}

/** Check, split and normalise a CONNECT authority (rules 3 and 4). */
export function parseAuthority(authority: string): ParsedConnect {
	if (authority.startsWith("[")) return bad("ipv6-literal");
	if (authority.includes("@")) return bad("userinfo");
	if (!AUTHORITY.test(authority)) return bad("authority-syntax");
	const colon = authority.lastIndexOf(":");
	const port = Number(authority.slice(colon + 1));
	if (port > 65535) return bad("port-range");
	const host = normalizeHost(authority.slice(0, colon));
	if (host === null) return bad("host-syntax");
	return { ok: true, host, port };
}

/**
 * Lower-case, strip one trailing dot, reject empty labels (so `a..b`, a
 * leading dot and a second trailing dot all fail). Null when invalid.
 */
export function normalizeHost(raw: string): string | null {
	let host = raw.toLowerCase();
	if (host.endsWith(".")) host = host.slice(0, -1);
	if (host === "" || host.length > 253) return null;
	for (const label of host.split(".")) {
		if (label === "" || label.length > 63) return null;
	}
	return host;
}

/**
 * Rule 5: a last label that is all digits or `0x` hex covers decimal, hex,
 * octal and short IPv4 encodings and every dotted-quad literal. Never rely
 * on an address parser to classify the string: `getaddrinfo` accepts forms
 * that parsers do not.
 */
export function isNumericHost(host: string): boolean {
	const last = host.slice(host.lastIndexOf(".") + 1);
	return /^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/i.test(last);
}

/** The exact per-run `(host, port)` allowlist (rule 6). No wildcards. */
export interface EgressAllowlist {
	has(host: string, port: number): boolean;
	/** Normalised `host:port` entries, sorted. */
	entries(): string[];
}

export type AllowEntry = string | { host: string; port?: number };

/**
 * Build the allowlist. A bare host means port 443. Throws on an entry that
 * would never match or that the policy forbids (numeric host, wildcard).
 */
export function buildAllowlist(
	entries: readonly AllowEntry[],
): EgressAllowlist {
	const set = new Set<string>();
	for (const entry of entries) {
		let hostRaw: string;
		let port = 443;
		if (typeof entry === "string") {
			const colon = entry.lastIndexOf(":");
			hostRaw = colon === -1 ? entry : entry.slice(0, colon);
			if (colon !== -1) port = Number(entry.slice(colon + 1));
		} else {
			hostRaw = entry.host;
			port = entry.port ?? 443;
		}
		if (hostRaw.includes("*"))
			throw new Error(`egress allowlist: wildcard not allowed: ${hostRaw}`);
		const host = /^[A-Za-z0-9.-]+$/.test(hostRaw)
			? normalizeHost(hostRaw)
			: null;
		if (host === null)
			throw new Error(`egress allowlist: bad host: ${hostRaw}`);
		if (isNumericHost(host))
			throw new Error(`egress allowlist: numeric host: ${hostRaw}`);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			throw new Error(`egress allowlist: bad port for ${hostRaw}`);
		}
		set.add(`${host}:${port}`);
	}
	return {
		has: (host, port) => set.has(`${host}:${port}`),
		entries: () => [...set].sort(),
	};
}

/** Policy check on a parsed target, before any resolution. */
export function checkTarget(
	host: string,
	port: number,
	allow: EgressAllowlist,
): EgressDenial | null {
	if (isNumericHost(host)) return deny(403, "numeric-host");
	if (!allow.has(host, port)) return deny(403, "not-allowlisted");
	return null;
}

/** An injected resolver returns every answer for a name, as address strings. */
export type Resolver = (host: string) => Promise<readonly string[]>;

export type Pinned = { ok: true; ip: string } | EgressDenial;

/**
 * Rule 7: resolve once, require every answer to be globally routable
 * (v4-mapped IPv6 unwrapped), and return the exact IP to connect to. One
 * non-public answer denies the whole request. Callers must connect to the
 * returned IP and never resolve the name again.
 */
export async function resolvePinned(
	host: string,
	resolve: Resolver,
	isHostAddress: (ip: string) => boolean = () => false,
): Promise<Pinned> {
	let answers: readonly string[];
	try {
		answers = await resolve(host);
	} catch {
		return deny(502, "dns-failure");
	}
	if (answers.length === 0) return deny(502, "dns-failure");
	const unwrapped: string[] = [];
	for (const answer of answers) {
		const ip = unwrapMapped(answer);
		if (ip === null || !isGlobalAddress(ip))
			return deny(403, "non-public-address");
		// A public address on one of this machine's interfaces is still the host.
		if (isHostAddress(ip)) return deny(403, "host-address");
		unwrapped.push(ip);
	}
	return { ok: true, ip: unwrapped[0] as string };
}

/**
 * Unwrap a v4-mapped IPv6 address (`::ffff:a.b.c.d`, `::ffff:7f00:1`) to
 * dotted IPv4. Other input is returned as-is when it is a valid address and
 * null when it is not an address at all.
 */
export function unwrapMapped(ip: string): string | null {
	const kind = isIP(ip);
	if (kind === 4) return ip;
	if (kind !== 6) return null;
	const bytes = parseIPv6(ip);
	if (bytes === null) return null;
	if (isV4Mapped(bytes)) return bytes.slice(12).join(".");
	return ip;
}

/** One spelling per address, so two forms of the same IPv6 compare equal. Null if not an address. */
export function canonicalAddress(raw: string): string | null {
	const ip = unwrapMapped(raw.split("%")[0] as string);
	if (ip === null) return null;
	if (isIP(ip) === 4) return ip;
	return parseIPv6(ip)?.join(":") ?? null;
}

/** True for a globally routable unicast address (IPv4 or IPv6). */
export function isGlobalAddress(raw: string): boolean {
	const ip = unwrapMapped(raw);
	if (ip === null) return false;
	if (isIP(ip) === 4) return isGlobalV4(ip.split(".").map(Number));
	const bytes = parseIPv6(ip);
	return bytes !== null && isGlobalV6(bytes);
}

function isGlobalV4([a = 0, b = 0, c = 0]: number[]): boolean {
	if (a === 0 || a === 10 || a === 127) return false;
	if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
	if (a === 169 && b === 254) return false; // link-local, metadata
	if (a === 172 && b >= 16 && b <= 31) return false;
	if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
	if (a === 192 && b === 88 && c === 99) return false;
	if (a === 192 && b === 168) return false;
	if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
	if (a === 198 && b === 51 && c === 100) return false;
	if (a === 203 && b === 0 && c === 113) return false;
	if (a >= 224) return false; // multicast, reserved, broadcast
	return true;
}

function isV4Mapped(bytes: number[]): boolean {
	for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return false;
	return bytes[10] === 0xff && bytes[11] === 0xff;
}

function isGlobalV6(b: number[]): boolean {
	if (isV4Mapped(b)) return isGlobalV4(b.slice(12));
	// Global unicast is 2000::/3; everything else (loopback, ULA, link-local,
	// multicast, v4-compatible, NAT64) is refused.
	if (((b[0] as number) & 0xe0) !== 0x20) return false;
	const w0 = ((b[0] as number) << 8) | (b[1] as number);
	const w1 = ((b[2] as number) << 8) | (b[3] as number);
	if (w0 === 0x2001 && w1 <= 0x01ff) return false; // 2001::/23 protocol assignments
	if (w0 === 0x2001 && w1 === 0x0db8) return false; // documentation
	if (w0 === 0x2002) return false; // 6to4 embeds arbitrary IPv4
	if (w0 === 0x3fff && w1 <= 0x0fff) return false; // documentation, 3fff::/20
	return true;
}

/** Parse an IPv6 text address to 16 bytes. Null on anything malformed. */
export function parseIPv6(text: string): number[] | null {
	if (text.includes("%") || isIP(text) !== 6) return null;
	let head = text;
	let tail4: number[] = [];
	const dot = text.lastIndexOf(".");
	if (dot !== -1) {
		const cut = text.lastIndexOf(":");
		const v4 = text
			.slice(cut + 1)
			.split(".")
			.map(Number);
		if (
			v4.length !== 4 ||
			v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
		)
			return null;
		tail4 = v4;
		head = `${text.slice(0, cut + 1)}0:0`;
	}
	const halves = head.split("::");
	if (halves.length > 2) return null;
	const left = halves[0] ? (halves[0] as string).split(":") : [];
	const right =
		halves.length === 2 && halves[1] ? (halves[1] as string).split(":") : [];
	const missing = 8 - left.length - right.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const groups = [
		...left,
		...Array(halves.length === 2 ? missing : 0).fill("0"),
		...right,
	];
	if (groups.length !== 8) return null;
	const bytes: number[] = [];
	for (const g of groups) {
		const n = Number.parseInt(g, 16);
		if (!/^[0-9a-fA-F]{1,4}$/.test(g) || Number.isNaN(n)) return null;
		bytes.push(n >> 8, n & 0xff);
	}
	if (tail4.length === 4) bytes.splice(12, 4, ...tail4);
	return bytes;
}

export type SniResult =
	| { status: "need-more" }
	| { status: "invalid" }
	| { status: "ok"; sni: string | null };

/**
 * Rule 11 helper: read the SNI from the first TLS record (a ClientHello that
 * fits one record). `need-more` until the whole record is buffered; `invalid`
 * for anything that is not a well-formed ClientHello. `sni` is null when the
 * hello carries no server_name extension.
 */
export function parseClientHelloSni(buf: Uint8Array): SniResult {
	if (buf.length < 5) return { status: "need-more" };
	if (buf[0] !== 0x16 || buf[1] !== 0x03) return { status: "invalid" };
	const recLen = ((buf[3] as number) << 8) | (buf[4] as number);
	if (recLen < 4 || recLen > 16384) return { status: "invalid" };
	if (buf.length < 5 + recLen) return { status: "need-more" };
	const end = 5 + recLen;
	let p = 5;
	const u8 = (): number => {
		if (p + 1 > end) throw new RangeError("short");
		return buf[p++] as number;
	};
	const u16 = (): number => (u8() << 8) | u8();
	// Not `p += u8()`: the left side is read before u8() advances p.
	const skip = (n: number): void => {
		p += n;
	};
	try {
		if (u8() !== 0x01) return { status: "invalid" }; // ClientHello
		const hsLen = (u8() << 16) | u16();
		if (5 + 4 + hsLen > end) return { status: "invalid" }; // fragmented hello
		p += 2 + 32; // version, random
		skip(u8()); // session id
		skip(u16()); // cipher suites
		skip(u8()); // compression methods
		if (p === end) return { status: "ok", sni: null }; // no extensions
		const extEnd = p + 2 + (((buf[p] as number) << 8) | (buf[p + 1] as number));
		p += 2;
		if (extEnd > end) return { status: "invalid" };
		while (p + 4 <= extEnd) {
			const type = u16();
			const len = u16();
			if (p + len > extEnd) return { status: "invalid" };
			if (type === 0) {
				const listEnd = p + len;
				p += 2; // list length
				if (u8() !== 0) return { status: "invalid" }; // host_name
				const nameLen = u16();
				if (p + nameLen > listEnd) return { status: "invalid" };
				const name = Buffer.from(buf.subarray(p, p + nameLen)).toString(
					"latin1",
				);
				return { status: "ok", sni: name };
			}
			p += len;
		}
		return { status: "ok", sni: null };
	} catch {
		return { status: "invalid" };
	}
}

function bad(reason: string): EgressDenial {
	return deny(400, reason);
}

function notAllowed(reason: string): EgressDenial {
	return deny(405, reason);
}

export function deny(
	status: EgressDenial["status"],
	reason: string,
): EgressDenial {
	return { ok: false, status, reason };
}
