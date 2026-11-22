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

/** The probe as a shell script body (no shebang); exits 78 on the first failure. */
export function buildProbeScript(spec: MinimalProbeSpec): string {
	const lines: string[] = [
		"mfw_probe_fail() { printf 'sandbox_probe_failed: %s\\n' \"$1\" >&2; exit 78; }",
		// 1. no canary env: every name must be on the allowlist
		`allowed=" ${spec.allowedEnv.join(" ")} "`,
		'for name in $(env | sed -n "s/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p"); do',
		'  case "$allowed" in *" $name "*) ;; *) mfw_probe_fail "environment variable $name leaked into the sandbox" ;; esac',
		"done",
		// 2. the host's pid 1 environment is unreadable or empty
		'if [ -r /proc/1/environ ] && [ -n "$(tr -d "\\000" < /proc/1/environ 2>/dev/null | head -c 1)" ]; then',
		'  mfw_probe_fail "/proc/1/environ is readable and not empty"',
		"fi",
	];
	for (const d of spec.emptyDirs) {
		lines.push(
			`if [ -e ${q(d)} ] && [ -n "$(ls -A ${q(d)} 2>/dev/null)" ]; then mfw_probe_fail ${q(`${d} is not empty`)}; fi`,
		);
	}
	for (const d of spec.noSocketDirs) {
		lines.push(
			`if [ -d ${q(d)} ] && [ -n "$(find ${q(d)} -maxdepth 2 -type s 2>/dev/null | head -n 1)" ]; then mfw_probe_fail ${q(`a unix socket is reachable under ${d}`)}; fi`,
		);
	}
	return lines.join("\n");
}
