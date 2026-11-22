/**
 * The experiments-3 E4 adversarial table, re-derived row by row against the
 * strict proxy (the scratch scripts no longer exist). Each row sends raw
 * bytes to the proxy and asserts the observable outcome: a tunnel, or a
 * refusal with a status code, the distinctive body and `X-Mfw-Egress: denied`.
 *
 * `allowed.test:18443` is the single allowlisted pair. `127.0.0.77` plays the
 * "public" address in the original experiment; here a documentation-free
 * public IP is dialled through an injected connector to a loopback backend.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type EgressLogEntry,
	type EgressProxy,
	startEgressProxy,
} from "../src/containment/egress-proxy.ts";

const PUBLIC_IP = "93.184.216.34";
const LOCAL_SECRET = "LOCAL-SECRET\n";
const ALLOWED_BANNER = "ALLOWED-SERVER\n";

interface Rig {
	proxy: EgressProxy;
	log: EgressLogEntry[];
	dialled: string[];
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await (cleanups.pop() as () => Promise<void>)();
});

async function banner(
	text: string,
): Promise<{ port: number; hits: () => number; close(): Promise<void> }> {
	let hits = 0;
	const socks = new Set<net.Socket>();
	const srv = net.createServer((s) => {
		hits++;
		socks.add(s);
		s.on("error", () => {});
		s.on("close", () => socks.delete(s));
		s.write(text);
	});
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	return {
		port: (srv.address() as net.AddressInfo).port,
		hits: () => hits,
		async close() {
			for (const s of socks) s.destroy();
			await new Promise<void>((r) => srv.close(() => r()));
		},
	};
}

/** Two backends: the allowed origin and a "local secret" that must stay unreachable. */
async function rig(dns: Record<string, string[]>) {
	const dir = await mkdtemp(join(tmpdir(), "ega-"));
	const allowed = await banner(ALLOWED_BANNER);
	const secret = await banner(LOCAL_SECRET);
	const log: EgressLogEntry[] = [];
	const dialled: string[] = [];
	const proxy = await startEgressProxy({
		runId: "adv",
		socketPath: join(dir, "e.sock"),
		allow: [
			{ host: "allowed.test", port: 18443 },
			{ host: "rebind.test", port: 18443 },
		],
		resolve: async (h) => {
			const a = dns[h];
			if (!a) throw new Error("NXDOMAIN");
			return a;
		},
		// Public IP -> the allowed origin. Anything else would be the secret,
		// and reaching it is the failure the table guards against.
		connect: (ip) => {
			dialled.push(ip);
			return net.connect({
				host: "127.0.0.1",
				port: ip === PUBLIC_IP ? allowed.port : secret.port,
			});
		},
		log: (e) => log.push(e),
		limits: { headerDeadlineMs: 600, idleMs: 2000 },
	});
	cleanups.push(async () => {
		await proxy.close();
		await allowed.close();
		await secret.close();
		await rm(dir, { recursive: true, force: true });
	});
	return { proxy, log, dialled, secret } as Rig & {
		secret: { hits: () => number };
	};
}

function send(
	path: string,
	bytes: string,
	waitMs = 350,
): Promise<{ text: string; closedMs: number | null }> {
	return new Promise((resolve) => {
		const t0 = Date.now();
		const chunks: Buffer[] = [];
		let closedMs: number | null = null;
		const s = net.connect(path);
		const done = () => {
			s.destroy();
			resolve({ text: Buffer.concat(chunks).toString("latin1"), closedMs });
		};
		s.on("error", () => {});
		s.on("data", (d) => chunks.push(Buffer.from(d)));
		s.on("close", () => {
			closedMs = Date.now() - t0;
			done();
		});
		s.on("connect", () => s.write(Buffer.from(bytes, "utf8")));
		setTimeout(done, waitMs);
	});
}

const dns = {
	"allowed.test": [PUBLIC_IP],
	"rebind.test": [PUBLIC_IP], // replaced per-test for the rebinding row
	"multi.test": [PUBLIC_IP, "127.0.0.1"],
	"meta-alias.test": ["169.254.169.254"],
	localhost: ["127.0.0.1"],
};

type Outcome = "tunnel" | 400 | 403 | 405 | 431;
interface Row {
	name: string;
	/** Raw bytes; a bare authority is wrapped in a CONNECT request. */
	req: string;
	expect: Outcome;
	/** Substring expected in the denial body. */
	reason?: string;
}

const c = (authority: string, ver = "HTTP/1.1") =>
	`CONNECT ${authority} ${ver}\r\n\r\n`;
