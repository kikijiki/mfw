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
	RunEgressConfigSchema,
	recordProxyProcess,
	removeRunEgressEndpoints,
} from "./egress-run.ts";

/** A hung close must not hold up the run's exit record. */
const SHUTDOWN_DEADLINE_MS = 2_000;

/** Its own process, so the cap protects this process's descriptors. */
const MAX_CONNECTIONS = 64;

async function main(): Promise<void> {
	const path = process.argv[2];
	if (!path) throw new Error("usage: egress-proxy-main <config.json>");
	const config = RunEgressConfigSchema.parse(
		JSON.parse(readFileSync(path, "utf8")),
	);
	const proxy = await startEgressProxy({
		runId: config.runId,
		socketPath: config.socketPath,
		allow: config.allow,
		gate: createConnectionGate(MAX_CONNECTIONS),
	});
	recordProxyProcess(config);

	let stopping = false;
	const stop = (): void => {
		if (stopping) return;
		stopping = true;
		setTimeout(() => {
			removeRunEgressEndpoints(config);
			process.exit(0);
		}, SHUTDOWN_DEADLINE_MS).unref();
		void proxy.close().finally(() => {
			removeRunEgressEndpoints(config);
			process.exit(0);
		});
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
