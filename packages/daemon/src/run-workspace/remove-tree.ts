/**
 * Remove a directory a sandboxed process could write. It may hold directories
 * with no permissions, which stop a plain recursive delete.
 *
 * Owner permissions are restored on real directories only, found with `lstat`,
 * so a symlink is never followed out of the tree. A failure on one entry does
 * not stop the others. Only call this once the sandbox that wrote the tree has
 * exited, because a live process could swap a directory for a link.
 */

import { chmod, lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

async function unlock(dir: string, failed: string[]): Promise<void> {
	try {
		await chmod(dir, 0o700);
	} catch {
		failed.push(dir);
		return;
	}
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		failed.push(dir);
		return;
	}
	for (const name of names) {
		const path = join(dir, name);
		try {
			if ((await lstat(path)).isDirectory()) await unlock(path, failed);
		} catch {
			failed.push(path);
		}
	}
}

/** Remove `path`. Returns what could not be removed; empty means it is gone. */
export async function removeTree(path: string): Promise<string[]> {
	const failed: string[] = [];
	try {
		const st = await lstat(path);
		if (st.isDirectory()) await unlock(path, failed);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		failed.push(path);
	}
	try {
		await rm(path, { recursive: true, force: true });
		return [];
	} catch {
		return failed.length > 0 ? failed : [path];
	}
}
