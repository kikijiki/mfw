import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildAllowlist,
	isGlobalAddress,
	isNumericHost,
	normalizeHost,
	parseAuthority,
	parseClientHelloSni,
	parseRequestHead,
	resolvePinned,
	unwrapMapped,
} from "../src/containment/egress-policy.ts";
import {
	createConnectionGate,
	type EgressLogEntry,
	type EgressProxy,
	egressSocketPath,
	startEgressProxy,
} from "../src/containment/egress-proxy.ts";

/** A name that the stub resolver maps to a documentation-free public IP. */
const PUBLIC_IP = "93.184.216.34";

interface Harness {
	dir: string;
	proxy: EgressProxy;
	log: EgressLogEntry[];
	/** Pinned IPs the proxy dialled. */
	dialled: string[];
	/** Resolver calls, to prove a name is resolved once. */
	resolved: string[];
	backend: { port: number; received: Buffer[]; close(): Promise<void> };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await (cleanups.pop() as () => Promise<void>)();
});

/** A loopback TCP server that banners, then echoes. */
async function startBackend(banner = "BACKEND\n") {
	const received: Buffer[] = [];
	const sockets = new Set<net.Socket>();
	const server = net.createServer((s) => {
		sockets.add(s);
		s.on("close", () => sockets.delete(s));
		s.on("error", () => {});
		s.write(banner);
		s.on("data", (d: Buffer) => {
			received.push(d);
			s.write(d);
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as net.AddressInfo).port;
	return {
		port,
		received,
		async close() {
			for (const s of sockets) s.destroy();
			await new Promise<void>((r) => server.close(() => r()));
		},
	};
}

async function startHarness(
	opts: {
		allow?: string[];
		dns?: Record<string, string[]>;
		limits?: Parameters<typeof startEgressProxy>[0]["limits"];
		sni?: boolean;
		gate?: ReturnType<typeof createConnectionGate>;
		resolve?: (host: string) => Promise<readonly string[]>;
	} = {},
): Promise<Harness> {
	const dir = await mkdtemp(join(tmpdir(), "egp-"));
	const backend = await startBackend();
	const log: EgressLogEntry[] = [];
	const dialled: string[] = [];
	const resolved: string[] = [];
	const dns = opts.dns ?? {
		"allowed.test": [PUBLIC_IP],
		"other.test": [PUBLIC_IP],
	};
	const proxy = await startEgressProxy({
		runId: "run-1",
		socketPath: join(dir, "e.sock"),
		allow: opts.allow ?? ["allowed.test", "allowed.test:8443"],
		resolve:
			opts.resolve ??
			(async (host) => {
				resolved.push(host);
				const a = dns[host.replace(/\.$/, "")];
				if (!a) throw new Error("NXDOMAIN");
				return a;
			}),
		connect: (ip) => {
			dialled.push(ip);
			return net.connect({ host: "127.0.0.1", port: backend.port });
		},
		log: (e) => log.push(e),
		limits: opts.limits,
		sni: opts.sni,
		gate: opts.gate ?? createConnectionGate(1000),
	});
	cleanups.push(async () => {
		await proxy.close();
		await backend.close();
		await rm(dir, { recursive: true, force: true });
	});
	return { dir, proxy, log, dialled, resolved, backend };
}

interface RawResult {
	text: string;
	closedAtMs: number | null;
	socket: net.Socket;
}

/**
 * Connect, send `bytes`, and collect everything until the proxy closes or
 * `waitMs` passes. `closedAtMs` is null when the socket was still open.
 */
function raw(
	socketPath: string,
	bytes: string | Buffer,
	waitMs = 400,
	keepOpen = false,
): Promise<RawResult> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		const started = Date.now();
		let closedAtMs: number | null = null;
		const s = net.connect(socketPath);
		const finish = () => {
			if (!keepOpen) s.destroy();
			resolve({
				text: Buffer.concat(chunks).toString("latin1"),
				closedAtMs,
				socket: s,
			});
		};
		s.on("error", () => {}); // a dropped connection may EPIPE the write
		s.on("data", (d) => chunks.push(Buffer.from(d)));
		s.on("close", () => {
			closedAtMs = Date.now() - started;
			finish();
		});
		s.on("connect", () => s.write(bytes));
		setTimeout(() => {
			if (closedAtMs === null) finish();
		}, waitMs);
	});
}

