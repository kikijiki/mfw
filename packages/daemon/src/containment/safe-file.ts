import { constants } from "node:fs";
import { open } from "node:fs/promises";

/**
 * Reads of files in a directory an agent can write (security review X9). The
 * agent can replace any of them with a symlink (to credentials, or dangling) or
 * a FIFO (a plain read then blocks forever), so a host read must never follow a
 * link, never block, require a regular file, and be bounded.
 */
const READ_FLAGS =
	constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export interface SmallRead {
	/** The first `maxBytes` bytes. */
	buffer: Buffer;
	/** The file's full size, so a caller can tell it was cut. */
	size: number;
}

/**
 * Open `path` read-only without following a final symlink or blocking, and
 * return up to `maxBytes` of it from `offset`; null when it is absent, a link,
 * a FIFO, a device or anything but a regular file.
 */
export async function readRegularFile(
	path: string,
	maxBytes: number,
	offset = 0,
): Promise<SmallRead | null> {
	let fh: Awaited<ReturnType<typeof open>>;
	try {
		fh = await open(path, READ_FLAGS);
	} catch {
		return null;
	}
	try {
		const st = await fh.stat();
		if (!st.isFile()) return null;
		const start = Math.min(Math.max(0, offset), st.size);
		const len = Math.min(Math.max(0, maxBytes), st.size - start);
		const buffer = Buffer.alloc(len);
		if (len > 0) {
			const { bytesRead } = await fh.read(buffer, 0, len, start);
			return { buffer: buffer.subarray(0, bytesRead), size: st.size };
		}
		return { buffer, size: st.size };
	} finally {
		await fh.close().catch(() => {});
	}
}

/** `readRegularFile` as text, capped at 4 KiB: for tiny status files such as `exit`. */
export async function readSmallRegularFile(
	path: string,
): Promise<string | null> {
	const r = await readRegularFile(path, 4096);
	return r ? r.buffer.toString("utf8") : null;
}
