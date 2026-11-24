/**
 * The environment an evaluation produced, turned from untrusted output into
 * what a run may be given (design "Dev environment runs inside the sandbox").
 *
 * The evaluation ran project code with network, so everything it wrote is
 * data from an untrusted source, however the owner approved the commit:
 *
 * - each tool's own machine format is parsed (`direnv export json`,
 *   `mise env --json`, `nix print-dev-env --json`, or `env -0`), never a
 *   shell script;
 * - names must be plain identifiers. Names the sandbox itself sets (HOME,
 *   TMPDIR, XDG_*, GIT_*, the proxy) are dropped so the compiler's values win,
 *   and so are names that change how a program loads code or how a shell
 *   starts (LD_*, DYLD_*, BUN_*, NODE_OPTIONS, GLIBC_TUNABLES, BASH_ENV, ...),
 *   because the run's own machinery (the egress relay, the WIP helper, the
 *   agent CLI) runs under this environment too;
 * - every value and the total are size-capped;
 * - `PATH` keeps only entries inside the environment's store closure, its
 *   private data directory, or the run's own tree. The evaluation sandbox's
 *   own PATH, which direnv and mise keep at the end, is removed: a run has
 *   its own toolchain.
 *
 * What is dropped is reported, so the owner can see why a variable is absent.
 */

import { inflateSync } from "node:zlib";
import {
	DEV_ENV_LIMITS,
	DEV_ENV_WORKSPACE,
	type DropReason,
	devEnvNameProblem,
	ENV_DATA_SANDBOX_PATH,
} from "./dev-env-rules.ts";
import { storePathOf, storeRefsIn } from "./store-closure.ts";

export { DEV_ENV_LIMITS, ENV_DATA_SANDBOX_PATH } from "./dev-env-rules.ts";

export class DevEnvParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DevEnvParseError";
	}
}

