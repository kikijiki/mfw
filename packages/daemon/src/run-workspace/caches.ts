/**
 * Declared per-project caches, carried into a freshly seeded run workspace.
 *
 * Seeding is git-tracked content only; a project opts into the heavy,
 * untracked directories it wants, by kind. Each kind has its own rule, taken
 * from the sandbox experiments on cache relocatability:
 *
 *  - `rust-target`: `cp -a` with a reflink. `-a` keeps the mtimes, which cargo's
 *    fingerprints depend on, so nothing recompiles but the project's own crates.
 *  - `node-modules`: a reflink. Safe for bun's isolated layout (relative links).
 *  - `venv`: a reflink, then a host fix-up that rewrites the old project path in
 *    `bin/*` and `pyvenv.cfg`. A plain copy silently runs the original venv.
 *  - `direnv`: never carried over (nix-direnv refuses a copied cache).
 *
 * A cache is an optimisation, so every refusal here skips it with a reason
 * instead of failing the seed. Nothing is ever copied without a reflink: a
 * multi-gigabyte real copy on a filesystem that cannot share extents would cost
 * more than the cache saves.
 */
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	readlink,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { runProc } from "../proc.ts";

export type CacheKind = "rust-target" | "node-modules" | "venv" | "direnv";

export interface CacheDeclaration {
	kind: CacheKind;
	/** Relative to the project root, no `..`, never inside `.git`. */
	path: string;
}

export type CacheSkipReason =
	| "never_carried"
	| "invalid_path"
	| "missing"
	| "not_a_directory"
	| "symlink_path"
	| "tracked_content_present"
	| "unsafe_symlink"
	| "reflink_unsupported";

export interface CacheOutcome {
	kind: CacheKind;
	path: string;
	status: "seeded" | "skipped";
	reason?: CacheSkipReason;
	detail?: string;
	/** Files rewritten by the venv fix-up. */
	fixedFiles?: number;
}

export interface SeedCachesOptions {
	/** The trusted primary checkout. */
	primaryRoot: string;
	/** The new work tree, already checked out. */
	treeRoot: string;
	declarations: CacheDeclaration[];
	log?: (msg: string) => void;
	timeoutMs?: number;
}

const COPY_TIMEOUT_MS = 10 * 60_000;
const MAX_FIXUP_BYTES = 2 * 1024 * 1024;

/** The checks a declaration must pass before anything is touched. Returns the normalized path. */
export function normalizeCachePath(path: string): string | undefined {
	if (path === "" || path.includes("\0") || isAbsolute(path)) return undefined;
	if (path.split(sep).includes("..")) return undefined;
	const norm = normalize(path).replace(/\/+$/, "");
	const parts = norm.split(sep);
	if (norm === "." || parts.some((p) => p === ".." || p === "" || p === ".")) {
		return undefined;
	}
	if (parts.some((p) => p === ".git")) return undefined;
	return norm;
}

async function isDir(p: string): Promise<boolean> {
	try {
		return (await lstat(p)).isDirectory();
	} catch {
		return false;
	}
}

