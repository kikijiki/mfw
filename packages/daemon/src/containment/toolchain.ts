/**
 * Toolchain discovery for the Tier 1 bwrap profile (design "Mounts", review
 * R4). Resolves the declared binaries (git, bun, node, agent CLIs, project
 * tools) into read-only binds, so a synthetic HOME does not hide them:
 *
 * - NixOS: `/nix/store` whole. The declared list therefore limits `PATH`, not
 *   what can run: anything in the store is readable and runs by absolute path.
 *   Binding the computed closure of the declared binaries is required before
 *   P6 adds egress;
 * - FHS distros: `/usr`, `/bin`, `/sbin`, `/lib*`;
 * - HOME-installed toolchains: `~/.local/bin`, `~/.bun`, `~/.rustup`,
 *   `~/.cargo/bin`, `~/.nvm`, uv, and the Claude native installer;
 * - the `/etc` set the sandbox experiments found necessary: `passwd`,
 *   `group`, `nsswitch.conf`, `ssl`, `static` (plus `alternatives` on Debian).
 *
 * Everything here is read-only by construction (the result type has no
 * writable kind), and `$HOME` itself is never bound: a binary that lives in
 * HOME outside the known toolchain roots is reported as unresolved instead.
 * Pure over an injectable filesystem root, so fixture trees for NixOS,
 * Debian and HOME-rustup run anywhere without bwrap.
 */

import {
	accessSync,
	constants,
	lstatSync,
	readlinkSync,
	statSync,
} from "node:fs";
import { isAbsolute, join, posix } from "node:path";

/** Where a bind came from, for the doctor and the audit trail. */
export type ToolchainSource = "nix" | "system" | "home" | "etc";

export interface ToolchainBind {
	/** Absolute path, identical on the host and inside the sandbox. Always read-only. */
	path: string;
	source: ToolchainSource;
	/** Why it is bound (a binary name or a fixed rule). */
	reason: string;
	/** True for entries that may legitimately be absent on some hosts. */
	optional: boolean;
}

export interface ResolvedBinary {
	name: string;
	/** The path found on PATH (or the absolute path given). */
	path: string;
	/** The fully symlink-resolved path. */
	realPath: string;
}

export interface UnresolvedBinary {
	name: string;
	reason: string;
}

export interface ToolchainPlan {
	binds: ToolchainBind[];
	resolved: ResolvedBinary[];
	unresolved: UnresolvedBinary[];
	/** Directories to put on the sandbox PATH, in lookup order, deduplicated. */
	pathDirs: string[];
}

export interface ToolchainOptions {
	/** The (real) home directory the toolchain roots are looked up in. */
	home: string;
	/** Binary names (searched on `path`) or absolute paths. */
	binaries: readonly string[];
	/** A PATH-style string; only absolute entries are used. */
	path: string;
	/** Filesystem root, `/` by default; tests point it at a fixture tree. */
	root?: string;
	/** The `/etc` entries to bind; defaults to {@link DEFAULT_ETC_ENTRIES}. */
	etcEntries?: readonly string[];
}

/** The E2 `/etc` set, plus Debian's alternatives links that `/usr/bin` symlinks point through. */
export const DEFAULT_ETC_ENTRIES = [
	"passwd",
	"group",
	"nsswitch.conf",
	"ssl",
	"static",
	"alternatives",
] as const;

/** System roots bound whole when a binary lives there or on any FHS host. */
const SYSTEM_ROOTS = [
	"/usr",
	"/bin",
	"/sbin",
	"/lib",
	"/lib32",
	"/lib64",
	"/libx32",
] as const;

const NIX_STORE = "/nix/store";
const NIX_ROOTS = [NIX_STORE, "/nix/var/nix/profiles"] as const;

/** Profile symlink trees that point into the store; bound only when a binary resolves into the store through them. */
const NIX_PROFILE_ROOTS = [
	"/run/current-system",
	"/etc/profiles",
	"/nix/var/nix/profiles",
] as const;

/**
 * HOME toolchain roots, relative to HOME. Each holds installed tools, not
 * credentials: `~/.cargo` is bound only at `bin` (it also holds
 * `credentials.toml`), `~/.local` only at `bin` and the named share dirs, uv
 * only at its interpreter and tool dirs (it keeps `credentials/` beside
 * them) and nvm only at `versions` (`.nvm/.npmrc` may hold a token). A root
 * that is a symlink is bound only when it resolves into the Nix store or
 * profiles; otherwise it is refused (see `homeRootRefusal`).
 */
export const HOME_TOOLCHAIN_ROOTS = [
	".local/bin",
	".local/share/claude",
	".local/share/uv/python",
	".local/share/uv/tools",
	".bun",
	".rustup",
	".cargo/bin",
	".nvm/versions",
	".nix-profile",
] as const;