function asObject(text: string, what: string): Record<string, unknown> {
	if (text.length > DEV_ENV_LIMITS.maxOutputBytes) {
		throw new DevEnvParseError(`${what} output is over the size limit`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new DevEnvParseError(`${what} output is not JSON`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new DevEnvParseError(`${what} output is not a JSON object`);
	}
	return parsed as Record<string, unknown>;
}

/** A variable the source sets (string) or unsets (null). */
export type RawEnv = Record<string, string | null>;

/** `direnv export json`: changed names, `null` for an unset one. Empty output is no change. */
export function parseDirenvExport(text: string): RawEnv {
	if (text.trim() === "") return {};
	const obj = asObject(text, "direnv");
	const out: RawEnv = Object.create(null);
	for (const [k, v] of Object.entries(obj)) {
		if (typeof v === "string" || v === null) out[k] = v;
	}
	return out;
}

/** `mise env --json`: a flat object of strings. */
export function parseMiseEnv(text: string): RawEnv {
	const obj = asObject(text, "mise");
	const out: RawEnv = Object.create(null);
	for (const [k, v] of Object.entries(obj)) {
		if (typeof v === "string") out[k] = v;
	}
	return out;
}

/** `nix print-dev-env --json`: only `exported` string variables reach a process's environment. */
export function parseNixDevEnv(text: string): RawEnv {
	const obj = asObject(text, "nix print-dev-env");
	const vars = obj.variables;
	if (!vars || typeof vars !== "object" || Array.isArray(vars)) {
		throw new DevEnvParseError("nix print-dev-env output has no variables");
	}
	const out: RawEnv = Object.create(null);
	for (const [k, v] of Object.entries(vars as Record<string, unknown>)) {
		const entry = v as { type?: unknown; value?: unknown } | null;
		if (entry?.type === "exported" && typeof entry.value === "string") {
			out[k] = entry.value;
		}
	}
	return out;
}

/** `env -0` inside the activated shell, minus what the entry started with. */
export function parseEnvNul(
	bytes: Buffer,
	baseline: Readonly<Record<string, string>>,
): RawEnv {
	if (bytes.byteLength > DEV_ENV_LIMITS.maxOutputBytes) {
		throw new DevEnvParseError("env output is over the size limit");
	}
	const out: RawEnv = Object.create(null);
	for (const record of bytes.toString("utf8").split("\0")) {
		const eq = record.indexOf("=");
		if (eq <= 0) continue;
		const name = record.slice(0, eq);
		const value = record.slice(eq + 1);
		if (baseline[name] !== value) out[name] = value;
	}
	return out;
}

/**
 * The files direnv watched: `DIRENV_WATCHES` is base64url of zlib-compressed
 * JSON. Inflated with a hard output cap; anything malformed is an error.
 */
export function decodeDirenvWatches(
	value: string | null | undefined,
): string[] {
	if (!value) return [];
	if (value.length > DEV_ENV_LIMITS.maxValueBytes * 4) {
		throw new DevEnvParseError("DIRENV_WATCHES is over the size limit");
	}
	let json: string;
	try {
		const packed = Buffer.from(
			value.replace(/-/g, "+").replace(/_/g, "/"),
			"base64",
		);
		json = inflateSync(packed, { maxOutputLength: 1024 * 1024 }).toString(
			"utf8",
		);
	} catch {
		throw new DevEnvParseError("DIRENV_WATCHES cannot be decoded");
	}
	let list: unknown;
	try {
		list = JSON.parse(json);
	} catch {
		throw new DevEnvParseError("DIRENV_WATCHES is not JSON");
	}
	if (!Array.isArray(list) || list.length > DEV_ENV_LIMITS.maxWatches) {
		throw new DevEnvParseError("DIRENV_WATCHES is not a bounded list");
	}
	const out: string[] = [];
	for (const w of list) {
		const path = (w as { path?: unknown } | null)?.path;
		if (typeof path === "string") out.push(path);
	}
	return out;
}

/** Watched files inside the work tree, as repository paths. */
export function watchedRepoPaths(watches: readonly string[]): string[] {
	const prefix = `${DEV_ENV_WORKSPACE}/`;
	const out = new Set<string>();
	for (const w of watches) {
		if (!w.startsWith(prefix)) continue;
		const rel = w.slice(prefix.length);
		if (
			rel === "" ||
			rel.split("/").some((s) => s === "" || s === "." || s === "..") ||
			rel.startsWith(".direnv/")
		) {
			continue;
		}
		out.add(rel);
	}
	return [...out].sort();
}

export interface DroppedVar {
	name: string;
	reason: DropReason;
}

export interface FilteredDevEnv {
	/** What a run's sandbox sets, PATH excluded. */
	env: Record<string, string>;
	/** PATH entries to put before the run's own toolchain, in order. */
	path: string[];
	/** Top-level store paths named by a kept value: the roots of the closure. */
	storeRoots: string[];
	dropped: DroppedVar[];
	droppedPath: string[];
}

export interface FilterContext {
	/** The evaluation sandbox's own PATH entries: removed, a run has its own. */
	evaluationPath: readonly string[];
}

/**
 * The environment's own PATH entries: the evaluation sandbox's PATH, which
 * direnv and mise keep after their own entries, comes off the end, matched
 * entry by entry. An entry of the environment that happens to equal one of
 * the sandbox's (the same bun) stays, in its place.
 */
export function stripEvaluationPath(
	entries: readonly string[],
	evaluation: readonly string[],
): string[] {
	const out = [...entries];
	let i = evaluation.length - 1;
	while (i >= 0 && out.length > 0 && out[out.length - 1] === evaluation[i]) {
		out.pop();
		i--;
	}
	return out;
}

function pathEntryAllowed(entry: string): boolean {
	if (!entry.startsWith("/") || entry.includes("\0")) return false;
	if (entry.split("/").some((s) => s === "." || s === "..")) return false;
	if (storePathOf(entry)) return true;
	const roots = [DEV_ENV_WORKSPACE, ENV_DATA_SANDBOX_PATH];
	return roots.some((r) => entry === r || entry.startsWith(`${r}/`));
}

/**
 * The run-safe part of a raw environment. Pure: the store closure of
 * `storeRoots` is computed by the caller, and PATH entries in the store are
 * checked against it there (`closePath`).
 */
export function filterDevEnv(raw: RawEnv, ctx: FilterContext): FilteredDevEnv {
	const env: Record<string, string> = {};
	const dropped: DroppedVar[] = [];
	let total = 0;
	const names = Object.keys(raw).sort();
	for (const name of names) {
		const value = raw[name];
		if (name === "PATH") continue;
		const problem = devEnvNameProblem(name);
		if (problem) {
			dropped.push({ name, reason: problem });
			continue;
		}
		if (value === null || value === undefined) {
			dropped.push({ name, reason: "unset" });
			continue;
		}
		const size = Buffer.byteLength(value) + Buffer.byteLength(name) + 2;
		if (
			Buffer.byteLength(value) > DEV_ENV_LIMITS.maxValueBytes ||
			value.includes("\0") ||
			total + size > DEV_ENV_LIMITS.maxTotalBytes
		) {
			dropped.push({ name, reason: "too_large" });
			continue;
		}
		if (Object.keys(env).length >= DEV_ENV_LIMITS.maxVariables) {
			dropped.push({ name, reason: "too_many" });
			continue;
		}
		total += size;
		env[name] = value;
	}

	const path: string[] = [];
	const droppedPath: string[] = [];
	const rawPath = raw.PATH;
	if (
		typeof rawPath === "string" &&
		rawPath.length <= DEV_ENV_LIMITS.maxValueBytes
	) {
		for (const entry of stripEvaluationPath(
			rawPath.split(":"),
			ctx.evaluationPath,
		)) {
			if (entry === "" || path.includes(entry)) continue;
			if (
				!pathEntryAllowed(entry) ||
				path.length >= DEV_ENV_LIMITS.maxPathEntries
			) {
				droppedPath.push(entry);
				continue;
			}
			path.push(entry);
		}
	} else if (typeof rawPath === "string") {
		droppedPath.push("(PATH over the size limit)");
	}

	const roots = new Set<string>();
	for (const v of [...Object.values(env), ...path]) {
		for (const r of storeRefsIn(v)) roots.add(r);
	}
	return {
		env,
		path,
		storeRoots: [...roots].sort(),
		dropped,
		droppedPath,
	};
}

/** Remove PATH entries in the store but outside `closure`. */
export function closePath(
	path: readonly string[],
	closure: ReadonlySet<string>,
): { path: string[]; dropped: string[] } {
	const kept: string[] = [];
	const dropped: string[] = [];
	for (const entry of path) {
		const store = storePathOf(entry);
		if (store && !closure.has(store)) dropped.push(entry);
		else kept.push(entry);
	}
	return { path: kept, dropped };
}
