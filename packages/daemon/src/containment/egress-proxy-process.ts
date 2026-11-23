/**
 * The body of the per-run proxy process (`egress-proxy-main.ts`).
 *
 * Started by the run's `run.sh` with a pipe on stdin. End of file on that pipe
 * means the run is over, however it ended, and the proxy removes its socket
 * directory and exits. There is no other way to keep it alive.
 */

import { readFileSync } from "node:fs";
import {
	createConnectionGate,
	type EgressProxyOptions,
	startEgressProxy,
} from "./egress-proxy.ts";
import {
	armProxyHardExit,
	ownsRunEgressEndpoints,
	RunEgressConfigSchema,
	recordProxyProcess,
	removeRunEgressEndpoints,
} from "./egress-run.ts";
import { EgressCounters, parseEgressStats } from "./egress-stats.ts";

/** A hung close must not hold up the run's exit record. */
const SHUTDOWN_DEADLINE_MS = 2_000;

/** Enforced by the kernel, for a proxy whose event loop no longer runs. */
const HARD_EXIT_SECONDS = 3;

/** Per run, because each proxy is its own process. See `MAX_PROXIED_RUNS`. */
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

/** Only the tests' fake network passes these. */
export type ProxyNetworkSeam = Pick<
	EgressProxyOptions,
	"resolve" | "connect" | "localAddresses"
>;

export async function runEgressProxyProcess(
	configPath: string,
	network: ProxyNetworkSeam = {},
): Promise<void> {
	const config = RunEgressConfigSchema.parse(
		JSON.parse(readFileSync(configPath, "utf8")),
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
		...network,
		runId: config.runId,
		socketPath: config.socketPath,
		allow: config.allow,
		// Fail closed: a hello that is missing, malformed or names another host
		// never reaches the upstream, so a shared CDN address stays one site.
		sni: true,
		gate: createConnectionGate(MAX_CONNECTIONS),
		ownsSocket: () => ownsRunEgressEndpoints(config),
		uploadBudget: config.uploadBudget,
		uploadedBefore: counters.uploadedBytes(),
		breachedBefore: counters.breached,
		onUploadBreach: (breach) => {
			counters.recordBreach(breach);
			flush();
		},
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