const connectLine = (authority: string, version = "HTTP/1.1") =>
	`CONNECT ${authority} ${version}\r\nHost: ${authority}\r\n\r\n`;

describe("egress policy: parsing", () => {
	test("accepts exact CONNECT on 1.1 and 1.0 and normalises the host", () => {
		expect(parseRequestHead("CONNECT Allowed.Test.:443 HTTP/1.1")).toEqual({
			ok: true,
			host: "allowed.test",
			port: 443,
		});
		expect(parseRequestHead("CONNECT a.b:8443 HTTP/1.0\r\nX: y")).toMatchObject(
			{
				ok: true,
				port: 8443,
			},
		);
	});

	test("classifies refusals: 405 for non-CONNECT, 400 for malformed", () => {
		const status = (h: string) => {
			const r = parseRequestHead(h);
			return r.ok ? 200 : r.status;
		};
		expect(status("GET http://a.test/ HTTP/1.1")).toBe(405);
		expect(status("connect a.test:443 HTTP/1.1")).toBe(405);
		expect(status("CONNECT  a.test:443 HTTP/1.1")).toBe(405);
		expect(status("CONNECT a.test:443")).toBe(405);
		expect(status("CONNECT a.test:443 HTTP/2")).toBe(405);
		expect(status("PRI * HTTP/2.0")).toBe(400);
		expect(status("CONNECT a.test:443 HTTP/1.1\r\nX: \u0000")).toBe(400);
		expect(status("CONNECT a.test:443 HTTP/1.1\nX: y")).toBe(400);
		expect(status("CONNECT ä.test:443 HTTP/1.1")).toBe(400);
	});

	test("authority syntax", () => {
		for (const bad of [
			"a@b.test:443",
			"[::1]:443",
			"a.test:0443",
			"a.test:+443",
			"a.test:0",
			"a.test:65536",
			"a.test",
			"a.test:",
			"a.test:443:1",
			".a.test:443",
			"a..test:443",
			"a.test..:443",
			"a_b.test:443",
		]) {
			expect(parseAuthority(bad).ok).toBe(false);
		}
		expect(normalizeHost("A.B.")).toBe("a.b");
		expect(normalizeHost("a..b")).toBeNull();
		expect(normalizeHost("")).toBeNull();
	});

	test("numeric hosts: every IPv4 encoding is rejected by shape", () => {
		for (const h of [
			"127.0.0.1",
			"2130706433",
			"0x7f000001",
			"0x7f.0.0.1",
			"0177.0.0.1",
			"127.1",
			"017700000001",
			"169.254.43518",
			"0251.0376.0251.0376",
			"host.0x",
		]) {
			expect(isNumericHost(h)).toBe(true);
		}
		for (const h of [
			"a.test",
			"x1.test",
			"0x.test",
			"1.test",
			"test1",
			"e0x.com",
		]) {
			expect(isNumericHost(h)).toBe(false);
		}
	});

	test("allowlist is exact, defaults to 443, and refuses wildcards and numerics", () => {
		const a = buildAllowlist([
			"A.test",
			{ host: "b.test", port: 8443 },
			"c.test:9",
		]);
		expect(a.has("a.test", 443)).toBe(true);
		expect(a.has("a.test", 80)).toBe(false);
		expect(a.has("b.test", 8443)).toBe(true);
		expect(a.has("sub.a.test", 443)).toBe(false);
		expect(a.entries()).toEqual(["a.test:443", "b.test:8443", "c.test:9"]);
		expect(() => buildAllowlist(["*.a.test"])).toThrow();
		expect(() => buildAllowlist(["127.0.0.1"])).toThrow();
		expect(() => buildAllowlist(["a.test:70000"])).toThrow();
	});
});

