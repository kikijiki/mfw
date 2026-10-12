import { spawnSync } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ownsPath } from "./ownership.ts";

/**
 * Reads the files of a directory that is not necessarily the board's, for the
 * checks that look outside it. Deterministic by construction: the file list is
 * sorted, ignored files are the repository's own (`git ls-files`, so
 * `.gitignore` is honoured), symlinks and submodules are never followed, and
 * binary or oversized files are skipped and counted rather than guessed at.
 */

export interface ScannedFile {
	/** Relative to the scanned root, `/`-separated. */
	path: string;
	text: string;
}

export interface SkippedFile {
	path: string;
	reason: "too-large" | "binary";
}

export interface ScanResult {
	files: ScannedFile[];
	skipped: SkippedFile[];
}

/** Directories never entered when `root` is not a git work tree. */
const WALK_SKIP = new Set([".git", "node_modules", "target"]);

function gitFiles(root: string): string[] | null {
	const r = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
		cwd: root,
		maxBuffer: 1 << 28,
	});
	if (r.error || r.status !== 0) return null;
	return r.stdout
		.toString("utf8")
		.split("\0")
		.filter((p) => p.length > 0);
}

async function walk(root: string, dir = ""): Promise<string[]> {
	const out: string[] = [];
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(join(root, dir), { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const rel = dir ? `${dir}/${e.name}` : e.name;
		if (e.isDirectory()) {
			if (!WALK_SKIP.has(e.name)) out.push(...(await walk(root, rel)));
		} else if (e.isFile()) {
			out.push(rel);
		}
	}
	return out;
}

/** The text of every file under `root` matching one of `globs`, sorted by path. */
export async function scanRoot(
	root: string,
	globs: readonly string[],
	opts: { maxBytes: number },
): Promise<ScanResult> {
	const listed = gitFiles(root) ?? (await walk(root));
	const wanted = [...new Set(listed)]
		.filter((p) => globs.some((g) => ownsPath(g, p)))
		.sort();
	const result: ScanResult = { files: [], skipped: [] };
	for (const path of wanted) {
		const abs = join(root, path);
		let st: import("node:fs").Stats;
		try {
			st = await lstat(abs);
		} catch {
			continue; // listed by the index but gone from the work tree
		}
		if (!st.isFile()) continue; // symlink, directory, submodule: never followed
		if (st.size > opts.maxBytes) {
			result.skipped.push({ path, reason: "too-large" });
			continue;
		}
		const buf = await readFile(abs);
		if (buf.subarray(0, 8000).includes(0)) {
			result.skipped.push({ path, reason: "binary" });
			continue;
		}
		result.files.push({ path, text: buf.toString("utf8") });
	}
	return result;
}
