import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import {
	egressClientEnv,
	egressProxyUrl,
	PROXY_VARS,
} from "../src/containment/egress-env.ts";
import {
	createConnectionGate,
	type EgressLogEntry,
	type EgressProxy,
	startEgressProxy,
} from "../src/containment/egress-proxy.ts";
import {
	type EgressRelay,
	startEgressRelay,
} from "../src/containment/egress-relay.ts";

const PUBLIC_IP = "93.184.216.34";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length) await (cleanups.pop() as () => Promise<void>)();
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "egr-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function collect(socket: net.Socket, ms: number): Promise<string> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		socket.on("data", (d: Buffer) => chunks.push(d));
		setTimeout(() => resolve(Buffer.concat(chunks).toString()), ms);
	});
}

// ---------------------------------------------------------------- env

describe("egress client env", () => {
	test("sets every proxy variable in both cases to the relay", () => {
		const env = egressClientEnv();
		expect(egressProxyUrl()).toBe("http://127.0.0.1:3128");
		for (const name of [
			"https_proxy",
			"HTTPS_PROXY",
			"http_proxy",
			"HTTP_PROXY",
			"ALL_PROXY",
			"all_proxy",
		]) {
			expect(env[name]).toBe("http://127.0.0.1:3128");
		}
		expect(PROXY_VARS.length).toBe(6);
	});

	test("NO_PROXY is empty in both cases and node honours the env", () => {
		const env = egressClientEnv();
		expect(env.NO_PROXY).toBe("");
		expect(env.no_proxy).toBe("");
		expect(env.NODE_USE_ENV_PROXY).toBe("1");
	});

	test("a custom host and port flow into every variable", () => {
		const env = egressClientEnv({ port: 4000 });
		for (const name of PROXY_VARS)
			expect(env[name]).toBe("http://127.0.0.1:4000");
	});

	test("sets nothing beyond the proxy variables", () => {
		expect(Object.keys(egressClientEnv()).sort()).toEqual(
			[...PROXY_VARS, "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY"].sort(),
		);
	});
});

// ------------------------------------------- real clients, end to end

/** Minimal DER encoder, enough for a self-signed P-256 test certificate. */
function der(tag: number, ...parts: Buffer[]): Buffer {
	const body = Buffer.concat(parts);
	const len =
		body.length < 128
			? Buffer.from([body.length])
			: body.length < 256
				? Buffer.from([0x81, body.length])
				: Buffer.from([0x82, body.length >> 8, body.length & 255]);
	return Buffer.concat([Buffer.from([tag]), len, body]);
}
const oid = (bytes: number[]) => der(0x06, Buffer.from(bytes));
const utf8 = (s: string) => der(0x0c, Buffer.from(s));
const utc = (s: string) => der(0x17, Buffer.from(s));

/** A throwaway self-signed certificate for `names`, as PEM, generated per run. */
function selfSignedPem(names: string[]): { cert: string; key: string } {
	const { privateKey, publicKey } = generateKeyPairSync("ec", {
		namedCurve: "P-256",
	});
	const ecdsaSha256 = der(
		0x30,
		oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]),
	);
	const name = der(
		0x30,
		der(0x31, der(0x30, oid([0x55, 0x04, 0x03]), utf8(names[0] as string))),
	);
	const san = der(
		0x30,
		oid([0x55, 0x1d, 0x11]),
		der(0x04, der(0x30, ...names.map((n) => der(0x82, Buffer.from(n))))),
	);
	const tbs = der(
		0x30,
		der(0xa0, der(0x02, Buffer.from([2]))),
		der(0x02, Buffer.from([1])),
		ecdsaSha256,
		name,
		der(0x30, utc("200101000000Z"), utc("491231235959Z")),
		name,
		publicKey.export({ type: "spki", format: "der" }) as Buffer,
		der(0xa3, der(0x30, san)),
	);
	const signature = sign("sha256", tbs, {
		key: privateKey,
		dsaEncoding: "der",
	});
	const cert = der(
		0x30,
		tbs,
		ecdsaSha256,
		der(0x03, Buffer.from([0]), signature),
	);
	const pem = (label: string, buf: Buffer) =>
		`-----BEGIN ${label}-----\n${buf
			.toString("base64")
			.replace(/(.{64})/g, "$1\n")}\n-----END ${label}-----\n`;
	// Round-trip so a malformed certificate fails here, not inside a client.
	createPublicKey(pem("CERTIFICATE", cert));
	return {
		cert: pem("CERTIFICATE", cert),
		key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
	};
}

interface Stack {
	relay: EgressRelay;
	proxy: EgressProxy;
	log: EgressLogEntry[];
	dir: string;
	caFile: string;
	/** Env for a client: the real client env plus trust for the test cert. */
	env: Record<string, string>;
	/** Where an upstream http redirect should point. */
	backendPort: number;
	hits: string[];
}

