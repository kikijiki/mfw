import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { runProc } from "../proc.ts";
import { pinnedTool } from "../sandbox.ts";
import {
	assertSocketPathFits,
	SocketPathError,
	type SocketRootEnv,
	socketBase,
	socketRoot,
} from "./socket-root.ts";

/**
 * What a sandboxed launch needs from the host, checked without changing it.
 * The doctor and the launch path both call this, so the doctor cannot say OK
 * about something a launch then refuses.
 */

export interface PreflightStat {
	kind: "file" | "dir" | "other";
	mode: number;
	uid: number;
}

export interface LaunchPreflightIo {
	home: string;
	uid: number;
	env: SocketRootEnv;
	/** Does not follow a final symlink; null when absent. */
	lstat(path: string): Promise<PreflightStat | null>;
	/** A trusted binary, or null. */
	tool(name: string): Promise<string | null>;
	run(
		argv: string[],
	): Promise<{ code: number | null; stdout: string } | undefined>;
}

export interface LaunchPreflightItem {
	id: "socket" | "env" | "systemd-run" | "tmux";
	ok: boolean;
	/** A failure here refuses a sandboxed launch, not only a tmux-hosted one. */
	launch: boolean;
	detail: string;
	fix?: string;
}

const SOCKET_FIX =
	"set MFW_SOCKET_DIR to a new short directory you own, mode 700 (mkdir -m 700 creates one)";

async function socketItem(io: LaunchPreflightIo): Promise<LaunchPreflightItem> {
	const base = { id: "socket" as const, launch: true };
	const options = { env: io.env, uid: io.uid };
	let dirs: string[];
	let root: string;
	try {
		root = socketRoot(io.home, options);
		dirs = [socketBase(options), root];
		// The longest socket the daemon binds below its per-home directory.
		assertSocketPathFits(join(root, "b", "0".repeat(12), "brain.sock"));
	} catch (e) {
		if (!(e instanceof SocketPathError)) throw e;
		return { ...base, ok: false, detail: e.message, fix: e.fix };
	}
	for (const dir of dirs) {
		const st = await io.lstat(dir);
		if (!st) continue; // created private at the first launch
		if (st.kind !== "dir" || st.uid !== io.uid || st.mode & 0o077) {
			return {
				...base,
				ok: false,
				detail: `socket directory ${dir} is not private to this user`,
				fix: SOCKET_FIX,
			};
		}
	}
	return {
		...base,
		ok: true,
		detail: `socket directory ${root} is private and fits the 107-byte limit`,
	};
}

async function toolItem(
	io: LaunchPreflightIo,
	id: "env" | "systemd-run",
): Promise<LaunchPreflightItem> {
	const path = await io.tool(id);
	return path
		? { id, launch: true, ok: true, detail: `${id} is at ${path}` }
		: {
				id,
				launch: true,
				ok: false,
				detail: `${id} is not on a trusted PATH`,
				fix: `install ${id} in a root-owned directory on PATH (it ships with coreutils or systemd)`,
			};
}

async function tmuxItem(io: LaunchPreflightIo): Promise<LaunchPreflightItem> {
	const base = { id: "tmux" as const, launch: false };
	const install =
		"install tmux in a root-owned directory on PATH (apt install tmux, dnf install tmux, pacman -S tmux, or nix profile install nixpkgs#tmux)";
	const path = await io.tool("tmux");
	if (!path) {
		return {
			...base,
			ok: false,
			detail: "tmux was not found on a trusted PATH",
			fix: install,
		};
	}
	const r = await io.run([path, "-V"]);
	if (r?.code !== 0) {
		return {
			...base,
			ok: false,
			detail:
				r === undefined
					? "tmux did not run"
					: `tmux exited with code ${r.code} when asked for its version`,
			fix: install,
		};
	}
	const version = /\d+\.\d+[a-z]?/.exec(r.stdout)?.[0];
	return {
		...base,
		ok: true,
		detail: `tmux ${version ?? "(version unknown)"}`,
	};
}

export async function launchPreflight(
	io: LaunchPreflightIo,
): Promise<LaunchPreflightItem[]> {
	return Promise.all([
		socketItem(io),
		toolItem(io, "env"),
		toolItem(io, "systemd-run"),
		tmuxItem(io),
	]);
}

/** The real host, for a launch. */
export function liveLaunchPreflightIo(mfwHome: string): LaunchPreflightIo {
	return {
		home: mfwHome,
		uid: process.getuid?.() ?? 0,
		env: {
			MFW_SOCKET_DIR: process.env.MFW_SOCKET_DIR,
			XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
		},
		lstat: async (path) => {
			try {
				const st = await lstat(path);
				return {
					kind: st.isFile() ? "file" : st.isDirectory() ? "dir" : "other",
					mode: st.mode & 0o7777,
					uid: st.uid,
				};
			} catch {
				return null;
			}
		},
		tool: async (name) => pinnedTool(name),
		run: async (argv) => {
			try {
				const r = await runProc(argv, {
					timeoutMs: 3_000,
					maxOutputBytes: 4096,
				});
				return r.timedOut ? undefined : { code: r.exitCode, stdout: r.stdout };
			} catch {
				return undefined;
			}
		},
	};
}
