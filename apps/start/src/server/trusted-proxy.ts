/**
 * Which peers may speak for a client through forwarded headers.
 *
 * `MFW_TRUSTED_PROXIES` lists proxy peer addresses or CIDRs. The default is
 * none, and loopback is not implicitly trusted: any local process can connect
 * from loopback. From any other peer these headers are ignored entirely.
 *
 * From a trusted peer they are parsed strictly and a malformed set is refused,
 * never partly used. The client is the rightmost address that is not itself a
 * trusted proxy, because everything to its left was supplied by the client.
 */

export const MAX_FORWARDED_HOPS = 16;
export const MAX_FORWARDED_LENGTH = 1024;

/** Wider than these is a typo or a way of trusting everybody. */
const MIN_PREFIX_V4 = 8;
const MIN_PREFIX_V6 = 32;

export interface TrustedProxy {
	bytes: Uint8Array;
	prefix: number;
}

const V4 =
	/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function parseV4(raw: string): Uint8Array | null {
	if (!V4.test(raw)) return null;
	return Uint8Array.from(raw.split(".").map(Number));
}

function parseV6(raw: string): Uint8Array | null {
	let text = raw.toLowerCase();
	if (!/^[0-9a-f:.]+$/.test(text) || !text.includes(":")) return null;
	const dotted = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
	if (dotted) {
		const v4 = parseV4(dotted[1] as string);
		if (!v4) return null;
		const [a, b, c, d] = v4 as unknown as [number, number, number, number];
		const tail = `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
		text = `${text.slice(0, text.length - (dotted[1] as string).length)}${tail}`;
	}
	const halves = text.split("::");
	if (halves.length > 2) return null;
	const left = halves[0] ? (halves[0] as string).split(":") : [];
	const right = halves[1] ? (halves[1] as string).split(":") : [];
	const missing = 8 - left.length - right.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const groups = [
		...left,
		...Array<string>(halves.length === 2 ? missing : 0).fill("0"),
		...right,
	];
	if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
	const out = new Uint8Array(16);
	groups.forEach((g, i) => {
		const n = Number.parseInt(g, 16);
		out[i * 2] = n >> 8;
		out[i * 2 + 1] = n & 255;
	});
	return out;
}

/** 4 bytes for IPv4 and IPv4-mapped IPv6, else 16. No zones, ports or brackets. */
function parseIp(raw: string): Uint8Array | null {
	const v4 = parseV4(raw);
	if (v4) return v4;
	const v6 = parseV6(raw);
	if (!v6) return null;
	const mapped =
		v6.slice(0, 10).every((b) => b === 0) && v6[10] === 255 && v6[11] === 255;
	return mapped ? v6.slice(12) : v6;
}

function formatIp(bytes: Uint8Array): string {
	if (bytes.length === 4) return [...bytes].join(".");
	const groups: number[] = [];
	for (let i = 0; i < 16; i += 2)
		groups.push(((bytes[i] as number) << 8) | (bytes[i + 1] as number));
	// RFC 5952: compress the longest run of two or more zero groups.
	let start = -1;
	let length = 0;
	for (let i = 0; i < 8; ) {
		if (groups[i] !== 0) {
			i++;
			continue;
		}
		let j = i;
		while (j < 8 && groups[j] === 0) j++;
		if (j - i > length && j - i >= 2) {
			start = i;
			length = j - i;
		}
		i = j;
	}
	const hex = (from: number, to: number) =>
		groups
			.slice(from, to)
			.map((g) => g.toString(16))
			.join(":");
	return start < 0 ? hex(0, 8) : `${hex(0, start)}::${hex(start + length, 8)}`;
}

/** What an IP literal means, and whether this is its one canonical spelling. */
export function ipLiteral(
	raw: string,
): { canonical: boolean; unspecified: boolean } | null {
	const bytes = parseIp(raw);
	if (!bytes) return null;
	return {
		canonical: formatIp(bytes) === raw,
		unspecified: bytes.every((b) => b === 0),
	};
}

export function isLoopbackAddress(raw: string): boolean {
	const b = parseIp(raw);
	if (!b) return false;
	if (b.length === 4) return b[0] === 127;
	return b.slice(0, 15).every((x) => x === 0) && b[15] === 1;
}

function inRange(ip: Uint8Array, range: TrustedProxy): boolean {
	if (ip.length !== range.bytes.length) return false;
	let bits = range.prefix;
	for (let i = 0; i < ip.length && bits > 0; i++, bits -= 8) {
		const mask = bits >= 8 ? 255 : (255 << (8 - bits)) & 255;
		if (((ip[i] as number) & mask) !== ((range.bytes[i] as number) & mask))
			return false;
	}
	return true;
}

const isTrusted = (ip: Uint8Array, list: readonly TrustedProxy[]) =>
	list.some((p) => inRange(ip, p));

/** A list with any bad entry is unusable: the server refuses to start on it. */
export function parseTrustedProxies(value: string | undefined): {
	proxies: TrustedProxy[];
	errors: string[];
} {
	const proxies: TrustedProxy[] = [];
	const errors: string[] = [];
	for (const entry of (value ?? "").split(/[\s,]+/)) {
		if (!entry) continue;
		const [address, prefixText, extra] = entry.split("/");
		const bytes = parseIp(address ?? "");
		const max = bytes?.length === 4 ? 32 : 128;
		const min = bytes?.length === 4 ? MIN_PREFIX_V4 : MIN_PREFIX_V6;
		const prefix = prefixText === undefined ? max : Number(prefixText);
		if (
			!bytes ||
			extra !== undefined ||
			(prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) ||
			prefix > max ||
			prefix < min
		) {
			errors.push(entry);
			continue;
		}
		proxies.push({ bytes, prefix });
	}
	return errors.length ? { proxies: [], errors } : { proxies, errors };
}

export type Forwarded =
	/** Not from a trusted proxy, or a trusted peer sending no forwarded headers. */
	| { kind: "direct" }
	| { kind: "proxied"; client: string; proto: "https"; host: string | null }
	| { kind: "invalid"; reason: string };

const invalid = (reason: string): Forwarded => ({ kind: "invalid", reason });

/** Rightmost address that is not a trusted proxy, else the leftmost. */
function pickClient(
	hops: readonly Uint8Array[],
	list: readonly TrustedProxy[],
): string {
	for (let i = hops.length - 1; i >= 0; i--)
		if (!isTrusted(hops[i] as Uint8Array, list))
			return formatIp(hops[i] as Uint8Array);
	return formatIp(hops[0] as Uint8Array);
}

/** Split on a separator outside double quotes; null on an unterminated quote. */
function splitQuoted(text: string, separator: string): string[] | null {
	const parts: string[] = [];
	let current = "";
	let quoted = false;
	for (const ch of text) {
		if (ch === "\\") return null;
		if (ch === '"') quoted = !quoted;
		if (ch === separator && !quoted) {
			parts.push(current);
			current = "";
		} else current += ch;
	}
	if (quoted) return null;
	parts.push(current);
	return parts;
}

/** An RFC 7239 node: IPv4, or quoted `[v6]`, with an optional port. */
function parseForwardedNode(raw: string): Uint8Array | null {
	const quoted = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2;
	const text = quoted ? raw.slice(1, -1) : raw;
	const v6 = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(text);
	if (v6) return quoted ? parseIp(v6[1] as string) : null;
	return parseV4(text.replace(/:\d{1,5}$/, ""));
}

function parseForwardedHeader(
	value: string,
	list: readonly TrustedProxy[],
): Forwarded {
	const elements = splitQuoted(value, ",");
	if (!elements) return invalid("malformed Forwarded header");
	if (elements.length > MAX_FORWARDED_HOPS)
		return invalid("too many Forwarded hops");
	const hops: Uint8Array[] = [];
	let proto: string | undefined;
	let host: string | undefined;
	for (const element of elements) {
		const pairs = splitQuoted(element, ";");
		if (!pairs) return invalid("malformed Forwarded header");
		const seen = new Map<string, string>();
		for (const pair of pairs) {
			const at = pair.indexOf("=");
			if (at <= 0) return invalid("malformed Forwarded header");
			const name = pair.slice(0, at).trim().toLowerCase();
			if (!["for", "by", "proto", "host"].includes(name) || seen.has(name))
				return invalid("malformed Forwarded header");
			seen.set(name, pair.slice(at + 1).trim());
		}
		const node = parseForwardedNode(seen.get("for") ?? "");
		if (!node) return invalid("Forwarded needs a literal client address");
		hops.push(node);
		// The nearest proxy's element is the last one and is the only authority.
		proto = seen.get("proto");
		host = seen.get("host")?.replace(/^"(.*)"$/, "$1");
	}
	if (proto?.replace(/^"(.*)"$/, "$1").toLowerCase() !== "https")
		return invalid("the proxy must report proto=https");
	if (host !== undefined && !/^[^\s,@/]+$/.test(host))
		return invalid("malformed Forwarded host");
	return {
		kind: "proxied",
		client: pickClient(hops, list),
		proto: "https",
		host: host ?? null,
	};
}

function parseXForwarded(h: Headers, list: readonly TrustedProxy[]): Forwarded {
	const xff = h.get("x-forwarded-for");
	const proto = h.get("x-forwarded-proto");
	const host = h.get("x-forwarded-host");
	if (xff === null || proto === null)
		return invalid("a proxy must send X-Forwarded-For and X-Forwarded-Proto");
	// Bun keeps only the LAST of repeated lines, so duplicates cannot be seen
	// here. A runtime that joins them with a comma is refused below. The proxy
	// must replace these headers, not add a line before the client's.
	if (proto !== "https")
		return invalid("X-Forwarded-Proto must be exactly https");
	if (host !== null && !/^[^\s,@/]+$/.test(host))
		return invalid("malformed X-Forwarded-Host");
	const entries = xff.split(",").map((e) => e.trim());
	if (entries.length > MAX_FORWARDED_HOPS)
		return invalid("too many X-Forwarded-For hops");
	const hops: Uint8Array[] = [];
	for (const entry of entries) {
		const ip = parseIp(entry);
		if (!ip) return invalid("malformed X-Forwarded-For");
		hops.push(ip);
	}
	return {
		kind: "proxied",
		client: pickClient(hops, list),
		proto: "https",
		host,
	};
}

/** What the forwarded headers mean for this peer. */
export function resolveForwarded(
	h: Headers,
	peer: string | undefined,
	list: readonly TrustedProxy[],
): Forwarded {
	const peerIp = peer ? parseIp(peer) : null;
	if (!peerIp || !isTrusted(peerIp, list)) return { kind: "direct" };

	const forwarded = h.get("forwarded");
	const hasX = [
		"x-forwarded-for",
		"x-forwarded-proto",
		"x-forwarded-host",
	].some((n) => h.has(n));
	if (forwarded === null && !hasX) return { kind: "direct" };
	if (forwarded !== null && hasX)
		return invalid("both Forwarded and X-Forwarded-* are present");
	for (const n of [
		"forwarded",
		"x-forwarded-for",
		"x-forwarded-proto",
		"x-forwarded-host",
	])
		if ((h.get(n)?.length ?? 0) > MAX_FORWARDED_LENGTH)
			return invalid(`${n} is too long`);
	return forwarded !== null
		? parseForwardedHeader(forwarded, list)
		: parseXForwarded(h, list);
}
