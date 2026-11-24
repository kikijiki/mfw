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
 *   private data directory, or the run's own tree. Entries of the evaluation
 *   sandbox's own toolchain are removed: a run has its own.
 *
 * What is dropped is reported, so the owner can see why a variable is absent.
 */

import { inflateSync } from "node:zlib";
import { SANDBOX_PATHS } from "./compile-bwrap.ts";
import { ENV_DATA_CACHE } from "./role-profiles.ts";
import { storePathOf, storeRefsIn } from "./store-closure.ts";

/** Where the environment's private data (mise installs) is seen in every sandbox. */
export const ENV_DATA_SANDBOX_PATH = `${SANDBOX_PATHS.caches}/${ENV_DATA_CACHE}`;

export const DEV_ENV_LIMITS = {
	maxValueBytes: 32 * 1024,
	maxTotalBytes: 512 * 1024,
	maxVariables: 512,
	maxPathEntries: 256,
	/** The raw output of an evaluation; past it the evaluation fails. */
	maxOutputBytes: 4 * 1024 * 1024,
	maxWatches: 256,
} as const;

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Set by the sandbox compiler or the run itself: never taken from the env. */
const RUNTIME_NAMES = new Set([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TERM",
	"LANG",
	"PWD",
	"OLDPWD",
	"SHLVL",
	"TMPDIR",
	"TEMP",
	"TMP",
	"TEMPDIR",
	"NIX_BUILD_TOP",
	"NIX_REMOTE",
	"NIX_CONFIG",
	"NIX_CONF_DIR",
	"NIX_USER_CONF_FILES",
	"NODE_USE_ENV_PROXY",
	"EDITOR",
	"VISUAL",
	"PAGER",
	"DISPLAY",
	"WAYLAND_DISPLAY",
	"XAUTHORITY",
	"DBUS_SESSION_BUS_ADDRESS",
	"SUDO_ASKPASS",
	"SSH_ASKPASS",
	"_",
]);

const RUNTIME_PREFIXES = [
	"XDG_",
	"GIT_",
	"SSH_",
	"GPG_",
	"GNUPG",
	"MFW_",
	"CLAUDE",
	"CODEX_",
	"ANTHROPIC_",
	"OPENAI_",
	"OPENROUTER_",
	"DIRENV_",
	"MISE_",
	"__MISE_",
	"KRB5",
];

/** Change how programs load code, resolve names or start a shell. */
const LOADER_NAMES = new Set([
	"NODE_OPTIONS",
	"NODE_EXTRA_CA_CERTS",
	"NODE_REPL_EXTERNAL_MODULE",
	"GLIBC_TUNABLES",
	"GCONV_PATH",
	"LOCPATH",
	"NLSPATH",
	"HOSTALIASES",
	"LOCALDOMAIN",
	"RES_OPTIONS",
	"BASH_ENV",
	"ENV",
	"ZDOTDIR",
	"PROMPT_COMMAND",
	"PS4",
	"SHELLOPTS",
	"BASHOPTS",
	"IFS",
	"CDPATH",
	"GLOBIGNORE",
	"PYTHONSTARTUP",
	"PYTHONINSPECT",
	"PERL5OPT",
	"PERL5DB",
	"RUBYOPT",
	"JAVA_TOOL_OPTIONS",
	"_JAVA_OPTIONS",
	"JDK_JAVA_OPTIONS",
	"LUA_INIT",
]);

const LOADER_PREFIXES = ["LD_", "DYLD_", "BUN_", "MALLOC_", "LUA_INIT_"];

export type DropReason =
	| "invalid_name"
	| "runtime"
	| "loader"
	| "too_large"
	| "too_many"
	| "unset";

/** Why `name` may not come from a dev environment, or null when it may. */
export function devEnvNameProblem(name: string): DropReason | null {
	if (!NAME.test(name)) return "invalid_name";
	const upper = name.toUpperCase();
	if (/^(?:HTTPS?|ALL|NO|FTP)_PROXY$/.test(upper)) return "runtime";
	if (
		RUNTIME_NAMES.has(name) ||
		RUNTIME_PREFIXES.some((p) => upper.startsWith(p))
	) {
		return "runtime";
	}
	if (upper.endsWith("_API_KEY") || upper.endsWith("_TOKEN")) return "runtime";
	if (
		LOADER_NAMES.has(name) ||
		LOADER_PREFIXES.some((p) => upper.startsWith(p))
	) {
		return "loader";
	}
	return null;
}

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
	const prefix = `${SANDBOX_PATHS.workspace}/`;
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

function pathEntryAllowed(entry: string): boolean {
	if (!entry.startsWith("/") || entry.includes("\0")) return false;
	if (entry.split("/").some((s) => s === "." || s === "..")) return false;
	if (storePathOf(entry)) return true;
	const roots = [SANDBOX_PATHS.workspace, ENV_DATA_SANDBOX_PATH];
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

	const own = new Set(ctx.evaluationPath);
	const path: string[] = [];
	const droppedPath: string[] = [];
	const rawPath = raw.PATH;
	if (
		typeof rawPath === "string" &&
		rawPath.length <= DEV_ENV_LIMITS.maxValueBytes
	) {
		for (const entry of rawPath.split(":")) {
			if (entry === "" || own.has(entry) || path.includes(entry)) continue;
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
