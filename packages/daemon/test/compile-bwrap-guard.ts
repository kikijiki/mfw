/**
 * The guards in front of the destructive live sandbox tests. A mis-scoped
 * destructive test can erase a real home, so these fail closed:
 *
 * - `assertContained` walks every bwrap option against an allowlist. Anything
 *   it does not know is refused, and a writable mount must be a plain `--bind`
 *   from inside the fixture onto an expected destination.
 * - `checkControlReport` judges what a harmless command saw from inside the
 *   same sandbox: its own namespaces, the exact set of writable mounts, a
 *   read-only root, and no real home. Exit codes and failed writes prove
 *   nothing here, because an unsandboxed non-root user also cannot write `/`.
 */

import { readlinkSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, posix } from "node:path";

/** The mounts every compiled sandbox has writable, whatever its profile. */
export const BASE_WRITABLE: readonly string[] = [
	"/proc",
	"/dev",
	"/dev/null",
	"/dev/zero",
	"/dev/full",
	"/dev/random",
	"/dev/urandom",
	"/dev/tty",
	"/dev/pts",
	"/tmp",
	"/run",
	"/run/user",
	"/sandbox/agent",
];

const TMPFS = new Set([
	"/tmp",
	"/run",
	"/run/user",
	"/sandbox/agent",
	"/scratch",
]);
const FLAGS = new Set([
	"--unshare-all",
	"--unshare-user",
	"--disable-userns",
	"--die-with-parent",
	"--new-session",
]);
const NAMESPACES = ["mnt", "user", "net", "pid"] as const;

export interface GuardSpec {
	/** The throwaway fixture directory. */
	root: string;
	bwrap: string;
	env: string;
	/** Real home paths: never mounted, and never inside or equal to `root`'s parent chain. */
	homes: readonly string[];
	/** Other host paths that must be invisible in the sandbox. */
	hidden: readonly string[];
	/** The launching process's namespace links. */
	hostNs: Readonly<Record<string, string>>;
	/** The exact set of writable mount points expected inside. */
	writable: readonly string[];
}

const under = (path: string, dir: string): boolean =>
	path === dir || path.startsWith(dir === "/" ? "/" : `${dir}/`);

const canonical = (p: string): boolean =>
	isAbsolute(p) && posix.normalize(p) === p && (p === "/" || !p.endsWith("/"));

function refuse(why: string): never {
	throw new Error(`refusing to launch: ${why}`);
}

/** Every path the real user's home could be known by. */
export function realHomes(): string[] {
	const out = new Set<string>([homedir(), userInfo().homedir]);
	if (process.env.HOME) out.add(process.env.HOME);
	return [...out].filter((p) => isAbsolute(p) && p !== "/");
}

export function hostNamespaces(): Record<string, string> {
	return Object.fromEntries(
		NAMESPACES.map((ns) => [ns, readlinkSync(`/proc/self/ns/${ns}`)]),
	);
}

function checkBindSource(source: string, dest: string, spec: GuardSpec): void {
	if (!canonical(source) || source === spec.root || !under(source, spec.root)) {
		refuse(`writable bind ${source} is outside the fixture`);
	}
	if (!spec.writable.includes(dest) || BASE_WRITABLE.includes(dest)) {
		refuse(`writable bind onto unexpected destination ${dest}`);
	}
}

function checkReadOnlySource(source: string, spec: GuardSpec): void {
	if (!canonical(source) || source === "/") {
		refuse(`read-only bind of ${source}`);
	}
	if (source !== spec.root && under(source, spec.root)) return;
	for (const home of spec.homes) {
		if (under(source, home) || under(home, source)) {
			refuse(`read-only bind ${source} overlaps the real home ${home}`);
		}
	}
}

/**
 * Validate a compiled argv and return it without the `systemd-run` scope.
 * Throws on anything not explicitly allowed.
 */
