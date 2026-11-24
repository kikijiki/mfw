/**
 * The refusal in front of every plain host git call. A run workspace is
 * agent-writable, and git run there executes what its config names
 * (`core.fsmonitor`, hooks, filters). Only `HostGit` and the seed and scratch
 * paths built on it may touch one, and they say so with `hostGitChecked`.
 *
 * Roots stay registered for the life of the process, so detaching a project
 * cannot reopen a live clone to plain git.
 */

import { basename, join, resolve } from "node:path";
import { isUnder } from "./paths.ts";

const roots = new Set<string>();

export function registerRunWorkspaceRoot(root: string): void {
	roots.add(resolve(root));
}

function workspaceRoots(env: NodeJS.ProcessEnv = process.env): string[] {
	const home = env.MFW_HOME;
	return home ? [...roots, join(home, "workspaces")] : [...roots];
}

/** True for a path at or below a run workspace root, through any symlink. */
export function isRunWorkspacePath(path: string): boolean {
	return workspaceRoots().some((root) => isUnder(path, root));
}

export class LegacyGitRefusedError extends Error {
	constructor(path: string) {
		super(`refusing to run host git in a run workspace: ${path}`);
		this.name = "LegacyGitRefusedError";
	}
}

const PATH_FLAGS = ["-C", "--git-dir", "--work-tree"];

/** Every location this git command would operate on. */
function gitLocations(
	argv: readonly string[],
	cwd: string | undefined,
	env: NodeJS.ProcessEnv | undefined,
): string[] {
	const base = cwd ?? process.cwd();
	const out = [base];
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (PATH_FLAGS.includes(arg) && argv[i + 1] !== undefined) {
			out.push(resolve(base, argv[i + 1] as string));
			i++;
			continue;
		}
		for (const flag of ["--git-dir=", "--work-tree="]) {
			if (arg.startsWith(flag)) {
				out.push(resolve(base, arg.slice(flag.length)));
			}
		}
	}
	for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) {
		const value = env?.[name];
		if (value) out.push(resolve(base, value));
	}
	return out;
}

/** Throws if `argv` is a git command aimed at a run workspace. */
export function assertLegacyGitAllowed(
	argv: readonly string[],
	cwd: string | undefined,
	env: NodeJS.ProcessEnv | undefined,
): void {
	if (basename(argv[0] ?? "") !== "git") return;
	for (const location of gitLocations(argv, cwd, env)) {
		if (isRunWorkspacePath(location)) {
			throw new LegacyGitRefusedError(location);
		}
	}
}
