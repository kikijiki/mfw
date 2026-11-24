/**
 * A compiled install: the `mfw` and `mfw-board` executables, the server bundle
 * and the pinned bun that runs it, described by one manifest.
 *
 *   <prefix>/bin/mfw
 *   <prefix>/bin/mfw-board
 *   <prefix>/lib/mfw/install.json        this manifest
 *   <prefix>/lib/mfw/server/ public/      the server bundle (`bun run build`)
 *   <prefix>/lib/mfw/runtime/bun          the pinned bun (tarball installs)
 *
 * The manifest is what makes a server bundle part of a compiled install. Such a
 * bundle has no host scripts: everything it runs on the host is `mfw __host`,
 * the sibling executable, checked against the hash recorded here before each
 * use. Removing the manifest does not turn the install back into one that loads
 * scripts: a plain bundle needs its host script manifest, which a compiled
 * install never ships, so every launch is refused.
 *
 * The hashes catch a partial upgrade, mixed versions and a damaged file. They
 * do not stop someone who can write the install: that is why it belongs in a
 * location agents cannot write (the Nix store, or a root-owned prefix).
 *
 * Node builtins only.
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const INSTALL_MANIFEST = "install.json";
export const INSTALL_MANIFEST_VERSION = 1;
/** Inside the prefix: where the manifest and the server bundle live. */
export const INSTALL_LIB_DIR = join("lib", "mfw");
/** The bundle's parts, hashed as one tree. The manifest itself is not part of it. */
export const SERVER_TREE_ENTRIES = [
	"server",
	"public",
	"THIRD_PARTY_NOTICES.txt",
] as const;

export interface InstallFile {
	/** Relative to the manifest's directory. The runtime may be absolute (a store path). */
	path: string;
	sha256: string;
}

export interface InstallManifest {
	version: number;
	kind: "compiled";
	mfw: InstallFile;
	mfwBoard: InstallFile;
	runtime: InstallFile & { bunVersion: string };
	/** `treeDigest` of the server bundle. */
	server: { digest: string };
}

const SHA256 = /^[0-9a-f]{64}$/;

export function sha256OfFile(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function regularFile(path: string): boolean {
	try {
		return lstatSync(path).isFile();
	} catch {
		return false;
	}
}

function validFile(v: unknown, absoluteOk: boolean): v is InstallFile {
	if (typeof v !== "object" || v === null) return false;
	const f = v as Partial<InstallFile>;
	return (
		typeof f.path === "string" &&
		f.path !== "" &&
		!f.path.includes("\0") &&
		(absoluteOk || !isAbsolute(f.path)) &&
		typeof f.sha256 === "string" &&
		SHA256.test(f.sha256)
	);
}

/**
 * The manifest in `libDir`, null when there is none. A manifest that is there
 * but not valid is an error, never "no manifest".
 */
export function readInstallManifest(libDir: string): InstallManifest | null {
	const path = join(libDir, INSTALL_MANIFEST);
	let st: ReturnType<typeof lstatSync>;
	try {
		st = lstatSync(path);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
	if (!st.isFile()) {
		throw new Error(
			`refusing: the install manifest ${path} is not a regular file`,
		);
	}
	let parsed: Partial<InstallManifest>;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error(`refusing: the install manifest ${path} is unreadable`);
	}
	if (
		parsed.version !== INSTALL_MANIFEST_VERSION ||
		parsed.kind !== "compiled" ||
		!validFile(parsed.mfw, false) ||
		!validFile(parsed.mfwBoard, false) ||
		!validFile(parsed.runtime, true) ||
		typeof parsed.runtime.bunVersion !== "string" ||
		typeof parsed.server?.digest !== "string" ||
		!SHA256.test(parsed.server.digest)
	) {
		throw new Error(
			`refusing: the install manifest ${path} has the wrong format. Reinstall mfw`,
		);
	}
	return parsed as InstallManifest;
}

/**
 * Where a manifest entry points. A relative path must stay inside the prefix
 * (the parent of `lib/mfw`), so a manifest cannot point at a checkout or a
 * home directory.
 */
export function installPath(libDir: string, file: InstallFile): string {
	if (isAbsolute(file.path)) return file.path;
	const prefix = resolve(libDir, "..", "..");
	const target = resolve(libDir, file.path);
	const rel = relative(prefix, target);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(
			`refusing: the install manifest points outside the install (${file.path})`,
		);
	}
	return target;
}

