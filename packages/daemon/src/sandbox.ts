import {
	accessSync,
	constants as fsConstants,
	lstatSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

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

/** Project roots this process serves: agents write there. */
const configuredWritableRoots = new Set<string>();

/**
 * Directories an agent can write: `$HOME`, the temp directories and every
 * configured project root. A binary found there is the agent's, not the
 * host's (security review G4).
 */
export function agentWritableRoots(): string[] {
	const roots = [
		homedir(),
		"/tmp",
		tmpdir(),
		"/var/tmp",
		"/dev/shm",
		...configuredWritableRoots,
	];
	return [...new Set(roots.map(realOrSelf))];
}

/** Exclude these project roots from every later tool resolution. */
export function addAgentWritableRoots(roots: readonly string[]): void {
	let changed = false;
	for (const root of roots) {
		for (const p of [root, realOrSelf(root)]) {
			if (p === "/" || configuredWritableRoots.has(p)) continue;
			configuredWritableRoots.add(p);
			changed = true;
		}
	}
	if (changed) {
		pinned.clear();
		cachedSafePath = undefined;
	}
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

export interface PathTrustStat {
	kind: "file" | "dir" | "link" | "other";
	uid: number;
	mode: number;
}

/** What the trust rule reads. Injected so each case runs without a real root-owned tree. */
export interface PathTrustIo {
	lstat(path: string): PathTrustStat | null;
	readlink(path: string): string | null;
	/** The directory with symlinks resolved; null when it does not exist. */
	realDir(path: string): string | null;
	/** Owners that an agent running as this user cannot be. */
	rootUids: ReadonlySet<number>;
}

/**
 * Uid 0, plus the kernel's overflow uid when this process is in a user
 * namespace that does not map 0: there, root's files appear as the overflow
 * uid. This process's own uid never counts.
 */
export function rootOwnerUids(
	uidMap: string | undefined,
	overflowUid: string | undefined,
	selfUid: number,
): Set<number> {
	const uids = new Set([0]);
	if (uidMap === undefined) return uids;
	const mapsRoot = uidMap.split("\n").some((line) => {
		const [inside, , count] = line.trim().split(/\s+/).map(Number);
		return (
			inside !== undefined &&
			count !== undefined &&
			inside <= 0 &&
			0 < inside + count
		);
	});
	if (mapsRoot) return uids;
	const overflow = Number(overflowUid?.trim());
	if (Number.isInteger(overflow) && overflow > 0 && overflow !== selfUid) {
		uids.add(overflow);
	}
	return uids;
}

const readOrUndefined = (path: string): string | undefined => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
};

let liveIo: PathTrustIo | undefined;

export function liveTrustIo(): PathTrustIo {
	liveIo ??= {
		lstat: (path) => {
			try {
				const st = lstatSync(path);
				return {
					kind: st.isSymbolicLink()
						? "link"
						: st.isDirectory()
							? "dir"
							: st.isFile()
								? "file"
								: "other",
					uid: st.uid,
					mode: st.mode & 0o7777,
				};
			} catch {
				return null;
			}
		},
		readlink: (path) => {
			try {
				return readlinkSync(path);
			} catch {
				return null;
			}
		},
		realDir: (path) => {
			try {
				return realpathSync(path);
			} catch {
				return null;
			}
		},
		rootUids: rootOwnerUids(
			readOrUndefined("/proc/self/uid_map"),
			readOrUndefined("/proc/sys/kernel/overflowuid"),
			process.getuid?.() ?? 0,
		),
	};
	return liveIo;
}

/**
 * Why an agent could change what is in this resolved directory, or null. It
 * and every parent must be root-owned and not group- or world-writable. The one
 * exception is `/nix/store`, which is root-owned, sticky and writable by the
 * build group: its entries can only be replaced by root.
 */
export function directoryTrustProblem(
	dir: string,
	writableRoots: readonly string[],
	io: PathTrustIo,
): string | null {
	if (writableRoots.some((r) => within(dir, r))) {
		return `${dir} is in a directory agents can write`;
	}
	for (let at = dir; ; at = dirname(at)) {
		const st = io.lstat(at);
		if (st?.kind !== "dir") return `${at} is not a directory`;
		if (!io.rootUids.has(st.uid)) return `${at} is not owned by root`;
		const nixStore =
			at === "/nix/store" &&
			(st.mode & 0o1000) !== 0 &&
			(st.mode & 0o002) === 0;
		if (st.mode & 0o022 && !nixStore) {
			return `${at} is group- or world-writable`;
		}
		if (at === "/" || at === ".") return null;
	}
}

const MAX_LINK_HOPS = 40;

/**
 * Why this binary cannot be trusted, or null. Every hop of a symlink chain is
 * checked where it lives, and the final file must be root-owned and not group-
 * or world-writable.
 */
export function binaryTrustProblem(
	path: string,
	writableRoots: readonly string[],
	io: PathTrustIo,
): string | null {
	let current = path;
	for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
		const dir = io.realDir(dirname(current));
		if (!dir) return `${dirname(current)} does not exist`;
		const inDir = directoryTrustProblem(dir, writableRoots, io);
		if (inDir) return inDir;
		const at = join(dir, basename(current));
		const st = io.lstat(at);
		if (!st) return `${at} does not exist`;
		if (!io.rootUids.has(st.uid)) return `${at} is not owned by root`;
		if (st.kind === "file") {
			return st.mode & 0o022 ? `${at} is group- or world-writable` : null;
		}
		if (st.kind !== "link") return `${at} is not a regular file`;
		const target = io.readlink(at);
		if (target === null) return `${at} cannot be read`;
		current = resolve(dir, target);
	}
	return `${path} has too many symbolic links`;
}

/**
 * `PATH` entries the agent cannot have planted a binary in: each entry is
 * resolved through symlinks (a `~/.nix-profile` link into the store is pinned
 * to its store target) and kept only when the resolved directory passes
 * `directoryTrustProblem`.
 */
export function trustedPathEntries(
	pathVar: string | undefined,
	writableRoots: readonly string[] = agentWritableRoots(),
	io: PathTrustIo = liveTrustIo(),
): string[] {
	const out: string[] = [];
	for (const entry of (pathVar ?? "").split(":")) {
		if (!entry.startsWith("/")) continue;
		const real = io.realDir(entry);
		if (!real) continue;
		if (directoryTrustProblem(real, writableRoots, io)) continue;
		if (!out.includes(real)) out.push(real);
	}
	return out;
}

/**
 * The first trusted executable `name` on `PATH`, null if none. The returned
 * path keeps its own name, because multi-call binaries dispatch on it, but
 * everything it resolves through has been checked.
 */
export function pinnedToolIn(
	name: string,
	pathVar: string | undefined,
	writableRoots?: readonly string[],
	io: PathTrustIo = liveTrustIo(),
): string | null {
	const roots = writableRoots ?? agentWritableRoots();
	for (const dir of trustedPathEntries(pathVar, roots, io)) {
		const candidate = join(dir, name);
		try {
			accessSync(candidate, fsConstants.X_OK);
			if (
				statSync(candidate).isFile() &&
				binaryTrustProblem(candidate, roots, io) === null
			) {
				return candidate;
			}
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
	configuredWritableRoots.clear();
	pinned.clear();
	cachedSafePath = undefined;
}
