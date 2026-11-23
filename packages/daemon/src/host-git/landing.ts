/**
 * The host-owned repository merges and pushes run from (backstage
 * architecture.md, "Host-executed paths").
 *
 * It lives in the daemon home, which no sandbox can see, and its config is the
 * one `git init` wrote. It has no refs of its own: git reads and writes objects
 * in the primary's object store through `GIT_OBJECT_DIRECTORY`, so nothing in the
 * primary's config, hooks or attributes is consulted. Objects are content
 * addressed, so a planted object cannot change what a commit id means.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { mfwHome } from "../config.ts";
import { runProc } from "../proc.ts";
import { requireHostTool } from "../sandbox.ts";
import { discoverGitDirs } from "./repo-config.ts";

export interface LandingRepo {
	gitDir: string;
	objects: string;
}

/** Pinned on every call. The landing config is empty, so these are belts. */
export const LANDING_OVERRIDES: readonly string[] = [
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.alternateRefsCommand=",
	"-c",
	"core.commitGraph=false",
	"-c",
	"protocol.ext.allow=never",
	"-c",
	"gc.auto=0",
	"-c",
	"maintenance.auto=false",
];

/** The landing repository for `projectRoot`, created on first use. */
export async function ensureLandingRepo(
	projectRoot: string,
	landingRoot: string = join(mfwHome(), "landing"),
): Promise<LandingRepo> {
	const dirs = discoverGitDirs(projectRoot);
	if (!dirs) throw new Error(`${projectRoot} is not a git repository`);
	const objects = join(realpathSync(dirs.commonDir), "objects");
	const id = createHash("sha256")
		.update(realpathSync(projectRoot))
		.digest("hex")
		.slice(0, 24);
	const gitDir = join(landingRoot, `${id}.git`);
	if (!existsSync(join(gitDir, "HEAD"))) {
		mkdirSync(landingRoot, { recursive: true, mode: 0o700 });
		const init = await runProc(
			[requireHostTool("git"), "init", "-q", "--bare", "--", gitDir],
			{
				cwd: landingRoot,
				env: {
					PATH: process.env.PATH ?? "",
					HOME: "/nonexistent",
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_NOSYSTEM: "1",
					// No template: a template directory could carry hooks.
					GIT_TEMPLATE_DIR: "",
				},
			},
		);
		if (init.exitCode !== 0) {
			throw new Error(`landing repository: ${init.stderr.trim()}`);
		}
	}
	return { gitDir, objects };
}

/** Points git at the landing repository and the primary's objects. */
export function landingRepoEnv(repo: LandingRepo): Record<string, string> {
	return {
		GIT_DIR: repo.gitDir,
		GIT_OBJECT_DIRECTORY: repo.objects,
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_ATTR_NOSYSTEM: "1",
		GIT_OPTIONAL_LOCKS: "0",
	};
}
