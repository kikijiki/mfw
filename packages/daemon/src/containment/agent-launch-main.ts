/**
 * The launcher process: `agent-launch-main.ts <request> -- <agent argv...>`.
 *
 * Runs on the host in place of the agent CLI, so a driver or bridge keeps
 * speaking to it over plain pipes. Always uses the live host and the real
 * probe, gate and launcher.
 */

import { realLaunchSteps } from "./agent-launch.ts";
import { liveCompileHost } from "./agent-launch-host.ts";
import { runLauncher } from "./agent-launch-run.ts";

await runLauncher(process.argv.slice(2), {
	...realLaunchSteps,
	compileHost: liveCompileHost,
});
