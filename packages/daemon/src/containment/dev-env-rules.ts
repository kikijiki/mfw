/**
 * The rules a captured dev environment must meet before any sandbox gets it.
 * A leaf module, so the profile schema (profile.ts), the compiler and the
 * capture (dev-env-capture.ts) apply the same rules: the schema re-checks
 * what the capture already filtered, because a cast can carry anything.
 */

/** Where the environment's private data (mise installs) is seen in every sandbox. Equals `/cache/` + ENV_DATA_CACHE. */
export const ENV_DATA_SANDBOX_PATH = "/cache/env-data";
/** The run's own tree, as every sandbox sees it (SANDBOX_PATHS.workspace). */
export const DEV_ENV_WORKSPACE = "/work";

export const DEV_ENV_LIMITS = {
	maxValueBytes: 32 * 1024,
	maxTotalBytes: 512 * 1024,
	maxVariables: 512,
	maxPathEntries: 256,
	maxClosurePaths: 4096,
	/** The raw output of an evaluation; past it the evaluation fails. */
	maxOutputBytes: 4 * 1024 * 1024,
	maxWatches: 256,
} as const;

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const STORE_PATH = /^\/nix\/store\/[0-9a-df-np-sv-z]{32}-[A-Za-z0-9+._?=-]+$/;

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

/** Change how programs load code, resolve names, trust TLS or start a shell. */
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

export function isStorePath(p: string): boolean {
	return STORE_PATH.test(p);
}

/** The top-level store path holding `p`, or null. */
function storeRoot(p: string): string | null {
	const m = /^\/nix\/store\/[^/]+/.exec(p);
	return m && STORE_PATH.test(m[0]) ? m[0] : null;
}

/**
 * Why a PATH entry may not be given to a run, or null. It must be canonical
 * and inside the closure, the environment's data, or the run's own tree.
 */
export function devEnvPathProblem(
	entry: string,
	closure: ReadonlySet<string>,
): string | null {
	if (
		!entry.startsWith("/") ||
		entry.length > 4096 ||
		entry.includes("\0") ||
		entry.includes(":") ||
		(entry.length > 1 && entry.endsWith("/")) ||
		entry
			.split("/")
			.some((s, i) => i > 0 && (s === "" || s === "." || s === ".."))
	) {
		return "not a canonical absolute path";
	}
	const store = storeRoot(entry);
	if (store)
		return closure.has(store)
			? null
			: "outside the environment's store closure";
	for (const root of [DEV_ENV_WORKSPACE, ENV_DATA_SANDBOX_PATH]) {
		if (entry === root || entry.startsWith(`${root}/`)) return null;
	}
	return "outside the store closure, the environment's data and the run's tree";
}

/**
 * Check prefixes that only load the project's environment. With the approved
 * environment applied they are redundant, and the tool they name has no
 * daemon, network or approval inside a check, so they are dropped.
 */
const LOADER_PREFIX_FORMS: readonly RegExp[] = [
	/^direnv\s+exec\s+(?:\.|\.\/|\/work)$/,
	/^nix\s+develop(?:\s+(?!-)\S+)?\s+(?:-c|--command)$/,
	/^devenv\s+shell(?:\s+--)?$/,
	/^mise\s+(?:exec|x)\s+--$/,
];

/** Whether a check prefix is one of the environment loaders. */
export function isEnvLoaderPrefix(prefix: string | undefined): boolean {
	const p = prefix?.trim().replace(/\s+/g, " ");
	return !!p && LOADER_PREFIX_FORMS.some((r) => r.test(p));
}

/** Any prefix that names an environment tool at all, recognised form or not. */
export function namesEnvTool(prefix: string | undefined): boolean {
	return /(?:^|[\s/])(?:direnv|nix|nix-shell|devenv|devbox|mise|asdf)(?:\s|$)/.test(
		prefix ?? "",
	);
}
