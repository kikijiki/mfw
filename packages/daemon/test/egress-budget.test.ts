import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus, listEvents } from "@mfw/db/eventlog";
import {
	prepareRunEgress,
	type RunEgressPaths,
} from "../src/containment/egress-run.ts";
import { ingestRunEgress } from "../src/egress-ledger.ts";
import { InboxService } from "../src/inbox.ts";
import type { TaskService } from "../src/task-service.ts";
import { clientHello } from "./support/tls-hello.ts";

const FAKE_NET = resolve(import.meta.dir, "support/egress-proxy-fake-net.ts");
const MiB = 1024 * 1024;

let root: string;
let upstream: net.Server;
let upstreamPort: number;
let upstreamBytes: number;
const children: Bun.Subprocess[] = [];

beforeEach(async () => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "mfw-egbudget-")));
	mkdirSync(join(root, "h"), { mode: 0o700 });
	mkdirSync(join(root, "runs/r1"), { recursive: true });
	upstreamBytes = 0;
	upstream = net.createServer((s) => {
		s.on("data", (d: Buffer) => {
			upstreamBytes += d.length;
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

async function start(budget: {
	perDestinationBytes: number;
	totalBytes: number;
}): Promise<RunEgressPaths & { child: Bun.Subprocess }> {
	const paths = prepareRunEgress({
		mfwHome: join(root, "h"),
		runDir: join(root, "runs/r1"),
		runId: "r1",
		allow: [
			{ host: "a.test", port: 443 },
			{ host: "b.test", port: 443 },
		],
		uploadBudget: budget,
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
	return { ...paths, child };
}

/** Upload up to `bytes` through one tunnel. Returns what was written before it closed. */
function upload(socket: string, host: string, bytes: number): Promise<number> {
	return new Promise((done) => {
		const chunk = Buffer.alloc(MiB, 0x61);
		let written = 0;
		let head = "";
		let open = false;
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			clearInterval(watch);
			c.destroy();
			done(written);
		};
		const pump = () => {
			while (!c.destroyed && written < bytes) {
				written += chunk.length;
				if (!c.write(chunk)) {
					c.once("drain", pump);
					return;
				}
			}
			if (written >= bytes) setTimeout(finish, 300);
		};
		const c = net.connect(socket, () =>
			c.write(`CONNECT ${host}:443 HTTP/1.1\r\n\r\n`),
		);
		c.on("data", (d) => {
			if (open) return;
			head += d.toString("latin1");
			if (!head.includes("\r\n\r\n")) return;
			if (!head.startsWith("HTTP/1.1 200")) return finish();
			open = true;
			c.write(clientHello(host));
			pump();
		});
		c.on("error", finish);
		c.on("close", finish);
		// Bun emits no close on a socket blocked in a write when the peer goes.
		const watch = setInterval(() => {
			if (open && !c.writable) finish();
		}, 25);
	});
}

function connectStatus(socket: string, host: string): Promise<string> {
	return new Promise((done) => {
		let out = "";
		const c = net.connect(socket, () =>
			c.write(`CONNECT ${host}:443 HTTP/1.1\r\n\r\n`),
		);
		c.on("data", (d) => {
			out += d.toString("latin1");
			if (out.startsWith("HTTP/1.1 200")) c.destroy();
		});
		c.on("close", () => done(out));
		c.on("error", () => done(out));
	});
}

async function statsOf(path: string, ready: (s: never) => boolean) {
	const end = Date.now() + 6_000;
	for (;;) {
		try {
			const s = JSON.parse(readFileSync(path, "utf8"));
			if (ready(s as never)) return s;
		} catch {}
		if (Date.now() > end) throw new Error("the counters never showed it");
		await Bun.sleep(25);
	}
}

const breached = (s: { uploadBreach?: unknown }) =>
	s.uploadBreach !== undefined;

describe("the upload budget in the real proxy process", () => {
	test("512 MiB against a 64 MiB budget: stopped, refused, recorded", async () => {
		const p = await start({
			perDestinationBytes: 64 * MiB,
			totalBytes: 128 * MiB,
		});
		const written = await upload(p.socketPath, "a.test", 512 * MiB);
		expect(written).toBeLessThan(512 * MiB);
		await Bun.sleep(100);
		expect(upstreamBytes).toBeLessThanOrEqual(64 * MiB);
		expect(upstreamBytes).toBeGreaterThan(32 * MiB);
		const refused = await connectStatus(p.socketPath, "b.test");
		expect(refused).toContain("403");
		expect(refused).toContain("upload-budget");
		const stats = await statsOf(p.statsPath, breached);
		expect(stats.uploadBreach).toMatchObject({
			scope: "destination",
			destination: "a.test:443",
			limitBytes: 64 * MiB,
		});
	}, 60_000);

	test("the total is enforced across destinations", async () => {
		const p = await start({
			perDestinationBytes: 8 * MiB,
			totalBytes: 12 * MiB,
		});
		await upload(p.socketPath, "a.test", 6 * MiB);
		await upload(p.socketPath, "b.test", 40 * MiB);
		await Bun.sleep(100);
		expect(upstreamBytes).toBeLessThanOrEqual(12 * MiB);
		const stats = await statsOf(p.statsPath, breached);
		expect(stats.uploadBreach.scope).toBe("total");
	}, 30_000);

	test("a relaunch of the run cannot reset a spent budget", async () => {
		const budget = { perDestinationBytes: 4 * MiB, totalBytes: 8 * MiB };
		const first = await start(budget);
		await upload(first.socketPath, "a.test", 32 * MiB);
		await statsOf(first.statsPath, breached);
		(first.child.stdin as import("bun").FileSink).end();
		await first.child.exited;
		const second = await start(budget);
		const refused = await connectStatus(second.socketPath, "a.test");
		expect(refused).toContain("upload-budget");
	}, 30_000);
});

describe("a budget breach reaches the owner", () => {
	let handle: ProjectDbHandle;
	let runDir: string;
	const stats = {
		version: 1,
		allowed: {
			"a.test:443": { bytesUp: 64 * MiB, bytesDown: 0, connections: 1 },
		},
		denied: {},
		uploadBreach: {
			scope: "destination",
			destination: "a.test:443",
			limitBytes: 64 * MiB,
			at: 1_000,
		},
		updatedAt: 1_000,
	};

	beforeEach(async () => {
		handle = await openProjectDb(join(root, ".mfw"));
		runDir = join(root, ".mfw/runs/r1");
		mkdirSync(join(runDir, "egress"), { recursive: true });
		writeFileSync(join(runDir, "egress/stats.json"), JSON.stringify(stats));
	});
	afterEach(() => handle.close());

	const inbox = () =>
		new InboxService({
			handle,
			project: "p",
			tasks: {
				list: async () => [],
				ownershipConflicts: () => [],
			} as unknown as TaskService,
		});

	test("one host-observed event and one inbox item, however often it is read", async () => {
		const bus = new EventBus();
		const seen: string[] = [];
		bus.subscribe((e) => seen.push(e.type));
		for (let i = 0; i < 3; i++) {
			await ingestRunEgress(handle.db, "r1", runDir, new Date(2_000), bus);
		}
		const { events } = await listEvents(handle.db, {
			types: ["run.egress_budget_exceeded"],
		} as never);
		expect(events.length).toBe(1);
		expect(events[0]?.payload).toMatchObject({
			provenance: "host-observed",
			scope: "destination",
			destination: "a.test:443",
			limitBytes: 64 * MiB,
		});
		expect(seen.filter((t) => t === "run.egress_budget_exceeded").length).toBe(
			1,
		);
		const items = (await inbox().list()).filter(
			(i) => i.kind === "egress_budget",
		);
		expect(items.length).toBe(1);
		expect(items[0]).toMatchObject({
			id: "egress_budget:r1",
			runId: "r1",
			severity: "critical",
			attention: "act",
		});
		expect(items[0]?.detail).toContain("a.test:443");
	});

	test("a run with no breach raises nothing", async () => {
		const { uploadBreach: _gone, ...clean } = stats;
		writeFileSync(join(runDir, "egress/stats.json"), JSON.stringify(clean));
		await ingestRunEgress(handle.db, "r1", runDir, new Date(2_000));
		expect(
			(await inbox().list()).filter((i) => i.kind === "egress_budget"),
		).toEqual([]);
	});
});