const A = "allowed.test:18443";

const ROWS: Row[] = [
	// 1-3 controls and allowlist exactness
	{ name: "control: allowed host:port", req: c(A), expect: "tunnel" },
	{ name: "control: HTTP/1.0", req: c(A, "HTTP/1.0"), expect: "tunnel" },
	{
		name: "other host",
		req: c("other.test:18443"),
		expect: 403,
		reason: "not-allowlisted",
	},
	{
		name: "other port of allowed host",
		req: c("allowed.test:18444"),
		expect: 403,
	},
	{ name: "allowed host on 443", req: c("allowed.test:443"), expect: 403 },
	{ name: "allowed host on 22", req: c("allowed.test:22"), expect: 403 },
	// normalisation
	{ name: "upper case host", req: c("ALLOWED.TEST:18443"), expect: "tunnel" },
	{ name: "trailing dot", req: c("allowed.test.:18443"), expect: "tunnel" },
	{ name: "double trailing dot", req: c("allowed.test..:18443"), expect: 400 },
	{ name: "leading dot", req: c(".allowed.test:18443"), expect: 400 },
	{ name: "leading-zero port", req: c("allowed.test:018443"), expect: 400 },
	{ name: "plus port", req: c("allowed.test:+18443"), expect: 400 },
	// userinfo
	{
		name: "userinfo allowed@evil",
		req: c("allowed.test@evil.test:18443"),
		expect: 400,
		reason: "userinfo",
	},
	{
		name: "userinfo evil@allowed",
		req: c("evil.test@allowed.test:18443"),
		expect: 400,
		reason: "userinfo",
	},
	{
		name: "userinfo with port to literal",
		req: c("a:18443@127.0.0.1:18443"),
		expect: 400,
		reason: "userinfo",
	},
	{
		name: "backslash variant",
		req: c("allowed.test\\@evil.test:18443"),
		expect: 400,
	},
	// IDN
	{
		name: "raw UTF-8 host",
		req: c("ällowed.test:18443"),
		expect: 400,
		reason: "non-ascii",
	},
	{
		name: "fullwidth dot",
		req: c("allowed．test:18443"),
		expect: 400,
		reason: "non-ascii",
	},
	{
		name: "punycode not listed",
		req: c("xn--llowed-0ra.test:18443"),
		expect: 403,
		reason: "not-allowlisted",
	},
	// IPv6 literals
	{ name: "[::1]", req: c("[::1]:18443"), expect: 400, reason: "ipv6-literal" },
	{
		name: "[::ffff:127.0.0.1]",
		req: c("[::ffff:127.0.0.1]:18443"),
		expect: 400,
		reason: "ipv6-literal",
	},
	{
		name: "[::ffff:7f00:1]",
		req: c("[::ffff:7f00:1]:18443"),
		expect: 400,
		reason: "ipv6-literal",
	},
	{
		name: "[fe80::1]",
		req: c("[fe80::1]:18443"),
		expect: 400,
		reason: "ipv6-literal",
	},
	{
		name: "[::ffff:a9fe:a9fe]",
		req: c("[::ffff:a9fe:a9fe]:18443"),
		expect: 400,
		reason: "ipv6-literal",
	},
	// numeric hosts
	{
		name: "127.0.0.1",
		req: c("127.0.0.1:18443"),
		expect: 403,
		reason: "numeric-host",
	},
	{
		name: "169.254.169.254",
		req: c("169.254.169.254:80"),
		expect: 403,
		reason: "numeric-host",
	},
	{
		name: "decimal 2130706433",
		req: c("2130706433:18443"),
		expect: 403,
		reason: "numeric-host",
	},
	{
		name: "hex 0x7f000001",
		req: c("0x7f000001:18443"),
		expect: 403,
		reason: "numeric-host",
	},
	{
		name: "dotted hex 0x7f.0.0.1",
		req: c("0x7f.0.0.1:18443"),
		expect: 403,
		reason: "numeric-host",
	},
	{
		name: "octal 0177.0.0.1",
		req: c("0177.0.0.1:18443"),
		expect: 403,
		reason: "numeric-host",
	},
	{
		name: "short 127.1",
		req: c("127.1:18443"),
		expect: 403,
		reason: "numeric-host",
	},
	{
		name: "octal int 017700000001",
		req: c("017700000001:18443"),
		expect: 403,
		reason: "numeric-host",
	},
	{
		name: "metadata decimal 2852039166",
		req: c("2852039166:80"),
		expect: 403,
		reason: "numeric-host",
	},
	{
		name: "metadata hex 0xa9fea9fe",
		req: c("0xa9fea9fe:80"),
		expect: 403,
		reason: "numeric-host",
	},
	{
		name: "metadata octal 0251.0376.0251.0376",
		req: c("0251.0376.0251.0376:80"),
		expect: 403,
		reason: "numeric-host",
	},
	{
		name: "metadata 169.254.43518",
		req: c("169.254.43518:80"),
		expect: 403,
		reason: "numeric-host",
	},
	// names that resolve privately
	{
		name: "localhost",
		req: c("localhost:18443"),
		expect: 403,
		reason: "not-allowlisted",
	},
	{ name: "multi-answer with a private IP", req: "", expect: 403 }, // see dedicated test (allowlist differs)
	{
		name: "name resolving to the metadata IP",
		req: c("meta-alias.test:18443"),
		expect: 403,
		reason: "not-allowlisted",
	},
	// request-line shapes
	{
		name: "GET absolute-form",
		req: `GET http://${A}/ HTTP/1.1\r\n\r\n`,
		expect: 405,
	},
	{
		name: "GET absolute-form to loopback",
		req: "GET http://127.0.0.1:18445/ HTTP/1.1\r\n\r\n",
		expect: 405,
	},
	{
		name: "POST absolute-form",
		req: `POST http://${A}/ HTTP/1.1\r\nContent-Length: 0\r\n\r\n`,
		expect: 405,
	},
	{
		name: "lowercase connect",
		req: `connect ${A} HTTP/1.1\r\n\r\n`,
		expect: 405,
	},
	{ name: "double space", req: `CONNECT  ${A} HTTP/1.1\r\n\r\n`, expect: 405 },
	{ name: "HTTP/0.9", req: `CONNECT ${A}\r\n\r\n`, expect: 405 },
	{
		name: "CRLF injection in authority",
		req: `CONNECT allowed.test:18443\r\nX HTTP/1.1\r\n\r\n`,
		expect: 405,
	},
	{
		name: "bare LF line ending",
		req: `CONNECT ${A} HTTP/1.1\nHost: x\n\n\r\n\r\n`,
		expect: 400,
	},
	{
		name: "NUL in authority",
		req: `CONNECT allowed.test\u0000:18443 HTTP/1.1\r\n\r\n`,
		expect: 400,
	},
	{
		name: "control byte in authority",
		req: `CONNECT allowed.test\u0007:18443 HTTP/1.1\r\n\r\n`,
		expect: 400,
	},
	{
		name: "HTTP/2 preface",
		req: "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n",
		expect: 400,
	},
	{
		name: "plain websocket upgrade",
		req: `GET /chat HTTP/1.1\r\nHost: ${A}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
		expect: 405,
	},
	// headers
	{
		name: "Host header evil on the CONNECT",
		req: `CONNECT ${A} HTTP/1.1\r\nHost: evil.test\r\n\r\n`,
		expect: "tunnel",
	},
	{
		name: "64 KiB header",
		req: `CONNECT ${A} HTTP/1.1\r\nX: ${"a".repeat(64 * 1024)}\r\n\r\n`,
		expect: 431,
	},
	{
		name: "100 KiB request line",
		req: `CONNECT ${"a".repeat(100 * 1024)}:443 HTTP/1.1\r\n\r\n`,
		expect: 431,
	},
	{
		name: "data pipelined with the CONNECT",
		req: `${c(A)}EARLYBYTES`,
		expect: "tunnel",
	},
];

describe("egress adversarial table (experiments-3 E4)", () => {
	for (const row of ROWS.filter((r) => r.req !== "")) {
		test(row.name, async () => {
			const r = await rig(dns);
			const res = await send(r.proxy.socketPath, row.req);
			if (row.expect === "tunnel") {
				expect(res.text).toContain("200 Connection Established");
				expect(res.text).toContain("ALLOWED-SERVER");
				expect(res.text).not.toContain("LOCAL-SECRET");
			} else {
				expect(res.text.startsWith(`HTTP/1.1 ${row.expect} `)).toBe(true);
				expect(res.text).toContain("X-Mfw-Egress: denied");
				expect(res.text).toContain("mfw-egress-denied: ");
				if (row.reason)
					expect(res.text).toContain(`mfw-egress-denied: ${row.reason}`);
				expect(r.dialled).toEqual([]);
			}
			// Whatever happened, the local secret was never reached.
			expect(r.secret.hits()).toBe(0);
		});
	}

	test("NUL in the authority: 400 and the socket closes within 1 s", async () => {
		const r = await rig(dns);
		const res = await send(
			r.proxy.socketPath,
			"CONNECT allowed.test\u0000:18443 HTTP/1.1\r\n\r\n",
			1500,
		);
		expect(res.text.startsWith("HTTP/1.1 400 ")).toBe(true);
		expect(res.closedMs).not.toBeNull();
		expect(res.closedMs as number).toBeLessThan(1000);
	});

	test("DNS rebinding: first answer pinned, no second resolution, secret unreached", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ega-"));
		const allowed = await banner(ALLOWED_BANNER);
		const secret = await banner(LOCAL_SECRET);
		let calls = 0;
		const dialled: string[] = [];
		const proxy = await startEgressProxy({
			runId: "rb",
			socketPath: join(dir, "e.sock"),
			allow: [{ host: "rebind.test", port: 18443 }],
			resolve: async () => (++calls === 1 ? [PUBLIC_IP] : ["127.0.0.1"]),
			connect: (ip) => {
				dialled.push(ip);
				return net.connect({
					host: "127.0.0.1",
					port: ip === PUBLIC_IP ? allowed.port : secret.port,
				});
			},
		});
		cleanups.push(async () => {
			await proxy.close();
			await allowed.close();
			await secret.close();
			await rm(dir, { recursive: true, force: true });
		});
		const res = await send(proxy.socketPath, c("rebind.test:18443"));
		expect(res.text).toContain("ALLOWED-SERVER");
		expect(dialled).toEqual([PUBLIC_IP]);
		expect(calls).toBe(1);
		expect(secret.hits()).toBe(0);
	});

	test("multi-answer [public, 127.0.0.1] is denied as a whole", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ega-"));
		const secret = await banner(LOCAL_SECRET);
		const dialled: string[] = [];
		const proxy = await startEgressProxy({
			runId: "m",
			socketPath: join(dir, "e.sock"),
			allow: [{ host: "multi.test", port: 18443 }],
			resolve: async () => [PUBLIC_IP, "127.0.0.1"],
			connect: (ip) => {
				dialled.push(ip);
				return net.connect({ host: "127.0.0.1", port: secret.port });
			},
		});
		cleanups.push(async () => {
			await proxy.close();
			await secret.close();
			await rm(dir, { recursive: true, force: true });
		});
		const res = await send(proxy.socketPath, c("multi.test:18443"));
		expect(res.text.startsWith("HTTP/1.1 403 ")).toBe(true);
		expect(res.text).toContain("mfw-egress-denied: non-public-address");
		expect(dialled).toEqual([]);
		expect(secret.hits()).toBe(0);
	});

	test("an allowlisted name that resolves to the metadata IP is denied", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ega-"));
		const proxy = await startEgressProxy({
			runId: "meta",
			socketPath: join(dir, "e.sock"),
			allow: [{ host: "meta-alias.test", port: 18443 }],
			resolve: async () => ["169.254.169.254"],
			connect: () => {
				throw new Error("must not dial");
			},
		});
		cleanups.push(async () => {
			await proxy.close();
			await rm(dir, { recursive: true, force: true });
		});
		const res = await send(proxy.socketPath, c("meta-alias.test:18443"));
		expect(res.text).toContain("mfw-egress-denied: non-public-address");
	});

	test("an allowlisted localhost is denied at the address check", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ega-"));
		const proxy = await startEgressProxy({
			runId: "lh",
			socketPath: join(dir, "e.sock"),
			allow: [{ host: "localhost", port: 18443 }],
			resolve: async () => ["127.0.0.1", "::1"],
			connect: () => {
				throw new Error("must not dial");
			},
		});
		cleanups.push(async () => {
			await proxy.close();
			await rm(dir, { recursive: true, force: true });
		});
		const res = await send(proxy.socketPath, c("localhost:18443"));
		expect(res.text).toContain("mfw-egress-denied: non-public-address");
	});

	test("every refusal in the table is logged as a DENY with the run id", async () => {
		const r = await rig(dns);
		await send(r.proxy.socketPath, c("127.0.0.1:18443"));
		await send(r.proxy.socketPath, "GET / HTTP/1.1\r\n\r\n");
		await new Promise((res) => setTimeout(res, 50));
		expect(r.log.map((e) => e.decision)).toEqual(["DENY", "DENY"]);
		expect(r.log.every((e) => e.runId === "adv")).toBe(true);
	});
});
