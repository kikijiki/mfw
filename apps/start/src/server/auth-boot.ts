import { definePlugin } from "nitro";
import { serverAuth } from "./auth-guard";

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

export default definePlugin(() => {
	void serverAuth()
		.then((auth) => announceFirstRun(auth))
		.catch((error) => {
			console.error("[mfw] auth store failed to open:", error);
			process.exit(1);
		});
});
