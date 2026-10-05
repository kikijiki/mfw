import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { git } from "./git.ts";
import { runProc } from "./proc.ts";
import type { RunRegistry } from "./run-registry.ts";

/**
 * Read-only workspace browser over the project root or a run's worktree.
 *
 * Path containment is why this is a daemon service and not a tRPC router: a
 * lexical `startsWith(root)` check passes a symlink inside the tree that points
 * at `/etc`, and agents commit symlinks freely. Every path goes through
 * `fs.realpath` first so the check runs on the physical path, and listings
 * never follow symlinks (a link out of the tree is reported as a link).
 *
 * Reads are capped (default 1 MiB), binaries are refused with a marker, and
 * listings are capped so a `node_modules` directory cannot flood a response.
 */

/** A path that escaped the base directory; mapped to FORBIDDEN by the API. */
export class PathEscapeError extends Error {
	constructor(requested: string) {
		super(`path '${requested}' resolves outside the workspace`);
		this.name = "PathEscapeError";
	}
}

/** Missing file/dir/worktree; mapped to NOT_FOUND by the API. */
export class NotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NotFoundError";
	}
}

export type EntryKind = "file" | "dir" | "symlink" | "other";

export interface DirEntry {
	name: string;
	/** Base-relative, always with `/` separators. */
	path: string;
	kind: EntryKind;
	/** Bytes for files, null for anything else. Never followed for symlinks. */
	size: number | null;
	modifiedAt: number | null;
	/** Symlinks only: true when the target leaves the tree. Never followed. */
	escapes?: boolean;
}

export interface DirListing {
	/** "root" or the runId whose worktree was listed. */
	base: string;
	path: string;
	entries: DirEntry[];
	/** True when the directory has more entries than `MAX_ENTRIES`. */
	truncated: boolean;
}

export interface FileContents {
	path: string;
	size: number;
	/** Bytes actually returned (≤ `maxBytes`). */
	bytes: number;
	truncated: boolean;
	binary: boolean;
	text: string;
	/** Human-readable reason when `text` is empty despite a non-empty file. */
	marker: string | null;
}

export interface WorkspaceStatusFile {
	path: string;
	/** Porcelain XY codes: index status, worktree status. */
	index: string;
	worktree: string;
	/** Original path for renames/copies. */
	from?: string;
}

export interface FileDiff {
	path: string;
	status: "added" | "modified" | "deleted";
	oldText: string;
	newText: string;
	binary: boolean;
}

export interface WorkspaceStatus {
	base: string;
	branch: string | null;
	clean: boolean;
	files: WorkspaceStatusFile[];
}

export interface WorktreeRef {
	runId: string;
	taskId: string | null;
	branch: string | null;
	path: string;
	state: string;
	label: string;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_ENTRIES = 2000;
/** Bytes inspected for NUL before declaring a file binary (git's heuristic). */
const SNIFF_BYTES = 8000;
/** Per side, for `diffFile`. */
const MAX_DIFF_BYTES = 512 * 1024;

export class WorkspaceService {
	constructor(private readonly deps: { root: string; registry: RunRegistry }) {}

	/** Worktrees that still exist on disk, for the base picker. */
	async worktrees(): Promise<WorktreeRef[]> {
		const rows = await this.deps.registry.list();
		const out: WorktreeRef[] = [];
		for (const run of rows) {
			if (!run.worktreePath) continue;
			try {
				await stat(run.worktreePath);
			} catch {
				continue; // finalized and cleaned up
			}
			out.push({
				runId: run.id,
				taskId: run.taskId,
				branch: run.branch,
				path: run.worktreePath,
				state: run.state,
				label: run.label,
			});
		}
		return out.reverse(); // registry.list() is oldest-first
	}