/**
 * Proxy (stub DNS, dialling a local TLS server) + relay, exactly the shape the
 * sandbox has. `redirect.test` is allowed too, and its server answers every
 * request with a 302 to `http://denied.test/`.
 */
async function startStack(): Promise<Stack> {
	const dir = await tempDir();
	const { cert, key } = selfSignedPem(["allowed.test", "redirect.test"]);
	const caFile = join(dir, "ca.pem");
	await writeFile(caFile, cert);
	const hits: string[] = [];
	const server = tls.createServer({ cert, key }, (s) => {
		s.on("error", () => {});
		s.once("data", (d) => {
			const request = d.toString();
			hits.push(request.split("\r\n")[0] as string);
			if (/^host: redirect\.test/im.test(request)) {
				s.end(
					"HTTP/1.1 302 Found\r\nLocation: http://denied.test/x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
				);
			} else {
				s.end(
					"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
				);
			}
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const backendPort = (server.address() as net.AddressInfo).port;
	cleanups.push(() => new Promise<void>((r) => server.close(() => r())));

	const log: EgressLogEntry[] = [];
	const proxy = await startEgressProxy({
		gate: createConnectionGate(1000),
		runId: "run-e7b",
		socketPath: join(dir, "e.sock"),
		allow: ["allowed.test", "redirect.test"],
		resolve: async (host) => {
			const name = host.replace(/\.$/, "");
			if (name === "allowed.test" || name === "redirect.test")
				return [PUBLIC_IP];
			throw new Error("NXDOMAIN");
		},
		connect: () => net.connect({ host: "127.0.0.1", port: backendPort }),
		log: (e) => log.push(e),
	});
	cleanups.push(() => proxy.close());
	const relay = await startEgressRelay({
		socketPath: proxy.socketPath,
		port: 0,
	});
	cleanups.push(() => relay.close());
	const env = {
		...egressClientEnv({ port: relay.port }),
		NODE_EXTRA_CA_CERTS: caFile,
		SSL_CERT_FILE: caFile,
		PATH: process.env.PATH ?? "",
	};
	return { relay, proxy, log, dir, caFile, env, backendPort, hits };
}

function have(cmd: string): boolean {
	return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
}

/** Run a client to completion, with a hard timeout. Returns both streams. */
async function run(
	cmd: string,
	args: string[],
	env: Record<string, string>,
): Promise<{ code: number | null; out: string }> {
	// Async: the proxy and relay live in this process, so it must keep serving.
	const child = spawn(cmd, args, { env, timeout: 15_000 });
	const chunks: Buffer[] = [];
	child.stdout.on("data", (d: Buffer) => chunks.push(d));
	child.stderr.on("data", (d: Buffer) => chunks.push(d));
	const code = await new Promise<number | null>((resolve) =>
		child.on("close", (c) => resolve(c)),
	);
	return { code, out: Buffer.concat(chunks).toString() };
}

const NODE_SNIPPETS: Record<string, (url: string) => string> = {
	"https.get": (url) =>
		`require("https").get(${JSON.stringify(url)},r=>{let b="";r.on("data",d=>b+=d);r.on("end",()=>console.log("RESULT",r.statusCode,b))}).on("error",e=>console.log("ERROR",e.message))`,
	"http.request": (url) =>
		`const u=new URL(${JSON.stringify(url)});require(u.protocol==="https:"?"https":"http").request(u,r=>{let b="";r.on("data",d=>b+=d);r.on("end",()=>console.log("RESULT",r.statusCode,b))}).on("error",e=>console.log("ERROR",e.message)).end()`,
	fetch: (url) =>
		`fetch(${JSON.stringify(url)}).then(async r=>console.log("RESULT",r.status,await r.text())).catch(e=>console.log("ERROR",e.message,e.cause&&e.cause.message))`,
};

describe("real clients through relay and proxy", () => {
	const nodeBin = have("node") ? "node" : null;
	const bunBin = process.execPath;
	const curlBin = have("curl") ? "curl" : null;

	test("curl: an allowed https request tunnels", async () => {
		if (!curlBin) return console.log("skip: curl not installed");
		const s = await startStack();
		const r = await run(curlBin, ["-sS", "https://allowed.test/"], s.env);
		expect(r.out).toBe("ok");
		expect(s.hits).toEqual(["GET / HTTP/1.1"]);
		expect(
			s.log.some((e) => e.decision === "ALLOW" && e.host === "allowed.test"),
		).toBe(true);
	});

	test("curl: a denied host shows the marker", async () => {
		if (!curlBin) return console.log("skip: curl not installed");
		const s = await startStack();
		const r = await run(curlBin, ["-sS", "-v", "https://denied.test/"], s.env);
		expect(r.code).not.toBe(0);
		expect(r.out.toLowerCase()).toContain("x-mfw-egress: denied");
		expect(s.hits).toEqual([]);
		expect(
			s.log.some((e) => e.decision === "DENY" && e.host === "denied.test"),
		).toBe(true);
	});

	test("curl: an http redirect to a denied host gets 405 at the proxy", async () => {
		if (!curlBin) return console.log("skip: curl not installed");
		const s = await startStack();
		const r = await run(
			curlBin,
			["-sS", "-L", "https://redirect.test/"],
			s.env,
		);
		expect(r.out).toContain("mfw-egress-denied");
		expect(s.log.some((e) => e.decision === "DENY" && e.status === 405)).toBe(
			true,
		);
		expect(s.hits).toEqual(["GET / HTTP/1.1"]);
	});

	for (const [name, snippet] of Object.entries(NODE_SNIPPETS)) {
		test(`node 22 ${name}: an allowed https request tunnels`, async () => {
			if (!nodeBin) return console.log("skip: node not installed");
			const s = await startStack();
			const r = await run(
				nodeBin,
				["-e", snippet("https://allowed.test/")],
				s.env,
			);
			expect(r.out).toContain("RESULT 200 ok");
			expect(s.log.some((e) => e.decision === "ALLOW")).toBe(true);
		});

		test(`node 22 ${name}: a denied host shows the marker`, async () => {
			if (!nodeBin) return console.log("skip: node not installed");
			const s = await startStack();
			const r = await run(
				nodeBin,
				["-e", snippet("https://denied.test/")],
				s.env,
			);
			expect(r.out).toContain("ERROR");
			expect(r.out).not.toContain("RESULT 200");
			expect(s.hits).toEqual([]);
			expect(
				s.log.some((e) => e.decision === "DENY" && e.host === "denied.test"),
			).toBe(true);
		});
	}

	test("node 22 fetch: an http redirect to a denied host is denied at the proxy", async () => {
		if (!nodeBin) return console.log("skip: node not installed");
		const s = await startStack();
		const r = await run(
			nodeBin,
			["-e", NODE_SNIPPETS.fetch?.("https://redirect.test/") as string],
			s.env,
		);
		// undici tunnels plain http through CONNECT too (to port 80, which is not
		// allowlisted), so the denial is a 403 here, not the 405 curl gets.
		expect(r.out).not.toContain("RESULT 200");
		expect(
			s.log.some((e) => e.decision === "DENY" && e.host === "denied.test"),
		).toBe(true);
		expect(s.hits).toEqual(["GET / HTTP/1.1"]);
	});

	test("node 22 without NODE_USE_ENV_PROXY goes direct, not through the proxy", async () => {
		if (!nodeBin) return console.log("skip: node not installed");
		const s = await startStack();
		const env = { ...s.env };
		delete env.NODE_USE_ENV_PROXY;
		await run(
			nodeBin,
			["-e", NODE_SNIPPETS.fetch?.("https://allowed.test/") as string],
			env,
		);
		expect(s.log).toEqual([]);
	});

	test("bun fetch: an allowed https request tunnels", async () => {
		const s = await startStack();
		const r = await run(
			bunBin,
			["-e", NODE_SNIPPETS.fetch?.("https://allowed.test/") as string],
			s.env,
		);
		expect(r.out).toContain("RESULT 200 ok");
		expect(s.log.some((e) => e.decision === "ALLOW")).toBe(true);
	});

	test("bun fetch: a denied host shows the marker", async () => {
		const s = await startStack();
		const r = await run(
			bunBin,
			["-e", NODE_SNIPPETS.fetch?.("https://denied.test/") as string],
			s.env,
		);
		expect(r.out).not.toContain("RESULT 200");
		expect(s.hits).toEqual([]);
		expect(
			s.log.some((e) => e.decision === "DENY" && e.host === "denied.test"),
		).toBe(true);
	});

	test("bun fetch: an http redirect to a denied host gets 405 at the proxy", async () => {
		const s = await startStack();
		const r = await run(
			bunBin,
			["-e", NODE_SNIPPETS.fetch?.("https://redirect.test/") as string],
			s.env,
		);
		expect(r.out).toContain("RESULT 405");
		expect(r.out).toContain("mfw-egress-denied");
		expect(s.log.some((e) => e.decision === "DENY" && e.status === 405)).toBe(
			true,
		);
	});

	test("the relay script serves the proxy socket (bun)", async () => {
		const s = await startStack();
		const proc = Bun.spawn(
			[
				bunBin,
				join(import.meta.dir, "../src/containment/egress-relay.ts"),
				"--socket",
				s.proxy.socketPath,
				"--port",
				"0",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		cleanups.push(() => void proc.kill());
		const reader = proc.stdout.getReader();
		const first = new TextDecoder().decode((await reader.read()).value);
		const port = Number(/:(\d+)\n/.exec(first)?.[1]);
		expect(port).toBeGreaterThan(0);
		const c = net.connect(port, "127.0.0.1");
		c.write("CONNECT denied.test:443 HTTP/1.1\r\n\r\n");
		const got = await collect(c, 300);
		c.destroy();
		expect(got).toContain("403");
		expect(got).toContain("mfw-egress-denied");
	});
});