/** HOME-relative names that are never bound, even under a toolchain root. */
const HOME_NEVER = [
	".ssh",
	".gnupg",
	".aws",
	".claude",
	".codex",
	".config",
	".netrc",
	".cargo/credentials",
	".cargo/credentials.toml",
	".npmrc",
	".git-credentials",
	".docker",
	".kube",
	".local/share/keyrings",
];

type Fs = {
	root: string;
	/** Map a sandbox-visible absolute path onto the host fixture root. */
	host(p: string): string;
};

function makeFs(root: string): Fs {
	return {
		root,
		host: (p) => (root === "/" ? p : join(root, p)),
	};
}

function isDir(fs: Fs, p: string): boolean {
	const real = realpathIn(fs, p);
	if (!real) return false;
	try {
		return statSync(fs.host(real)).isDirectory();
	} catch {
		return false;
	}
}

function exists(fs: Fs, p: string): boolean {
	try {
		lstatSync(fs.host(p));
		return true;
	} catch {
		return false;
	}
}

function isExecutableFile(fs: Fs, p: string): boolean {
	const real = realpathIn(fs, p);
	if (!real) return false;
	try {
		if (!statSync(fs.host(real)).isFile()) return false;
		accessSync(fs.host(real), constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolve symlinks inside the fixture root (so an absolute link target means
 * "under the root", as it would on a real host). Returns null on a loop or a
 * dangling link.
 */
function realpathIn(fs: Fs, input: string): string | null {
	let pending = input.split("/").filter(Boolean);
	let resolved = "/";
	let hops = 0;
	while (pending.length > 0) {
		const part = pending.shift() as string;
		if (part === ".") continue;
		if (part === "..") {
			resolved = posix.dirname(resolved);
			continue;
		}
		const next = posix.join(resolved, part);
		let target: string | null = null;
		try {
			if (lstatSync(fs.host(next)).isSymbolicLink()) {
				target = readlinkSync(fs.host(next));
			}
		} catch {
			return null;
		}
		if (target === null) {
			resolved = next;
			continue;
		}
		if (++hops > 40) return null;
		pending = target.split("/").filter(Boolean).concat(pending);
		if (isAbsolute(target)) resolved = "/";
	}
	return resolved;
}

function under(path: string, dir: string): boolean {
	return path === dir || path.startsWith(`${dir}/`);
}

/** HOME toolchain root that contains `path`, or null. */
function homeRootOf(home: string, path: string): string | null {
	for (const rel of HOME_TOOLCHAIN_ROOTS) {
		const abs = posix.join(home, rel);
		if (under(path, abs)) return abs;
	}
	return null;
}

function forbiddenHomePath(home: string, path: string): boolean {
	if (path === home || home.startsWith(`${path}/`) || path === "/") return true;
	return HOME_NEVER.some((rel) => under(path, posix.join(home, rel)));
}

/**
 * Why a HOME toolchain root must not be bound, or null when it is safe. The
 * check is on the resolved path, because bwrap follows the source symlink:
 * an agent-writable HOME can hold `~/.bun -> ~/.ssh`. A root must resolve to
 * itself (a link is allowed only into the Nix store or profiles), and the
 * resolved path must neither be, contain nor sit inside a credential or
 * writable location, taken both lexically and after resolution.
 */
function homeRootRefusal(fs: Fs, home: string, root: string): string | null {
	const real = realpathIn(fs, root);
	if (real === null) return `${root} is a dangling or looping link`;
	if (real !== root && !NIX_ROOTS.some((r) => under(real, r))) {
		return `${root} resolves to ${real}, outside the toolchain root`;
	}
	// HOME itself is protected only against binding it or an ancestor; roots
	// legitimately live below it.
	if (real === "/" || under(home, real)) {
		return `${root} resolves to ${real}, which contains HOME`;
	}
	for (const rel of HOME_NEVER) {
		const abs = posix.join(home, rel);
		for (const bad of [abs, realpathIn(fs, abs)]) {
			if (bad && (under(real, bad) || under(bad, real))) {
				return `${root} resolves to ${real}, which overlaps the protected location ${bad}`;
			}
		}
	}
	return null;
}

/** Find a binary name on PATH, or accept an absolute path. */
function lookup(
	fs: Fs,
	name: string,
	pathDirs: readonly string[],
): string | null {
	if (isAbsolute(name)) return isExecutableFile(fs, name) ? name : null;
	if (name.includes("/")) return null;
	for (const dir of pathDirs) {
		const candidate = posix.join(dir, name);
		if (isExecutableFile(fs, candidate)) return candidate;
	}
	return null;
}

/**
 * Plan the read-only binds for the declared binaries. Never throws: a binary
 * that cannot be found, or that lives somewhere unsafe to bind, is reported in
 * `unresolved` and gets no bind.
 */
export function discoverToolchain(opts: ToolchainOptions): ToolchainPlan {
	const fs = makeFs(opts.root ?? "/");
	const home = posix.normalize(opts.home).replace(/\/+$/, "") || "/";
	const searchDirs = opts.path.split(":").filter((d) => isAbsolute(d));

	const binds = new Map<string, ToolchainBind>();
	const add = (b: ToolchainBind) => {
		if (!binds.has(b.path)) binds.set(b.path, b);
	};
	const resolved: ResolvedBinary[] = [];
	const unresolved: UnresolvedBinary[] = [];
	const pathDirs: string[] = [];

	for (const name of opts.binaries) {
		const found = lookup(fs, name, searchDirs);
		if (!found) {
			unresolved.push({ name, reason: "not found on PATH" });
			continue;
		}
		const real = realpathIn(fs, found);
		if (!real) {
			unresolved.push({ name, reason: "symlink loop or dangling link" });
			continue;
		}
		// Every location the binary is reachable through must be bound: the
		// PATH entry and the final target (they differ for shims and symlinks).
		const locations = found === real ? [found] : [found, real];
		const planned: ToolchainBind[] = [];
		let refusal: string | null = null;
		for (const loc of locations) {
			if (under(loc, NIX_STORE)) {
				planned.push({
					path: NIX_STORE,
					source: "nix",
					reason: name,
					optional: false,
				});
			} else if (
				NIX_PROFILE_ROOTS.some((r) => under(loc, r)) &&
				under(real, NIX_STORE)
			) {
				const profile = NIX_PROFILE_ROOTS.find((r) => under(loc, r)) as string;
				planned.push({
					path: profile,
					source: "nix",
					reason: name,
					optional: false,
				});
				planned.push({
					path: NIX_STORE,
					source: "nix",
					reason: name,
					optional: false,
				});
			} else if (SYSTEM_ROOTS.some((r) => under(loc, r))) {
				for (const r of SYSTEM_ROOTS) {
					if (exists(fs, r)) {
						planned.push({
							path: r,
							source: "system",
							reason: name,
							optional: false,
						});
					}
				}
			} else if (under(loc, home)) {
				const rootDir = homeRootOf(home, loc);
				const rootRefusal =
					rootDir && !forbiddenHomePath(home, rootDir)
						? homeRootRefusal(fs, home, rootDir)
						: null;
				if (!rootDir || forbiddenHomePath(home, rootDir)) {
					refusal = `${loc} is in HOME outside the known toolchain roots`;
				} else if (rootRefusal) {
					refusal = rootRefusal;
				} else {
					planned.push({
						path: rootDir,
						source: "home",
						reason: name,
						optional: false,
					});
				}
			} else {
				refusal = `${loc} is outside the system, Nix and HOME toolchain roots`;
			}
		}
		if (refusal) {
			unresolved.push({ name, reason: refusal });
			continue;
		}
		for (const b of planned) add(b);
		resolved.push({ name, path: found, realPath: real });
		const dir = posix.dirname(found);
		if (!pathDirs.includes(dir)) pathDirs.push(dir);
	}

	// Fixed rules: the HOME roots that exist (so PATH-relative tools and
	// shims keep working), the FHS roots on non-Nix hosts, the /etc set.
	for (const rel of HOME_TOOLCHAIN_ROOTS) {
		const abs = posix.join(home, rel);
		if (forbiddenHomePath(home, abs) || !exists(fs, abs)) continue;
		const why = homeRootRefusal(fs, home, abs);
		if (why) {
			unresolved.push({ name: `~/${rel}`, reason: why });
			continue;
		}
		if (isDir(fs, abs)) {
			add({
				path: abs,
				source: "home",
				reason: "home toolchain root",
				optional: true,
			});
		}
	}
	if (isDir(fs, NIX_STORE)) {
		add({
			path: NIX_STORE,
			source: "nix",
			reason: "nix store",
			optional: true,
		});
	}
	for (const r of SYSTEM_ROOTS) {
		if (exists(fs, r)) {
			add({ path: r, source: "system", reason: "system root", optional: true });
		}
	}
	for (const entry of opts.etcEntries ?? DEFAULT_ETC_ENTRIES) {
		const abs = `/etc/${entry}`;
		if (exists(fs, abs)) {
			add({ path: abs, source: "etc", reason: "etc set", optional: true });
		}
	}

	return {
		binds: orderBinds([...binds.values()]),
		resolved,
		unresolved,
		pathDirs,
	};
}

/** Parents before children, then by path, and drop children of an already bound parent. */
function orderBinds(all: ToolchainBind[]): ToolchainBind[] {
	const sorted = [...all].sort((a, b) => a.path.localeCompare(b.path));
	const out: ToolchainBind[] = [];
	for (const b of sorted) {
		if (out.some((p) => under(b.path, p.path))) continue;
		out.push(b);
	}
	return out;
}

/**
 * The bwrap arguments for a plan: read-only binds only. Optional entries use
 * `--ro-bind-try` so a host that lacks one still launches.
 */
export function toolchainBwrapArgs(plan: ToolchainPlan): string[] {
	const args: string[] = [];
	for (const b of plan.binds) {
		args.push(b.optional ? "--ro-bind-try" : "--ro-bind", b.path, b.path);
	}
	return args;
}
