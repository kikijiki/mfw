/**
 * Whether a compiled install is out of agents' reach (security review REL-1
 * M2). The manifest's hashes only prove the parts belong together: anyone who
 * can write the install can rewrite them. So the install itself must be where
 * an agent, or any process running as this user, cannot write it: the Nix
 * store, or a root-owned prefix that is not group- or world-writable, with
 * every parent the same, and not inside a directory agents write (the home
 * directory, temp directories, project roots).
 *
 * The same trusted-binary rule as host tools (`sandbox.ts`). A prefix that
 * fails it still works, loudly: `mfw server` warns, `mfw version` and the
 * doctor report it, and the launcher refuses every autonomous launch until the
 * owner names that exact prefix in `acknowledgeUntrustedInstall` in
 * `$MFW_HOME/config.json`.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
	agentWritableRoots,
	binaryTrustProblem,
	directoryTrustProblem,
	liveTrustIo,
	type PathTrustIo,
} from "../sandbox.ts";
import { type InstallManifest, installPath } from "./install-manifest.ts";

/** The config key that accepts an install that fails the check. */
export const ACK_UNTRUSTED_INSTALL = "acknowledgeUntrustedInstall";

export interface InstallTrustOptions {
	io?: PathTrustIo;
	writableRoots?: readonly string[];
}

/** Every entry under `dir` must be root-owned and not group- or world-writable. */
function treeProblem(dir: string, io: PathTrustIo): string | null {
	const st = io.lstat(dir);
	if (!st) return `${dir} does not exist`;
	if (st.kind === "link") return null; // links stay inside the tree (treeDigest)
	if (!io.rootUids.has(st.uid)) return `${dir} is not owned by root`;
	if (st.mode & 0o022) {
		return `${dir} is group- or world-writable`;
	}
	if (st.kind !== "dir") return null;
	for (const child of readdirSync(dir)) {
		const problem = treeProblem(join(dir, child), io);
		if (problem) return problem;
	}
	return null;
}

/** Each reason agents could change this install; empty when they cannot. */
export function installTrustProblems(
	prefix: string,
	libDir: string,
	manifest: InstallManifest,
	o: InstallTrustOptions = {},
): string[] {
	const io = o.io ?? liveTrustIo();
	const roots = o.writableRoots ?? agentWritableRoots();
	const problems: string[] = [];
	const add = (label: string, problem: string | null) => {
		if (problem) problems.push(`${label}: ${problem}`);
	};
	for (const dir of [join(prefix, "bin"), libDir]) {
		const real = io.realDir(dir);
		add(dir, real ? directoryTrustProblem(real, roots, io) : "does not exist");
	}
	add("mfw", binaryTrustProblem(installPath(libDir, manifest.mfw), roots, io));
	add(
		"mfw-board",
		binaryTrustProblem(installPath(libDir, manifest.mfwBoard), roots, io),
	);
	add(
		"runtime",
		binaryTrustProblem(installPath(libDir, manifest.runtime), roots, io),
	);
	if (problems.length === 0) add("lib/mfw", treeProblem(libDir, io));
	return problems;
}

/** The exact fix, for a warning or a refusal. */
export function installTrustFix(prefix: string): string {
	return `install into a root-owned prefix (extract the tarball as root with --no-same-owner, such as into /opt/mfw) or use the Nix package; or accept this prefix by setting "${ACK_UNTRUSTED_INSTALL}": ${JSON.stringify(prefix)} in $MFW_HOME/config.json`;
}
