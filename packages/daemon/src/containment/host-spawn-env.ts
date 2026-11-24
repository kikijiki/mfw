/**
 * The environment of every process the host starts that is `mfw`, bun, or any
 * other compiled bun executable (the driver, the bridges, the launcher, the
 * egress proxy, `mfw server`'s runtime, `mfw-board`).
 *
 * A compiled bun executable cannot defend itself against its environment:
 * `BUN_OPTIONS` preloads code into it before any of its own code runs,
 * `BUN_BE_BUN` turns it into a plain bun, and `LD_PRELOAD` and friends load a
 * library into it. So the control is here, at the spawn: an allowlist.
 *
 *  - Kept: the base names below, every `MFW_*` name, and the names a launch
 *    declares (its provider environment and secret names), which travel to
 *    the next hop in `MFW_HOST_ENV_NAMES`.
 *  - Never kept, even when declared: `BUN_*`, `NODE_*`, `LD_*`, `DYLD_*`,
 *    `GLIBC_TUNABLES`, and the shell start-up variables (`BASH_ENV`, `ENV`,
 *    exported `BASH_FUNC_*`).
 *  - Everything else is dropped.
 *
 * The one exposure left is a process the daemon does not start: the owner's
 * own shell running `mfw` with such a variable set runs that code with the
 * owner's own rights, which nothing inside `mfw` can prevent.
 *
 * No imports: the drivers and bridges load this.
 */

/** Names every host process may need: identity, locale, temp, the user bus, TLS and proxies. */
export const HOST_ENV_BASE = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LANGUAGE",
	"TZ",
	"TERM",
	"TMPDIR",
	"XDG_RUNTIME_DIR",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
	"DBUS_SESSION_BUS_ADDRESS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NIX_SSL_CERT_FILE",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
] as const;

/** Prefixes that are always kept: mfw's own settings, and the locale. */
const KEPT_PREFIXES = ["MFW_", "LC_"] as const;

/** Prefixes and names that are never passed, declared or not. */
const FORBIDDEN_PREFIXES = ["BUN_", "NODE_", "LD_", "DYLD_", "BASH_FUNC_"];
const FORBIDDEN_NAMES = ["GLIBC_TUNABLES", "BASH_ENV", "ENV"];

/** Carries the declared extra names from one hop to the next. */
export const HOST_ENV_NAMES = "MFW_HOST_ENV_NAMES";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** True for a name no host spawn may pass on, whoever declares it. */
export function forbiddenHostEnvName(name: string): boolean {
	return (
		FORBIDDEN_NAMES.includes(name) ||
		FORBIDDEN_PREFIXES.some((p) => name.startsWith(p))
	);
}

function declaredNames(
	source: Record<string, string | undefined>,
	extra: readonly string[],
): string[] {
	const carried = (source[HOST_ENV_NAMES] ?? "")
		.split(",")
		.filter((n) => n !== "");
	return [...new Set([...carried, ...extra])].filter(
		(n) => NAME.test(n) && !forbiddenHostEnvName(n),
	);
}

function kept(name: string, declared: ReadonlySet<string>): boolean {
	if (forbiddenHostEnvName(name)) return false;
	return (
		(HOST_ENV_BASE as readonly string[]).includes(name) ||
		KEPT_PREFIXES.some((p) => name.startsWith(p)) ||
		declared.has(name)
	);
}

/**
 * The environment for a host spawn of `mfw` or another bun executable: the
 * allowlisted part of `source`, plus `extraNames` declared by the caller
 * (taken from `source` too). The declared names are recorded for the next hop.
 */
export function hostSpawnEnv(
	source: Record<string, string | undefined>,
	extraNames: readonly string[] = [],
): Record<string, string> {
	const declared = declaredNames(source, extraNames);
	const allowed = new Set(declared);
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(source)) {
		if (value === undefined || !kept(name, allowed)) continue;
		out[name] = value;
	}
	if (declared.length > 0) out[HOST_ENV_NAMES] = declared.join(",");
	else delete out[HOST_ENV_NAMES];
	return out;
}

/**
 * The same rule in bash, for `run.sh`: lines that fill the array `mfw_env`
 * with the allowlisted exported variables, for `env -i "${mfw_env[@]}" ...`.
 * `extraNames` must already be valid names; forbidden ones are dropped.
 */
export function hostSpawnEnvShell(extraNames: readonly string[]): string[] {
	const declared = declaredNames({}, extraNames);
	const forbidden = [
		...FORBIDDEN_NAMES,
		...FORBIDDEN_PREFIXES.map((p) => `${p}*`),
	].join("|");
	const allowed = [
		...HOST_ENV_BASE,
		...KEPT_PREFIXES.map((p) => `${p}*`),
		...declared,
	].join("|");
	return [
		...(declared.length > 0
			? [`export ${HOST_ENV_NAMES}=${declared.join(",")}`]
			: [`unset ${HOST_ENV_NAMES}`]),
		"mfw_env=()",
		"for mfw_v in $(compgen -e); do",
		`  case "$mfw_v" in ${forbidden}) continue ;; esac`,
		`  case "$mfw_v" in ${allowed}) mfw_env+=("$mfw_v=\${!mfw_v}") ;; esac`,
		"done",
		"unset mfw_v",
	];
}

/**
 * `source` without the never-passed names. For a child started on behalf of
 * whoever ran `mfw` (`mfw server`'s runtime, `mfw board`'s `mfw-board`): the
 * owner's own environment, which may carry settings the server needs, minus
 * what would load code into the child.
 */
export function withoutForbiddenEnv(
	source: Record<string, string | undefined>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(source)) {
		if (value !== undefined && !forbiddenHostEnvName(name)) out[name] = value;
	}
	return out;
}
