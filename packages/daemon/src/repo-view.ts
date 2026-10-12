import { lstat, open, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { ProjectDbHandle } from "@mfw/db/client";
import { events, mergeJobs } from "@mfw/db/schema";
import { isTerminalRunState } from "@mfw/db/spans";
import { eq } from "drizzle-orm";
import { parseDiffPaths } from "./git-diff-paths.ts";
import { runProc } from "./proc.ts";
import type { RunRegistry, RunRow } from "./run-registry.ts";
import {
	MAX_IMAGE_BYTES,
	NotFoundError,
	PathEscapeError,
	viewerImageMime,
} from "./workspace.ts";

/**
 * The repository as a human reads it: branches, worktrees, commits, and what
 * differs between two refs. READ ONLY. Nothing here changes a ref, an index or
 * a working tree; the destructive moves belong to the services that own them.
 *
 * Every git call goes through `gitRead`, which:
 *  - spawns argv directly (never a shell), with a timeout and an output cap;
 *  - turns off everything a repository can configure to run code
 *    (`diff.external`, textconv, fsmonitor) and everything that would write
 *    (optional locks, the terminal prompt);
 *  - only ever receives user input as an already-validated ref name resolved
 *    to a full sha first, so later arguments are shas, never caller strings.
 *
 * Results are immutable per sha, so a small LRU keyed by (kind, shas, args)
 * answers repeats without touching git.
 */

/** A ref name or path the caller sent that cannot be a ref or a path; BAD_REQUEST. */
export class InvalidRefError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidRefError";
	}
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to reject them
const CONTROL = /[\u0000-\u001f\u007f]/;
const REF_CHARS = /^[A-Za-z0-9._/@+#=%,-]+$/;

/**
 * A revision the UI may name: a branch, remote branch, tag, `HEAD` or a sha.
 * Deliberately narrower than git's own grammar. It has no `..`, `@{`, `~`,
 * `^`, `:` or whitespace, so a caller cannot smuggle a range, a pathspec or a
 * reflog lookup, and it cannot begin with `-`, so it can never be an option.
 */
export function validateRefName(input: string): string {
	if (typeof input !== "string" || input.length === 0) {
		throw new InvalidRefError("a ref name is required");
	}
	if (input.length > 256) throw new InvalidRefError("ref name is too long");
	if (CONTROL.test(input)) {
		throw new InvalidRefError("ref name contains control characters");
	}
	if (input.startsWith("-")) {
		throw new InvalidRefError("ref name must not start with '-'");
	}
	if (!REF_CHARS.test(input)) {
		throw new InvalidRefError("ref name contains characters git refs forbid");
	}
	if (
		input.includes("..") ||
		input.includes("//") ||
		input.includes("@{") ||
		input.startsWith("/") ||
		input.endsWith("/") ||
		input.endsWith(".") ||
		input.endsWith(".lock") ||
		input.split("/").some((s) => s.startsWith("."))
	) {
		throw new InvalidRefError("ref name is not a valid git ref");
	}
	return input;
}

/** A repo-relative path: no control characters, no `.`/`..`/empty segments. */
export function validateRepoPath(input: string): string {
	if (CONTROL.test(input)) {
		throw new InvalidRefError("path contains control characters");
	}
	if (input.length > 4096) throw new InvalidRefError("path is too long");
	const trimmed = input.replace(/^[/\\]+/, "").replace(/\/+$/, "");
	if (trimmed === "") return "";
	if (
		trimmed
			.split("/")
			.some((s) => s === "" || s === "." || s === ".." || s.includes("\\"))
	) {
		throw new InvalidRefError("path must be repo-relative and normalised");
	}
	return trimmed;
}

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

export type RepoFileStatus =
	| "added"
	| "modified"
	| "deleted"
	| "renamed"
	| "copied"
	| "typechange";

export interface RepoFileChange {
	path: string;
	/** Pre-rename/copy path; equals `path` otherwise. */
	oldPath: string;
	status: RepoFileStatus;
	/** 0-100, renames and copies only. */
	similarity: number | null;
	/** Null for binary files. */
	added: number | null;
	deleted: number | null;
	binary: boolean;
}

export interface RepoDiffStat {
	files: RepoFileChange[];
	/** More files changed than the list carries. */
	truncated: boolean;
	added: number;
	deleted: number;
}

export interface RepoRunOwner {
	runId: string;
	taskId: string | null;
	state: string;
	/** The run still owns its branch (not terminal). */
	live: boolean;
	label: string;
}

export interface RepoMergeJob {
	id: number;
	state: string;
	error: string | null;
	targetBranch: string;
	/** The commit the branch landed as, from `merge.completed`. */
	mergedSha: string | null;
}

export interface RepoBranch {
	/** Short name: `main`, `origin/main`, `mfw/<run>`. */
	name: string;
	kind: "local" | "remote";
	sha: string;
	isIntegration: boolean;
	isHead: boolean;
	/** Commits on the branch the integration branch lacks / the reverse. */
	ahead: number;
	behind: number;
	/** Nothing on the branch is missing from the integration branch. */
	merged: boolean;
	lastCommit: { author: string; time: number; subject: string };
	upstream: string | null;
	/** How mfw created it: a run's `mfw/` branch or a `wip/` archive. */
	mfw: "run" | "wip" | null;
	run: RepoRunOwner | null;
	mergeJob: RepoMergeJob | null;
	/** The worktree that has this branch checked out. */
	worktreeId: string | null;
}

export interface RepoWorktree {
	/** Run id for a run's worktree, `root` for the primary, else `wt-<hash>`. */
	id: string;
	path: string;
	/** Path relative to the project root when inside it. */
	displayPath: string;
	primary: boolean;
	branch: string | null;
	detached: boolean;
	bare: boolean;
	head: string | null;
	locked: string | null;
	prunable: string | null;
	exists: boolean;
	run: RepoRunOwner | null;
	mergeJob: RepoMergeJob | null;
	/** `wip/` archives of the owning run, by branch name. */
	wipBranches: string[];
	/** Null when the checkout is gone or status was skipped. */
	dirty: { changed: number; truncated: boolean } | null;
	ahead: number | null;
	behind: number | null;
}

export interface RepoCommitRef {
	name: string;
	kind: "head" | "local" | "remote" | "tag";
}

export interface RepoCommitSummary {
	sha: string;
	parents: string[];
	author: string;
	time: number;
	subject: string;
	refs: RepoCommitRef[];
	taskIds: string[];
}

export interface RepoCommitDetail extends RepoCommitSummary {
	message: string;
	committer: string;
	committerTime: number;
	isMerge: boolean;
	/** What the stat is against: the first parent, or nothing for a root commit. */
	base: string | null;
	diff: RepoDiffStat;
}

export interface RepoFileDiff {
	path: string;
	oldPath: string;
	status: "added" | "modified" | "deleted" | "renamed";
	oldText: string;
	newText: string;
	binary: boolean;
	/** Why the text is empty for a non-empty file. */
	reason: "binary" | "oversize" | null;
}

export interface RepoTreeEntry {
	name: string;
	path: string;
	kind: "file" | "dir" | "symlink" | "other";
	size: number | null;
	modifiedAt: null;
}

export interface RepoWorktreeChange {
	path: string;
	from: string | null;
	index: string;
	worktree: string;
	untracked: boolean;
	added: number | null;
	deleted: number | null;
}

// ---------------------------------------------------------------------------
// limits
// ---------------------------------------------------------------------------

const GIT_TIMEOUT_MS = 20_000;
const STATUS_TIMEOUT_MS = 8_000;
const LIST_BYTES = 2 * 1024 * 1024;
const MAX_BRANCHES = 500;
const MAX_FILES = 500;
const MAX_UNTRACKED = 500;
const MAX_TREE_ENTRIES = 2000;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_BLOB_BYTES = 1024 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024;
const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
const SNIFF_BYTES = 8000;
const CACHE_ENTRIES = 300;
const STATUS_CONCURRENCY = 4;
const TASK_ID = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;
const WIP_BRANCH = /^wip\/(?:(.+)-)?([0-9A-HJKMNP-TV-Z]{26})(?:-\d+)?$/;

export interface RepoViewDeps {
	root: string;
	integrationBranch: string;
	registry: RunRegistry;
	handle: ProjectDbHandle;
}

interface GitOut {
	ok: boolean;
	stdout: string;
	stderr: string;
	truncated: boolean;
}

export class RepoViewService {
	private readonly cache = new Map<string, unknown>();
	private emptyTree: string | null = null;

	constructor(private readonly deps: RepoViewDeps) {}

	// ------------------------------------------------------------------
	// the one git runner
	// ------------------------------------------------------------------

	private async git(
		args: string[],
		opts: {
			cwd?: string;
			maxBytes?: number;
			timeoutMs?: number;
			input?: string;
		} = {},
	): Promise<GitOut> {
		const r = await runProc(
			[
				"git",
				"--no-pager",
				"-c",
				"core.quotepath=off",
				"-c",
				"core.fsmonitor=false",
				"-c",
				"diff.external=",
				"-c",
				"core.hooksPath=/dev/null",
				...args,
			],
			{
				cwd: opts.cwd ?? this.deps.root,
				timeoutMs: opts.timeoutMs ?? GIT_TIMEOUT_MS,
				maxOutputBytes: opts.maxBytes ?? LIST_BYTES,
				...(opts.input !== undefined ? { input: opts.input } : {}),
				env: {
					...process.env,
					GIT_OPTIONAL_LOCKS: "0",
					GIT_TERMINAL_PROMPT: "0",
					GIT_EXTERNAL_DIFF: "",
					LC_ALL: "C",
				},
			},
		);
		return {
			ok: r.exitCode === 0 && !r.timedOut,
			stdout: r.stdout,
			stderr: r.stderr,
			truncated: r.truncated,
		};
	}

	private cached<T>(key: string, make: () => Promise<T>): Promise<T> {
		const hit = this.cache.get(key);
		if (hit !== undefined) {
			// LRU: re-insert as most recent.
			this.cache.delete(key);
			this.cache.set(key, hit);
			return Promise.resolve(hit as T);
		}
		return make().then((value) => {
			this.cache.set(key, value);
			while (this.cache.size > CACHE_ENTRIES) {
				const oldest = this.cache.keys().next().value;
				if (oldest === undefined) break;
				this.cache.delete(oldest);
			}
			return value;
		});
	}

	/** Validate a ref name and resolve it to a full commit sha. */
	async resolve(ref: string): Promise<string> {
		const name = validateRefName(ref);
		const candidates = [
			`refs/heads/${name}`,
			`refs/remotes/${name}`,
			`refs/tags/${name}`,
			name,
		];
		for (const candidate of candidates) {
			const r = await this.git([
				"rev-parse",
				"--verify",
				"-q",
				"--end-of-options",
				`${candidate}^{commit}`,
			]);
			const sha = r.stdout.trim();
			if (r.ok && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
		}
		throw new NotFoundError(`no such ref: ${name}`);
	}

	private async getEmptyTree(): Promise<string> {
		if (this.emptyTree) return this.emptyTree;
		const r = await this.git(["hash-object", "-t", "tree", "--stdin"], {
			input: "",
		});
		this.emptyTree = r.ok
			? r.stdout.trim()
			: "4b825dc642cb6eb9a060e54bf8d69288fbee3391";
		return this.emptyTree;
	}

	// ------------------------------------------------------------------
	// registries
	// ------------------------------------------------------------------

	private async runIndex(): Promise<{
		byId: Map<string, RunRow>;
		byBranch: Map<string, RunRow>;
		byPath: Map<string, RunRow>;
	}> {
		const rows = await this.deps.registry.list();
		const byId = new Map<string, RunRow>();
		const byBranch = new Map<string, RunRow>();
		const byPath = new Map<string, RunRow>();
		for (const run of rows) {
			byId.set(run.id, run);
			if (run.branch) byBranch.set(run.branch, run);
			if (run.worktreePath) {
				byPath.set(run.worktreePath, run);
				const real = await realpath(run.worktreePath).catch(() => null);
				if (real) byPath.set(real, run);
			}
		}
		return { byId, byBranch, byPath };
	}

	private async mergeIndex(): Promise<Map<string, RepoMergeJob>> {
		const out = new Map<string, RepoMergeJob>();
		const jobs = await this.deps.handle.db.select().from(mergeJobs);
		const landed = await this.deps.handle.db
			.select({ runId: events.runId, payload: events.payload })
			.from(events)
			.where(eq(events.type, "merge.completed"));
		const shaByRun = new Map<string, string>();
		for (const row of landed) {
			const sha = (row.payload as { sha?: unknown }).sha;
			if (row.runId && typeof sha === "string") shaByRun.set(row.runId, sha);
		}
		for (const job of jobs) {
			out.set(job.runId, {
				id: job.id,
				state: job.state,
				error: job.error,
				targetBranch: job.targetBranch,
				mergedSha: shaByRun.get(job.runId) ?? null,
			});
		}
		return out;
	}

	private ownerOf(run: RunRow | undefined): RepoRunOwner | null {
		if (!run) return null;
		return {
			runId: run.id,
			taskId: run.taskId ?? null,
			state: run.state,
			live: !isTerminalRunState(run.state),
			label: run.label,
		};
	}

	// ------------------------------------------------------------------
	// worktrees
	// ------------------------------------------------------------------

	private async listWorktrees(): Promise<
		Omit<
			RepoWorktree,
			| "run"
			| "mergeJob"
			| "wipBranches"
			| "dirty"
			| "ahead"
			| "behind"
			| "displayPath"
			| "id"
			| "exists"
		>[]
	> {
		const r = await this.git(["worktree", "list", "--porcelain"]);
		if (!r.ok) return [];
		const out: Awaited<ReturnType<RepoViewService["listWorktrees"]>> = [];
		const blocks = r.stdout.split(/\n\n+/);
		for (const [index, block] of blocks.entries()) {
			let path: string | null = null;
			let head: string | null = null;
			let branch: string | null = null;
			let detached = false;
			let bare = false;
			let locked: string | null = null;
			let prunable: string | null = null;
			for (const line of block.split("\n")) {
				if (line.startsWith("worktree ")) path = line.slice(9);
				else if (line.startsWith("HEAD ")) head = line.slice(5);
				else if (line.startsWith("branch ")) {
					branch = line.slice(7).replace(/^refs\/heads\//, "");
				} else if (line === "detached") detached = true;
				else if (line === "bare") bare = true;
				else if (line === "locked" || line.startsWith("locked ")) {
					locked = line.slice(7).trim() || "locked";
				} else if (line === "prunable" || line.startsWith("prunable ")) {
					prunable = line.slice(9).trim() || "prunable";
				}
			}
			if (!path) continue;
			out.push({
				path,
				primary: index === 0,
				branch,
				detached,
				bare,
				head: head && !/^0+$/.test(head) ? head : null,
				locked,
				prunable,
			});
		}
		return out;
	}

	private worktreeId(path: string, primary: boolean, run?: RunRow): string {
		if (run) return run.id;
		if (primary) return "root";
		let h = 2166136261;
		for (const ch of path) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
		return `wt-${(h >>> 0).toString(16).padStart(8, "0")}`;
	}

	async worktrees(): Promise<{
		integrationBranch: string;
		worktrees: RepoWorktree[];
	}> {
		const [listed, runs, jobs, integ] = await Promise.all([
			this.listWorktrees(),
			this.runIndex(),
			this.mergeIndex(),
			this.resolve(this.deps.integrationBranch).catch(() => null),
		]);
		const wipByRun = await this.wipByRun();
		const root = await realpath(this.deps.root).catch(() => this.deps.root);
		const base = listed.map((wt) => {
			const byBranch = wt.branch ? runs.byBranch.get(wt.branch) : undefined;
			const run =
				runs.byPath.get(wt.path) ?? (wt.primary ? undefined : byBranch);
			return { wt, run };
		});
		const rows = await mapPool(
			base,
			STATUS_CONCURRENCY,
			async ({ wt, run }) => {
				const exists = await stat(wt.path).then(
					() => true,
					() => false,
				);
				const dirty =
					exists && !wt.bare && !wt.prunable
						? await this.dirtyCount(wt.path)
						: null;
				let ahead: number | null = null;
				let behind: number | null = null;
				if (integ && wt.head) {
					const ab = await this.aheadBehind(integ, wt.head);
					ahead = ab?.ahead ?? null;
					behind = ab?.behind ?? null;
				}
				const rel = relative(root, wt.path);
				const inside =
					rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
				return {
					...wt,
					id: this.worktreeId(wt.path, wt.primary, run),
					displayPath: wt.primary ? "." : inside ? rel : wt.path,
					exists,
					run: this.ownerOf(run),
					mergeJob: run ? (jobs.get(run.id) ?? null) : null,
					wipBranches: run ? (wipByRun.get(run.id) ?? []) : [],
					dirty,
					ahead,
					behind,
				} satisfies RepoWorktree;
			},
		);
		return { integrationBranch: this.deps.integrationBranch, worktrees: rows };
	}

	/** Cheap dirtiness: capped porcelain, never a full diff. */
	private async dirtyCount(
		cwd: string,
	): Promise<{ changed: number; truncated: boolean } | null> {
		const r = await this.git(
			["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
			{ cwd, maxBytes: 64 * 1024, timeoutMs: STATUS_TIMEOUT_MS },
		);
		if (!r.ok && !r.truncated) return null;
		const records = r.stdout.split("\0").filter(Boolean);
		return { changed: records.length, truncated: r.truncated };
	}

	private async wipByRun(): Promise<Map<string, string[]>> {
		const r = await this.git([
			"for-each-ref",
			"--format=%(refname:short)",
			"refs/heads/wip/",
		]);
		const out = new Map<string, string[]>();
		if (!r.ok) return out;
		for (const name of r.stdout.split("\n")) {
			const m = WIP_BRANCH.exec(name);
			if (!m?.[2]) continue;
			const list = out.get(m[2]) ?? [];
			list.push(name);
			out.set(m[2], list);
		}
		return out;
	}

	private async aheadBehind(
		base: string,
		tip: string,
	): Promise<{ ahead: number; behind: number } | null> {
		return this.cached(`ab:${base}:${tip}`, async () => {
			const r = await this.git([
				"rev-list",
				"--left-right",
				"--count",
				`${base}...${tip}`,
			]);
			if (!r.ok) return null;
			const [behind, ahead] = r.stdout.trim().split(/\s+/).map(Number);
			if (behind === undefined || ahead === undefined) return null;
			return { ahead, behind };
		});
	}

	// ------------------------------------------------------------------
	// branches, tags, summary
	// ------------------------------------------------------------------

	async refs(): Promise<{
		head: { branch: string | null; sha: string | null };
		integrationBranch: string;
		branches: { name: string; kind: "local" | "remote"; sha: string }[];
		tags: { name: string; sha: string }[];
		truncated: boolean;
	}> {
		const r = await this.git([
			"for-each-ref",
			`--count=${MAX_BRANCHES + 1}`,
			"--sort=-committerdate",
			"--format=%(refname)%00%(objectname)%00%(*objectname)",
			"refs/heads",
			"refs/remotes",
			"refs/tags",
		]);
		const branches: { name: string; kind: "local" | "remote"; sha: string }[] =
			[];
		const tags: { name: string; sha: string }[] = [];
		let truncated = false;
		const lines = r.ok ? r.stdout.split("\n").filter(Boolean) : [];
		for (const line of lines) {
			const [ref = "", sha = "", peeled = ""] = line.split("\0");
			if (ref.startsWith("refs/heads/")) {
				branches.push({ name: ref.slice(11), kind: "local", sha });
			} else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD")) {
				branches.push({ name: ref.slice(13), kind: "remote", sha });
			} else if (ref.startsWith("refs/tags/")) {
				tags.push({ name: ref.slice(10), sha: peeled || sha });
			}
		}
		if (lines.length > MAX_BRANCHES) truncated = true;
		const head = await this.git(["symbolic-ref", "--short", "-q", "HEAD"]);
		const headSha = await this.git(["rev-parse", "--verify", "-q", "HEAD"]);
		return {
			head: {
				branch: head.ok ? head.stdout.trim() || null : null,
				sha: headSha.ok ? headSha.stdout.trim() : null,
			},
			integrationBranch: this.deps.integrationBranch,
			branches,
			tags,
			truncated,
		};
	}

	async branches(): Promise<{
		integrationBranch: string;
		integrationSha: string | null;
		branches: RepoBranch[];
		truncated: boolean;
	}> {
		const integrationSha = await this.resolve(
			this.deps.integrationBranch,
		).catch(() => null);
		const r = await this.git([
			"for-each-ref",
			`--count=${MAX_BRANCHES + 1}`,
			"--sort=-committerdate",
			"--format=%(refname)%00%(objectname)%00%(HEAD)%00%(upstream:short)%00%(committerdate:unix)%00%(authorname)%00%(subject)",
			"refs/heads",
			"refs/remotes",
		]);
		const lines = r.ok ? r.stdout.split("\n").filter(Boolean) : [];
		const truncated = lines.length > MAX_BRANCHES;
		const [runs, jobs, wts] = await Promise.all([
			this.runIndex(),
			this.mergeIndex(),
			this.listWorktrees(),
		]);
		const worktreeByBranch = new Map<string, string>();
		for (const wt of wts) {
			if (!wt.branch) continue;
			const run = runs.byPath.get(wt.path) ?? runs.byBranch.get(wt.branch);
			worktreeByBranch.set(
				wt.branch,
				this.worktreeId(wt.path, wt.primary, run),
			);
		}
		const parsed = lines.slice(0, MAX_BRANCHES).flatMap((line) => {
			const [
				ref = "",
				sha = "",
				head = "",
				upstream = "",
				time = "0",
				author = "",
				...subject
			] = line.split("\0");
			if (ref.endsWith("/HEAD") && ref.startsWith("refs/remotes/")) return [];
			const local = ref.startsWith("refs/heads/");
			return [
				{
					name: ref.replace(/^refs\/(heads|remotes)\//, ""),
					kind: (local ? "local" : "remote") as "local" | "remote",
					sha,
					isHead: head === "*",
					upstream: upstream || null,
					time: Number(time) || 0,
					author,
					subject: subject.join("\0"),
				},
			];
		});

		const rows = await mapPool(parsed, 8, async (b): Promise<RepoBranch> => {
			const ab = integrationSha
				? await this.aheadBehind(integrationSha, b.sha)
				: null;
			const isRun = b.kind === "local" && b.name.startsWith("mfw/");
			const wip = b.kind === "local" ? WIP_BRANCH.exec(b.name) : null;
			const run =
				runs.byBranch.get(b.name) ??
				(isRun ? runs.byId.get(b.name.slice(4)) : undefined) ??
				(wip?.[2] ? runs.byId.get(wip[2]) : undefined);
			return {
				name: b.name,
				kind: b.kind,
				sha: b.sha,
				isIntegration:
					b.kind === "local" && b.name === this.deps.integrationBranch,
				isHead: b.isHead,
				ahead: ab?.ahead ?? 0,
				behind: ab?.behind ?? 0,
				merged: ab ? ab.ahead === 0 : false,
				lastCommit: { author: b.author, time: b.time, subject: b.subject },
				upstream: b.upstream,
				mfw: wip ? "wip" : isRun ? "run" : null,
				run: this.ownerOf(run),
				mergeJob: run ? (jobs.get(run.id) ?? null) : null,
				worktreeId: worktreeByBranch.get(b.name) ?? null,
			};
		});
		return {
			integrationBranch: this.deps.integrationBranch,
			integrationSha,
			branches: rows,
			truncated,
		};
	}

	async summary(): Promise<{
		integrationBranch: string;
		head: { branch: string | null; sha: string | null };
		branches: number;
		remoteBranches: number;
		mfwBranches: number;
		wipBranches: number;
		tags: number;
		worktrees: number;
	}> {
		const [refs, wts] = await Promise.all([this.refs(), this.listWorktrees()]);
		const local = refs.branches.filter((b) => b.kind === "local");
		return {
			integrationBranch: this.deps.integrationBranch,
			head: refs.head,
			branches: local.length,
			remoteBranches: refs.branches.length - local.length,
			mfwBranches: local.filter((b) => b.name.startsWith("mfw/")).length,
			wipBranches: local.filter((b) => b.name.startsWith("wip/")).length,
			tags: refs.tags.length,
			worktrees: wts.length,
		};
	}

	// ------------------------------------------------------------------
	// commits
	// ------------------------------------------------------------------

	async commits(input: {
		ref: string;
		exclude?: string;
		path?: string;
		search?: string;
		cursor?: string;
		limit?: number;
		firstParent?: boolean;
	}): Promise<{
		sha: string;
		commits: RepoCommitSummary[];
		nextCursor: string | null;
	}> {
		const sha = await this.resolve(input.ref);
		const exclude = input.exclude ? await this.resolve(input.exclude) : null;
		const path = input.path ? validateRepoPath(input.path) : "";
		const search = input.search?.trim() ?? "";
		if (CONTROL.test(search) || search.length > 100) {
			throw new InvalidRefError("search text is not valid");
		}
		const skip = input.cursor ? Number(input.cursor) : 0;
		if (!Number.isInteger(skip) || skip < 0 || skip > 1_000_000) {
			throw new InvalidRefError("cursor is not valid");
		}
		const limit = Math.min(Math.max(input.limit ?? PAGE_DEFAULT, 1), PAGE_MAX);
		const key = `log:${sha}:${exclude ?? ""}:${path}:${search}:${skip}:${limit}:${input.firstParent ? 1 : 0}`;
		const page = await this.cached(key, async () => {
			const args = [
				"log",
				"--no-color",
				"--no-show-signature",
				"--decorate=full",
				"--date-order",
				`--max-count=${limit + 1}`,
				`--skip=${skip}`,
				"--format=%x1e%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s",
			];
			if (input.firstParent) args.push("--first-parent");
			if (search) args.push("-i", "--fixed-strings", `--grep=${search}`);
			args.push(sha);
			if (exclude) args.push(`^${exclude}`);
			args.push("--");
			if (path) args.push(path);
			const r = await this.git(args);
			if (!r.ok) {
				throw new Error(`git log failed: ${r.stderr.trim().slice(0, 300)}`);
			}
			return r.stdout
				.split("\x1e")
				.filter((s) => s.trim() !== "")
				.map(parseCommitRecord);
		});
		const more = page.length > limit;
		return {
			sha,
			commits: page.slice(0, limit),
			nextCursor: more ? String(skip + limit) : null,
		};
	}

	async commit(input: { sha: string }): Promise<RepoCommitDetail> {
		const sha = await this.resolve(input.sha);
		return this.cached(`commit:${sha}`, async () => {
			const r = await this.git(
				[
					"show",
					"-s",
					"--no-color",
					"--no-show-signature",
					"--decorate=full",
					"--format=%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s%x1f%cn%x1f%ct%x1f%B",
					sha,
					"--",
				],
				{ maxBytes: MAX_MESSAGE_BYTES * 2 },
			);
			if (!r.ok) throw new NotFoundError(`no such commit: ${sha}`);
			const f = r.stdout.split("\x1f");
			const summary = parseCommitRecord(f.slice(0, 6).join("\x1f"));
			const message = f
				.slice(8)
				.join("\x1f")
				.trim()
				.slice(0, MAX_MESSAGE_BYTES);
			const base = summary.parents[0] ?? null;
			const diff = await this.diffStat(base, sha);
			const taskIds = [
				...new Set([...summary.taskIds, ...(message.match(TASK_ID) ?? [])]),
			];
			return {
				...summary,
				taskIds,
				message,
				committer: f[6] ?? summary.author,
				committerTime: Number(f[7]) || summary.time,
				isMerge: summary.parents.length > 1,
				base,
				diff,
			};
		});
	}

	// ------------------------------------------------------------------
	// diffs
	// ------------------------------------------------------------------

	/** Files changed between two commits (`from` null: against the empty tree). */
	private async diffStat(
		from: string | null,
		to: string,
	): Promise<RepoDiffStat> {
		const base = from ?? (await this.getEmptyTree());
		const common = [
			"diff",
			"--no-color",
			"--no-ext-diff",
			"--no-textconv",
			"-M",
			"-z",
		];
		const [names, nums] = await Promise.all([
			this.git([...common, "--name-status", base, to, "--"]),
			this.git([...common, "--numstat", base, to, "--"]),
		]);
		if (!names.ok) return { files: [], truncated: false, added: 0, deleted: 0 };
		const changes = parseDiffPaths(names.stdout);
		const numByPath = parseNumstat(nums.ok ? nums.stdout : "");
		const files: RepoFileChange[] = [];
		let added = 0;
		let deleted = 0;
		for (const c of changes) {
			const n = numByPath.get(c.newPath);
			if (n && n.added !== null) added += n.added;
			if (n && n.deleted !== null) deleted += n.deleted;
			if (files.length >= MAX_FILES) continue;
			files.push({
				path: c.newPath,
				oldPath: c.oldPath,
				status: statusOf(c.code),
				similarity: /^[RC]\d+$/.test(c.code) ? Number(c.code.slice(1)) : null,
				added: n?.added ?? null,
				deleted: n?.deleted ?? null,
				binary: n ? n.added === null : false,
			});
		}
		return {
			files,
			truncated: changes.length > MAX_FILES,
			added,
			deleted,
		};
	}

	/** Both sides of one file between two refs, for DiffView. */
	async fileDiff(input: {
		from?: string;
		to: string;
		path: string;
		oldPath?: string;
	}): Promise<RepoFileDiff> {
		const to = await this.resolve(input.to);
		const from = input.from ? await this.resolve(input.from) : null;
		const path = validateRepoPath(input.path);
		const oldPath = input.oldPath ? validateRepoPath(input.oldPath) : path;
		if (!path) throw new InvalidRefError("a file path is required");
		return this.cached(
			`fdiff:${from ?? "-"}:${to}:${oldPath}:${path}`,
			async () => {
				const oldSide = from ? await this.blobText(from, oldPath) : ABSENT_SIDE;
				const newSide = await this.blobText(to, path);
				if (!oldSide.exists && !newSide.exists) {
					throw new NotFoundError(`no such path in either revision: ${path}`);
				}
				const unreadable = oldSide.unreadable ?? newSide.unreadable;
				return {
					path,
					oldPath,
					status: !oldSide.exists
						? "added"
						: !newSide.exists
							? "deleted"
							: oldPath !== path
								? "renamed"
								: "modified",
					oldText: unreadable ? "" : oldSide.text,
					newText: unreadable ? "" : newSide.text,
					binary: unreadable !== undefined,
					reason: unreadable ?? null,
				};
			},
		);
	}

	private async blobText(
		sha: string,
		path: string,
	): Promise<{
		exists: boolean;
		text: string;
		size: number;
		unreadable?: "binary" | "oversize";
	}> {
		const spec = `${sha}:${path}`;
		const size = await this.git(["cat-file", "-s", spec]);
		if (!size.ok) return ABSENT_SIDE;
		const bytes = Number(size.stdout.trim());
		if (bytes > MAX_TEXT_BYTES) {
			return { exists: true, text: "", size: bytes, unreadable: "oversize" };
		}
		const body = await this.git(["cat-file", "blob", spec], {
			maxBytes: MAX_TEXT_BYTES + 1024,
		});
		if (!body.ok) return ABSENT_SIDE;
		if (body.stdout.slice(0, SNIFF_BYTES).includes("\0")) {
			return { exists: true, text: "", size: bytes, unreadable: "binary" };
		}
		return { exists: true, text: body.stdout, size: bytes };
	}

	/**
	 * A PR-shaped comparison. Three-dot (the default) diffs `b` against the
	 * merge base of `a` and `b`, so it shows only what `b` brought; two-dot
	 * diffs the two tips directly.
	 */
	async compare(input: {
		a: string;
		b: string;
		mode?: "three-dot" | "two-dot";
	}): Promise<{
		mode: "three-dot" | "two-dot";
		a: string;
		b: string;
		/** The commit the diff is taken from. */
		base: string;
		mergeBase: string | null;
		ahead: number;
		behind: number;
		diff: RepoDiffStat;
		commits: RepoCommitSummary[];
		commitsTruncated: boolean;
	}> {
		const a = await this.resolve(input.a);
		const b = await this.resolve(input.b);
		const requested = input.mode ?? "three-dot";
		return this.cached(`cmp:${requested}:${a}:${b}`, async () => {
			const mb = await this.git(["merge-base", a, b]);
			const mergeBase = mb.ok ? mb.stdout.trim() || null : null;
			const mode =
				requested === "three-dot" && mergeBase ? "three-dot" : "two-dot";
			const base = mode === "three-dot" && mergeBase ? mergeBase : a;
			const [diff, ab, log] = await Promise.all([
				this.diffStat(base, b),
				this.aheadBehind(a, b),
				this.commits({ ref: b, exclude: a, limit: 100 }),
			]);
			return {
				mode,
				a,
				b,
				base,
				mergeBase,
				ahead: ab?.ahead ?? 0,
				behind: ab?.behind ?? 0,
				diff,
				commits: log.commits,
				commitsTruncated: log.nextCursor !== null,
			};
		});
	}

	// ------------------------------------------------------------------
	// trees and blobs
	// ------------------------------------------------------------------

	async tree(input: { ref: string; path?: string }): Promise<{
		ref: string;
		sha: string;
		path: string;
		entries: RepoTreeEntry[];
		truncated: boolean;
	}> {
		const sha = await this.resolve(input.ref);
		const path = validateRepoPath(input.path ?? "");
		return this.cached(`tree:${sha}:${path}`, async () => {
			const spec = path ? `${sha}:${path}` : sha;
			const kind = await this.git(["cat-file", "-t", spec]);
			if (!kind.ok)
				throw new NotFoundError(`no such path at ${input.ref}: ${path}`);
			const t = kind.stdout.trim();
			if (t !== "tree" && t !== "commit") {
				throw new NotFoundError(`${path} is not a directory`);
			}
			const r = await this.git(["ls-tree", "-z", "-l", spec], {
				maxBytes: LIST_BYTES,
			});
			if (!r.ok) throw new NotFoundError(`cannot list ${path || "the tree"}`);
			const records = r.stdout.split("\0").filter(Boolean);
			const entries: RepoTreeEntry[] = [];
			for (const rec of records) {
				const tab = rec.indexOf("\t");
				if (tab < 0) continue;
				const [mode = "", type = "", , size = "-"] = rec
					.slice(0, tab)
					.split(/\s+/);
				const name = rec.slice(tab + 1);
				const kindOf: RepoTreeEntry["kind"] =
					type === "tree"
						? "dir"
						: type === "commit"
							? "other"
							: mode === "120000"
								? "symlink"
								: "file";
				entries.push({
					name,
					path: path ? `${path}/${name}` : name,
					kind: kindOf,
					size: kindOf === "file" && size !== "-" ? Number(size) : null,
					modifiedAt: null,
				});
			}
			entries.sort(
				(x, y) =>
					Number(y.kind === "dir") - Number(x.kind === "dir") ||
					x.name.localeCompare(y.name),
			);
			return {
				ref: input.ref,
				sha,
				path,
				entries: entries.slice(0, MAX_TREE_ENTRIES),
				truncated: entries.length > MAX_TREE_ENTRIES,
			};
		});
	}

	async blob(input: { ref: string; path: string }): Promise<{
		path: string;
		sha: string;
		size: number;
		bytes: number;
		truncated: boolean;
		binary: boolean;
		text: string;
		marker: string | null;
	}> {
		const sha = await this.resolve(input.ref);
		const path = validateRepoPath(input.path);
		if (!path) throw new InvalidRefError("a file path is required");
		return this.cached(`blob:${sha}:${path}`, async () => {
			const spec = `${sha}:${path}`;
			const kind = await this.git(["cat-file", "-t", spec]);
			if (!kind.ok)
				throw new NotFoundError(`no such file at ${input.ref}: ${path}`);
			if (kind.stdout.trim() !== "blob") {
				throw new NotFoundError(`${path} is a directory, not a file`);
			}
			const sizeOut = await this.git(["cat-file", "-s", spec]);
			const size = Number(sizeOut.stdout.trim()) || 0;
			const refuse = (marker: string, binary: boolean) => ({
				path,
				sha,
				size,
				bytes: 0,
				truncated: false,
				binary,
				text: "",
				marker,
			});
			if (size > MAX_BLOB_BYTES) {
				return refuse(
					`too large to render (${size} bytes; the limit is ${MAX_BLOB_BYTES})`,
					false,
				);
			}
			const body = await this.git(["cat-file", "blob", spec], {
				maxBytes: MAX_BLOB_BYTES + 1024,
			});
			if (!body.ok) throw new NotFoundError(`cannot read ${path}`);
			if (body.stdout.slice(0, SNIFF_BYTES).includes("\0")) {
				return refuse("binary file (contains NUL bytes), not rendered", true);
			}
			return {
				path,
				sha,
				size,
				bytes: size,
				truncated: false,
				binary: false,
				text: body.stdout,
				marker: null,
			};
		});
	}

	/**
	 * Raw bytes of an image at any ref, for `<img>`. Same ref and path rules as
	 * `blob`; only image extensions, only regular blobs (a symlink's "content"
	 * is its target text), capped at `MAX_IMAGE_BYTES`. Bytes are read without
	 * the text decoding `git()` applies, so they arrive intact.
	 */
	async blobBytes(input: { ref: string; path: string }): Promise<{
		data: Buffer;
		mime: string;
		size: number;
		sha: string;
	}> {
		const sha = await this.resolve(input.ref);
		const path = validateRepoPath(input.path);
		if (!path) throw new InvalidRefError("a file path is required");
		const mime = viewerImageMime(path);
		if (!mime) throw new NotFoundError(`${path} is not an image`);
		const spec = `${sha}:${path}`;
		const kind = await this.git(["cat-file", "-t", spec]);
		if (!kind.ok)
			throw new NotFoundError(`no such file at ${input.ref}: ${path}`);
		if (kind.stdout.trim() !== "blob") {
			throw new NotFoundError(`${path} is a directory, not a file`);
		}
		const entry = await this.git(["ls-tree", "-z", sha, "--", path]);
		if (entry.stdout.startsWith("120000")) {
			throw new NotFoundError(`${path} is a symlink`);
		}
		const size =
			Number((await this.git(["cat-file", "-s", spec])).stdout.trim()) || 0;
		if (size > MAX_IMAGE_BYTES) {
			throw new NotFoundError(`${path} is too large to serve`);
		}
		const proc = Bun.spawn(
			[
				"git",
				"--no-pager",
				"-c",
				"core.hooksPath=/dev/null",
				"cat-file",
				"blob",
				spec,
			],
			{
				cwd: this.deps.root,
				stdout: "pipe",
				stderr: "ignore",
				stdin: "ignore",
				env: {
					...process.env,
					GIT_OPTIONAL_LOCKS: "0",
					GIT_TERMINAL_PROMPT: "0",
					LC_ALL: "C",
				},
			},
		);
		const timer = setTimeout(() => proc.kill(), GIT_TIMEOUT_MS);
		let data: Buffer;
		try {
			data = Buffer.from(await new Response(proc.stdout).arrayBuffer());
			await proc.exited;
		} finally {
			clearTimeout(timer);
		}
		if (proc.exitCode !== 0 || data.byteLength !== size) {
			throw new NotFoundError(`cannot read ${path}`);
		}
		return { data, mime, size, sha };
	}

	// ------------------------------------------------------------------
	// uncommitted changes of one worktree
	// ------------------------------------------------------------------

	private async worktreePath(id: string): Promise<string> {
		const { worktrees } = await this.worktrees();
		const wt = worktrees.find((w) => w.id === id);
		if (!wt) throw new NotFoundError(`no such worktree: ${id}`);
		if (!wt.exists) throw new NotFoundError(`worktree ${id} is gone from disk`);
		return wt.path;
	}

	/** `git diff HEAD` plus the untracked listing, both capped. */
	async worktreeChanges(input: { id: string }): Promise<{
		id: string;
		branch: string | null;
		head: string | null;
		files: RepoWorktreeChange[];
		added: number;
		deleted: number;
		truncated: boolean;
	}> {
		const cwd = await this.worktreePath(input.id);
		const [status, nums, headOut, branchOut] = await Promise.all([
			this.git(["status", "--porcelain=v1", "-z", "--untracked-files=normal"], {
				cwd,
				timeoutMs: STATUS_TIMEOUT_MS,
			}),
			this.git(
				[
					"diff",
					"HEAD",
					"--no-color",
					"--no-ext-diff",
					"--no-textconv",
					"-M",
					"-z",
					"--numstat",
					"--",
				],
				{ cwd },
			),
			this.git(["rev-parse", "--verify", "-q", "HEAD"], { cwd }),
			this.git(["symbolic-ref", "--short", "-q", "HEAD"], { cwd }),
		]);
		const numByPath = parseNumstat(nums.ok ? nums.stdout : "");
		const parts = status.stdout.split("\0").filter((p) => p.length > 0);
		const files: RepoWorktreeChange[] = [];
		let untracked = 0;
		let truncated = status.truncated;
		let added = 0;
		let deleted = 0;
		for (let i = 0; i < parts.length; i++) {
			const record = parts[i] as string;
			const index = record[0] ?? " ";
			const worktree = record[1] ?? " ";
			const path = record.slice(3);
			let from: string | null = null;
			if (index === "R" || index === "C") from = (parts[++i] as string) ?? null;
			const isUntracked = index === "?" && worktree === "?";
			if (isUntracked) {
				untracked++;
				if (untracked > MAX_UNTRACKED) {
					truncated = true;
					continue;
				}
			}
			if (files.length >= MAX_FILES + MAX_UNTRACKED) {
				truncated = true;
				continue;
			}
			const n = numByPath.get(path);
			if (n?.added) added += n.added;
			if (n?.deleted) deleted += n.deleted;
			files.push({
				path,
				from,
				index,
				worktree,
				untracked: isUntracked,
				added: n?.added ?? null,
				deleted: n?.deleted ?? null,
			});
		}
		return {
			id: input.id,
			branch: branchOut.ok ? branchOut.stdout.trim() || null : null,
			head: headOut.ok ? headOut.stdout.trim() : null,
			files,
			added,
			deleted,
			truncated,
		};
	}

	/** HEAD against what is on disk, for one file of a worktree. */
	async worktreeFileDiff(input: {
		id: string;
		path: string;
		oldPath?: string;
	}): Promise<RepoFileDiff> {
		const cwd = await this.worktreePath(input.id);
		const path = validateRepoPath(input.path);
		const oldPath = input.oldPath ? validateRepoPath(input.oldPath) : path;
		if (!path) throw new InvalidRefError("a file path is required");

		const head = await this.git(["rev-parse", "--verify", "-q", "HEAD"], {
			cwd,
		});
		const oldSide = head.ok
			? await this.blobText(head.stdout.trim(), oldPath)
			: ABSENT_SIDE;

		const base = await realpath(cwd);
		const target = resolve(base, path);
		let newSide: Awaited<ReturnType<RepoViewService["blobText"]>> = ABSENT_SIDE;
		const info = await lstat(target).catch(() => null);
		if (info) {
			const real = await realpath(target).catch(() => null);
			// A symlink out of the tree is never followed.
			if (!real || (real !== base && !real.startsWith(base + sep))) {
				throw new PathEscapeError(path);
			}
			const st = await stat(real);
			if (st.isDirectory()) throw new NotFoundError(`${path} is a directory`);
			if (st.size > MAX_TEXT_BYTES) {
				newSide = {
					exists: true,
					text: "",
					size: st.size,
					unreadable: "oversize",
				};
			} else {
				const buf = new Uint8Array(st.size);
				const fh = await open(real, "r");
				try {
					if (st.size > 0) await fh.read(buf, 0, st.size, 0);
				} finally {
					await fh.close();
				}
				newSide = buf.subarray(0, SNIFF_BYTES).includes(0)
					? { exists: true, text: "", size: st.size, unreadable: "binary" }
					: {
							exists: true,
							text: new TextDecoder().decode(buf),
							size: st.size,
						};
			}
		}
		if (!oldSide.exists && !newSide.exists) {
			throw new NotFoundError(`no such path: ${path}`);
		}
		const unreadable = oldSide.unreadable ?? newSide.unreadable;
		return {
			path,
			oldPath,
			status: !oldSide.exists
				? "added"
				: !newSide.exists
					? "deleted"
					: oldPath !== path
						? "renamed"
						: "modified",
			oldText: unreadable ? "" : oldSide.text,
			newText: unreadable ? "" : newSide.text,
			binary: unreadable !== undefined,
			reason: unreadable ?? null,
		};
	}
}

// ---------------------------------------------------------------------------
// parsing helpers (exported for tests)
// ---------------------------------------------------------------------------

const ABSENT_SIDE = { exists: false, text: "", size: 0 } as {
	exists: boolean;
	text: string;
	size: number;
	unreadable?: "binary" | "oversize";
};

export function statusOf(code: string): RepoFileStatus {
	switch (code[0]) {
		case "A":
			return "added";
		case "D":
			return "deleted";
		case "R":
			return "renamed";
		case "C":
			return "copied";
		case "T":
			return "typechange";
		default:
			return "modified";
	}
}

/** `git diff --numstat -z`: `a\td\tpath\0`, or `a\td\t\0old\0new\0` for a move. Binary is `-`. */
export function parseNumstat(
	output: string,
): Map<string, { added: number | null; deleted: number | null }> {
	const out = new Map<
		string,
		{ added: number | null; deleted: number | null }
	>();
	const parts = output.split("\0");
	for (let i = 0; i < parts.length; i++) {
		const head = parts[i] ?? "";
		const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head);
		if (!m) continue;
		let path = m[3] ?? "";
		if (path === "") {
			i += 2; // old, new
			path = parts[i] ?? "";
		}
		out.set(path, {
			added: m[1] === "-" ? null : Number(m[1]),
			deleted: m[2] === "-" ? null : Number(m[2]),
		});
	}
	return out;
}

/** `%D` with `--decorate=full`: `HEAD -> refs/heads/main, refs/remotes/o/main, tag: refs/tags/v1`. */
export function parseDecorations(raw: string): RepoCommitRef[] {
	const out: RepoCommitRef[] = [];
	for (const piece of raw.split(", ")) {
		const p = piece.trim();
		if (!p) continue;
		if (p === "HEAD") {
			out.push({ name: "HEAD", kind: "head" });
		} else if (p.startsWith("HEAD -> ")) {
			out.push({ name: "HEAD", kind: "head" });
			out.push({
				name: p.slice(8).replace(/^refs\/heads\//, ""),
				kind: "local",
			});
		} else if (p.startsWith("tag: ")) {
			out.push({ name: p.slice(5).replace(/^refs\/tags\//, ""), kind: "tag" });
		} else if (p.startsWith("refs/remotes/")) {
			if (!p.endsWith("/HEAD")) {
				out.push({ name: p.slice(13), kind: "remote" });
			}
		} else if (p.startsWith("refs/heads/")) {
			out.push({ name: p.slice(11), kind: "local" });
		}
	}
	return out;
}

function parseCommitRecord(record: string): RepoCommitSummary {
	const [sha = "", parents = "", author = "", at = "0", refs = "", ...rest] =
		record.trim().split("\x1f");
	const subject = rest.join("\x1f");
	const decorated = parseDecorations(refs);
	const ids = new Set<string>(subject.match(TASK_ID) ?? []);
	for (const ref of decorated) {
		for (const id of ref.name.match(TASK_ID) ?? []) ids.add(id);
	}
	return {
		sha,
		parents: parents ? parents.split(" ") : [],
		author,
		time: Number(at) || 0,
		subject,
		refs: decorated,
		taskIds: [...ids],
	};
}

/** Bounded-concurrency map that keeps input order. */
async function mapPool<T, R>(
	items: readonly T[],
	size: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from(
		{ length: Math.min(size, items.length) },
		async () => {
			for (;;) {
				const i = next++;
				if (i >= items.length) return;
				out[i] = await fn(items[i] as T);
			}
		},
	);
	await Promise.all(workers);
	return out;
}
