import { existsSync } from "node:fs";
import { AuthService, authDbPath } from "./service.ts";

/**
 * `mfw auth ...`: the owner's recovery path. It works on `$MFW_HOME/auth.db`
 * directly, so it needs no session and no server. That file is what limits it
 * to the owner: it is 0600 and `$MFW_HOME` is hidden inside the agent sandbox,
 * where this command finds no database and refuses. It never creates one.
 */

export const AUTH_USAGE = [
	"usage: mfw auth <command>",
	"",
	"  unlock        clear failed sign-in attempts for every address",
].join("\n");

export interface AuthCliDeps {
	home: string;
	out: (line: string) => void;
	err: (line: string) => void;
}

async function withStore(
	d: AuthCliDeps,
	run: (auth: AuthService) => Promise<number>,
): Promise<number> {
	const path = authDbPath(d.home);
	if (!existsSync(path)) {
		d.err(
			`mfw auth: no auth database at ${path}. Start the server once, and run this on the host, outside any agent sandbox.`,
		);
		return 1;
	}
	const auth = await AuthService.open(path);
	try {
		return await run(auth);
	} finally {
		auth.close();
	}
}

export async function runAuthCommand(
	args: readonly string[],
	d: AuthCliDeps,
): Promise<number> {
	switch (args[0]) {
		case "unlock":
			return withStore(d, async (auth) => {
				await auth.unlock();
				d.out("mfw auth: cleared all failed sign-in attempts.");
				return 0;
			});
		default:
			d.err(AUTH_USAGE);
			return 2;
	}
}
