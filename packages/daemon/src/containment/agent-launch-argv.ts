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

/** The flags for any bun process the host starts on behalf of a sandboxed run. */
export const HOST_BUN_FLAGS = ["--config=/dev/null", "--no-env-file"] as const;

const LAUNCHER = join(import.meta.dir, "agent-launch-main.ts");

type Env = Record<string, string | undefined>;

export function agentSpawnArgv(
	argv: readonly string[],
	env: Env = process.env,
): string[] {
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
	const request = env[AGENT_LAUNCH_ENV];
	return request ? dirname(request) : cwd;
}
