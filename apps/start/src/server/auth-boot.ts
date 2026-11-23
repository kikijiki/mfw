import { definePlugin } from "nitro";
import { serverAuth } from "./auth-guard";
import { checkExposure, exposureWarnings, homeFor } from "./exposure";
import { startUnixListener } from "./unix-listener";

/**
 * Open the auth store with the server and, on a first run, issue the one-time
 * setup token. The token goes to a 0600 file under `$MFW_HOME` and only the
 * path is printed: logs are readable by more than the owner (agents can reach
 * the system journal on some hosts). A store that cannot open stops the server
 * rather than serving unguarded.
 */
export async function announceFirstRun(
	auth: {
		beginFirstRun(): Promise<string | null>;
		readonly setupTokenFile: string | null;
	},
	print: (line: string) => void = console.log,
): Promise<void> {
	const token = await auth.beginFirstRun();
	if (!token) return;
	print(
		[
			"",
			"[mfw] FIRST RUN: open the web UI and enter the one-time setup token.",
			`[mfw] It is in ${auth.setupTokenFile}, or run: mfw auth setup-token`,
			"[mfw] It expires in 1 hour and stops working once used.",
			"",
		].join("\n"),
	);
}

declare const __MFW_VITE_DEV_SERVER__: boolean | undefined;

/** Set at build time from Vite's command. Absent or false means enforce. */
const isViteDevServer = (): boolean =>
	typeof __MFW_VITE_DEV_SERVER__ !== "undefined" &&
	__MFW_VITE_DEV_SERVER__ === true;

/**
 * Stop before the listener opens if this configuration would expose the server
 * without TLS. Vite's dev server has its own bind, which `HOST` does not
 * describe; there the per-request peer checks still apply.
 */
export function enforceExposure(
	env: Record<string, string | undefined>,
	exit: (code: number) => void = (code) => process.exit(code),
	print: (line: string) => void = console.error,
): void {
	const refusal = checkExposure(env);
	if (!refusal) return;
	print(`[mfw] refusing to start: ${refusal}`);
	exit(1);
}

/** The private proxy socket. A failure stops the server: it was asked for. */
function listenOnSocket(nitro: unknown): void {
	const socket = process.env.MFW_LISTEN_SOCKET;
	if (!socket) return;
	const app = nitro as { fetch(req: Request): Response | Promise<Response> };
	void startUnixListener(socket, homeFor(process.env), (req) =>
		app.fetch(req),
	).catch((error) => {
		console.error(`[mfw] refusing to start: ${(error as Error).message}`);
		process.exit(1);
	});
}

export default definePlugin((nitro) => {
	if (!isViteDevServer()) {
		enforceExposure(process.env);
		for (const warning of exposureWarnings(process.env))
			console.warn(`\n[mfw] WARNING: ${warning}\n`);
		listenOnSocket(nitro);
	}
	void serverAuth()
		.then((auth) => announceFirstRun(auth))
		.catch((error) => {
			console.error("[mfw] auth store failed to open:", error);
			process.exit(1);
		});
});
