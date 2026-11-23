/**
 * Toolchain discovery for the Tier 1 bwrap profile (design "Mounts", review
 * R4). Resolves the declared binaries (git, bun, node, agent CLIs, project
 * tools) into read-only binds, so a synthetic HOME does not hide them:
 *
 * - NixOS: only the runtime closure of the declared binaries (store-closure.ts),
 *   each store path bound on its own. A closure also holds tools nobody
 *   declared (git's holds python3 and perl), so the `bin` and `sbin` of a
 *   member that is neither declared, nor a declared tool's launcher, nor a
 *   system link are hidden. If the closure cannot be computed the binaries are
 *   unresolved and the launch is refused;
 * - FHS distros: `/usr`, `/bin`, `/sbin`, `/lib*` whole, so there the declared
 *   list limits `PATH` and not what can run;
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
	readdirSync,
	readlinkSync,
	statSync,
} from "node:fs";
import { isAbsolute, join, posix } from "node:path";
import {
	hostStoreClosure,
	type StoreClosure,
	scanFileText,
	scanStoreClosure,
	storePathOf,
} from "./store-closure.ts";

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
	/** Executable directories of undeclared closure members, hidden by an empty read-only mount. */
	masks?: string[];
	/** How the store closure was computed; absent when no binary is in the store. */
	closureMethod?: StoreClosure["method"];
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
	/**
	 * Store paths the host itself vouches for, bound as data with their
	 * executables hidden: the runtime a binary outside the store links against.
	 * Never derived from the contents of a file outside the store.
	 */
	storeRoots?: readonly string[];
	/** Computes the store closure; throws when it cannot. Defaults to the host's. */
	closure?: (roots: readonly string[]) => StoreClosure;
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

/** System links a dynamic binary or a shebang needs; their targets stay executable. */
const NIX_SUPPORT_LINKS = [
	"/bin/sh",
	"/usr/bin/env",
	"/lib64/ld-linux-x86-64.so.2",
	"/lib/ld-linux-aarch64.so.1",
] as const;

/** Executable directories hidden in an undeclared closure member. */
const MASKED_DIRS = ["bin", "sbin"] as const;

/** A script this size or smaller is read whole for the store paths it launches. */
const MAX_WRAPPER_BYTES = 64 * 1024;
/** An ELF this size or smaller may be a generated wrapper around another program. */
const MAX_ELF_WRAPPER_BYTES = 4 * 1024 * 1024;
const MAX_LAUNCH_CHAIN = 16;
const MAX_CERT_ENTRIES = 512;
const STORE_FILE =
	/\/nix\/store\/[0-9a-df-np-sv-z]{32}-[A-Za-z0-9+._?=-]+(?:\/[A-Za-z0-9+._-]+)*/g;

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
 * The store path a binary is entered through: the last link in its chain that
 * keeps the name. A multi-call binary needs that name (`cat -> coreutils`), and
 * a profile's link farm is not in the closure. Null if no store entry has it.
 */
function storeEntry(fs: Fs, found: string, real: string): string | null {
	const name = posix.basename(found);
	let entry: string | null = null;
	let current = found;
	for (let hop = 0; hop < 40; hop++) {
		const dir = realpathIn(fs, posix.dirname(current));
		if (!dir) break;
		const here = posix.join(dir, posix.basename(current));
		if (under(here, NIX_STORE) && posix.basename(here) === name) entry = here;
		let target: string;
		try {
			if (!lstatSync(fs.host(here)).isSymbolicLink()) break;
			target = readlinkSync(fs.host(here));
		} catch {
			break;
		}
		current = isAbsolute(target) ? target : posix.join(dir, target);
	}
	return entry ?? (posix.basename(real) === name ? real : null);
}

/**
 * Store paths a declared binary starts directly: a script's interpreter and
 * what a wrapper script or generated ELF wrapper executes. Only these stay
 * executable. A large ELF is a program, whose embedded paths (git's python) say
 * nothing about what it must launch.
 */
function launchChain(fs: Fs, entry: string): string[] {
	const out = new Set<string>();
	const seen = new Set<string>();
	const pending = [entry];
	while (pending.length > 0 && seen.size < MAX_LAUNCH_CHAIN) {
		const file = realpathIn(fs, pending.pop() as string);
		if (!file || seen.has(file)) continue;
		seen.add(file);
		const store = storePathOf(file);
		if (store) out.add(store);
		let size: number;
		let text = "";
		try {
			const st = statSync(fs.host(file));
			if (!st.isFile()) continue;
			size = st.size;
			scanFileText(
				fs.host(file),
				(chunk) => {
					if (text.length < MAX_WRAPPER_BYTES) text += chunk;
				},
				Math.max(size, 1),
			);
		} catch {
			continue;
		}
		let refs: string[] = [];
		if (text.startsWith("#!")) {
			const body =
				size <= MAX_WRAPPER_BYTES ? text : (text.split("\n")[0] as string);
			refs = body.match(STORE_FILE) ?? [];
		} else if (text.startsWith("\x7fELF") && size <= MAX_ELF_WRAPPER_BYTES) {
			refs = (text.match(STORE_FILE) ?? []).filter((r) =>
				r.endsWith("-wrapped"),
			);
		}
		for (const ref of refs) {
			const path = storePathOf(ref);
			if (path) out.add(path);
			if (ref !== path) pending.push(ref);
		}
	}
	return [...out];
}

