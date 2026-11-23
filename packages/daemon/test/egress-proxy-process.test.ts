import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createConnectionGate,
	startEgressProxy,
} from "../src/containment/egress-proxy.ts";
import {
	prepareRunEgress,
	type RunEgressPaths,
} from "../src/containment/egress-run.ts";
import { clientHello } from "./support/tls-hello.ts";

/** The real proxy process, on a fake network with a loopback upstream. */

const FAKE_NET = resolve(import.meta.dir, "support/egress-proxy-fake-net.ts");

let root: string;
let upstream: net.Server;
let upstreamPort: number;
let received: Buffer[];
const children: Bun.Subprocess[] = [];

beforeEach(async () => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "mfw-egp-")));
	mkdirSync(join(root, "h"), { mode: 0o700 });
	mkdirSync(join(root, "runs/r1"), { recursive: true });
	received = [];
	upstream = net.createServer((s) => {
		s.on("data", (d: Buffer) => {
			received.push(d);
			s.write("answer");
		});
		s.on("error", () => s.destroy());
	});
	await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
	upstreamPort = (upstream.address() as net.AddressInfo).port;
});

afterEach(async () => {
	for (const c of children.splice(0)) c.kill("SIGKILL");
	await new Promise<void>((r) => upstream.close(() => r()));
	rmSync(root, { recursive: true, force: true });
});

async function start(): Promise<RunEgressPaths> {
	const paths = prepareRunEgress({
		mfwHome: join(root, "h"),
		runDir: join(root, "runs/r1"),
		runId: "r1",
		allow: [{ host: "allowed.test", port: 443 }],
	});
	const child = Bun.spawn(
		[process.execPath, "run", FAKE_NET, paths.configPath, String(upstreamPort)],
		{ stdin: "pipe", stdout: "ignore", stderr: "ignore" },
	);
	children.push(child);
	const end = Date.now() + 15_000;
	while (
		!existsSync(paths.socketPath) ||
		!readFileSync(paths.indexPath, "utf8").includes('"pid"')
	) {
		if (Date.now() > end) throw new Error("proxy did not start");
		await Bun.sleep(20);
	}
	return paths;
}

/** Open a tunnel, send `first`, and report what came back before it closed. */
function tunnel(socketPath: string, first: Buffer): Promise<string> {
	return new Promise((done, fail) => {
		let out = "";
		let sent = false;
		const c = net.connect(socketPath, () =>
			c.write("CONNECT allowed.test:443 HTTP/1.1\r\n\r\n"),
		);
		const timer = setTimeout(() => c.destroy(), 1_500);
		c.on("data", (d) => {
			out += d.toString("latin1");
			if (!sent && out.includes("\r\n\r\n")) {
				sent = true;
				out = "";
				c.write(first);
			}
		});
		c.on("close", () => {
			clearTimeout(timer);
			done(out);
		});
		c.on("error", fail);
	});
}

describe("SNI in the real proxy process", () => {
	test("a hello naming the CONNECT host passes", async () => {
		const paths = await start();
		const hello = clientHello("allowed.test");
		expect(await tunnel(paths.socketPath, hello)).toBe("answer");
		expect(Buffer.concat(received).equals(hello)).toBe(true);
	}, 20_000);

	test.each([
		["another site", clientHello("attacker-site.example")],
		["no server name", clientHello(null)],
		["bytes that are not TLS", Buffer.from("GET / HTTP/1.1\r\n\r\n")],
	])(
		"%s reaches no upstream",
		async (_name, first) => {
			const paths = await start();
			expect(await tunnel(paths.socketPath, first)).toBe("");
			expect(received).toEqual([]);
			await Bun.sleep(50);
			const stats = JSON.parse(await waitFor(paths.statsPath)) as {
				denied: Record<string, { lastReason: string }>;
			};
			expect(stats.denied["allowed.test:443"]?.lastReason).toMatch(/^sni-/);
		},
		20_000,
	);
});

async function waitFor(path: string): Promise<string> {
	const end = Date.now() + 5_000;
	while (!existsSync(path)) {
		if (Date.now() > end) throw new Error(`${path} never appeared`);
		await Bun.sleep(25);
	}
	return readFileSync(path, "utf8");
}

describe("a client over a connection cap", () => {
	const answer = (path: string): Promise<string> =>
		new Promise((done) => {
			let out = "";
			const c = net.connect(path);
			const timer = setTimeout(() => {
				c.destroy();
				done(`no close: ${out}`);
			}, 3_000);
			c.on("data", (d) => {
				out += d.toString("latin1");
			});
			c.on("error", () => {});
			c.on("close", () => {
				clearTimeout(timer);
				done(out);
			});
		});

	test.each([
		["per run", { maxConnectionsPerRun: 1 }, 8],
		["global", {}, 1],
	])(
		"%s: gets a 429 and a close",
		async (_name, limits, gateSize) => {
			const socketPath = join(root, "cap.sock");
			const proxy = await startEgressProxy({
				runId: "r",
				socketPath,
				allow: ["allowed.test"],
				gate: createConnectionGate(gateSize),
				limits,
			});
			const holder = net.connect(socketPath);
			holder.on("error", () => {});
			try {
				await new Promise<void>((r) => holder.once("connect", () => r()));
				const end = Date.now() + 2_000;
				while (proxy.active === 0 && Date.now() < end) await Bun.sleep(5);
				const out = await answer(socketPath);
				expect(out).toContain("HTTP/1.1 429");
				expect(out).toContain("X-Mfw-Egress: denied");
			} finally {
				holder.destroy();
				await proxy.close();
			}
		},
		15_000,
	);
});
