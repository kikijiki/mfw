import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseRelayArgs,
	startEgressRelay,
} from "../src/containment/egress-relay.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length) await (cleanups.pop() as () => Promise<void>)();
});

describe("relay args", () => {
	test("parses socket, port and host", () => {
		expect(
			parseRelayArgs([
				"--socket",
				"/s/e.sock",
				"--port",
				"3129",
				"--host",
				"127.0.0.1",
			]),
		).toEqual({ socketPath: "/s/e.sock", port: 3129, host: "127.0.0.1" });
		expect(parseRelayArgs(["--socket", "/s/e.sock"])).toEqual({
			socketPath: "/s/e.sock",
		});
	});

	test("rejects a missing socket, a bad port and unknown flags", () => {
		expect(() => parseRelayArgs([])).toThrow(/--socket is required/);
		expect(() => parseRelayArgs(["--socket", "x", "--port", "70000"])).toThrow(
			/invalid --port/,
		);
		expect(() => parseRelayArgs(["--socket", "x", "--port", "a"])).toThrow(
			/invalid --port/,
		);
		expect(() => parseRelayArgs(["--socket", "x", "--wat"])).toThrow(
			/unknown argument/,
		);
		expect(() => parseRelayArgs(["--socket"])).toThrow(/needs a value/);
	});
});

// -------------------------------------------------------------- relay

/** A unix-socket echo server with a banner. */
async function startUnixEcho(dir: string) {
	const path = join(dir, "echo.sock");
	const sockets = new Set<net.Socket>();
	const server = net.createServer((s) => {
		sockets.add(s);
		s.on("close", () => sockets.delete(s));
		s.on("error", () => {});
		s.write("HELLO\n");
		s.on("data", (d) => s.write(d));
	});
	await new Promise<void>((r) => server.listen(path, r));
	cleanups.push(async () => {
		for (const s of sockets) s.destroy();
		await new Promise<void>((r) => server.close(() => r()));
	});
	return path;
}

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

