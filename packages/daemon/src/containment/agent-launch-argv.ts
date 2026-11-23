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

import { dirname, join } from "node:path";

export const AGENT_LAUNCH_ENV = "MFW_AGENT_LAUNCH_REQUEST";
/** Set beside the request: this process belongs to a host-bridged run. */
export const AGENT_BRIDGED_ENV = "MFW_AGENT_BRIDGED";

/** The flags for any bun process the host starts on behalf of a sandboxed run. */
export const HOST_BUN_FLAGS = ["--config=/dev/null", "--no-env-file"] as const;

const LAUNCHER = join(import.meta.dir, "agent-launch-main.ts");

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
	return [
		process.execPath,
		...HOST_BUN_FLAGS,
		"run",
		LAUNCHER,
		request,
		"--",
		...argv,
	];
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
