/**
 * The per-run egress lifecycle (design "Egress"): one proxy process and one
 * socket directory per sandboxed run.
 *
 * The proxy is a host-side child of the run's `run.sh`, so it lives in the
 * run's tmux session and survives a daemon restart exactly as the run does. It
 * holds the read end of a pipe from `run.sh` and exits when that closes, which
 * happens however the script ends, SIGKILL included.
 *
 * Three locations, none readable from another run's sandbox:
 *
 * - `$MFW_HOME/run/s/<hash>/e.sock`: the socket directory, the only part bound
 *   into the sandbox (read-only, pinned). It holds nothing else;
 * - `<runDir>/egress/`: config and counters, in the host-only run root;
 * - `$MFW_HOME/run/e/<hash>.json`: the index recovery uses to find a proxy whose
 *   run is gone.
 */

import { createHash } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { egressSocketPath } from "./egress-proxy.ts";

export const EGRESS_SOCKET_NAME = "e.sock";

/** Distinct denied hosts kept per run; the agent chooses these names. */
export const MAX_DENIED_HOSTS = 64;

const AllowEntrySchema = z.strictObject({
	host: z.string().min(1).max(253),
	port: z.number().int().min(1).max(65535),
});

export const RunEgressConfigSchema = z.strictObject({
	version: z.literal(1),
	runId: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
	socketPath: z.string().startsWith("/"),
	statsPath: z.string().startsWith("/"),
	indexPath: z.string().startsWith("/"),
	allow: z.array(AllowEntrySchema).max(256),
});

export type RunEgressConfig = z.infer<typeof RunEgressConfigSchema>;

const IndexSchema = z.strictObject({
	runId: z.string(),
	socketDir: z.string().startsWith("/"),
	pid: z.number().int().positive().optional(),
	startTicks: z.string().optional(),
});

export interface RunEgressPaths {
	socketDir: string;
	socketPath: string;
	stateDir: string;
	configPath: string;
	statsPath: string;
	indexPath: string;
}

const shortId = (runId: string): string =>
	createHash("sha256").update(runId).digest("hex").slice(0, 12);

const indexRoot = (mfwHome: string): string => join(mfwHome, "run", "e");

export function runEgressPaths(
	mfwHome: string,
	runDir: string,
	runId: string,
): RunEgressPaths {
	const socketPath = egressSocketPath(mfwHome, runId);
	const stateDir = join(runDir, "egress");
	return {
		socketDir: dirname(socketPath),
		socketPath,
		stateDir,
		configPath: join(stateDir, "config.json"),
		statsPath: join(stateDir, "stats.json"),
		indexPath: join(indexRoot(mfwHome), `${shortId(runId)}.json`),
	};
}

/** A real directory of ours, mode 0700. Refuses a planted link or a shared directory. */
function ensurePrivateDir(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const st = lstatSync(path);
	if (
		!st.isDirectory() ||
		st.uid !== process.getuid?.() ||
		(st.mode & 0o077) !== 0
	) {
		throw new Error(`egress directory ${path} is not private to this user`);
	}
}

/**
 * Create the run's directories and proxy config, replacing what an earlier
 * launch of the same run left. Counters are kept, so a relaunch adds to them.
 */
export function prepareRunEgress(input: {
	mfwHome: string;
	runDir: string;
	runId: string;
	allow: readonly { host: string; port: number }[];
}): RunEgressPaths {
	const paths = runEgressPaths(input.mfwHome, input.runDir, input.runId);
	for (const dir of [dirname(paths.socketDir), indexRoot(input.mfwHome)]) {
		ensurePrivateDir(dir);
	}
	rmSync(paths.socketDir, { recursive: true, force: true });
	ensurePrivateDir(paths.socketDir);
	ensurePrivateDir(paths.stateDir);
	const config: RunEgressConfig = {
		version: 1,
		runId: input.runId,
		socketPath: paths.socketPath,
		statsPath: paths.statsPath,
		indexPath: paths.indexPath,
		allow: input.allow.map((a) => ({ host: a.host, port: a.port })),
	};
	writePrivate(paths.configPath, JSON.stringify(config));
	writePrivate(
		paths.indexPath,
		JSON.stringify({ runId: input.runId, socketDir: paths.socketDir }),
	);
	return paths;
}

function writePrivate(path: string, content: string): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, content, { mode: 0o600, flag: "w" });
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
}

/** Field 22 of `/proc/<pid>/stat`: with the pid, it identifies one process. */
export function processStartTicks(pid: number): string | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "latin1");
		// The command name may hold spaces and parentheses; fields resume after the last `)`.
		const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return rest[19] ?? null;
	} catch {
		return null;
	}
}

/** Called by the proxy once it listens, so recovery can identify it. */
export function recordProxyProcess(config: RunEgressConfig): void {
	const startTicks = processStartTicks(process.pid);
	if (!startTicks) return;
	writePrivate(
		config.indexPath,
		JSON.stringify({
			runId: config.runId,
			socketDir: dirname(config.socketPath),
			pid: process.pid,
			startTicks,
		}),
	);
}

/** The proxy's own cleanup on a normal exit. */
export function removeRunEgressEndpoints(config: RunEgressConfig): void {
	rmSync(dirname(config.socketPath), { recursive: true, force: true });
	rmSync(config.indexPath, { force: true });
}

export interface EgressSweepReport {
	killed: number;
	removed: number;
	kept: number;
}

/** A launch writes its index entry just before its tmux session exists. */
export const EGRESS_SWEEP_GRACE_MS = 60_000;

/**
 * Remove what a dead run left: kill its proxy and delete its socket directory.
 * `isLive` answers null when it cannot tell, and such a run is kept: losing a
 * live run's network is worse than a leftover until the next sweep. A pid is
 * signalled only if its start time still matches, so a reused pid is never
 * killed. An unreadable index entry is removed with nothing signalled.
 */
export async function sweepRunEgress(
	mfwHome: string,
	isLive: (runId: string) => Promise<boolean | null>,
	opts: { graceMs?: number; now?: number } = {},
): Promise<EgressSweepReport> {
	const graceMs = opts.graceMs ?? EGRESS_SWEEP_GRACE_MS;
	const now = opts.now ?? Date.now();
	const report: EgressSweepReport = { killed: 0, removed: 0, kept: 0 };
	const root = indexRoot(mfwHome);
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return report;
	}
	const socketsRoot = join(mfwHome, "run", "s");
	for (const name of names) {
		if (!/^[0-9a-f]{12}\.json$/.test(name)) continue;
		const path = join(root, name);
		let entry: z.infer<typeof IndexSchema> | null = null;
		try {
			entry = IndexSchema.parse(JSON.parse(readFileSync(path, "utf8")));
		} catch {
			// Written atomically, so this is damage. Its socket dir has the same hash.
		}
		let young = false;
		try {
			young = graceMs > 0 && now - lstatSync(path).mtimeMs < graceMs;
		} catch {
			continue; // Its proxy removed it just now.
		}
		if (young || (entry && (await isLive(entry.runId)) !== false)) {
			report.kept++;
			continue;
		}
		if (entry?.pid && entry.startTicks) {
			if (processStartTicks(entry.pid) === entry.startTicks) {
				try {
					process.kill(entry.pid, "SIGKILL");
					report.killed++;
				} catch {
					// Already gone.
				}
			}
		}
		// Derived from the index file's name, never from its contents.
		rmSync(join(socketsRoot, name.slice(0, 12)), {
			recursive: true,
			force: true,
		});
		rmSync(path, { force: true });
		report.removed++;
	}
	return report;
}