/** Why `path` does not match `sha256`, or null when it does. */
export function fileMismatch(path: string, sha256: string): string | null {
	if (!regularFile(path)) return `${path} is not a regular file`;
	return sha256OfFile(path) === sha256
		? null
		: `${path} does not match the hash in the install manifest`;
}

/**
 * One sha256 over a tree, from each entry's type, path and content (or link
 * target). Order-independent of the filesystem; anything other than files,
 * directories and links that stay inside the tree is refused.
 */
export function treeDigest(
	root: string,
	entries: readonly string[] = SERVER_TREE_ENTRIES,
): string {
	const lines: string[] = [];
	const visit = (rel: string) => {
		const abs = join(root, rel);
		const st = lstatSync(abs);
		const name = rel.split(sep).join("/");
		if (st.isDirectory()) {
			lines.push(`d ${name}`);
			for (const child of readdirSync(abs).sort()) visit(join(rel, child));
		} else if (st.isFile()) {
			lines.push(`f ${name} ${sha256OfFile(abs)}`);
		} else if (st.isSymbolicLink()) {
			// A link may only point within the tree: one into a checkout or a home
			// directory would load code from where an agent might write.
			const target = readlinkSync(abs);
			const inside = relative(resolve(root), resolve(dirname(abs), target));
			if (isAbsolute(target) || inside.startsWith("..") || isAbsolute(inside)) {
				throw new Error(
					`refusing ${abs}: it links outside the install (${target})`,
				);
			}
			lines.push(`l ${name} ${target}`);
		} else {
			throw new Error(`refusing to hash ${abs}: not a file, directory or link`);
		}
	};
	for (const entry of entries) visit(entry);
	lines.sort();
	return createHash("sha256")
		.update(`${lines.join("\n")}\n`)
		.digest("hex");
}

/** The install's prefix and lib directory for an executable inside `<prefix>/bin`. */
export function installOfExecutable(executable: string): {
	prefix: string;
	libDir: string;
} {
	const prefix = dirname(dirname(executable));
	return { prefix, libDir: join(prefix, INSTALL_LIB_DIR) };
}

export interface InstallCheck {
	libDir: string;
	manifest: InstallManifest | null;
	/** Each reason the install does not verify; empty when it does. */
	problems: string[];
}

/**
 * Check a compiled install against its manifest: the two executables, the
 * runtime and the server tree. `expected` holds digests the running `mfw`
 * carries from its own build, so a manifest rewritten to match other files is
 * still caught. Nothing is written.
 */
export function checkInstall(
	libDir: string,
	expected: { server?: string; runtime?: string; self?: string } = {},
): InstallCheck {
	const problems: string[] = [];
	let manifest: InstallManifest | null;
	try {
		manifest = readInstallManifest(libDir);
	} catch (e) {
		return { libDir, manifest: null, problems: [(e as Error).message] };
	}
	if (!manifest) {
		return {
			libDir,
			manifest: null,
			problems: [`no install manifest at ${join(libDir, INSTALL_MANIFEST)}`],
		};
	}
	const file = (label: string, entry: InstallFile) => {
		try {
			const problem = fileMismatch(installPath(libDir, entry), entry.sha256);
			if (problem) problems.push(`${label}: ${problem}`);
		} catch (e) {
			problems.push(`${label}: ${(e as Error).message}`);
		}
	};
	file("mfw", manifest.mfw);
	file("mfw-board", manifest.mfwBoard);
	file("runtime", manifest.runtime);
	if (expected.self) {
		try {
			if (resolve(expected.self) !== installPath(libDir, manifest.mfw)) {
				problems.push(
					`mfw: this executable (${expected.self}) is not the install's mfw`,
				);
			}
		} catch (e) {
			problems.push(`mfw: ${(e as Error).message}`);
		}
	}
	if (expected.runtime && expected.runtime !== manifest.runtime.sha256) {
		problems.push(
			"runtime: the manifest names another bun than this mfw was built with",
		);
	}
	try {
		const digest = treeDigest(libDir);
		if (digest !== manifest.server.digest) {
			problems.push("server: the bundle does not match the install manifest");
		} else if (expected.server && expected.server !== digest) {
			problems.push(
				"server: the bundle is not the one this mfw was built with",
			);
		}
	} catch (e) {
		problems.push(`server: ${(e as Error).message}`);
	}
	return { libDir, manifest, problems };
}
