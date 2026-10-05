import { randomBytes } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Crash-safe file writes:
 *
 *   write .tmp-<name>-<rand> → fsync(file) → rename over target → fsync(dir)
 *
 * A reader can never observe a torn file that mfw wrote. Used for mirror
 * exports, credentials.json, and every other daemon-written file.
 */
export async function writeFileAtomic(
	path: string,
	data: string | Uint8Array,
	opts: { mode?: number } = {},
): Promise<void> {
	const dir = dirname(path);
	const tmp = join(
		dir,
		`.tmp-${basename(path)}-${randomBytes(4).toString("hex")}`,
	);
	const fh = await open(tmp, "w", opts.mode ?? 0o644);
	try {
		await fh.writeFile(data);
		await fh.sync();
	} finally {
		await fh.close();
	}
	try {
		await rename(tmp, path);
	} catch (e) {
		await unlink(tmp).catch(() => {
			// best-effort: the temp file is orphaned but harmless (dot-prefixed)
		});
		throw e;
	}
	// fsync the directory so the rename itself is durable
	const dh = await open(dir, "r");
	try {
		await dh.sync();
	} catch {
		// some filesystems refuse dir fsync, the rename is still atomic
	} finally {
		await dh.close();
	}
}
