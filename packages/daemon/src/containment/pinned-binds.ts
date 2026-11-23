/**
 * Launch-time pinning of bind sources.
 *
 * The compiler checks each source's real path, but anything that can rename
 * inside the source's parent could swap it for a symlink before bwrap follows
 * it. Each source is therefore opened once, without following a final symlink,
 * and the open descriptor is what bwrap mounts (`--bind-fd`, `--ro-bind-fd`).
 *
 * `O_NOFOLLOW` covers only the last component, so the descriptor's own path is
 * read back and must equal the declared one. That catches a swapped parent.
 */

import { closeSync, constants, openSync, readlinkSync } from "node:fs";

/** Linux `O_PATH`; node does not export it. */
const O_PATH = 0o10000000;
const O_CLOEXEC = 0o2000000;

export const PIN_OPEN_FLAGS =
	O_PATH | O_CLOEXEC | constants.O_NOFOLLOW | constants.O_DIRECTORY;

/** One bind the launcher must pass to bwrap on an exact child descriptor. */
export interface PinnedBind {
	/** The descriptor number the child must receive this source on. */
	fd: number;
	/** The declared real path on the host. */
	source: string;
	/** The mount point inside the sandbox. */
	dest: string;
	writable: boolean;
	label: string;
}

export class PinnedBindError extends Error {
	readonly label: string;
	constructor(label: string, detail: string) {
		super(`cannot pin ${label}: ${detail}`);
		this.name = "PinnedBindError";
		this.label = label;
	}
}

export interface OpenPins {
	/** Parent descriptors, in the same order as the binds. */
	parentFds: number[];
	close(): void;
	/**
	 * Forget the descriptors without closing them, because something else now
	 * owns them. `Bun.spawnSync` closes numeric stdio entries in the parent
	 * (`Bun.spawn` does not), and a second close could hit a reused number.
	 */
	release(): void;
}

/**
 * Open and verify every source, or throw with nothing left open. The caller
 * must keep the result open until the child has been spawned.
 */
export function openPinnedBinds(binds: readonly PinnedBind[]): OpenPins {
	const parentFds: number[] = [];
	const close = () => {
		for (const fd of parentFds.splice(0)) closeSync(fd);
	};
	try {
		for (const bind of binds) {
			let fd: number;
			try {
				fd = openSync(bind.source, PIN_OPEN_FLAGS);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code ?? "open failed";
				throw new PinnedBindError(
					bind.label,
					`${bind.source} is not a real directory (${code})`,
				);
			}
			parentFds.push(fd);
			const actual = readlinkSync(`/proc/self/fd/${fd}`);
			if (actual !== bind.source) {
				throw new PinnedBindError(
					bind.label,
					`${bind.source} resolved to ${actual}`,
				);
			}
		}
	} catch (err) {
		close();
		throw err;
	}
	return {
		parentFds,
		close,
		release: () => {
			parentFds.length = 0;
		},
	};
}