export function assertContained(input: string[], spec: GuardSpec): string[] {
	if (!canonical(spec.root) || spec.root === "/") {
		refuse(`bad fixture root ${spec.root}`);
	}
	for (const home of spec.homes) {
		if (under(home, spec.root)) {
			refuse(`fixture root ${spec.root} contains the real home ${home}`);
		}
	}
	const argv = input.slice(input.indexOf("--") + 1);
	if (argv[0] !== spec.env || argv[1] !== "-i" || argv[2] !== spec.bwrap) {
		refuse("not an env -i bwrap command");
	}

	const seen = new Set<string>();
	let rootReadOnly = false;
	let i = 3;
	const value = (): string => {
		const v = argv[++i];
		if (v === undefined) refuse(`${argv[i - 1]} is missing a value`);
		return v;
	};
	for (; i < argv.length; i++) {
		const opt = argv[i] as string;
		if (opt === "--") break;
		seen.add(opt);
		if (FLAGS.has(opt)) continue;
		switch (opt) {
			case "--cap-drop":
				if (value() !== "ALL") refuse("--cap-drop must be ALL");
				break;
			case "--seccomp":
				if (value() !== "3") refuse("--seccomp must be fd 3");
				break;
			case "--proc":
				if (value() !== "/proc") refuse("--proc must be /proc");
				break;
			case "--dev":
				if (value() !== "/dev") refuse("--dev must be /dev");
				break;
			case "--perms":
				if (value() !== "0700") refuse("--perms must be 0700");
				break;
			case "--tmpfs": {
				const dest = value();
				if (!TMPFS.has(dest)) refuse(`unexpected tmpfs ${dest}`);
				break;
			}
			case "--dir":
			case "--chdir": {
				const dest = value();
				if (!canonical(dest)) refuse(`${opt} ${dest}`);
				break;
			}
			case "--remount-ro": {
				const dest = value();
				if (dest !== "/") refuse(`--remount-ro ${dest}`);
				rootReadOnly = true;
				break;
			}
			case "--setenv":
				value();
				value();
				break;
			case "--ro-bind":
			case "--ro-bind-try": {
				const source = value();
				value();
				checkReadOnlySource(source, spec);
				break;
			}
			case "--bind": {
				const source = value();
				const dest = value();
				if (!rootReadOnly) refuse("writable bind before --remount-ro /");
				checkBindSource(source, dest, spec);
				break;
			}
			default:
				refuse(`option ${opt} is not on the allowlist`);
		}
	}
	if (argv[i] !== "--") refuse("no -- before the command");
	if (i + 1 >= argv.length) refuse("no command");
	for (const flag of [...FLAGS, "--cap-drop", "--seccomp", "--remount-ro"]) {
		if (!seen.has(flag)) refuse(`no ${flag}`);
	}
	return argv;
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** A read-only command whose output {@link checkControlReport} judges. */
export function buildControlScript(spec: GuardSpec): string {
	const paths = [...spec.homes, ...spec.hidden].map(shellQuote).join(" ");
	return [
		`for ns in ${NAMESPACES.join(" ")}; do printf 'NS %s %s\\n' "$ns" "$(readlink /proc/self/ns/$ns)"; done`,
		`for p in ${paths}; do if [ -e "$p" ] || [ -L "$p" ]; then printf 'PRESENT %s\\n' "$p"; fi; done`,
		"echo MOUNTINFO",
		"cat /proc/self/mountinfo",
	].join("\n");
}

const decodeMountPath = (p: string): string =>
	p.replace(/\\([0-7]{3})/g, (_m, oct: string) =>
		String.fromCharCode(Number.parseInt(oct, 8)),
	);

/** Everything wrong with a control report; empty only for the expected sandbox. */
export function checkControlReport(out: string, spec: GuardSpec): string[] {
	const problems: string[] = [];
	const lines = out.split("\n");
	const marker = lines.indexOf("MOUNTINFO");
	if (marker < 0) return ["the control report has no mount table"];

	const ns = new Map<string, string>();
	for (const line of lines.slice(0, marker)) {
		const [kind, a, b] = line.split(" ");
		if (kind === "NS" && a) ns.set(a, b ?? "");
		else if (line.startsWith("PRESENT ")) {
			problems.push(`${line.slice(8)} is visible in the sandbox`);
		} else if (line !== "") problems.push(`unexpected report line: ${line}`);
	}
	for (const name of NAMESPACES) {
		const inside = ns.get(name);
		if (!inside) problems.push(`namespace ${name} is unreadable`);
		else if (inside === spec.hostNs[name]) {
			problems.push(`namespace ${name} is the host's`);
		}
	}

	const writable = new Set<string>();
	let rootSeen = false;
	const forbidden = [...spec.homes, ...spec.hidden];
	for (const line of lines.slice(marker + 1)) {
		if (line === "") continue;
		const fields = line.split(" ");
		const point = fields[4];
		const opts = fields[5];
		if (point === undefined || opts === undefined || !fields.includes("-")) {
			problems.push(`unparseable mount line: ${line}`);
			continue;
		}
		const path = decodeMountPath(point);
		const access = opts.split(",")[0];
		if (path === "/") rootSeen = true;
		if (access === "rw") writable.add(path);
		else if (access !== "ro") problems.push(`${path} has no access mode`);
		const hit = forbidden.find((f) => under(path, f));
		if (hit) problems.push(`mount ${path} is inside ${hit}`);
	}
	if (!rootSeen) problems.push("the mount table has no root");
	for (const path of writable) {
		if (!spec.writable.includes(path)) {
			problems.push(`unexpected writable mount ${path}`);
		}
	}
	for (const path of spec.writable) {
		if (!writable.has(path)) problems.push(`missing writable mount ${path}`);
	}
	return problems;
}