describe("egress policy: addresses", () => {
	test("non-global IPv4 and IPv6 are refused", () => {
		for (const ip of [
			"0.0.0.0",
			"10.1.2.3",
			"100.64.0.1",
			"127.0.0.1",
			"169.254.169.254",
			"172.16.0.1",
			"172.31.255.255",
			"192.0.2.1",
			"192.168.1.1",
			"198.18.0.1",
			"198.51.100.1",
			"203.0.113.1",
			"224.0.0.1",
			"255.255.255.255",
			"::",
			"::1",
			"fe80::1",
			"fc00::1",
			"ff02::1",
			"::ffff:127.0.0.1",
			"::ffff:7f00:1",
			"::ffff:a9fe:a9fe",
			"2001:db8::1",
			"2002::1",
			"64:ff9b::7f00:1",
			"not-an-ip",
		]) {
			expect(isGlobalAddress(ip)).toBe(false);
		}
	});

	test("global addresses pass, and v4-mapped globals unwrap", () => {
		expect(isGlobalAddress("93.184.216.34")).toBe(true);
		expect(isGlobalAddress("172.32.0.1")).toBe(true);
		expect(isGlobalAddress("2606:4700::1111")).toBe(true);
		expect(isGlobalAddress("::ffff:93.184.216.34")).toBe(true);
		expect(unwrapMapped("::ffff:5db8:d822")).toBe("93.184.216.34");
		expect(unwrapMapped("2606:4700::1111")).toBe("2606:4700::1111");
		expect(unwrapMapped("nope")).toBeNull();
	});

	test("resolvePinned: first answer pinned, any non-public answer denies", async () => {
		expect(
			await resolvePinned("a.test", async () => ["93.184.216.34", "8.8.8.8"]),
		).toEqual({
			ok: true,
			ip: "93.184.216.34",
		});
		expect(
			await resolvePinned("a.test", async () => ["93.184.216.34", "127.0.0.1"]),
		).toMatchObject({ ok: false, status: 403, reason: "non-public-address" });
		expect(await resolvePinned("a.test", async () => [])).toMatchObject({
			status: 502,
		});
		expect(
			await resolvePinned("a.test", async () => {
				throw new Error("x");
			}),
		).toMatchObject({ status: 502, reason: "dns-failure" });
	});
});

describe("egress policy: ClientHello SNI", () => {
	function hello(sni: string | null): Buffer {
		const ext: number[] = [];
		if (sni !== null) {
			const name = Buffer.from(sni, "latin1");
			const list = [0, name.length >> 8, name.length & 0xff, ...name];
			const body = [list.length >> 8, list.length & 0xff, ...list];
			ext.push(0, 0, body.length >> 8, body.length & 0xff, ...body);
		}
		const exts = [ext.length >> 8, ext.length & 0xff, ...ext];
		const body = [
			0x03,
			0x03,
			...new Array(32).fill(7),
			0, // session id
			0,
			2,
			0x13,
			0x01, // one cipher suite
			1,
			0, // compression
			...exts,
		];
		const hs = [0x01, 0, body.length >> 8, body.length & 0xff, ...body];
		return Buffer.from([
			0x16,
			0x03,
			0x01,
			hs.length >> 8,
			hs.length & 0xff,
			...hs,
		]);
	}

	test("reads the server_name, waits for a full record, rejects junk", () => {
		expect(parseClientHelloSni(hello("allowed.test"))).toEqual({
			status: "ok",
			sni: "allowed.test",
		});
		expect(parseClientHelloSni(hello(null))).toEqual({
			status: "ok",
			sni: null,
		});
		expect(parseClientHelloSni(hello("a.test").subarray(0, 20))).toEqual({
			status: "need-more",
		});
		expect(parseClientHelloSni(Buffer.from("GET / HTTP/1.1\r\n\r\n"))).toEqual({
			status: "invalid",
		});
		expect(parseClientHelloSni(Buffer.alloc(3))).toEqual({
			status: "need-more",
		});
	});
});

