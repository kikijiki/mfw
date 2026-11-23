/**
 * The allowlist for repository-scope git config (backstage architecture.md,
 * "Host-executed paths").
 *
 * A denylist of keys that run programs cannot be complete: git 2.54 added
 * `hook.<name>.command`, which `core.hooksPath` does not disable. So every host
 * git call first reads the repository's own config files and refuses unless
 * each key is one this list names. The operator's global and system config are
 * theirs and are not audited.
 *
 * The files are read with `git config --file`, which neither follows includes
 * nor runs anything. An unreadable config counts as a refusal.
 */
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { runProc } from "../proc.ts";
import { requireHostTool } from "../sandbox.ts";

export interface RepoConfigRefusal {
	keys: string[];
	message: string;
}

const EXACT = new Set([
	"core.repositoryformatversion",
	"core.filemode",
	"core.bare",
	"core.logallrefupdates",
	"core.ignorecase",
	"core.precomposeunicode",
	"core.symlinks",
	"core.sparsecheckout",
	"core.sparsecheckoutcone",
	// Inert: every host git call pins both with `-c`.
	"core.hookspath",
	"core.fsmonitor",
	"extensions.objectformat",
	"extensions.worktreeconfig",
	"extensions.refstorage",
	"lfs.repositoryformatversion",
	"user.name",
	"user.email",
	"init.defaultbranch",
	"pull.rebase",
	"pull.ff",
	"push.default",
	"fetch.prune",
	"merge.conflictstyle",
	"diff.algorithm",
	"diff.renames",
	"rerere.enabled",
	"rerere.autoupdate",
	"uploadpack.allowanysha1inwant",
]);

/** `<section>.<subsection>.<variable>` shapes whose values are data. */
const SUBSECTION: readonly RegExp[] = [
	// The push target comes from the daemon home, never from `remote.*.url`.
	/^remote\..+\.(?:url|fetch|tagopt|prune)$/,
	/^branch\..+\.(?:remote|merge|rebase|description|vscode-merge-base)$/,
];
const SECTION: readonly RegExp[] = [
	// Ownership stamps the worktree code writes; data, never run.
	/^mfw\.owner-[a-z-]+$/,
	/^advice\.[a-z0-9-]+$/,
	/^color\.[a-z.-]+$/,
];

/** Section and variable names are case-insensitive; a subsection is not. */
function normalizeKey(key: string): string {
	const first = key.indexOf(".");
	const last = key.lastIndexOf(".");
	if (first < 0) return key.toLowerCase();
	if (first === last) return key.toLowerCase();
	return `${key.slice(0, first).toLowerCase()}${key.slice(first, last)}${key.slice(last).toLowerCase()}`;
}

export function isAllowedRepoConfigKey(key: string): boolean {
	const k = normalizeKey(key);
	return (
		EXACT.has(k) ||
		SUBSECTION.some((re) => re.test(k)) ||
		SECTION.some((re) => re.test(k))
	);
}

interface GitDirs {
	gitDir: string;
	commonDir: string;
}

