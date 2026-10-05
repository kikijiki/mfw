import { definePlugin } from "nitro";
import { getOrchestrator } from "./orchestrator";

interface NitroLifecycle {
	hooks: {
		hook(name: "close", handler: () => Promise<void>): void;
	};
}

/**
 * Boot the orchestrator with the server process (not on first request) so
 * supervisor passes and run reconciliation resume after a reboot. Shutdown
 * detaches from tmux runs rather than killing them; the next boot adopts them.
 *
 * `MFW_DISABLE_ORCHESTRATOR=1` serves the UI without attaching anything. It is
 * not a safety mechanism (the per-project `daemon.lock` prevents two
 * orchestrators); it just gives a quiet dev server where the daemon already runs.
 *
 * `vite dev` needs two things production does not:
 *   1. `bun --bun x vite dev`, not `bunx vite dev`: the latter runs SSR under
 *      NODE where `Bun.spawn` is missing, so `runProc` returns 127 and every git
 *      call fails (see `assertGitRepo`).
 *   2. `MFW_BASE_PATH=/`: at `/mfw/`, nitro 3.0.1-alpha's dev server 404s any URL
 *      with a literal `.` and its 404 handler redirects in a loop. tRPC batches
 *      procedure names into the path (`system.projects,files.listDir`), so every
 *      query loops. Upstream, dev-only.
 */
function failServerStartup(error: unknown): never {
	console.error("[mfw] orchestrator boot failed:", error);
	process.exit(1);
}

export function installOrchestrator(
	nitro: NitroLifecycle,
	get = getOrchestrator,
	fail = failServerStartup,
): void {
	if (process.env.MFW_DISABLE_ORCHESTRATOR === "1") {
		console.warn(
			"[mfw] MFW_DISABLE_ORCHESTRATOR=1: serving the UI with no projects attached",
		);
		return;
	}
	// Nitro 3.0.1-alpha only catches synchronous plugin throws; exit on boot
	// rejection, or its error handler serves a permanent 500-only listener.
	const booted = get();
	void booted.catch(fail);

	nitro.hooks.hook("close", async () => {
		await (await booted).shutdown();
	});
}

export default definePlugin(installOrchestrator);
