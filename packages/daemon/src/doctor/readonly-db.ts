import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";

/**
 * Read a SQLite database without touching it.
 *
 * SQLite's own read-only mode is not enough: on a WAL database it still writes
 * read marks to the `-shm` file, and may create that file. So the database and
 * the committed frames of its WAL are read as plain bytes, merged into a private
 * image and opened from memory. No lock is taken and no file is opened for
 * writing. The image stays in this process.
 */

const WAL_HEADER = 32;
const FRAME_HEADER = 24;
const WAL_MAGIC_LE = 0x377f0682;
const WAL_MAGIC_BE = 0x377f0683;
const MAX_IMAGE_BYTES = 256 * 1024 * 1024;
const STABLE_READ_ATTEMPTS = 3;

function checksum(
	data: Uint8Array,
	littleEndian: boolean,
	seed: readonly [number, number],
): [number, number] {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	let [s0, s1] = seed;
	// SQLite consumes the input as pairs of 32-bit words.
	for (let i = 0; i + 8 <= data.length; i += 8) {
		s0 = (s0 + view.getUint32(i, littleEndian) + s1) >>> 0;
		s1 = (s1 + view.getUint32(i + 4, littleEndian) + s0) >>> 0;
	}
	return [s0, s1];
}

/** The pages of every committed transaction, and the database size they leave. */
export function committedWalPages(wal: Uint8Array): {
	pageSize: number;
	pages: Map<number, Uint8Array>;
	dbPages: number | null;
} {
	if (wal.length < WAL_HEADER) {
		throw new Error("its write-ahead log has no valid header");
	}
	const view = new DataView(wal.buffer, wal.byteOffset, wal.byteLength);
	const magic = view.getUint32(0);
	if (magic !== WAL_MAGIC_LE && magic !== WAL_MAGIC_BE) {
		throw new Error("its write-ahead log has no valid header");
	}
	const littleEndian = magic === WAL_MAGIC_LE;
	const rawSize = view.getUint32(8);
	const pageSize = rawSize === 1 ? 65536 : rawSize;
	if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) {
		throw new Error("its write-ahead log has an invalid page size");
	}
	let sum = checksum(wal.subarray(0, 24), littleEndian, [0, 0]);
	if (sum[0] !== view.getUint32(24) || sum[1] !== view.getUint32(28)) {
		throw new Error("its write-ahead log has no valid header");
	}
	const salt1 = view.getUint32(16);
	const salt2 = view.getUint32(20);
	const pages = new Map<number, Uint8Array>();
	const pending = new Map<number, Uint8Array>();
	let dbPages: number | null = null;
	const frameSize = FRAME_HEADER + pageSize;
	for (let at = WAL_HEADER; at + frameSize <= wal.length; at += frameSize) {
		// A frame from an earlier log generation, or a torn write, ends the log.
		if (view.getUint32(at + 8) !== salt1 || view.getUint32(at + 12) !== salt2) {
			break;
		}
		const page = wal.subarray(at + FRAME_HEADER, at + frameSize);
		const next = checksum(
			page,
			littleEndian,
			checksum(wal.subarray(at, at + 8), littleEndian, sum),
		);
		if (
			next[0] !== view.getUint32(at + 16) ||
			next[1] !== view.getUint32(at + 20)
		) {
			break;
		}
		sum = next;
		pending.set(view.getUint32(at), page);
		const commitSize = view.getUint32(at + 4);
		if (commitSize > 0) {
			for (const [n, p] of pending) pages.set(n, p);
			pending.clear();
			dbPages = commitSize;
		}
	}
	return { pageSize, pages, dbPages };
}

/** The database as of its last commit, as a standalone rollback-journal image. */
export function mergedImage(
	main: Uint8Array,
	wal: Uint8Array | null,
): Uint8Array {
	let image: Uint8Array = main;
	if (wal && wal.length > 0) {
		const { pageSize, pages, dbPages } = committedWalPages(wal);
		if (dbPages !== null) {
			const size = dbPages * pageSize;
			if (size > MAX_IMAGE_BYTES) throw new Error("the database is too large");
			image = new Uint8Array(size);
			image.set(main.subarray(0, Math.min(main.length, size)));
			for (const [n, page] of pages) {
				if (n >= 1 && n <= dbPages) image.set(page, (n - 1) * pageSize);
			}
		}
	}
	if (image.length < 100) throw new Error("it is not a SQLite database");
	const copy = image === main ? new Uint8Array(main) : image;
	// Bytes 18 and 19 say "WAL". An in-memory image cannot be opened that way.
	copy[18] = 1;
	copy[19] = 1;
	return copy;
}

function stamp(path: string): string {
	const part = (p: string) => {
		if (!existsSync(p)) return "-";
		const s = statSync(p);
		return `${s.size}:${s.mtimeMs}`;
	};
	return `${part(path)}|${part(`${path}-wal`)}`;
}

function readStable(path: string): Uint8Array {
	for (let i = 0; i < STABLE_READ_ATTEMPTS; i++) {
		const before = stamp(path);
		if (statSync(path).size > MAX_IMAGE_BYTES) {
			throw new Error("the database is too large");
		}
		const walPath = `${path}-wal`;
		if (existsSync(walPath) && statSync(walPath).size > MAX_IMAGE_BYTES) {
			throw new Error("the database is too large");
		}
		const wal = existsSync(walPath) ? readFileSync(walPath) : null;
		const main = readFileSync(path);
		// A checkpoint between the two reads would mix generations.
		if (stamp(path) === before) return mergedImage(main, wal);
	}
	throw new Error("it is being written too quickly to read consistently");
}

/** Run `fn` on a read-only, in-memory copy of the database at `path`. */
export function withReadOnlyDb<T>(path: string, fn: (db: Database) => T): T {
	const db = Database.deserialize(readStable(path), true);
	try {
		return fn(db);
	} finally {
		db.close();
	}
}
