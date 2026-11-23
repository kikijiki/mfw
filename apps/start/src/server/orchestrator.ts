import { resolve } from "node:path";
import { appRouter } from "@mfw/api";
import type { Principal } from "@mfw/daemon/auth/service";
import { boot } from "@mfw/daemon/boot";
import {
	BRAIN_SOCKET_ENDPOINT,
	BRAIN_TURN_HEADER,
	brainSocketFor,
} from "@mfw/daemon/brain-runtime/brain-socket";
import {
	mfwHome as configuredMfwHome,
	loadConfig,
	toBootProjects,
} from "@mfw/daemon/config";
import type { Orchestrator } from "@mfw/daemon/services";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

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

function brainPrincipal(runId: string | null): Principal | null {
	return runId ? { kind: "brain", id: `brain:${runId}`, runId } : null;
}

export function getOrchestrator(): Promise<Orchestrator> {
	const holder = globalThis as unknown as Holder;
	holder[KEY] ??= (async () => {
		const mfwHome = resolve(configuredMfwHome());
		const cfg = await loadConfig(mfwHome);
		// The brain's unix socket serves the same router; the socket checks the
		// per-turn token and only lets the brain's own procedures through.
		brainSocketFor(mfwHome).setHandler((req) =>
			fetchRequestHandler({
				endpoint: BRAIN_SOCKET_ENDPOINT,
				router: appRouter,
				req,
				createContext: async () => ({
					orchestrator: await getOrchestrator(),
					// The socket verified the turn token and set this header from it.
					principal: brainPrincipal(req.headers.get(BRAIN_TURN_HEADER)),
				}),
				onError({ error, path }) {
					console.error(
						`[mfw] brain socket error on '${path}':`,
						error.message,
					);
				},
			}),
		);
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