describe("egress proxy: tunnels", () => {
	test("allowed CONNECT tunnels, relays both ways, pins the IP, logs bytes", async () => {
		const h = await startHarness();
		const r = await raw(
			h.proxy.socketPath,
			connectLine("allowed.test:443"),
			100,
			true,
		);
		expect(r.text).toContain("HTTP/1.1 200 Connection Established");
		expect(r.text).toContain("BACKEND");
		r.socket.write("ping");
		await new Promise((res) => setTimeout(res, 100));
		r.socket.end();
		await new Promise((res) => setTimeout(res, 150));
		expect(h.dialled).toEqual([PUBLIC_IP]);
		// Resolved exactly once, as a fully-qualified name so the host's DNS search
		// domains are never appended.
		expect(h.resolved).toEqual(["allowed.test."]);
		expect(Buffer.concat(h.backend.received).toString()).toBe("ping");
		const allow = h.log.find(
			(e) => e.decision === "ALLOW" && e.phase === "close",
		);
		expect(allow).toMatchObject({
			runId: "run-1",
			host: "allowed.test",
			port: 443,
			ip: PUBLIC_IP,
			bytesUp: 4,
		});
		if (allow?.decision === "ALLOW")
			expect(allow.bytesDown).toBeGreaterThanOrEqual(12);
	});

	test("a second allowed port is a separate key", async () => {
		const h = await startHarness();
		const r = await raw(
			h.proxy.socketPath,
			connectLine("allowed.test:8443"),
			150,
		);
		expect(r.text).toContain("200 Connection Established");
		const denied = await raw(
			h.proxy.socketPath,
			connectLine("allowed.test:80"),
			150,
		);
		expect(denied.text).toContain("403");
	});

	test("every denial carries the distinctive body and header", async () => {
		const h = await startHarness();
		const r = await raw(h.proxy.socketPath, connectLine("other.test:443"), 300);
		expect(r.text).toContain("HTTP/1.1 403 Forbidden");
		expect(r.text).toContain("X-Mfw-Egress: denied");
		expect(r.text).toContain("mfw-egress-denied: not-allowlisted");
		expect(h.log[0]).toMatchObject({
			decision: "DENY",
			host: "other.test",
			port: 443,
			reason: "not-allowlisted",
			status: 403,
		});
		expect(h.dialled).toEqual([]);
		expect(h.resolved).toEqual([]); // denied before any DNS
	});

	test("data pipelined with the CONNECT is forwarded after the 200", async () => {
		const h = await startHarness();
		const r = await raw(
			h.proxy.socketPath,
			`${connectLine("allowed.test:443")}EARLY`,
			250,
		);
		expect(r.text).toContain("200 Connection Established");
		expect(Buffer.concat(h.backend.received).toString()).toBe("EARLY");
	});

	test("a Host header on the CONNECT is ignored; the authority decides", async () => {
		const h = await startHarness();
		const r = await raw(
			h.proxy.socketPath,
			"CONNECT allowed.test:443 HTTP/1.1\r\nHost: evil.test:443\r\n\r\n",
			150,
		);
		expect(r.text).toContain("200 Connection Established");
	});

	test("wss through CONNECT: the upgrade handshake tunnels end to end", async () => {
		const h = await startHarness();
		const r = await raw(
			h.proxy.socketPath,
			connectLine("allowed.test:443"),
			100,
			true,
		);
		r.socket.write(
			"GET /ws HTTP/1.1\r\nHost: allowed.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
		);
		await new Promise((res) => setTimeout(res, 150));
		r.socket.destroy();
		expect(Buffer.concat(h.backend.received).toString()).toContain(
			"Upgrade: websocket",
		);
	});

	test("a rebinding stub pins the first IP and never resolves twice", async () => {
		let calls = 0;
		const h = await startHarness({ allow: ["rebind.test"] });
		// Replace behaviour by a fresh proxy with a rebinding resolver.
		const dir = h.dir;
		const dialled: string[] = [];
		const p = await startEgressProxy({
			gate: createConnectionGate(1000),
			runId: "r",
			socketPath: join(dir, "rb.sock"),
			allow: ["rebind.test"],
			resolve: async () => (++calls === 1 ? [PUBLIC_IP] : ["127.0.0.1"]),
			connect: (ip) => {
				dialled.push(ip);
				return net.connect({ host: "127.0.0.1", port: h.backend.port });
			},
		});
		cleanups.push(() => p.close());
		const r = await raw(p.socketPath, connectLine("rebind.test:443"), 200);
		expect(r.text).toContain("200 Connection Established");
		expect(dialled).toEqual([PUBLIC_IP]);
		expect(calls).toBe(1);
	});

	test("a mixed public and private answer set is denied", async () => {
		const h = await startHarness({
			allow: ["multi.test"],
			dns: { "multi.test": [PUBLIC_IP, "127.0.0.1"] },
		});
		const r = await raw(h.proxy.socketPath, connectLine("multi.test:443"), 200);
		expect(r.text).toContain("403");
		expect(r.text).toContain("non-public-address");
		expect(h.dialled).toEqual([]);
	});

	test("v4-mapped private answers are denied; unresolvable names get 502", async () => {
		const h = await startHarness({
			allow: ["m.test", "nx.test"],
			dns: { "m.test": ["::ffff:127.0.0.1"] },
		});
		expect(
			(await raw(h.proxy.socketPath, connectLine("m.test:443"), 200)).text,
		).toContain("403");
		expect(
			(await raw(h.proxy.socketPath, connectLine("nx.test:443"), 200)).text,
		).toContain("502");
	});

	test("an upstream that refuses is 502 and logged with the pinned ip", async () => {
		const dir = await mkdtemp(join(tmpdir(), "egp-"));
		const log: EgressLogEntry[] = [];
		const p = await startEgressProxy({
			gate: createConnectionGate(1000),
			runId: "r",
			socketPath: join(dir, "e.sock"),
			allow: ["a.test"],
			resolve: async () => [PUBLIC_IP],
			connect: () => net.connect({ host: "127.0.0.1", port: 1 }),
			log: (e) => log.push(e),
		});
		cleanups.push(async () => {
			await p.close();
			await rm(dir, { recursive: true, force: true });
		});
		const r = await raw(p.socketPath, connectLine("a.test:443"), 300);
		expect(r.text).toContain("502");
		expect(log[0]).toMatchObject({
			decision: "DENY",
			ip: PUBLIC_IP,
			reason: "upstream-unreachable",
		});
	});

	test("a throwing log sink does not take the proxy down", async () => {
		const dir = await mkdtemp(join(tmpdir(), "egp-"));
		const p = await startEgressProxy({
			gate: createConnectionGate(1000),
			runId: "r",
			socketPath: join(dir, "e.sock"),
			allow: ["a.test"],
			log: () => {
				throw new Error("sink");
			},
		});
		cleanups.push(async () => {
			await p.close();
			await rm(dir, { recursive: true, force: true });
		});
		expect(
			(await raw(p.socketPath, connectLine("b.test:443"), 200)).text,
		).toContain("403");
		expect(
			(await raw(p.socketPath, connectLine("b.test:443"), 200)).text,
		).toContain("403");
	});
});