async function exists(p: string): Promise<boolean> {
	try {
		await lstat(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Cache declarations a project gets with no configuration: what is present
 * and recognisable. `.direnv` is not among them.
 */
export async function defaultCacheDeclarations(
	primaryRoot: string,
): Promise<CacheDeclaration[]> {
	const out: CacheDeclaration[] = [];
	if (
		(await exists(join(primaryRoot, "Cargo.toml"))) &&
		(await isDir(join(primaryRoot, "target")))
	) {
		out.push({ kind: "rust-target", path: "target" });
	}
	const nodeProjects = [""];
	for (const parent of ["packages", "apps"]) {
		try {
			for (const e of await readdir(join(primaryRoot, parent), {
				withFileTypes: true,
			})) {
				if (e.isDirectory()) nodeProjects.push(join(parent, e.name));
			}
		} catch {
			// no such workspace parent
		}
	}
	for (const dir of nodeProjects.sort()) {
		if (
			(await exists(join(primaryRoot, dir, "package.json"))) &&
			(await isDir(join(primaryRoot, dir, "node_modules")))
		) {
			out.push({ kind: "node-modules", path: join(dir, "node_modules") });
		}
	}
	for (const name of [".venv", "venv"]) {
		if (await exists(join(primaryRoot, name, "pyvenv.cfg"))) {
			out.push({ kind: "venv", path: name });
		}
	}
	return out;
}

function under(path: string, root: string): boolean {
	return (
		path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
	);
}

/**
 * The first symlink in `dir` that would not survive relocation, or undefined.
 * An absolute link into the project would point the clone back at the
 * primary, and a relative link leaving the project would resolve somewhere
 * else once the tree moves. Absolute links elsewhere (the nix store, system
 * interpreters) are fine. Symlinks are never followed.
 */
export async function findUnsafeSymlink(
	dir: string,
	projectRoot: string,
): Promise<string | undefined> {
	const root = resolve(projectRoot);
	const stack = [dir];
	while (stack.length > 0) {
		const cur = stack.pop() as string;
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(cur, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			const p = join(cur, e.name);
			if (e.isDirectory()) {
				stack.push(p);
			} else if (e.isSymbolicLink()) {
				const target = await readlink(p);
				if (isAbsolute(target)) {
					if (under(resolve(target), root)) return `${p} -> ${target}`;
				} else if (!under(resolve(dirname(p), target), root)) {
					return `${p} -> ${target}`;
				}
			}
		}
	}
	return undefined;
}

/** A reflink copy that keeps mode, ownership where permitted, links and mtimes. Never a real copy. */
export async function reflinkCopy(
	src: string,
	dst: string,
	timeoutMs = COPY_TIMEOUT_MS,
): Promise<{ ok: true } | { ok: false; detail: string }> {
	const r = await runProc(["cp", "-a", "--reflink=always", "--", src, dst], {
		timeoutMs,
	});
	if (r.exitCode === 0) return { ok: true };
	await rm(dst, { recursive: true, force: true });
	return { ok: false, detail: (r.stderr || r.stdout).trim().slice(0, 300) };
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrite the old project path in a copied venv: `bin/*` (shebangs, activate
 * scripts) and `pyvenv.cfg`. `python -m venv --upgrade` does not do this.
 * Returns the number of files changed. Regular files only; a link is never
 * written through.
 */
export async function fixupVenv(
	venvDir: string,
	oldRoots: string[],
	newRoot: string,
): Promise<number> {
	const files = [join(venvDir, "pyvenv.cfg")];
	try {
		for (const e of await readdir(join(venvDir, "bin"), {
			withFileTypes: true,
		})) {
			if (e.isFile()) files.push(join(venvDir, "bin", e.name));
		}
	} catch {
		// no bin directory
	}
	const roots = [...new Set(oldRoots)].sort((a, b) => b.length - a.length);
	// A match must end at a path boundary: `/p/proj` is not `/p/proj2`.
	const re = new RegExp(
		`(?:${roots.map(escapeRe).join("|")})(?![A-Za-z0-9_.-])`,
		"g",
	);
	let changed = 0;
	for (const f of files) {
		let st: Awaited<ReturnType<typeof lstat>>;
		try {
			st = await lstat(f);
		} catch {
			continue;
		}
		if (!st.isFile() || st.size > MAX_FIXUP_BYTES) continue;
		const buf = await readFile(f);
		if (buf.subarray(0, 8000).includes(0)) continue;
		const text = buf.toString("utf8");
		const next = text.replace(re, () => newRoot);
		if (next !== text) {
			await writeFile(f, next);
			changed++;
		}
	}
	return changed;
}

/** Carry the declared caches from the primary into the new tree. Never throws for a refused cache. */
export async function seedCaches(
	opts: SeedCachesOptions,
): Promise<CacheOutcome[]> {
	const log = opts.log ?? (() => {});
	const primary = await realpath(opts.primaryRoot);
	const tree = await realpath(opts.treeRoot);
	const outcomes: CacheOutcome[] = [];
	const seen = new Set<string>();

	for (const decl of opts.declarations) {
		const skip = (reason: CacheSkipReason, detail?: string): CacheOutcome => {
			log(`cache ${decl.kind} ${decl.path}: skipped (${reason})`);
			return {
				kind: decl.kind,
				path: decl.path,
				status: "skipped",
				reason,
				...(detail ? { detail } : {}),
			};
		};

		const rel = normalizeCachePath(decl.path);
		if (decl.kind === "direnv" || rel?.split(sep).includes(".direnv")) {
			outcomes.push(skip("never_carried"));
			continue;
		}
		if (!rel) {
			outcomes.push(skip("invalid_path"));
			continue;
		}
		if (seen.has(rel)) continue;
		seen.add(rel);

		const src = join(primary, rel);
		const dst = join(tree, rel);
		if (!(await exists(src))) {
			outcomes.push(skip("missing"));
			continue;
		}
		// The source, and every component above it, must be real directories.
		if ((await realpath(src)) !== src) {
			outcomes.push(skip("symlink_path"));
			continue;
		}
		if (!(await isDir(src))) {
			outcomes.push(skip("not_a_directory"));
			continue;
		}
		if (await exists(dst)) {
			outcomes.push(skip("tracked_content_present"));
			continue;
		}
		const unsafe = await findUnsafeSymlink(src, primary);
		if (unsafe) {
			outcomes.push(skip("unsafe_symlink", unsafe));
			continue;
		}
		await mkdir(dirname(dst), { recursive: true });
		// The parent, resolved, must still be inside the tree (a tracked symlink).
		if (!under(await realpath(dirname(dst)), tree)) {
			outcomes.push(skip("symlink_path"));
			continue;
		}
		const copied = await reflinkCopy(src, dst, opts.timeoutMs);
		if (!copied.ok) {
			outcomes.push(skip("reflink_unsupported", copied.detail));
			continue;
		}
		const out: CacheOutcome = {
			kind: decl.kind,
			path: rel,
			status: "seeded",
		};
		if (decl.kind === "venv") {
			out.fixedFiles = await fixupVenv(
				dst,
				[opts.primaryRoot, primary].map((p) => resolve(p)),
				tree,
			);
		}
		log(`cache ${decl.kind} ${rel}: seeded`);
		outcomes.push(out);
	}
	return outcomes;
}
