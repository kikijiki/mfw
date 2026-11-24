/**
 * What kind of build this code runs from, and what the build stamped into it.
 *
 *  - `source`: a checkout run with bun; nothing is stamped.
 *  - `bundle`: the production server output (`bun run build`), run by bun.
 *  - `compiled`: a standalone `mfw` or `mfw-board` executable.
 *
 * The stamp is a build-time constant (`__MFW_BUILD__`, a bundler define), so no
 * environment variable or file can change the kind of a running build. A
 * compiled executable is also recognised by its embedded module paths, so a
 * compile that lost its stamp still never runs as `source`.
 *
 * No imports: the host scripts and the board CLI load this too.
 */

export type BuildKind = "source" | "bundle" | "compiled";

export interface BuildStamp {
	kind: "bundle" | "compiled";
	/** The version of the package that was built. */
	version: string;
	/** The commit it was built from, `unknown` outside a git checkout. */
	gitSha: string;
	/** ISO time: `SOURCE_DATE_EPOCH` when set, else the commit time. */
	buildTime: string;
	/** The bun that built it (for a compiled executable, the bun inside it). */
	bunVersion: string;
	/** A compiled executable's target, such as `bun-linux-x64`. */
	target?: string;
	/** Named sha256 digests the build recorded, such as the server tree. */
	integrity?: Record<string, string>;
}

declare const __MFW_BUILD__: BuildStamp | undefined;

/** Bun's virtual root for the modules inside a standalone executable. */
const COMPILED_ROOT = "file:///$bunfs/";

export function buildStamp(): BuildStamp | null {
	return typeof __MFW_BUILD__ === "undefined" ? null : __MFW_BUILD__;
}

/** True when `moduleUrl` is a module inside a standalone executable. */
export function isCompiledModuleUrl(moduleUrl: string): boolean {
	return moduleUrl.startsWith(COMPILED_ROOT);
}

export function buildKind(): BuildKind {
	if (isCompiledModuleUrl(import.meta.url)) return "compiled";
	return buildStamp()?.kind ?? "source";
}