function isDir(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

function readTrimmed(path: string): string | null {
	try {
		return readFileSync(path, "utf8").slice(0, 8192).trim();
	} catch {
		return null;
	}
}

function dirsFrom(gitDir: string): GitDirs {
	const common = readTrimmed(join(gitDir, "commondir"));
	return {
		gitDir,
		commonDir: common ? resolve(gitDir, common) : gitDir,
	};
}

/** The gitdir git would discover from `cwd`. Null outside a repository. */
export function discoverGitDirs(cwd: string): GitDirs | null {
	let cur = resolve(cwd);
	for (;;) {
		const dot = join(cur, ".git");
		if (isDir(dot)) return dirsFrom(dot);
		const file = readTrimmed(dot);
		if (file?.startsWith("gitdir:")) {
			const target = file.slice("gitdir:".length).trim();
			return dirsFrom(isAbsolute(target) ? target : resolve(cur, target));
		}
		if (isDir(join(cur, "objects")) && isDir(join(cur, "refs"))) {
			if (readTrimmed(join(cur, "HEAD")) !== null) return dirsFrom(cur);
		}
		const up = dirname(cur);
		if (up === cur) return null;
		cur = up;
	}
}

/**
 * What a sandbox may touch of the gitdir behind `cwd`. A plain repository is
 * read-only. A linked worktree needs its common dir writable, because git takes
 * `packed-refs.lock` there on every ref update, so each entry that steers git
 * is bound read-only over it: a mount cannot be replaced or renamed. Only its
 * private gitdir, the object store and its branch's ref and log directories
 * are writable below those.
 */
export function sandboxGitBinds(
	cwd: string,
): { writable: string[]; readOnly: string[]; reopened: string[] } | null {
	const dirs = discoverGitDirs(cwd);
	if (!dirs) return null;
	const { gitDir, commonDir } = dirs;
	if (!isDir(commonDir)) return null;
	if (gitDir === commonDir) {
		return { writable: [], readOnly: [commonDir], reopened: [] };
	}
	// An absent `packed-refs` could be created to forge a branch.
	const packed = join(commonDir, "packed-refs");
	if (!existsSync(packed)) writeFileSync(packed, "", { flag: "a" });
	const readOnly = [
		"config",
		"HEAD",
		"packed-refs",
		"hooks",
		"info",
		"refs",
		"logs",
		"worktrees",
	]
		.map((name) => join(commonDir, name))
		.filter((path) => existsSync(path));
	const reopened = [gitDir, join(commonDir, "objects")];
	const head = readTrimmed(join(gitDir, "HEAD"));
	const ref = head?.startsWith("ref: refs/heads/")
		? head.slice("ref: ".length)
		: null;
	// A branch at the top of refs/heads would expose its siblings, so only a
	// namespaced one (`mfw/<run>`) gets a writable directory.
	if (ref && ref.split("/").length > 3) {
		const refDir = dirname(join(commonDir, ref));
		const logDir = dirname(join(commonDir, "logs", ref));
		mkdirSync(refDir, { recursive: true });
		mkdirSync(logDir, { recursive: true });
		reopened.push(refDir, logDir);
	}
	return { writable: [commonDir], readOnly, reopened };
}

interface CachedAudit {
	stamp: string;
	keys: string[] | null;
}
const audits = new Map<string, CachedAudit>();
const MAX_CACHED = 512;

function stampOf(path: string): string {
	try {
		const st = lstatSync(path, { bigint: true });
		return `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.mode}`;
	} catch {
		return "absent";
	}
}

/** The keys of one config file, or null when it cannot be read. */
async function keysOf(path: string): Promise<string[] | null> {
	const stamp = stampOf(path);
	if (stamp === "absent") return [];
	const hit = audits.get(path);
	if (hit?.stamp === stamp) return hit.keys;
	const r = await runProc(
		[
			requireHostTool("git"),
			"config",
			"--file",
			path,
			"--list",
			"--name-only",
			"-z",
		],
		{
			// Outside any repository: a hostile `core.worktree` must not break the read.
			cwd: "/",
			env: {
				PATH: process.env.PATH ?? "",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				HOME: "/nonexistent",
			},
		},
	);
	const keys =
		r.exitCode === 0 && !r.truncated
			? r.stdout.split("\0").filter(Boolean)
			: null;
	if (audits.size >= MAX_CACHED) audits.clear();
	// Re-stat: a file that changed during the read is not cached as clean.
	if (stampOf(path) === stamp) audits.set(path, { stamp, keys });
	return keys;
}

/** Why host git must not run in `cwd`, or null when its config is allowlisted. */
export async function repoConfigRefusal(
	cwd: string,
): Promise<RepoConfigRefusal | null> {
	const dirs = discoverGitDirs(cwd);
	if (!dirs) return null;
	const files = new Set([
		join(dirs.commonDir, "config"),
		join(dirs.commonDir, "config.worktree"),
		join(dirs.gitDir, "config.worktree"),
	]);
	const bad = new Set<string>();
	for (const file of files) {
		const keys = await keysOf(file);
		if (keys === null) {
			return {
				keys: [file],
				message: `refusing to run git: cannot read ${file}. Fix: repair that file with \`git config --file\`.`,
			};
		}
		for (const key of keys) {
			if (!isAllowedRepoConfigKey(key)) bad.add(key);
		}
	}
	if (bad.size === 0) return null;
	const keys = [...bad].sort();
	return {
		keys,
		message: `refusing to run git: the repository's config sets keys mfw does not allow (${keys.join(", ")}). Fix: remove them with \`git config --unset\`, or move them to your global git config if you set them yourself.`,
	};
}
