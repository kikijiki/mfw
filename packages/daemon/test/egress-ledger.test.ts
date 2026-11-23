import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { listRunEgress, runEgressTotals } from "@mfw/db/run-egress";
import { sql } from "drizzle-orm";
import {
	createConnectionGate,
	startEgressProxy,
} from "../src/containment/egress-proxy.ts";
import {
	EgressCounters,
	type EgressStats,
	emptyEgressStats,
	MAX_DENIED_HOSTS,
	MAX_EGRESS_STATS_BYTES,
	OTHER_DESTINATION,
	parseEgressStats,
	UNPARSED_DESTINATION,
} from "../src/containment/egress-stats.ts";
import { egressRows, ingestRunEgress } from "../src/egress-ledger.ts";
import { runProvenanceView } from "../src/run-provenance-view.ts";

const deny = (host?: string, reason = "not-allowlisted") =>
	({
		decision: "DENY",
		runId: "r",
		...(host ? { host, port: 443 } : {}),
		status: 403,
		reason,
		at: 1,
	}) as const;

describe("egress counters", () => {
	test("count connections once and bytes per chunk", () => {
		const c = new EgressCounters();
		const open = {
			decision: "ALLOW",
			runId: "r",
			host: "a.test",
			port: 443,
			ip: "1.1.1.1",
			bytesUp: 0,
			bytesDown: 0,
			durationMs: 0,
			at: 1,
		} as const;
		c.record({ ...open, phase: "open" });
		c.addBytes("a.test", 443, 10, 0);
		c.addBytes("a.test", 443, 0, 25);
		// The close carries the same bytes as totals; they must not count twice.
		c.record({ ...open, phase: "close", bytesUp: 10, bytesDown: 25 });
		expect(c.snapshot().allowed["a.test:443"]).toEqual({
			bytesUp: 10,
			bytesDown: 25,
			connections: 1,
		});
	});

	test("an agent inventing names cannot grow the record without limit", () => {
		const c = new EgressCounters();
		for (let i = 0; i < 5_000; i++) c.record(deny(`h${i}.test`));
		c.record(deny());
		const { denied } = c.snapshot();
		expect(Object.keys(denied).length).toBe(MAX_DENIED_HOSTS + 2);
		expect(denied[OTHER_DESTINATION]?.count).toBe(5_000 - MAX_DENIED_HOSTS);
		expect(denied[UNPARSED_DESTINATION]?.count).toBe(1);
		// A name already recorded keeps counting after the cap.
		c.record(deny("h0.test"));
		expect(c.snapshot().denied["h0.test:443"]?.count).toBe(2);
		expect(JSON.stringify(c.snapshot()).length).toBeLessThan(
			MAX_EGRESS_STATS_BYTES,
		);
		expect(parseEgressStats(JSON.stringify(c.snapshot()))).not.toBeNull();
	});

	test.each([
		["not json", "{"],
		[
			"a negative count",
			JSON.stringify({
				...emptyEgressStats(),
				allowed: {
					"a.test:443": { bytesUp: -1, bytesDown: 0, connections: 0 },
				},
			}),
		],
		[
			"an escape in a name",
			JSON.stringify({
				...emptyEgressStats(),
				denied: { "\u001b[2Jx:443": { count: 1, lastReason: "x" } },
			}),
		],
		["an unknown key", JSON.stringify({ ...emptyEgressStats(), extra: 1 })],
	])("refuses %s", (_name, text) => {
		expect(parseEgressStats(text)).toBeNull();
	});
});

