/**
 * The minimal sandbox probe (the sandbox experiments, E0 and E1).
 *
 * Interim containment only: `$HOME` stays writable and the network shared, so
 * this does not prove isolation. It proves the two leaks the experiments
 * found are closed: the daemon's environment (E0) and the tmux server's
 * environment and sockets (E1) are not reachable from inside the sandbox.
 *
 * The probe is a POSIX shell script that runs INSIDE bwrap, before the
 * driver. Any failed check exits 78 with one line on stderr naming it, and the
 * driver never starts. The same script is run by the host (`probeSandbox` in
 * `sandbox.ts`) so preflight can refuse autonomy before anything is claimed.
 */

/** The exit code of a failed probe; matches the secret-handoff refusal. */
export const PROBE_EXIT_CODE = 78;

export interface MinimalProbeSpec {
	/** Every environment name the sandbox is allowed to hold. Any other name is a leak. */
	allowedEnv: readonly string[];
	/** Directories that must be empty or absent: the daemon home and `/run/user/<uid>`, masked with a tmpfs. */
	emptyDirs: readonly string[];
	/** Directories that must hold no unix socket (tmux and dbus). */
	noSocketDirs: readonly string[];
}

/** POSIX single-quote. */
function q(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Set to `1` by whoever starts the probe. Seeing it in `env` output is the
 * positive control: if listing the environment silently yields nothing (a
 * missing or broken helper), the probe must fail, not pass.
 */
export const PROBE_SENTINEL = "MFW_PROBE_SENTINEL";

/**
 * The probe as a shell script body (no shebang); exits 78 on the first
 * failure. It fails closed (security review G6): every helper it needs is
 * checked first, `env` must show the sentinel, and any helper error is a
 * failure, never an empty (passing) result.
 */
export function buildProbeScript(spec: MinimalProbeSpec): string {
	const allowed = [...spec.allowedEnv, PROBE_SENTINEL];
	const lines: string[] = [
		"mfw_probe_fail() { printf 'sandbox_probe_failed: %s\\n' \"$1\" >&2; exit 78; }",
		'for mfw_t in env sed ls find tr head; do command -v "$mfw_t" >/dev/null 2>&1 || mfw_probe_fail "required helper $mfw_t is missing"; done',
		// 1. no canary env: every name must be on the allowlist
		`allowed=" ${allowed.join(" ")} "`,
		'mfw_env=$(env) || mfw_probe_fail "cannot list the environment"',
		`case "$mfw_env" in *"${PROBE_SENTINEL}=1"*) ;; *) mfw_probe_fail "the environment listing is missing its sentinel" ;; esac`,
		"mfw_names=$(printf '%s\\n' \"$mfw_env\" | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p') || mfw_probe_fail \"cannot read the environment names\"",
		"for name in $mfw_names; do",
		'  case "$allowed" in *" $name "*) ;; *) mfw_probe_fail "environment variable $name leaked into the sandbox" ;; esac',
		"done",
		// 2. pid 1's environment (the sandbox's own init, in its pid namespace) holds only allowlisted names
		"if [ -r /proc/1/environ ]; then",
		"  mfw_p1=$(tr '\\000' '\\n' < /proc/1/environ | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p') || mfw_probe_fail \"cannot read /proc/1/environ\"",
		"  for name in $mfw_p1; do",
		'    case "$allowed" in *" $name "*) ;; *) mfw_probe_fail "/proc/1/environ holds $name" ;; esac',
		"  done",
		"fi",
	];
	for (const d of spec.emptyDirs) {
		lines.push(
			`if [ -e ${q(d)} ]; then mfw_l=$(ls -A ${q(d)}) || mfw_probe_fail ${q(`cannot list ${d}`)}; [ -z "$mfw_l" ] || mfw_probe_fail ${q(`${d} is not empty`)}; fi`,
		);
	}
	for (const d of spec.noSocketDirs) {
		lines.push(
			`if [ -d ${q(d)} ]; then mfw_s=$(find ${q(d)} -maxdepth 2 -type s) || mfw_probe_fail ${q(`cannot scan ${d}`)}; [ -z "$mfw_s" ] || mfw_probe_fail ${q(`a unix socket is reachable under ${d}`)}; fi`,
		);
	}
	// the sentinel is the probe's, not the driver's
	lines.push(
		`unset ${PROBE_SENTINEL} mfw_env mfw_names mfw_p1 mfw_l mfw_s mfw_t`,
	);
	return lines.join("\n");
}
