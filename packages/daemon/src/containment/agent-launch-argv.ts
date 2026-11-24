/**
 * How a host-side driver or bridge starts its agent CLI. With a launch request
 * in the environment the CLI is never spawned directly: the launcher runs in
 * its place and starts it in the sandbox (`agent-launch.ts`).
 *
 * Bun is started with `--config=/dev/null --no-env-file` and outside the
 * workspace, because it otherwise loads `bunfig.toml` and `.env` from its
 * working directory, and the workspace is agent-written.
 *
 * Imported by the drivers and bridges: node builtins only.
 */

import { dirname } from "node:path";
import {
	AGENT_LAUNCHER,
	HOST_BUN_FLAGS,
	hostCommand,
	hostEntry,
} from "./host-script.ts";
import { hostSpawnEnv } from "./host-spawn-env.ts";

export { HOST_BUN_FLAGS };

export const AGENT_LAUNCH_ENV = "MFW_AGENT_LAUNCH_REQUEST";
/** Set beside the request: this process belongs to a host-bridged run. */
export const AGENT_BRIDGED_ENV = "MFW_AGENT_BRIDGED";

/** The launcher: a verified script, or in a compiled install `mfw __host agent-launcher`. */
const launcherCommand = () =>
	hostCommand(hostEntry(import.meta.url, AGENT_LAUNCHER), process.execPath);

type Env = Record<string, string | undefined>;

const MISSING_REQUEST =
	"refusing to start the agent: this host-bridged run has no launch request";

/** Never a direct host spawn for a run that belongs in the sandbox. */
function assertRequestPresent(env: Env): void {
	if (env[AGENT_BRIDGED_ENV] && !env[AGENT_LAUNCH_ENV]) {
		throw new Error(MISSING_REQUEST);
	}
}

/** For a driver, which knows from its run dir that it is host-bridged. */
export function refuseBridgedRunWithoutRequest(
	hostBridged: boolean,
	env: Env = process.env,
): void {
	if (!hostBridged || env[AGENT_LAUNCH_ENV]) return;
	process.stderr.write(`${MISSING_REQUEST}\n`);
	process.exit(78);
}

export function agentSpawnArgv(
	argv: readonly string[],
	env: Env = process.env,
): string[] {
	assertRequestPresent(env);
	const request = env[AGENT_LAUNCH_ENV];
	if (!request) return [...argv];
	return [...launcherCommand(), request, "--", ...argv];
}

/**
 * The environment for `agentSpawnArgv`'s command. With a launch request that
 * command is the launcher, `mfw` or bun, so only the allowlist reaches it
 * (`host-spawn-env.ts`); without one it is the agent CLI itself, started by a
 * driver whose own environment was already allowlisted.
 */
export function agentSpawnEnv(
	env: Env = process.env,
	extraNames: readonly string[] = [],
): Env {
	assertRequestPresent(env);
	return env[AGENT_LAUNCH_ENV] ? hostSpawnEnv(env, extraNames) : { ...env };
}

/** The launcher's working directory is the host-only one holding its request. */
export function agentSpawnCwd(
	cwd: string | undefined,
	env: Env = process.env,
): string | undefined {
	assertRequestPresent(env);
	const request = env[AGENT_LAUNCH_ENV];
	return request ? dirname(request) : cwd;
}