describe("egress proxy: limits", () => {
	test("silent partial head gets 408 at the total deadline", async () => {
		const h = await startHarness({ limits: { headerDeadlineMs: 300 } });
		const r = await raw(h.proxy.socketPath, "CONNECT allowed.te", 1200);
		expect(r.text).toContain("408");
		expect(r.closedAtMs).not.toBeNull();
	});

	test("a drip client does not reset the deadline", async () => {
		const h = await startHarness({ limits: { headerDeadlineMs: 400 } });
		const s = net.connect(h.proxy.socketPath);
		const out: Buffer[] = [];
		s.on("data", (d) => out.push(Buffer.from(d)));
		s.on("error", () => {});
		// The client drips one byte every 100 ms for at most 40 drips (4 s, ten
		// deadlines). A deadline that each byte reset would stay open for the
		// whole budget, so the proof is that the proxy hung up while the client
		// was still dripping; counting drips instead of reading the wall clock
		// keeps the check independent of how late a loaded host runs timers.
		let drips = 0;
		const drip = setInterval(() => {
			if (drips >= 40) return clearInterval(drip);
			if (s.writable) {
				drips++;
				s.write("X");
			}
		}, 100);
		// The proxy's hang-up is the FIN it sends after the 408. A client with a
		// write in flight does not always turn that FIN into a "close" (observed
		// on Bun), so the end of the stream is the hang-up, not the socket close.
		await new Promise((res) => {
			s.once("end", res);
			s.once("close", res);
		});
		clearInterval(drip);
		s.destroy();
		expect(drips).toBeLessThan(40);
		expect(Buffer.concat(out).toString()).toContain("408");
	});

	test("head over 8 KiB gets 431, with or without a terminator", async () => {
		const h = await startHarness();
		const big = `CONNECT allowed.test:443 HTTP/1.1\r\nX: ${"a".repeat(9000)}\r\n\r\n`;
		expect((await raw(h.proxy.socketPath, big, 300)).text).toContain("431");
		const noEnd = `CONNECT ${"a".repeat(9000)}`;
		expect((await raw(h.proxy.socketPath, noEnd, 300)).text).toContain("431");
		const line = `CONNECT ${"a".repeat(100 * 1024)}:443 HTTP/1.1\r\n\r\n`;
		expect((await raw(h.proxy.socketPath, line, 300)).text).toContain("431");
	});

	test("an idle tunnel is closed at the idle limit", async () => {
		const h = await startHarness({ limits: { idleMs: 300 } });
		const r = await raw(
			h.proxy.socketPath,
			connectLine("allowed.test:443"),
			1200,
			true,
		);
		expect(r.text).toContain("200 Connection Established");
		expect(r.closedAtMs).not.toBeNull();
		expect(r.closedAtMs as number).toBeLessThan(1000);
		r.socket.destroy();
	});

	test("per-run cap drops the excess and the proxy recovers", async () => {
		const h = await startHarness({
			limits: { maxConnectionsPerRun: 3, idleMs: 400 },
		});
		const results = await Promise.all(
			Array.from({ length: 8 }, () =>
				raw(h.proxy.socketPath, connectLine("allowed.test:443"), 250, true),
			),
		);
		const admitted = results.filter((r) =>
			r.text.includes("200 Connection Established"),
		);
		expect(admitted.length).toBe(3);
		expect(
			h.log.filter((e) => e.decision === "DENY" && e.reason === "limit-run")
				.length,
		).toBe(5);
		for (const r of results) r.socket.destroy();
		await new Promise((res) => setTimeout(res, 100));
		expect(h.proxy.active).toBe(0);
		const again = await raw(
			h.proxy.socketPath,
			connectLine("allowed.test:443"),
			150,
		);
		expect(again.text).toContain("200 Connection Established");
	});

	test("a resolver that never answers is cut off with 504 and frees its slot", async () => {
		const gate = createConnectionGate(5);
		const h = await startHarness({
			gate,
			limits: { resolveMs: 150 },
			resolve: () => new Promise(() => {}),
		});
		const r = await raw(
			h.proxy.socketPath,
			connectLine("allowed.test:443"),
			1500,
		);
		expect(r.text).toContain("504");
		expect(r.text).toContain("mfw-egress-denied: dns-timeout");
		expect(r.closedAtMs).not.toBeNull();
		expect(r.closedAtMs as number).toBeLessThan(1000);
		for (let i = 0; i < 30 && gate.active > 0; i++)
			await new Promise((res) => setTimeout(res, 20));
		expect(gate.active).toBe(0);
		expect(h.log.some((e) => e.decision === "DENY" && e.status === 504)).toBe(
			true,
		);
	});

	test("an open tunnel is logged as ALLOW before it closes", async () => {
		const h = await startHarness();
		const r = await raw(
			h.proxy.socketPath,
			connectLine("allowed.test:443"),
			150,
			true,
		);
		expect(r.text).toContain("200 Connection Established");
		const open = h.log.filter((e) => e.decision === "ALLOW");
		expect(open).toHaveLength(1);
		expect(open[0]).toMatchObject({
			phase: "open",
			host: "allowed.test",
			port: 443,
			ip: PUBLIC_IP,
			bytesUp: 0,
			bytesDown: 0,
		});
		r.socket.destroy();
		await new Promise((res) => setTimeout(res, 150));
		const all = h.log.filter((e) => e.decision === "ALLOW");
		expect(all.map((e) => (e.decision === "ALLOW" ? e.phase : ""))).toEqual([
			"open",
			"close",
		]);
	});

	test("a tunnel is closed at its maximum lifetime even when it is busy", async () => {
		const h = await startHarness({ limits: { maxTunnelMs: 300 } });
		const r = await raw(
			h.proxy.socketPath,
			connectLine("allowed.test:443"),
			100,
			true,
		);
		const started = Date.now();
		// Keep it busy so the idle timeout never fires.
		const timer = setInterval(() => r.socket.write("x"), 50);
		const closed = await new Promise<boolean>((resolve) => {
			r.socket.on("close", () => resolve(true));
			setTimeout(() => resolve(false), 1500);
		});
		clearInterval(timer);
		expect(closed).toBe(true);
		expect(Date.now() - started).toBeLessThan(1200);
		await new Promise((res) => setTimeout(res, 100));
		const close = h.log.find(
			(e) => e.decision === "ALLOW" && e.phase === "close",
		);
		expect(close).toBeDefined();
	});

	test("a proxy without a global connection gate refuses to start", async () => {
		const dir = await mkdtemp(join(tmpdir(), "egp-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		await expect(
			startEgressProxy({
				runId: "run-1",
				socketPath: join(dir, "e.sock"),
				allow: ["allowed.test"],
				// Simulates a JS caller that ignores the type.
			} as unknown as Parameters<typeof startEgressProxy>[0]),
		).rejects.toThrow(/gate/);
	});

	test("the global gate is shared across proxies", async () => {
		const gate = createConnectionGate(2);
		const a = await startHarness({ gate });
		const b = await startHarness({ gate });
		const rs = await Promise.all([
			raw(a.proxy.socketPath, connectLine("allowed.test:443"), 250, true),
			raw(b.proxy.socketPath, connectLine("allowed.test:443"), 250, true),
			raw(b.proxy.socketPath, connectLine("allowed.test:443"), 250, true),
		]);
		expect(rs.filter((r) => r.text.includes("200 Connection")).length).toBe(2);
		expect(gate.active).toBe(2);
		for (const r of rs) r.socket.destroy();
		await new Promise((res) => setTimeout(res, 100));
		expect(gate.active).toBe(0);
	});

	test("upstream connect timeout is 504", async () => {
		const dir = await mkdtemp(join(tmpdir(), "egp-"));
		const p = await startEgressProxy({
			gate: createConnectionGate(1000),
			runId: "r",
			socketPath: join(dir, "e.sock"),
			allow: ["a.test"],
			resolve: async () => [PUBLIC_IP],
			limits: { upstreamConnectMs: 150 },
			// A socket that never connects.
			connect: () => new net.Socket(),
		});
		cleanups.push(async () => {
			await p.close();
			await rm(dir, { recursive: true, force: true });
		});
		expect(
			(await raw(p.socketPath, connectLine("a.test:443"), 600)).text,
		).toContain("504");
	});
});

describe("egress proxy: SNI check (rule 11)", () => {
	function hello(sni: string): Buffer {
		const name = Buffer.from(sni);
		const list = [0, name.length >> 8, name.length & 0xff, ...name];
		const body = [list.length >> 8, list.length & 0xff, ...list];
		const ext = [0, 0, body.length >> 8, body.length & 0xff, ...body];
		const b = [
			0x03,
			0x03,
			...new Array(32).fill(1),
			0,
			0,
			2,
			0x13,
			0x01,
			1,
			0,
			ext.length >> 8,
			ext.length & 0xff,
			...ext,
		];
		const hs = [1, 0, b.length >> 8, b.length & 0xff, ...b];
		return Buffer.from([0x16, 3, 1, hs.length >> 8, hs.length & 0xff, ...hs]);
	}

	test("matching SNI passes; mismatch and non-TLS are closed and logged", async () => {
		const h = await startHarness({ sni: true });
		const ok = await raw(
			h.proxy.socketPath,
			Buffer.concat([
				Buffer.from(connectLine("allowed.test:443")),
				hello("allowed.test"),
			]),
			250,
		);
		expect(ok.text).toContain("200 Connection Established");
		expect(h.backend.received.length).toBeGreaterThan(0);
		const before = h.backend.received.length;
		const bad = await raw(
			h.proxy.socketPath,
			Buffer.concat([
				Buffer.from(connectLine("allowed.test:443")),
				hello("evil.test"),
			]),
			300,
		);
		expect(bad.closedAtMs).not.toBeNull();
		expect(
			h.log.some((e) => e.decision === "DENY" && e.reason === "sni-mismatch"),
		).toBe(true);
		const junk = await raw(
			h.proxy.socketPath,
			`${connectLine("allowed.test:443")}GET / HTTP/1.1\r\n\r\n`,
			300,
		);
		expect(junk.closedAtMs).not.toBeNull();
		expect(
			h.log.some((e) => e.decision === "DENY" && e.reason === "sni-invalid"),
		).toBe(true);
		expect(h.backend.received.length).toBe(before);
	});

	test("with the flag off a mismatching SNI is not inspected", async () => {
		const h = await startHarness();
		await raw(
			h.proxy.socketPath,
			Buffer.concat([
				Buffer.from(connectLine("allowed.test:443")),
				hello("evil.test"),
			]),
			250,
		);
		expect(h.log.some((e) => e.decision === "DENY")).toBe(false);
	});
});

describe("egress proxy: socket", () => {
	test("socket path is short, per run, and under the 107-byte limit", () => {
		const p = egressSocketPath("/var/lib/mfw", "01JABCDEFGHJKMNPQRSTVWXYZ0");
		expect(p).toMatch(/^\/var\/lib\/mfw\/run\/s\/[0-9a-f]{12}\/e\.sock$/);
		expect(egressSocketPath("/var/lib/mfw", "x")).not.toBe(
			egressSocketPath("/var/lib/mfw", "y"),
		);
		expect(() => egressSocketPath(`/${"d".repeat(120)}`, "x")).toThrow(/107/);
	});

	test("the socket is 0600 and removed on close", async () => {
		const h = await startHarness();
		const mode = (await stat(h.proxy.socketPath)).mode & 0o777;
		expect(mode).toBe(0o600);
		await h.proxy.close();
		await expect(stat(h.proxy.socketPath)).rejects.toThrow();
	});
});