describe("egress relay", () => {
	test("binds loopback only and pipes both directions", async () => {
		const dir = await tempDir();
		const relay = await startEgressRelay({
			socketPath: await startUnixEcho(dir),
			port: 0,
		});
		cleanups.push(() => relay.close());
		expect(relay.host).toBe("127.0.0.1");
		const c = net.connect(relay.port, "127.0.0.1");
		c.write("ping\n");
		const got = await collect(c, 200);
		c.destroy();
		expect(got).toBe("HELLO\nping\n");
	});

	test("bytes sent before the upstream is connected are not lost", async () => {
		const dir = await tempDir();
		const relay = await startEgressRelay({
			socketPath: await startUnixEcho(dir),
			port: 0,
		});
		cleanups.push(() => relay.close());
		const c = net.connect(relay.port, "127.0.0.1");
		c.write("early");
		expect(await collect(c, 200)).toContain("early");
		c.destroy();
	});

	test("carries a large payload intact", async () => {
		const dir = await tempDir();
		const relay = await startEgressRelay({
			socketPath: await startUnixEcho(dir),
			port: 0,
		});
		cleanups.push(() => relay.close());
		const payload = Buffer.alloc(2 * 1024 * 1024, "abcdefghij");
		const c = net.connect(relay.port, "127.0.0.1");
		const chunks: Buffer[] = [];
		c.on("data", (d: Buffer) => chunks.push(d));
		c.write(payload);
		await new Promise<void>((resolve) => {
			const t = setInterval(() => {
				if (Buffer.concat(chunks).length >= payload.length + 6) {
					clearInterval(t);
					resolve();
				}
			}, 20);
		});
		c.destroy();
		expect(Buffer.concat(chunks).subarray(6).equals(payload)).toBe(true);
	});

	test("closes the client when the proxy socket is missing", async () => {
		const dir = await tempDir();
		const relay = await startEgressRelay({
			socketPath: join(dir, "absent.sock"),
			port: 0,
		});
		cleanups.push(() => relay.close());
		const c = net.connect(relay.port, "127.0.0.1");
		c.on("error", () => {});
		const closed = await new Promise<boolean>((resolve) => {
			c.on("close", () => resolve(true));
			setTimeout(() => resolve(false), 1000);
		});
		expect(closed).toBe(true);
		await new Promise((r) => setTimeout(r, 50));
		expect(relay.active).toBe(0);
	});

	test("an upstream close reaches the client and frees the pipe", async () => {
		const dir = await tempDir();
		const path = join(dir, "once.sock");
		const server = net.createServer((s) => s.end("bye\n"));
		await new Promise<void>((r) => server.listen(path, r));
		cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
		const relay = await startEgressRelay({ socketPath: path, port: 0 });
		cleanups.push(() => relay.close());
		const c = net.connect(relay.port, "127.0.0.1");
		expect(await collect(c, 200)).toBe("bye\n");
		c.destroy();
		await new Promise((r) => setTimeout(r, 50));
		expect(relay.active).toBe(0);
	});

	test("a client close tears down the upstream", async () => {
		const dir = await tempDir();
		const path = join(dir, "watch.sock");
		let upstreamClosed = false;
		const server = net.createServer((s) => {
			s.on("error", () => {});
			s.on("close", () => {
				upstreamClosed = true;
			});
		});
		await new Promise<void>((r) => server.listen(path, r));
		cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
		const relay = await startEgressRelay({ socketPath: path, port: 0 });
		cleanups.push(() => relay.close());
		const c = net.connect(relay.port, "127.0.0.1");
		await new Promise<void>((r) => c.once("connect", r));
		await new Promise((r) => setTimeout(r, 50));
		expect(relay.active).toBe(1);
		c.destroy();
		await new Promise((r) => setTimeout(r, 100));
		expect(upstreamClosed).toBe(true);
		expect(relay.active).toBe(0);
	});

	test("close destroys open pipes and releases the port", async () => {
		const dir = await tempDir();
		const relay = await startEgressRelay({
			socketPath: await startUnixEcho(dir),
			port: 0,
		});
		const c = net.connect(relay.port, "127.0.0.1");
		c.on("error", () => {});
		await new Promise<void>((r) => c.once("connect", r));
		const closed = new Promise<void>((r) => c.once("close", () => r()));
		await relay.close();
		await closed;
		const again = await startEgressRelay({
			socketPath: join(dir, "x.sock"),
			port: relay.port,
		});
		await again.close();
	});

	test("a port that is taken rejects", async () => {
		const dir = await tempDir();
		const relay = await startEgressRelay({
			socketPath: join(dir, "x.sock"),
			port: 0,
		});
		cleanups.push(() => relay.close());
		await expect(
			startEgressRelay({ socketPath: join(dir, "x.sock"), port: relay.port }),
		).rejects.toThrow();
	});
});

describe("the relay in front of a command", () => {
	const RELAY = join(import.meta.dir, "../src/containment/egress-relay.ts");
	const relayed = (port: number, command: string[]) =>
		Bun.spawn(
			[
				process.execPath,
				"--config=/dev/null",
				"--no-env-file",
				"run",
				RELAY,
				"--socket",
				"/nonexistent/e.sock",
				"--port",
				String(port),
				"--",
				...command,
			],
			{ stdin: "ignore", stdout: "pipe", stderr: "pipe" },
		);

	test("passes on the command's output and exit status", async () => {
		const child = relayed(0, ["sh", "-c", "echo from-command; exit 7"]);
		const out = await new Response(child.stdout).text();
		expect(await child.exited).toBe(7);
		expect(out).toBe("from-command\n");
	});

	test("reports a command it cannot run", async () => {
		const child = relayed(0, ["/nonexistent/agent"]);
		expect(await child.exited).toBe(127);
	});

	test("never starts the command if it cannot listen", async () => {
		const taken = net.createServer();
		await new Promise<void>((r) => taken.listen(0, "127.0.0.1", r));
		const { port } = taken.address() as net.AddressInfo;
		try {
			const child = relayed(port, ["sh", "-c", "echo started"]);
			const out = await new Response(child.stdout).text();
			expect(await child.exited).toBe(78);
			expect(out).toBe("");
		} finally {
			await new Promise<void>((r) => taken.close(() => r()));
		}
	});
});
