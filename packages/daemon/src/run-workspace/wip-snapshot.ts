/**
 * The end-of-run snapshot: the WIP helper alone, in a fresh sandbox, once every
 * process of the run is dead. It goes through the same launcher, probe and gate
 * as the agent. The host never fetches from the clone path, because a tampered
 * gitdir can redirect that read to other host repositories.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentLaunchRequest } from "../containment/agent-launch.ts";
import {
	AGENT_LAUNCH_ENV,
	agentSpawnArgv,
} from "../containment/agent-launch-argv.ts";
import type { FinalSnapshot } from "./clone-impl.ts";

const REQUEST_FILE = "wip-launch.json";
/** The launcher's exit code for a launch it refused. */
const LAUNCH_REFUSED = 78;
/** The probe items that fail on the clone's content rather than on the host. */
const AGENT_CAUSED_REFUSAL =
	/probe_failed: the sandbox probe failed: .*\b(?:exec_sweep|socket_sweep)\b/;
/** Past the helper's own per-command limit, so it reports first when it can. */
const DEFAULT_TIMEOUT_MS = 180_000;

/** Kept in the host-only run root, because the control root does not survive a reboot. */
export function wipLaunchRequestPath(runDir: string): string {
	return join(runDir, REQUEST_FILE);
}

/** The agent's request with everything but the clone taken out. */
export function wipSnapshotRequest(
	req: AgentLaunchRequest,
): AgentLaunchRequest {
	const { egressSocketDir: _egress, ...rest } = req;
	return { ...rest, env: {}, secretNames: [], purpose: "wip-snapshot" };
}

export function writeWipLaunchRequest(req: AgentLaunchRequest): void {
	writeFileSync(
		wipLaunchRequestPath(req.runDir),
		JSON.stringify(wipSnapshotRequest(req)),
		{ mode: 0o600 },
	);
}

export interface SandboxSnapshotOptions {
	runDirOf: (runId: string) => string;
	timeoutMs?: number;
	/** The launcher command for a request. Default: the real launcher. */
	launcher?: (requestPath: string) => {
		argv: string[];
		env: Record<string, string | undefined>;
	};
}

export function sandboxFinalSnapshot(
	opts: SandboxSnapshotOptions,
): FinalSnapshot {
	return {
		available: (runId) =>
			existsSync(wipLaunchRequestPath(opts.runDirOf(runId))),
		run: async (runId) => {
			const runDir = opts.runDirOf(runId);
			const requestPath = wipLaunchRequestPath(runDir);
			const { argv, env } = opts.launcher?.(requestPath) ?? {
				argv: agentSpawnArgv(["bun"], {
					[AGENT_LAUNCH_ENV]: requestPath,
				}),
				env: process.env,
			};
			const proc = Bun.spawn(argv, {
				cwd: runDir,
				env,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "pipe",
			});
			// Drained so the launcher never blocks; only the tail is kept.
			let tail = "";
			const drained = (async () => {
				const decoder = new TextDecoder();
				for await (const chunk of proc.stderr) {
					tail = (tail + decoder.decode(chunk, { stream: true })).slice(-600);
				}
			})().catch(() => {});
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				// The sandbox dies with its launcher.
				proc.kill("SIGKILL");
			}, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
			const code = await proc.exited;
			clearTimeout(timer);
			await Promise.race([drained, Bun.sleep(1_000)]);
			if (timedOut) return "failed";
			if (code === LAUNCH_REFUSED) {
				// What the agent left in its clone: a retry would see the same.
				if (AGENT_CAUSED_REFUSAL.test(tail)) return "refused";
				// A refusal is the launcher's own line: the sandbox never started.
				throw new Error(
					`the snapshot sandbox for run ${runId} was refused: ${tail.trim()}`,
				);
			}
			return code === 0 ? "ok" : "failed";
		},
	};
}
