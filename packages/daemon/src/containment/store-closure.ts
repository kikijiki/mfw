/**
 * The runtime closure of the declared binaries in the Nix store, so a sandbox
 * binds those store paths instead of all of `/nix/store`.
 *
 * Two ways to compute it, and a refusal when neither works:
 *
 * 1. `nix-store --query --requisites`, from a fixed system location (never
 *    `PATH`), which reads the store's own reference database;
 * 2. a reference scan: read every file and symlink of a store path for
 *    `/nix/store/<hash>-<name>` strings, and repeat for what it finds. This is
 *    how Nix itself finds references at build time. It can miss a reference
 *    stored compressed or in UTF-16; the tool then fails inside the sandbox,
 *    which is the safe direction.
 *
 * Store paths are immutable, so a computed closure is cached by its roots.
 */

import { spawnSync } from "node:child_process";
import {
	closeSync,
	lstatSync,
	openSync,
	readdirSync,
	readlinkSync,
	readSync,
} from "node:fs";
import { join } from "node:path";

export const NIX_STORE_DIR = "/nix/store";

/** Fixed, root-owned locations of the query tool. `PATH` is never consulted. */
const NIX_STORE_TOOLS = [
	"/run/current-system/sw/bin/nix-store",
	"/nix/var/nix/profiles/default/bin/nix-store",
] as const;

const STORE_NAME = /^[0-9a-df-np-sv-z]{32}-[A-Za-z0-9+._?=-]+$/;
const STORE_REF = /\/nix\/store\/([0-9a-df-np-sv-z]{32}-[A-Za-z0-9+._?=-]+)/g;

/** Bounds on the scan: past them the closure is refused, never truncated. */
export const SCAN_LIMITS = {
	maxPaths: 4096,
	maxFiles: 500_000,
	maxBytes: 16 * 1024 * 1024 * 1024,
} as const;

const CHUNK_BYTES = 1024 * 1024;
/** Longest reference that can straddle two chunks. */
const CHUNK_OVERLAP = 256;

export type ClosureMethod = "nix-store" | "reference-scan";

export interface StoreClosure {
	method: ClosureMethod;
	/** Top-level store paths, sorted. */
	paths: string[];
}

export class StoreClosureError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StoreClosureError";
	}
}

/** The top-level store path holding `path`, or null. */
export function storePathOf(path: string): string | null {
	if (!path.startsWith(`${NIX_STORE_DIR}/`)) return null;
	const name = path.slice(NIX_STORE_DIR.length + 1).split("/")[0] as string;
	return STORE_NAME.test(name) ? `${NIX_STORE_DIR}/${name}` : null;
}

/** Every store path named in `text`. */
export function storeRefsIn(text: string): string[] {
	const out = new Set<string>();
	for (const m of text.matchAll(STORE_REF)) {
		out.add(`${NIX_STORE_DIR}/${m[1]}`);
	}
	return [...out];
}

/** Read a file in overlapping chunks, handing each to `visit` as latin1. */
export function scanFileText(
	hostPath: string,
	visit: (text: string) => void,
	maxBytes: number = Number.POSITIVE_INFINITY,
): number {
	const fd = openSync(hostPath, "r");
	try {
		const buf = Buffer.allocUnsafe(CHUNK_BYTES + CHUNK_OVERLAP);
		let kept = 0;
		let total = 0;
		for (;;) {
			const n = readSync(fd, buf, kept, CHUNK_BYTES, null);
			if (n === 0) return total;
			total += n;
			if (total > maxBytes) {
				throw new StoreClosureError(`${hostPath} exceeds the scan limit`);
			}
			const end = kept + n;
			visit(buf.toString("latin1", 0, end));
			kept = Math.min(CHUNK_OVERLAP, end);
			buf.copy(buf, 0, end - kept, end);
		}
	} finally {
		closeSync(fd);
	}
}

function scanTree(
	hostRoot: string,
	found: Set<string>,
	budget: { files: number; bytes: number },
): void {
	const stack = [hostRoot];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		const st = lstatSync(dir);
		if (st.isSymbolicLink()) {
			for (const r of storeRefsIn(readlinkSync(dir))) found.add(r);
			continue;
		}
		if (st.isDirectory()) {
			for (const entry of readdirSync(dir)) stack.push(join(dir, entry));
			continue;
		}
		if (!st.isFile()) continue;
		if (--budget.files < 0) {
			throw new StoreClosureError("the closure holds too many files to scan");
		}
		budget.bytes -= st.size;
		if (budget.bytes < 0) {
			throw new StoreClosureError("the closure is too large to scan");
		}
		scanFileText(dir, (text) => {
			for (const r of storeRefsIn(text)) found.add(r);
		});
	}
}

/**
 * The closure by reference scan. `hostOf` maps a store path onto the host, so
 * fixture trees work. Throws when a path is missing or unreadable, or a limit
 * is reached: a partial closure would silently be the wrong sandbox.
 */
export function scanStoreClosure(
	roots: readonly string[],
	hostOf: (path: string) => string = (p) => p,
	limits: {
		maxPaths: number;
		maxFiles: number;
		maxBytes: number;
	} = SCAN_LIMITS,
): StoreClosure {
	const seen = new Set<string>();
	const pending = [...roots];
	const budget = { files: limits.maxFiles, bytes: limits.maxBytes };
	while (pending.length > 0) {
		const path = pending.pop() as string;
		if (seen.has(path)) continue;
		if (storePathOf(path) !== path) {
			throw new StoreClosureError(`${path} is not a store path`);
		}
		seen.add(path);
		if (seen.size > limits.maxPaths) {
			throw new StoreClosureError("the closure holds too many store paths");
		}
		const refs = new Set<string>();
		try {
			scanTree(hostOf(path), refs, budget);
		} catch (err) {
			if (err instanceof StoreClosureError) throw err;
			throw new StoreClosureError(
				`cannot read ${path}: ${(err as Error).message}`,
			);
		}
		for (const r of refs) if (!seen.has(r)) pending.push(r);
	}
	return { method: "reference-scan", paths: [...seen].sort() };
}

/** The closure from the store's database, or null when the tool cannot answer. */
export function queryStoreClosure(
	roots: readonly string[],
	tools: readonly string[] = NIX_STORE_TOOLS,
): StoreClosure | null {
	for (const tool of tools) {
		const res = spawnSync(tool, ["--query", "--requisites", ...roots], {
			encoding: "utf8",
			env: {},
			timeout: 15_000,
			maxBuffer: 16 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (res.error || res.status !== 0) continue;
		const paths = res.stdout.split("\n").filter(Boolean);
		// Every root must come back, and every line must be a store path.
		if (
			paths.length === 0 ||
			paths.some((p) => storePathOf(p) !== p) ||
			roots.some((r) => !paths.includes(r))
		) {
			continue;
		}
		return { method: "nix-store", paths: [...new Set(paths)].sort() };
	}
	return null;
}

const cache = new Map<string, StoreClosure>();

/** The host's closure of `roots`: the store's database, then the scan. Throws if neither works. */
export function hostStoreClosure(roots: readonly string[]): StoreClosure {
	const key = [...new Set(roots)].sort().join("\n");
	const hit = cache.get(key);
	if (hit) return hit;
	const unique = key.split("\n");
	const closure = queryStoreClosure(unique) ?? scanStoreClosure(unique);
	cache.set(key, closure);
	return closure;
}
