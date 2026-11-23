import { definePlugin } from "nitro";
import { serverAuth } from "./auth-guard";
import { checkExposure } from "./exposure";

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

export default definePlugin(() => {
	if (!import.meta.env?.DEV) enforceExposure(process.env);
	void serverAuth()
		.then((auth) => announceFirstRun(auth))
		.catch((error) => {
			console.error("[mfw] auth store failed to open:", error);
			process.exit(1);
		});
});
