import type { AppRouter } from "@mfw/api";
import { createTRPCClient, httpBatchStreamLink } from "@trpc/client";
import SuperJSON from "superjson";

/**
 * tRPC client to the *running* mfw app (default :7777). The MCP server is a thin
 * bridge, all task state goes through the app's API, so there is no second
 * source of truth. Override the URL with MFW_URL.
 *
 * The `/mfw` prefix is the app's default mount (Vite `base`, see
 * `apps/start/vite.config.ts`). This package runs outside that build and cannot
 * read `import.meta.env.BASE_URL`, so it repeats the default; a build with a
 * different `MFW_BASE_PATH` needs MFW_URL set to match.
 */
export function makeClient(
	url = process.env.MFW_URL ?? "http://localhost:7777/mfw/api/trpc",
) {
	return createTRPCClient<AppRouter>({
		links: [httpBatchStreamLink({ transformer: SuperJSON, url })],
	});
}

export type MfwClient = ReturnType<typeof makeClient>;
