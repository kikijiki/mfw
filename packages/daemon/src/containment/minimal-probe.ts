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
	/**
	 * Check pid 1's environment (default true). Only a sandbox with its own pid
	 * namespace has a pid 1 worth reading; the pure unit layer, run on a plain
	 * host where `/proc/1/environ` is root's, turns it off.
	 */
	checkPid1Environ?: boolean;
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
 * checked first, the environment must show the sentinel, and any helper error is a
 * failure, never an empty (passing) result.
 */
export function buildProbeScript(spec: MinimalProbeSpec): string {
	const allowed = [...spec.allowedEnv, PROBE_SENTINEL];
	const lines: string[] = [
		"mfw_probe_fail() { printf 'sandbox_probe_failed: %s\\n' \"$1\" >&2; exit 78; }",
		'for mfw_t in sed ls find tr head; do command -v "$mfw_t" >/dev/null 2>&1 || mfw_probe_fail "required helper $mfw_t is missing"; done',
		// 1. no canary env: EVERY name must be on the allowlist, whatever characters it has
		// (a name that is not a shell identifier, like BAD-NAME, is still a leak). The names
		// come from the process's own NUL-separated environment, not from the `env` helper.
		`allowed=" ${allowed.join(" ")} "`,
		'[ -r /proc/$$/environ ] || mfw_probe_fail "cannot read /proc/$$/environ"',
		"mfw_names=$(tr '\\000' '\\n' < /proc/$$/environ | sed -n 's/^\\([^=]*\\)=.*/\\1/p') || mfw_probe_fail \"cannot read the environment names\"",
		"mfw_ifs=$IFS; IFS='\n'",
		"mfw_seen=",
		"for name in $mfw_names; do",
		`  [ "$name" = ${PROBE_SENTINEL} ] && mfw_seen=1`,
		'  case "$allowed" in *" $name "*) ;; *) IFS=$mfw_ifs; mfw_probe_fail "environment variable $name leaked into the sandbox" ;; esac',
		"done",
		"IFS=$mfw_ifs",
		'[ "$mfw_seen" = 1 ] || mfw_probe_fail "the environment listing is missing its sentinel"',
	];
	if (spec.checkPid1Environ !== false) {
		lines.push(
			// 2. pid 1's environment (the sandbox's own init, in its pid namespace) holds only allowlisted names;
			// an unreadable file is a failure, not a skip
			'[ -r /proc/1/environ ] || mfw_probe_fail "cannot read /proc/1/environ"',
			"mfw_p1=$(tr '\\000' '\\n' < /proc/1/environ | sed -n 's/^\\([^=]*\\)=.*/\\1/p') || mfw_probe_fail \"cannot read /proc/1/environ\"",
			"mfw_ifs=$IFS; IFS='\n'",
			"for name in $mfw_p1; do",
			'  case "$allowed" in *" $name "*) ;; *) IFS=$mfw_ifs; mfw_probe_fail "/proc/1/environ holds $name" ;; esac',
			"done",
			"IFS=$mfw_ifs",
		);
	}
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
		`unset ${PROBE_SENTINEL} mfw_names mfw_p1 mfw_l mfw_s mfw_t mfw_ifs mfw_seen`,
	);
	return lines.join("\n");
}