/** The store paths the `/etc/ssl` links point at: CA bundles, as data. */
function certRoots(fs: Fs): string[] {
	const out = new Set<string>();
	const pending = ["/etc/ssl"];
	let budget = MAX_CERT_ENTRIES;
	while (pending.length > 0 && budget-- > 0) {
		const real = realpathIn(fs, pending.pop() as string);
		if (!real) continue;
		const store = storePathOf(real);
		if (store) out.add(store);
		try {
			if (!statSync(fs.host(real)).isDirectory()) continue;
			for (const e of readdirSync(fs.host(real))) {
				pending.push(posix.join(real, e));
			}
		} catch {}
	}
	return [...out];
}

function isRealDir(fs: Fs, p: string): boolean {
	try {
		return lstatSync(fs.host(p)).isDirectory();
	} catch {
		return false;
	}
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
	const storeResolved: ResolvedBinary[] = [];
	const launchRoots = new Set<string>();
	const dataRoots = new Set<string>();

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
		if (under(real, NIX_STORE)) {
			const entry = storeEntry(fs, found, real);
			if (!entry || !storePathOf(entry) || !storePathOf(real)) {
				unresolved.push({
					name,
					reason: `${found} has no store entry named ${posix.basename(found)}`,
				});
				continue;
			}
			storeResolved.push({ name, path: entry, realPath: real });
			for (const p of launchChain(fs, entry)) launchRoots.add(p);
			launchRoots.add(storePathOf(real) as string);
			continue;
		}
		// Every location the binary is reachable through must be bound: the
		// PATH entry and the final target (they differ for shims and symlinks).
		const locations = found === real ? [found] : [found, real];
		const planned: ToolchainBind[] = [];
		let refusal: string | null = null;
		for (const loc of locations) {
			if (SYSTEM_ROOTS.some((r) => under(loc, r))) {
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
		// Nothing is read from a file outside the store: it may be writable by
		// a run, and the paths it names would widen every later sandbox.
	}
	for (const root of opts.storeRoots ?? []) {
		const store = storePathOf(root);
		if (store && exists(fs, store)) dataRoots.add(store);
	}

	let masks: string[] = [];
	let closureMethod: StoreClosure["method"] | undefined;
	const visible = new Set(launchRoots);
	if (resolved.length + storeResolved.length > 0 && isDir(fs, NIX_STORE)) {
		for (const link of NIX_SUPPORT_LINKS) {
			const target = exists(fs, link) ? realpathIn(fs, link) : null;
			const store = target ? storePathOf(target) : null;
			if (store) visible.add(store);
		}
	}
	if (visible.size + dataRoots.size > 0) {
		const closureOf =
			opts.closure ??
			((r: readonly string[]) =>
				fs.root === "/" ? hostStoreClosure(r) : scanStoreClosure(r, fs.host));
		try {
			const closure = closureOf([
				...new Set([...visible, ...dataRoots, ...certRoots(fs)]),
			]);
			closureMethod = closure.method;
			for (const path of closure.paths) {
				add({ path, source: "nix", reason: "closure", optional: false });
				if (visible.has(path)) continue;
				for (const d of MASKED_DIRS) {
					const dir = `${path}/${d}`;
					if (isRealDir(fs, dir)) masks.push(dir);
				}
			}
			for (const b of storeResolved) {
				resolved.push(b);
				const dir = posix.dirname(b.path);
				if (!pathDirs.includes(dir)) pathDirs.push(dir);
			}
		} catch (err) {
			// No partial closure: every store binary is refused by the compiler.
			masks = [];
			for (const b of storeResolved) {
				unresolved.push({
					name: b.name,
					reason: `its store closure cannot be computed: ${(err as Error).message}`,
				});
			}
		}
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
		...(masks.length > 0 ? { masks: masks.sort() } : {}),
		...(closureMethod ? { closureMethod } : {}),
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
	// After the binds they cover. Read-only, or the mask is a writable directory.
	for (const dir of plan.masks ?? []) {
		args.push("--tmpfs", dir, "--remount-ro", dir);
	}
	return args;
}
