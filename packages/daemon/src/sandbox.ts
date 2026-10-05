import { homedir } from "node:os";
import { runProc } from "./proc.ts";

/**
 * Agent filesystem isolation (MFW-33 item 3; MFW-117 §3.5's residual risk).
 *
 * The agent runs as the same uid as the daemon, so this does not stop a
 * deliberate escape. It closes the casual/confused path: a prompt-injected
 * agent reading or editing `~/.local/share/mfw` (arming store, credentials,
 * config). bwrap masks that path so it does not exist inside the sandbox.
 *
 * Only the filesystem view changes. Network stays shared and `$HOME` stays
 * writable, except the hidden paths, masked with an empty tmpfs layered inside
 * the `$HOME` bind.
 */

export interface BwrapIsolation {
	mode: "bwrap";
	/** Absolute paths masked with an empty tmpfs. Applied after every writable
	 *  bind so a path nested under one (e.g. under `$HOME`) still overlays it. */
	hidePaths: string[];
}

let cachedAvailable: boolean | null = null;

/** Cached for the process lifetime; checked on every launch. */
export async function bwrapAvailable(): Promise<boolean> {
	if (cachedAvailable !== null) return cachedAvailable;
	try {
		const r = await runProc(["sh", "-c", "command -v bwrap"], {
			timeoutMs: 5_000,
		});
		cachedAvailable = r.exitCode === 0;
	} catch {
		cachedAvailable = false;
	}
	return cachedAvailable;
}

/** Test seam: clears the `bwrapAvailable` memo. */
export function resetBwrapAvailableCache(): void {
	cachedAvailable = null;
}

/** POSIX single-quote, mirrors `agent-host.ts`'s `q`. */
function q(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Wrap a shell command in `bwrap`: host filesystem read-only, `$HOME`
 * re-bound read-write, `isolation.hidePaths` masked with an empty tmpfs.
 * `--die-with-parent` ties the sandbox to `run.sh` so a killed run leaks no
 * `bwrap` process. Network is shared.
 */
export function wrapWithBwrap(
	cmd: string,
	cwd: string,
	runDir: string,
	isolation: BwrapIsolation,
): string {
	const home = homedir();
	// `/tmp` stays writable: build tools and test runners use it as scratch.
	const writable = [...new Set([home, "/tmp", cwd, runDir])];
	const tokens: string[] = [
		"bwrap",
		"--die-with-parent",
		"--ro-bind",
		"/",
		"/",
		"--dev",
		"/dev",
		"--proc",
		"/proc",
	];
	for (const p of writable) tokens.push("--bind", q(p), q(p));
	// After every writable bind, so a hidden path under `$HOME` overlays it.
	for (const p of isolation.hidePaths) tokens.push("--tmpfs", q(p));
	tokens.push("--", "sh", "-c", q(cmd));
	return tokens.join(" ");
}
