/**
 * Where per-run unix sockets live on the host (egress proxy, brain turns).
 *
 * `sun_path` holds 107 bytes, and `$MFW_HOME` is the owner's: a long home
 * directory, a long user name or a deep workspace would push a socket under it
 * past the limit and break every sandboxed run with network. So sockets never
 * live under `$MFW_HOME`. They live in a short, private, per-uid directory:
 *
 *   `$MFW_SOCKET_DIR`, else `$XDG_RUNTIME_DIR/mfw`, else `<tmpdir>/mfw-<uid>`
 *     `/<8 hex of this home>/`     one directory per `$MFW_HOME`
 *       `s/<12 hex>/e.sock`        egress, one directory per run
 *       `b/<12 hex>/brain.sock`    brain turns, one directory per turn
 *
 * Inside the sandbox the run's directory is bound at a fixed short path
 * (`SANDBOX_PATHS`), so the host path never reaches the agent. Every directory
 * is ours, a real directory and mode 0700, or the launch is refused: a shared
 * `/tmp` is the reason for those checks, since another user may have planted
 * the name first.
 */

import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** `sun_path` is 108 bytes including the NUL. */
export const UNIX_PATH_MAX = 107;

/**
 * The longest name below the per-home directory:
 * `/b/<12 hex>/brain.sock` (egress `/s/<12 hex>/e.sock` is shorter). A base is
 * usable when `<base>/<8 hex>` plus this fits.
 */
const BELOW_ROOT = "/b/".length + 12 + "/brain.sock".length;
const HOME_DIR_CHARS = 8;

export class SocketPathError extends Error {
	readonly fix: string;
	constructor(message: string, fix: string) {
		super(`${message}. ${fix}`);
		this.name = "SocketPathError";
		this.fix = fix;
	}
}

export interface SocketRootEnv {
	MFW_SOCKET_DIR?: string | undefined;
	XDG_RUNTIME_DIR?: string | undefined;
}

export interface SocketRootOptions {
	env?: SocketRootEnv;
	uid?: number;
	/** The system temp directory. Defaults to `os.tmpdir()`. */
	tmp?: string;
}

const FIX =
	"set MFW_SOCKET_DIR to a short absolute directory you own (for example /tmp/mfw-sock)";

const isAbsolute = (p: string | undefined): p is string =>
	typeof p === "string" && p.startsWith("/");

/** Does a socket directly under `<root>/<8 hex>` fit, in bytes? */
const fits = (base: string): boolean =>
	Buffer.byteLength(base) + 1 + HOME_DIR_CHARS + BELOW_ROOT <= UNIX_PATH_MAX;

/**
 * The base directory for this host and user. An explicit `MFW_SOCKET_DIR`
 * is used as given (and refused later if too long); otherwise the first
 * candidate that leaves room for the longest socket name wins, so a long
 * `$TMPDIR` falls back to `/tmp` rather than failing.
 */
export function socketBase(options: SocketRootOptions = {}): string {
	const env = options.env ?? process.env;
	const explicit = env.MFW_SOCKET_DIR;
	if (explicit !== undefined && explicit !== "") {
		if (!isAbsolute(explicit)) {
			throw new SocketPathError(
				`MFW_SOCKET_DIR is not an absolute path: ${explicit}`,
				FIX,
			);
		}
		return resolve(explicit);
	}
	const uid = options.uid ?? process.getuid?.() ?? 0;
	const candidates = [
		isAbsolute(env.XDG_RUNTIME_DIR)
			? join(env.XDG_RUNTIME_DIR, "mfw")
			: undefined,
		join(options.tmp ?? tmpdir(), `mfw-${uid}`),
		`/tmp/mfw-${uid}`,
	].filter((c): c is string => c !== undefined);
	const chosen = candidates.find(fits);
	if (chosen) return chosen;
	throw new SocketPathError(
		`no short socket directory is available (tried ${candidates.join(", ")})`,
		FIX,
	);
}

/** The per-home socket directory. A pure computation: nothing is created. */
export function socketRoot(
	mfwHome: string,
	options: SocketRootOptions = {},
): string {
	const id = createHash("sha256")
		.update(resolve(mfwHome))
		.digest("hex")
		.slice(0, HOME_DIR_CHARS);
	return join(socketBase(options), id);
}

/** Refuse a socket path `bind(2)` would reject, with the fix. */
export function assertSocketPathFits(path: string, what = "socket"): void {
	const bytes = Buffer.byteLength(path);
	if (bytes > UNIX_PATH_MAX) {
		throw new SocketPathError(
			`the ${what} path is ${bytes} bytes, over the ${UNIX_PATH_MAX} a unix socket allows: ${path}`,
			FIX,
		);
	}
}

/** A real directory of ours, mode 0700. Refuses a planted link or a shared directory. */
export function ensurePrivateDir(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const st = lstatSync(path);
	if (
		!st.isDirectory() ||
		st.uid !== process.getuid?.() ||
		(st.mode & 0o077) !== 0
	) {
		throw new Error(`socket directory ${path} is not private to this user`);
	}
}

/**
 * Create the per-home socket directory (and its base) and check each level.
 * The base is made one level at a time so a shared parent such as `/tmp` is
 * never made private by accident and a planted name is caught.
 */
export function ensureSocketRoot(
	mfwHome: string,
	options: SocketRootOptions = {},
): string {
	const base = socketBase(options);
	const root = socketRoot(mfwHome, options);
	assertSocketPathFits(join(root, "b", "0".repeat(12), "brain.sock"), "socket");
	const parent = resolve(base, "..");
	mkdirSync(parent, { recursive: true });
	for (const dir of [base, root]) {
		try {
			mkdirSync(dir, { mode: 0o700 });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
		ensurePrivateDir(dir);
	}
	chmodSync(root, 0o700);
	return root;
}
