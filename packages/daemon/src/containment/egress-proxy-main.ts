/**
 * The per-run egress proxy process: `egress-proxy-main.ts <config.json>`.
 *
 * Started by the run's `run.sh` with a pipe on stdin. End of file on that pipe
 * means the run is over, however it ended, and the proxy removes its socket
 * directory and exits. There is no other way to keep it alive.
 */

import { readFileSync } from "node:fs";
import { createConnectionGate, startEgressProxy } from "./egress-proxy.ts";
import {
	armProxyHardExit,
	RunEgressConfigSchema,
	recordProxyProcess,
	removeRunEgressEndpoints,
} from "./egress-run.ts";
import { EgressCounters, parseEgressStats } from "./egress-stats.ts";

/** A hung close must not hold up the run's exit record. */
const SHUTDOWN_DEADLINE_MS = 2_000;

/** Enforced by the kernel, for a proxy whose event loop no longer runs. */
const HARD_EXIT_SECONDS = 3;

/** Its own process, so the cap protects this process's descriptors. */
const MAX_CONNECTIONS = 64;

/** How stale the host's view of a live run's traffic can be. */
const FLUSH_EVERY_MS = 2_000;

function readIfPresent(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

async function main(): Promise<void> {
	const path = process.argv[2];
	if (!path) throw new Error("usage: egress-proxy-main <config.json>");
	const config = RunEgressConfigSchema.parse(
		JSON.parse(readFileSync(path, "utf8")),
	);
	// A relaunch of the run adds to its earlier counters.
	const counters = new EgressCounters(
		parseEgressStats(readIfPresent(config.statsPath)) ?? undefined,
	);
	const flush = (): void => {
		try {
			counters.flush(config.statsPath, Date.now());
		} catch {
			// The next flush retries; the proxy keeps working without its counters.
		}
	};
	const proxy = await startEgressProxy({
		runId: config.runId,
		socketPath: config.socketPath,
		allow: config.allow,
		gate: createConnectionGate(MAX_CONNECTIONS),
		log: (entry) => counters.record(entry),
		onBytes: (host, port, up, down) => counters.addBytes(host, port, up, down),
	});
	recordProxyProcess(config);
	setInterval(flush, FLUSH_EVERY_MS).unref();

	let stopping = false;
	const stop = (): void => {
		if (stopping) return;
		stopping = true;
		try {
			armProxyHardExit(HARD_EXIT_SECONDS);
		} catch {
			// The timer below still applies; the recovery sweep covers the rest.
		}
		const finish = (): void => {
			flush();
			removeRunEgressEndpoints(config);
			process.exit(0);
		};
		setTimeout(finish, SHUTDOWN_DEADLINE_MS).unref();
		void proxy.close().finally(finish);
	};
	process.stdin.on("end", stop);
	process.stdin.on("close", stop);
	process.stdin.on("error", stop);
	process.stdin.resume();
	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
		process.on(signal, stop);
	}
}

main().catch((err) => {
	process.stderr.write(`egress proxy: ${(err as Error).message}\n`);
	process.exit(1);
});