describe("run egress records", () => {
	let dir: string;
	let handle: ProjectDbHandle;
	let runDir: string;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "mfw-egl-"));
		handle = await openProjectDb(join(dir, ".mfw"));
		runDir = join(dir, ".mfw", "runs", "r1");
		mkdirSync(join(runDir, "egress"), { recursive: true });
	});
	afterEach(() => {
		handle.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const stats = (up: number, denied = 1): EgressStats => ({
		version: 1,
		allowed: {
			"api.anthropic.com:443": { bytesUp: up, bytesDown: 500, connections: 2 },
		},
		denied: {
			"evil.test:443": { count: denied, lastReason: "not-allowlisted" },
		},
		updatedAt: 5,
	});
	const write = (s: EgressStats) =>
		writeFileSync(join(runDir, "egress/stats.json"), JSON.stringify(s));
	const ingest = () => ingestRunEgress(handle.db, "r1", runDir, new Date(1000));

	test("records bytes per destination and denied attempts, host-observed", async () => {
		write(stats(100));
		expect(await ingest()).toBe(2);
		const totals = await runEgressTotals(handle.db, "r1");
		expect(totals).toMatchObject({
			provenance: "host-observed",
			bytesUp: 100,
			bytesDown: 500,
			denied: 1,
		});
		expect(totals?.destinations.map((d) => d.destination)).toEqual([
			"api.anthropic.com:443",
			"evil.test:443",
		]);
		const view = await runProvenanceView(handle.db, "r1");
		expect(view.egress?.bytesUp).toBe(100);
	});

	test("a run with no egress has no record and no view entry", async () => {
		expect(await ingest()).toBe(0);
		expect(await runEgressTotals(handle.db, "r1")).toBeNull();
		expect((await runProvenanceView(handle.db, "r1")).egress).toBeUndefined();
	});

	test("ingest is idempotent and never lowers a total", async () => {
		write(stats(100, 3));
		await ingest();
		await ingest();
		write(stats(40, 1));
		await ingest();
		const totals = await runEgressTotals(handle.db, "r1");
		expect(totals?.bytesUp).toBe(100);
		expect(totals?.denied).toBe(3);
		write(stats(250, 4));
		await ingest();
		expect((await runEgressTotals(handle.db, "r1"))?.bytesUp).toBe(250);
	});

	test("the table refuses any other provenance", async () => {
		await expect(
			(async () => {
				await handle.db.run(
					sql`INSERT INTO run_egress (run_id, destination, provenance, observed_at) VALUES ('r1', 'a.test:443', 'sandbox-reported', 1)`,
				);
			})(),
		).rejects.toThrow();
		expect(await listRunEgress(handle.db, "r1")).toEqual([]);
	});

	test.each([
		"damaged",
		"oversized",
		"symlink",
	])("skips a %s file", async (kind) => {
		const path = join(runDir, "egress/stats.json");
		if (kind === "damaged") writeFileSync(path, "{nope");
		if (kind === "oversized") {
			writeFileSync(path, " ".repeat(MAX_EGRESS_STATS_BYTES + 1));
		}
		if (kind === "symlink") {
			const other = join(dir, "other.json");
			writeFileSync(other, JSON.stringify(stats(9)));
			symlinkSync(other, path);
		}
		expect(await ingest()).toBe(0);
		expect(await runEgressTotals(handle.db, "r1")).toBeNull();
	});

	test("merges allowed and denied traffic to one destination", () => {
		const rows = egressRows({
			...emptyEgressStats(),
			allowed: { "a.test:443": { bytesUp: 1, bytesDown: 2, connections: 1 } },
			denied: { "a.test:443": { count: 4, lastReason: "limit-run" } },
		});
		expect(rows).toEqual([
			{
				destination: "a.test:443",
				bytesUp: 1,
				bytesDown: 2,
				connections: 1,
				denied: 4,
				lastDeniedReason: "limit-run",
			},
		]);
	});
});

describe("live byte counts", () => {
	test("reach the counter while the tunnel is still open", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mfw-egb-"));
		const upstream = net.createServer((s) => {
			s.on("data", (d) => s.write(d));
			s.on("error", () => {});
		});
		await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
		const port = (upstream.address() as net.AddressInfo).port;
		const counters = new EgressCounters();
		const proxy = await startEgressProxy({
			runId: "r",
			socketPath: join(dir, "e.sock"),
			allow: ["a.test"],
			gate: createConnectionGate(4),
			resolve: async () => ["1.1.1.1"],
			connect: () => net.connect(port, "127.0.0.1"),
			log: (e) => counters.record(e),
			onBytes: (h, p, up, down) => counters.addBytes(h, p, up, down),
		});
		const client = net.connect(join(dir, "e.sock"));
		try {
			await new Promise<void>((done) => {
				let tunnelled = false;
				client.on("data", (d) => {
					if (!tunnelled && d.toString().startsWith("HTTP/1.1 200")) {
						tunnelled = true;
						client.write("12345");
					} else if (tunnelled) done();
				});
				client.write("CONNECT a.test:443 HTTP/1.1\r\n\r\n");
			});
			expect(client.destroyed).toBe(false);
			expect(counters.snapshot().allowed["a.test:443"]).toEqual({
				bytesUp: 5,
				bytesDown: 5,
				connections: 1,
			});
		} finally {
			client.destroy();
			await proxy.close();
			await new Promise<void>((r) => upstream.close(() => r()));
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