	async listDir(input: { path?: string; runId?: string }): Promise<DirListing> {
		const base = await this.baseDir(input.runId);
		const dir = await this.resolveWithin(base, input.path);
		const st = await stat(dir);
		if (!st.isDirectory()) {
			throw new NotFoundError(`${input.path ?? "."} is not a directory`);
		}

		const names = await readdir(dir);
		const truncated = names.length > MAX_ENTRIES;
		const entries: DirEntry[] = [];
		for (const name of names.sort().slice(0, MAX_ENTRIES)) {
			const full = join(dir, name);
			// lstat, never stat: symlinks must not be followed.
			let info: Awaited<ReturnType<typeof lstat>>;
			try {
				info = await lstat(full);
			} catch {
				continue; // vanished between readdir and lstat (live worktree)
			}
			const kind: EntryKind = info.isSymbolicLink()
				? "symlink"
				: info.isDirectory()
					? "dir"
					: info.isFile()
						? "file"
						: "other";
			entries.push({
				name,
				path: toPosix(relative(base, full)),
				kind,
				size: kind === "file" ? info.size : null,
				modifiedAt: info.mtimeMs,
				...(kind === "symlink"
					? { escapes: await this.linkEscapes(base, full) }
					: {}),
			});
		}
		entries.sort(
			(a, b) =>
				Number(b.kind === "dir") - Number(a.kind === "dir") ||
				a.name.localeCompare(b.name),
		);
		return {
			base: input.runId ?? "root",
			path: toPosix(relative(base, dir)),
			entries,
			truncated,
		};
	}

	async readFile(input: {
		path: string;
		runId?: string;
		maxBytes?: number;
	}): Promise<FileContents> {
		const max = Math.min(
			Math.max(input.maxBytes ?? DEFAULT_MAX_BYTES, 1),
			DEFAULT_MAX_BYTES,
		);
		const base = await this.baseDir(input.runId);
		const file = await this.resolveWithin(base, input.path);
		const st = await stat(file);
		if (st.isDirectory()) {
			throw new NotFoundError(`${input.path} is a directory, not a file`);
		}

		const want = Math.min(st.size, max);
		const buf = new Uint8Array(want);
		const fh = await open(file, "r");
		try {
			if (want > 0) await fh.read(buf, 0, want, 0);
		} finally {
			await fh.close();
		}
		const relPath = toPosix(relative(base, file));
		if (buf.subarray(0, SNIFF_BYTES).includes(0)) {
			return {
				path: relPath,
				size: st.size,
				bytes: 0,
				truncated: false,
				binary: true,
				text: "",
				marker: "binary file (contains NUL bytes), not rendered",
			};
		}
		const truncated = st.size > want;
		return {
			path: relPath,
			size: st.size,
			bytes: want,
			truncated,
			binary: false,
			text: new TextDecoder().decode(buf),
			marker: truncated
				? `truncated: showing the first ${want} of ${st.size} bytes`
				: null,
		};
	}

	async gitStatus(input: { runId?: string } = {}): Promise<WorkspaceStatus> {
		const base = await this.baseDir(input.runId);
		const head = await git(["symbolic-ref", "--short", "-q", "HEAD"], base);
		// runProc, not `git()`: that trims stdout, and porcelain records start
		// with a status character that is often a space (" M path").
		const porcelain = await runProc(["git", "status", "--porcelain", "-z"], {
			cwd: base,
		});
		const files: WorkspaceStatusFile[] = [];
		if (porcelain.exitCode === 0) {
			const parts = porcelain.stdout.split("\0").filter((p) => p.length > 0);
			for (let i = 0; i < parts.length; i++) {
				const record = parts[i] as string;
				const index = record[0] ?? " ";
				const worktree = record[1] ?? " ";
				const path = record.slice(3);
				// Renames/copies emit the original path as the next NUL-separated field.
				let from: string | undefined;
				if (index === "R" || index === "C") {
					from = parts[++i] as string;
				}
				files.push({ path, index, worktree, ...(from ? { from } : {}) });
			}
		}
		return {
			base: input.runId ?? "root",
			branch: head.exitCode === 0 && head.stdout ? head.stdout : null,
			clean: files.length === 0,
			files,
		};
	}

