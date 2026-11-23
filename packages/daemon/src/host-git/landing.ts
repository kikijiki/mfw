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
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
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

export interface LandingResult {
	exitCode: number;
	/** Untrimmed: `-z` listings keep their separators. */
	stdout: string;
	stderr: string;
}

/** Run git in the landing repository with no global, system or repository config. */
export async function landingGit(
	repo: LandingRepo,
	args: string[],
	opts: { env?: Record<string, string>; input?: string } = {},
): Promise<LandingResult> {
	const r = await runProc(
		[requireHostTool("git"), ...LANDING_OVERRIDES, ...args],
		{
			cwd: repo.gitDir,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: "/nonexistent",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_TERMINAL_PROMPT: "0",
				...landingRepoEnv(repo),
				...opts.env,
			},
			...(opts.input !== undefined ? { input: opts.input } : {}),
		},
	);
	if (r.truncated)
		throw new Error(`git ${args[0]} produced more output than the cap`);
	return { exitCode: r.exitCode ?? -1, stdout: r.stdout, stderr: r.stderr };
}

async function landingOk(
	repo: LandingRepo,
	args: string[],
	opts: { env?: Record<string, string>; input?: string } = {},
): Promise<string> {
	const r = await landingGit(repo, args, opts);
	if (r.exitCode !== 0) {
		throw new Error(
			`git ${args[0]} failed: ${(r.stderr || r.stdout).trim().slice(-300)}`,
		);
	}
	return r.stdout.trim();
}

export interface LandingIdentity {
	name: string;
	email: string;
}

const identityEnv = (who: LandingIdentity): Record<string, string> => ({
	GIT_AUTHOR_NAME: who.name,
	GIT_AUTHOR_EMAIL: who.email,
	GIT_COMMITTER_NAME: who.name,
	GIT_COMMITTER_EMAIL: who.email,
});

/**
 * Merge `source` into `base` without a work tree: no checkout, so no filter;
 * an empty config, so a `merge=` attribute names no driver. Returns the merge
 * commit, `base` when there is nothing to merge, or null on a conflict.
 */
export async function landingMerge(
	repo: LandingRepo,
	base: string,
	source: string,
	message: string,
	who: LandingIdentity,
): Promise<string | null> {
	const ancestor = await landingGit(repo, [
		"merge-base",
		"--is-ancestor",
		source,
		base,
	]);
	if (ancestor.exitCode === 0) return base;
	const merged = await landingGit(repo, [
		"merge-tree",
		"--write-tree",
		"--no-messages",
		"-z",
		base,
		source,
	]);
	if (merged.exitCode === 1) return null;
	if (merged.exitCode !== 0) {
		throw new Error(
			`git merge-tree failed: ${merged.stderr.trim().slice(-300)}`,
		);
	}
	const tree = merged.stdout.split("\0")[0]?.trim() ?? "";
	if (!/^[0-9a-f]{40,64}$/.test(tree))
		throw new Error("git merge-tree gave no tree");
	return landingOk(
		repo,
		["commit-tree", tree, "-p", base, "-p", source, "-m", message],
		{ env: identityEnv(who) },
	);
}

/** Paths at `rev` under `pathspecs`, read in full. */
async function treePaths(
	repo: LandingRepo,
	rev: string,
	pathspecs: readonly string[],
): Promise<string[]> {
	const r = await landingGit(repo, [
		"ls-tree",
		"-r",
		"-z",
		"--name-only",
		rev,
		"--",
		...pathspecs,
	]);
	if (r.exitCode !== 0) {
		throw new Error(
			`mfw firewall could not inspect ${rev}: ${r.stderr.trim()}`,
		);
	}
	return r.stdout.split("\0").filter(Boolean);
}

/**
 * Put every protected path of `merge` back to its state at `base`. Returns the
 * commit to land (`merge`, or a replacement with the same parents) and the
 * paths that were reverted.
 */
export async function landingRestorePaths(
	repo: LandingRepo,
	base: string,
	merge: string,
	pathspecs: readonly string[],
	keep: (path: string) => boolean,
	who: LandingIdentity,
): Promise<{ sha: string; reverted: string[] }> {
	if (merge === base) return { sha: merge, reverted: [] };
	const baseFiles = await treePaths(repo, base, pathspecs);
	const mergeFiles = await treePaths(repo, merge, pathspecs);
	const paths = [...new Set([...baseFiles, ...mergeFiles])].filter(
		(p) => !keep(p),
	);
	if (paths.length === 0) return { sha: merge, reverted: [] };

	const index = join(repo.gitDir, `index-${process.pid}-${randomUUID()}`);
	const env = { GIT_INDEX_FILE: index };
	try {
		await landingOk(repo, ["read-tree", merge], { env });
		// `--index-info` needs no work tree; mode 0 removes the entry.
		const none = "0".repeat(base.length);
		await landingOk(repo, ["update-index", "-z", "--index-info"], {
			env,
			input: paths.map((p) => `0 ${none}\t${p}\0`).join(""),
		});
		const kept = new Set(paths);
		const inBase = baseFiles.filter((p) => kept.has(p));
		if (inBase.length > 0) {
			const listed = await landingGit(repo, [
				"ls-tree",
				"-r",
				"-z",
				base,
				"--",
				...inBase,
			]);
			if (listed.exitCode !== 0) {
				throw new Error(
					`board firewall could not read the base: ${listed.stderr.trim()}`,
				);
			}
			await landingOk(repo, ["update-index", "-z", "--index-info"], {
				env,
				input: listed.stdout,
			});
		}
		const tree = await landingOk(repo, ["write-tree"], { env });
		const diff = await landingGit(repo, [
			"diff-tree",
			"-r",
			"-z",
			"--name-only",
			"--no-renames",
			`${merge}^{tree}`,
			tree,
		]);
		if (diff.exitCode !== 0) {
			throw new Error(
				`board firewall could not verify paths: ${diff.stderr.trim()}`,
			);
		}
		const reverted = diff.stdout.split("\0").filter(Boolean);
		if (reverted.length === 0) return { sha: merge, reverted };
		const parents = (
			await landingOk(repo, ["rev-list", "--parents", "-n", "1", merge])
		)
			.split(" ")
			.slice(1);
		const message = await landingOk(repo, ["log", "-1", "--format=%B", merge]);
		const sha = await landingOk(
			repo,
			[
				"commit-tree",
				tree,
				...parents.flatMap((p) => ["-p", p]),
				"-m",
				message,
			],
			{ env: identityEnv(who) },
		);
		return { sha, reverted };
	} finally {
		await rm(index, { force: true });
		await rm(`${index}.lock`, { force: true });
	}
}
