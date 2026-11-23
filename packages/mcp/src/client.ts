import { readFile } from "node:fs/promises";
import type { AppRouter } from "@mfw/api";
import { createTRPCClient, httpBatchStreamLink, httpLink } from "@trpc/client";
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

/** The brain socket serves tRPC at this path (the daemon's `BRAIN_SOCKET_ENDPOINT`). */
const SOCKET_URL = "http://mfw-brain/trpc";

/**
 * The daemon refused the call outright (a bad, revoked or mismatched token, or a
 * procedure the brain may not use). Not a transient failure: never retried.
 */
export class BrainSocketRefused extends Error {
	override readonly name = "BrainSocketRefused";
	constructor(
		message: string,
		readonly status: number,
	) {
		super(`the mfw daemon refused this brain call (${status}): ${message}`);
	}
}

export interface BrainSocketEnv {
	socketPath: string;
	tokenFile: string;
	turnRunId: string;
}

/**
 * tRPC client for a brain turn over the daemon's unix socket. The bearer
 * token is read from its 0600 file on every call (the daemon deletes the file
 * when the turn ends), and the turn id rides along as `x-mfw-brain-turn`,
 * which the daemon checks against the token.
 */
export function makeBrainSocketClient(env: BrainSocketEnv) {
	return createTRPCClient<AppRouter>({
		links: [
			// One call per request: the socket refuses batches.
			httpLink({
				transformer: SuperJSON,
				url: SOCKET_URL,
				fetch: async (input, init) => {
					const token = (
						await readFile(env.tokenFile, "utf8").catch(
							(e: NodeJS.ErrnoException) => {
								// The daemon deletes the file when the turn ends.
								if (e.code === "ENOENT")
									throw new BrainSocketRefused(
										"this turn's token is gone: the turn has ended",
										401,
									);
								throw e;
							},
						)
					).trim();
					const headers = new Headers(init?.headers);
					headers.set("authorization", `Bearer ${token}`);
					if (env.turnRunId) headers.set("x-mfw-brain-turn", env.turnRunId);
					const res = await fetch(
						input as string | URL | Request,
						{
							...init,
							headers,
							unix: env.socketPath,
						} as unknown as RequestInit,
					);
					if (res.status === 401 || res.status === 403 || res.status === 400) {
						const body = (await res
							.clone()
							.json()
							.catch(() => null)) as {
							error?: string | { json?: { message?: string } };
						} | null;
						// The socket's own refusals carry a string. A tRPC 400 is an
						// ordinary tool error and goes back to the brain as one.
						if (typeof body?.error === "string" || res.status !== 400)
							throw new BrainSocketRefused(
								typeof body?.error === "string"
									? body.error
									: (body?.error?.json?.message ?? `HTTP ${res.status}`),
								res.status,
							);
					}
					// Bun's Response is a real one; tRPC's FetchEsque typing is narrower.
					return res as never;
				},
			}),
		],
	});
}

/**
 * The client a brain turn uses: always the socket the daemon gave it
 * (`MFW_SOCKET`, `MFW_BRAIN_TOKEN_FILE`). There is no TCP path.
 */
export function makeBrainClient(
	env: NodeJS.ProcessEnv = process.env,
): MfwClient {
	const socketPath = env.MFW_SOCKET;
	if (!socketPath)
		throw new Error("a brain turn needs MFW_SOCKET; it has no TCP path");
	const tokenFile = env.MFW_BRAIN_TOKEN_FILE;
	if (!tokenFile)
		throw new Error("MFW_SOCKET is set but MFW_BRAIN_TOKEN_FILE is not");
	return makeBrainSocketClient({
		socketPath,
		tokenFile,
		turnRunId: env.MFW_BRAIN_TURN ?? "",
	});
}
