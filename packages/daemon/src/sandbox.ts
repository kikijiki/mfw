import {
	accessSync,
	constants as fsConstants,
	realpathSync,
	statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Host tools resolved from a trusted `PATH`, and the settings of a sandboxed
 * run. The sandbox itself is `containment/`: every kind launches through
 * `containment/agent-launch.ts`, and no run gets the real home.
 */

export interface BwrapIsolation {
	mode: "bwrap";
	/** Host paths no sandbox may show. Nothing is bound from them in the first place. */
	hidePaths: string[];
	/** The daemon's home, where a run finds its fleet config. */
	mfwHome?: string;
	/** Owner opt-in: let sandboxed runs reach their CLI's telemetry hosts. */
	egressTelemetry?: boolean;
	/** Per-run upload limits; a limit left out takes the proxy's default. */
	egressUploadBudget?: { perDestinationBytes?: number; totalBytes?: number };
}

/** Thrown instead of launching unsandboxed; the engine maps it to `sandbox_unavailable`. */
export class SandboxUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SandboxUnavailableError";
	}
}

/**
 * Directories an agent can write: `$HOME`, `/tmp` and the OS temp dir. A binary
 * found there is the agent's, not the host's (security review G4).
 */
function agentWritableRoots(): string[] {
	const roots = [homedir(), "/tmp", tmpdir()];
	return [...new Set(roots.map(realOrSelf))];
}

function realOrSelf(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

const within = (p: string, root: string) =>
	p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);

/**
 * `PATH` entries the agent cannot have planted a binary in: each entry is
 * resolved through symlinks (a `~/.nix-profile` link into the store is pinned
 * to its store target) and dropped if it lands in a writable root.
 */
export function trustedPathEntries(
	pathVar: string | undefined,
	writableRoots: readonly string[] = agentWritableRoots(),
): string[] {
	const out: string[] = [];
	for (const entry of (pathVar ?? "").split(":")) {
		if (!entry.startsWith("/")) continue;
		let real: string;
		try {
			real = realpathSync(entry);
		} catch {
			continue;
		}
		if (writableRoots.some((r) => within(real, r))) continue;
		if (!out.includes(real)) out.push(real);
	}
	return out;
}

/** The first executable `name` in a trusted `PATH` entry, as an absolute real path; null if none. */
export function pinnedToolIn(
	name: string,
	pathVar: string | undefined,
	writableRoots?: readonly string[],
): string | null {
	for (const dir of trustedPathEntries(pathVar, writableRoots)) {
		const candidate = join(dir, name);
		try {
			accessSync(candidate, fsConstants.X_OK);
			if (statSync(candidate).isFile()) return candidate;
		} catch {}
	}
	return null;
}

const pinned = new Map<string, { pathVar: string | undefined; path: string }>();

/**
 * Host tools (`bwrap`, `tmux`, `env`, `bash`) resolved from a trusted `PATH`.
 * A hit is remembered for as long as `PATH` is unchanged, so a launch cannot
 * be redirected later by a planted binary; a miss is never remembered.
 */
export function pinnedTool(name: string): string | null {
	const pathVar = process.env.PATH;
	const hit = pinned.get(name);
	if (hit && hit.pathVar === pathVar) return hit.path;
	const path = pinnedToolIn(name, pathVar);
	if (path) pinned.set(name, { pathVar, path });
	else pinned.delete(name);
	return path;
}

/**
 * A pinned host tool, or a refusal. Used where a missing tool must stop the
 * operation rather than fall back to a `PATH` lookup an agent can steer
 * (security review X8).
 */
export function requireHostTool(name: string): string {
	const path = pinnedTool(name);
	if (!path) {
		throw new SandboxUnavailableError(`${name} is not on a trusted PATH`);
	}
	return path;
}

/** The host-only control directory (`run.sh`, secret FIFOs, exit records): masked in every sandbox. */
export function controlRootPath(uid: number = process.getuid?.() ?? 0): string {
	return join(tmpdir(), `mfw-control-${uid}`);
}

let cachedSafePath: { pathVar: string | undefined; value: string } | undefined;

/** `PATH` for host-side shells: trusted entries only. */
export function safeHostPath(): string {
	const pathVar = process.env.PATH;
	if (cachedSafePath && cachedSafePath.pathVar === pathVar) {
		return cachedSafePath.value;
	}
	const value = trustedPathEntries(pathVar).join(":");
	cachedSafePath = { pathVar, value };
	return value;
}

/** The pinned absolute `bwrap` path, resolved once per process; null when absent. */
export async function resolveBwrapPath(): Promise<string | null> {
	return pinnedTool("bwrap");
}

/** Cached for the process lifetime; checked on every launch. */
export async function bwrapAvailable(): Promise<boolean> {
	return (await resolveBwrapPath()) !== null;
}

/** Test seam: clears the `bwrapAvailable` memo. */
export function resetBwrapAvailableCache(): void {
	pinned.clear();
	cachedSafePath = undefined;
}
