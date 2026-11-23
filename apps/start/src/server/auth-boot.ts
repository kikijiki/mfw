import { definePlugin } from "nitro";
import { serverAuth } from "./auth-guard";

/**
 * Open the auth store with the server and, on a first run, print the one-time
 * setup token. Only its digest is stored, so it cannot be printed again: a
 * restart before setup replaces it, and once an owner exists none is issued.
 * A store that cannot open stops the server rather than serving unguarded.
 */
export async function announceFirstRun(
	auth: { beginFirstRun(): Promise<string | null> },
	print: (line: string) => void = console.log,
): Promise<void> {
	const token = await auth.beginFirstRun();
	if (!token) return;
	print(
		[
			"",
			"[mfw] FIRST RUN: open the web UI and enter this one-time setup token.",
			`[mfw] setup token: ${token}`,
			"[mfw] It expires in 1 hour and stops working once used. Restart the server for a new one.",
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