	/**
	 * Both sides of one dirty file: HEAD against what is on disk now (index and
	 * worktree changes combined).
	 *
	 * `fromPath` is the pre-rename path from a `gitStatus` row; without it a
	 * rename reads as "added", since the new path never existed at HEAD.
	 */
	async diffFile(input: {
		path: string;
		runId?: string;
		fromPath?: string;
	}): Promise<FileDiff> {
		const base = await this.baseDir(input.runId);
		const relPath = stripLeadingSlashes(input.path);
		const oldPath = input.fromPath
			? stripLeadingSlashes(input.fromPath)
			: relPath;

		const shown = await runProc(["git", "show", `HEAD:${oldPath}`], {
			cwd: base,
			maxOutputBytes: MAX_DIFF_BYTES,
		});
		const tracked = shown.exitCode === 0;

		let newText = "";
		let exists = true;
		try {
			const file = await this.resolveWithin(base, relPath);
			const st = await stat(file);
			if (st.isDirectory()) {
				throw new NotFoundError(`${relPath} is a directory, not a file`);
			}
			const want = Math.min(st.size, MAX_DIFF_BYTES);
			const buf = new Uint8Array(want);
			const fh = await open(file, "r");
			try {
				if (want > 0) await fh.read(buf, 0, want, 0);
			} finally {
				await fh.close();
			}
			newText = new TextDecoder().decode(buf);
		} catch (e) {
			if (e instanceof NotFoundError) exists = false;
			else throw e;
		}

		if (!tracked && !exists) {
			throw new NotFoundError(`no such path: ${relPath}`);
		}

		const oldText = tracked ? shown.stdout : "";
		const binary = containsNul(oldText) || containsNul(newText);

		return {
			path: relPath,
			status: !tracked ? "added" : !exists ? "deleted" : "modified",
			oldText: binary ? "" : oldText,
			newText: binary ? "" : newText,
			binary,
		};
	}

	// ------------------------------------------------------------------
	// containment
	// ------------------------------------------------------------------

	/** The physical directory a request is scoped to. */
	private async baseDir(runId?: string): Promise<string> {
		if (!runId) return this.realOrThrow(this.deps.root, "project root");
		const run = await this.deps.registry.get(runId);
		if (!run) throw new NotFoundError(`unknown run ${runId}`);
		if (!run.worktreePath) {
			throw new NotFoundError(`run ${runId} has no worktree`);
		}
		return this.realOrThrow(run.worktreePath, `worktree of run ${runId}`);
	}

	private async realOrThrow(path: string, what: string): Promise<string> {
		try {
			return await realpath(path);
		} catch {
			throw new NotFoundError(`${what} does not exist: ${path}`);
		}
	}

	/**
	 * Resolve a caller-supplied path against `base` and verify it stays inside.
	 * `realpath` first, string compare second: `<base>/link` with
	 * `link -> /etc` passes any lexical prefix test. Absolute inputs are treated
	 * as base-relative (`/etc/passwd` means `<base>/etc/passwd`).
	 */
	private async resolveWithin(base: string, rel?: string): Promise<string> {
		const requested = rel ?? "";
		const target = resolve(base, requested.replace(/^[/\\]+/, ""));
		let real: string;
		try {
			real = await realpath(target);
		} catch {
			throw new NotFoundError(`no such path: ${requested || "."}`);
		}
		if (real !== base && !real.startsWith(base + sep)) {
			throw new PathEscapeError(requested);
		}
		return real;
	}

	/** Does a symlink point out of the tree? The flag is for the UI; the refusal
	 *  is in `resolveWithin`. A dangling link escapes nothing. */
	private async linkEscapes(base: string, link: string): Promise<boolean> {
		try {
			const real = await realpath(link);
			return real !== base && !real.startsWith(base + sep);
		} catch {
			return false;
		}
	}
}

function toPosix(p: string): string {
	return p.split(sep).join("/");
}

function stripLeadingSlashes(p: string): string {
	return p.replace(/^[/\\]+/, "");
}

/** Same NUL-sniff heuristic as `readFile`, over already-decoded text. */
function containsNul(text: string): boolean {
	return text.slice(0, SNIFF_BYTES).includes("\0");
}
