/**
 * The libsql native addon inside a compiled `mfw`.
 *
 * `tools/compile.ts` embeds the `.node` file and rewrites libsql's loader to
 * call the function registered here, so nothing is looked up by package name
 * or from `node_modules` at run time. A shared object cannot be loaded from
 * inside the executable, so on first use it is written to a new private
 * directory (`mkdtemp` under `$TMPDIR`, created exclusively), checked against
 * the sha256 recorded at build, loaded, and removed again. That works from a
 * read-only install location: the only thing written is the private copy, which
 * is gone before any query runs. A `$TMPDIR` that cannot be written is a clear
 * error, and so is one mounted `noexec`: neither falls back to another copy.
 *
 * Bun's own handling of an embedded addon writes it to a fixed name in the
 * temp directory; this keeps the name unguessable and the bytes checked.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const LIBSQL_LOADER = Symbol.for("mfw.libsqlNative");

export interface NativeAddon {
	/** The embedded file (a path inside the executable). */
	file: string;
	sha256: string;
}

export interface NativeIo {
	read: (path: string) => Uint8Array;
	tmp: () => string;
	dlopen: (module: { exports: unknown }, path: string) => void;
}

const liveIo: NativeIo = {
	read: (p) => readFileSync(p),
	tmp: () => tmpdir(),
	dlopen: (m, p) => process.dlopen(m, p),
};

/** Load the addon once: check, copy privately, load, remove the copy. */
export function loadNativeAddon(
	addon: NativeAddon,
	io: NativeIo = liveIo,
): unknown {
	const bytes = io.read(addon.file);
	const actual = createHash("sha256").update(bytes).digest("hex");
	if (actual !== addon.sha256) {
		throw new Error(
			"refusing to load the libsql addon: it does not match the hash recorded at build. Fix: reinstall mfw",
		);
	}
	let dir: string;
	try {
		dir = mkdtempSync(join(io.tmp(), "mfw-native-"));
	} catch (e) {
		throw new Error(
			`cannot load the libsql addon: no private directory under ${io.tmp()} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}). Fix: point TMPDIR at a writable directory`,
		);
	}
	try {
		const path = join(dir, "libsql.node");
		writeFileSync(path, bytes, { mode: 0o500, flag: "wx" });
		const module = { exports: {} as unknown };
		try {
			io.dlopen(module, path);
		} catch (e) {
			// The usual cause on a hardened host is a temp directory mounted noexec.
			throw new Error(
				`cannot load the libsql addon from ${io.tmp()}: ${(e as Error).message}. If that directory is mounted noexec, point TMPDIR at a private directory that allows execution`,
			);
		}
		return module.exports;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Called by the compiled entry before anything opens a database. */
export function installLibsqlLoader(addon: NativeAddon): void {
	let loaded: unknown;
	(globalThis as Record<symbol, unknown>)[LIBSQL_LOADER] = () => {
		loaded ??= loadNativeAddon(addon);
		return loaded;
	};
}
