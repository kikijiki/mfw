import { resolve } from "node:path";
import { boot } from "@mfw/daemon/boot";
import {
	mfwHome as configuredMfwHome,
	loadConfig,
	toBootProjects,
} from "@mfw/daemon/config";
import type { Orchestrator } from "@mfw/daemon/services";

/**
 * The orchestrator singleton: constructed ONCE per server process, eagerly at
 * startup (see server/boot.ts), never per request.
 *
 * It lives on `globalThis` because the production bundle emits this file into
 * two chunks (one reached by the nitro startup plugin, one by the tRPC route
 * handler); a module-scoped `let` would give each its own instance and boot a
 * second orchestrator, duplicating supervisors, schedulers and audit events.
 */

const KEY = Symbol.for("mfw.orchestrator");

type Holder = { [KEY]?: Promise<Orchestrator> };

export function getOrchestrator(): Promise<Orchestrator> {
	const holder = globalThis as unknown as Holder;
	holder[KEY] ??= (async () => {
		const mfwHome = resolve(configuredMfwHome());
		const cfg = await loadConfig(mfwHome);
		return boot({
			mfwHome,
			projects: toBootProjects(cfg),
			supervisorIntervalMs: cfg.supervisorIntervalMs,
			schedulerIntervalMs: cfg.schedulerIntervalMs,
			// The master stop survives a restart.
			dispatchPaused: cfg.dispatchPaused,
			runpod: cfg.runpod,
		});
	})();
	return holder[KEY] as Promise<Orchestrator>;
}

/** The booted orchestrator, if one exists yet (for shutdown hooks). */
export function bootedOrchestrator(): Promise<Orchestrator> | null {
	return (globalThis as unknown as Holder)[KEY] ?? null;
}
