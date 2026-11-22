import {
	accessSync,
	existsSync,
	constants as fsConstants,
	realpathSync,
	statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildProbeScript,
	PROBE_EXIT_CODE,
	PROBE_SENTINEL,
} from "./containment/minimal-probe.ts";
import { runProc } from "./proc.ts";

/**
 * Agent filesystem and environment isolation (MFW-33 item 3; MFW-117 §3.5's
 * residual risk; the sandbox experiments E0 and E1).
 *
 * INTERIM. The agent runs as the same uid as the daemon, so this does not stop
 * a deliberate escape, and `$HOME` stays writable (agents need their login
 * until the per-run home exists) and the network stays shared. It closes the
 * casual path and the two leaks the experiments found:
 *
 *  - the daemon's own `$MFW_HOME` (arming store, credentials) is masked;
 *  - the environment is an explicit allowlist, started under `env -i` and
 *    `--clearenv`, so daemon and tmux-server secrets (E0, E1) are absent;
 *  - the user runtime dir and the tmux socket dirs are masked, and
 *    `--new-session` detaches the controlling terminal;
 *  - a minimal probe runs inside, before the driver, and fails closed.
 *
 * Nothing here degrades: callers refuse when `bwrap` is missing.
 */

export interface BwrapIsolation {
	mode: "bwrap";
	/** Absolute paths masked with an empty tmpfs. Applied after every writable
	 *  bind so a path nested under one (e.g. under `$HOME`) still overlays it. */
	hidePaths: string[];
}

/**
 * The environment names a sandbox may inherit from the launching process.
 * Modelled on the verifier's `DEFAULT_ENV_ALLOWLIST`: nothing that can hold a
 * credential. Per-run values (`MFW_*`, the agent's own keys) are added by name
 * from the launch spec, never by pattern.
 */
export const SANDBOX_ENV_ALLOWLIST: readonly string[] = [
	"PATH",
	"HOME",
	"LANG",
	"LC_ALL",
	"TZ",
	"TERM",
	"SHELL",
	"USER",
	"LOGNAME",
	"TMPDIR",
	"XDG_CACHE_HOME",
	"XDG_DATA_HOME",
	"XDG_CONFIG_HOME",
	"NIX_PATH",
	"NIX_PROFILES",
	"NIX_SSL_CERT_FILE",
	"SSL_CERT_FILE",
];

/** Names a POSIX shell adds on its own; the probe must not read them as leaks. */
const SHELL_OWN_ENV = ["PWD", "OLDPWD", "SHLVL", "_"];

/** Thrown instead of launching unsandboxed; the engine maps it to `sandbox_unavailable`. */
export class SandboxUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SandboxUnavailableError";
	}
}

/**
 * Directories an agent can write: `$HOME`, `/tmp` and the OS temp dir. A binary
 * found there is the agent's, not the host's (security review G4).
 */
function agentWritableRoots(): string[] {
	const roots = [homedir(), "/tmp", tmpdir()];
	return [...new Set(roots.map(realOrSelf))];
}

function realOrSelf(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

const within = (p: string, root: string) =>
	p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);

/**
 * `PATH` entries the agent cannot have planted a binary in: each entry is
 * resolved through symlinks (a `~/.nix-profile` link into the store is pinned
 * to its store target) and dropped if it lands in a writable root.
 */
export function trustedPathEntries(
	pathVar: string | undefined,
	writableRoots: readonly string[] = agentWritableRoots(),
): string[] {
	const out: string[] = [];
	for (const entry of (pathVar ?? "").split(":")) {
		if (!entry.startsWith("/")) continue;
		let real: string;
		try {
			real = realpathSync(entry);
		} catch {
			continue;
		}
		if (writableRoots.some((r) => within(real, r))) continue;
		if (!out.includes(real)) out.push(real);
	}
	return out;
}

/** The first executable `name` in a trusted `PATH` entry, as an absolute real path; null if none. */
export function pinnedToolIn(
	name: string,
	pathVar: string | undefined,
	writableRoots?: readonly string[],
): string | null {
	for (const dir of trustedPathEntries(pathVar, writableRoots)) {
		const candidate = join(dir, name);
		try {
			accessSync(candidate, fsConstants.X_OK);
			if (statSync(candidate).isFile()) return candidate;
		} catch {}
	}
	return null;
}

const pinned = new Map<string, string | null>();

/** Host tools (`bwrap`, `tmux`, `env`, `bash`) resolved once per process from a trusted `PATH`. */
export function pinnedTool(name: string): string | null {
	if (!pinned.has(name)) pinned.set(name, pinnedToolIn(name, process.env.PATH));
	return pinned.get(name) ?? null;
}

let cachedSafePath: string | undefined;

/** `PATH` for host-side shells: trusted entries only. */
export function safeHostPath(): string {
	cachedSafePath ??= trustedPathEntries(process.env.PATH).join(":");
	return cachedSafePath;
}

/** The pinned absolute `bwrap` path, resolved once per process; null when absent. */
export async function resolveBwrapPath(): Promise<string | null> {
	return pinnedTool("bwrap");
}

/** Cached for the process lifetime; checked on every launch. */
export async function bwrapAvailable(): Promise<boolean> {
	return (await resolveBwrapPath()) !== null;
}

/** Test seam: clears the `bwrapAvailable` memo. */
export function resetBwrapAvailableCache(): void {
	pinned.clear();
	cachedSafePath = undefined;
}

/** POSIX single-quote, mirrors `agent-host.ts`'s `q`. */
function q(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Directories masked with an empty tmpfs so the daemon's runtime and tmux
 * sockets are unreachable (E1): `/run/user/<uid>`, `$TMUX_TMPDIR` and
 * `/tmp/tmux-<uid>`. Only paths that exist are masked; bwrap cannot create a
 * mount point on a read-only root, and an absent path holds nothing to leak.
 */
export function maskedRuntimePaths(
	env: NodeJS.ProcessEnv = process.env,
	uid: number = process.getuid?.() ?? 0,
	exists: (p: string) => boolean = existsSync,
): string[] {
	const candidates = [`/run/user/${uid}`, env.TMUX_TMPDIR, `/tmp/tmux-${uid}`];
	const out = candidates.filter(
		(p): p is string => typeof p === "string" && p.startsWith("/") && exists(p),
	);
	return [...new Set(out)];
}

export interface BwrapCoreOptions {
	bwrapPath: string;
	cwd: string;
	runDir: string;
	isolation: BwrapIsolation;
	/** Paths bound read-only AFTER the writable binds (the reviewer's checkouts). */
	readOnly?: readonly string[];
	masks?: readonly string[];
}

/** The bwrap flags shared by the driver sandbox and the reviewer: no env, no command. */
export function bwrapCore(o: BwrapCoreOptions): string[] {
	const home = homedir();
	const writable = [...new Set([home, o.cwd, o.runDir])];
	const tokens: string[] = [
		o.bwrapPath,
		"--die-with-parent",
		"--new-session",
		"--ro-bind",
		"/",
		"/",
		"--dev",
		"/dev",
		"--proc",
		"/proc",
		// A private, empty `/tmp` per sandbox (security review G2/G8): runs share a
		// uid, so a shared `/tmp` lets one run reach another's FIFOs and sockets.
		// Build scratch still works; the writable binds below nest inside it.
		"--tmpfs",
		"/tmp",
	];
	for (const p of writable) tokens.push("--bind", p, p);
	for (const p of new Set(o.readOnly ?? [])) tokens.push("--ro-bind", p, p);
	// After every writable bind, so a masked path under one overlays it.
	for (const p of new Set([...(o.masks ?? []), ...o.isolation.hidePaths])) {
		tokens.push("--tmpfs", p);
	}
	tokens.push("--clearenv");
	return tokens;
}

function probeScriptFor(
	isolation: BwrapIsolation,
	allowedEnv: readonly string[],
	masks: readonly string[],
): string {
	return buildProbeScript({
		allowedEnv: [...allowedEnv, ...SHELL_OWN_ENV],
		emptyDirs: [...isolation.hidePaths, ...masks],
		noSocketDirs: [...masks],
	});
}

/**
 * Wrap a shell command in `bwrap`: host filesystem read-only, `$HOME`
 * re-bound read-write, `isolation.hidePaths` and the runtime and tmux dirs
 * masked, the environment cleared and rebuilt from the allowlist plus
 * `passEnv`, and the minimal probe run first (exit 78 on any failure).
 *
 * The returned text is a bash fragment for `run.sh`. Environment VALUES are
 * read from the shell at run time, so secrets handed over by the FIFO never
 * appear in the script. `--die-with-parent` ties the sandbox to `run.sh` so a
 * killed run leaks no `bwrap` process. Network is shared.
 */
export function wrapWithBwrap(
	cmd: string,
	cwd: string,
	runDir: string,
	isolation: BwrapIsolation,
	passEnv: readonly string[] = [],
	extra: { readOnly?: readonly string[] } = {},
): string {
	const bwrapPath = pinnedTool("bwrap");
	const envPath = pinnedTool("env");
	if (!bwrapPath || !envPath) {
		throw new SandboxUnavailableError("bwrap is not on a trusted PATH");
	}
	const masks = maskedRuntimePaths();
	// PATH is handled apart: run.sh keeps a trusted host PATH for itself and
	// hands the daemon's full PATH to the sandbox as MFW_SANDBOX_PATH.
	const names = [...new Set([...SANDBOX_ENV_ALLOWLIST, ...passEnv])].filter(
		(n) => n !== "PATH",
	);
	const core = bwrapCore({
		bwrapPath,
		cwd,
		runDir,
		isolation,
		masks,
		readOnly: extra.readOnly,
	});
	const inner = `${probeScriptFor(isolation, [...names, "PATH"], masks)}\n${cmd}`;
	return [
		"_mfw_env=()",
		`_mfw_env+=(--setenv ${PROBE_SENTINEL} 1)`,
		`for _n in ${names.join(" ")}; do`,
		// biome-ignore lint/suspicious/noTemplateCurlyInString: bash indirect expansion, not a JS template
		'  if [ -n "${!_n+x}" ]; then _mfw_env+=(--setenv "$_n" "${!_n}"); fi',
		"done",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: bash default expansion
		'_mfw_env+=(--setenv PATH "${MFW_SANDBOX_PATH-$PATH}")',
		`${q(envPath)} -i PATH="$PATH" ${core.map(q).join(" ")} "\${_mfw_env[@]}" -- sh -c ${q(inner)}`,
	].join("\n");
}

/** `--setenv` pairs for the named variables present in `source`. */
export function cleanEnvSetenvArgs(
	source: NodeJS.ProcessEnv,
	names: readonly string[],
): string[] {
	const out: string[] = [];
	for (const n of new Set(names)) {
		const v = source[n];
		if (typeof v === "string") out.push("--setenv", n, v);
	}
	return out;
}

export type SandboxProbeResult = { ok: true } | { ok: false; detail: string };

const PROBE_TTL_MS = 60_000;
let probeMemo: { key: string; at: number; result: SandboxProbeResult } | null =
	null;

/** Test seam: forgets the memoized probe. */
export function resetSandboxProbeCache(): void {
	probeMemo = null;
}

/**
 * Run the minimal probe in a real bwrap, with the same flags a run gets.
 * Memoized for a minute per isolation, so preflight stays cheap. A bwrap that
 * cannot start (no user namespaces, AppArmor) is a failed probe too.
 */
export async function probeSandbox(
	isolation: BwrapIsolation,
	opts: { env?: NodeJS.ProcessEnv; now?: () => number } = {},
): Promise<SandboxProbeResult> {
	const bwrapPath = await resolveBwrapPath();
	if (!bwrapPath) return { ok: false, detail: "bwrap is not on PATH" };
	const now = (opts.now ?? Date.now)();
	const key = JSON.stringify(isolation);
	if (probeMemo && probeMemo.key === key && now - probeMemo.at < PROBE_TTL_MS) {
		return probeMemo.result;
	}
	const env = opts.env ?? process.env;
	const scratch = tmpdir();
	const masks = maskedRuntimePaths(env);
	const core = bwrapCore({
		bwrapPath,
		cwd: scratch,
		runDir: scratch,
		isolation,
		masks,
	});
	const envPath = pinnedTool("env");
	if (!envPath) return { ok: false, detail: "env is not on a trusted PATH" };
	const argv = [
		envPath,
		"-i",
		`PATH=${env.PATH ?? "/usr/bin:/bin"}`,
		...core,
		...cleanEnvSetenvArgs(env, SANDBOX_ENV_ALLOWLIST),
		"--setenv",
		PROBE_SENTINEL,
		"1",
		"--",
		"sh",
		"-c",
		`${probeScriptFor(isolation, SANDBOX_ENV_ALLOWLIST, masks)}\ntrue`,
	];
	let result: SandboxProbeResult;
	try {
		const r = await runProc(argv, { timeoutMs: 15_000 });
		result =
			r.exitCode === 0
				? { ok: true }
				: {
						ok: false,
						detail:
							(r.stderr || r.stdout).trim().split("\n").pop() ||
							`probe exited ${r.exitCode ?? "by signal"} (expected ${PROBE_EXIT_CODE} on a refusal)`,
					};
	} catch (error) {
		result = {
			ok: false,
			detail: error instanceof Error ? error.message : String(error),
		};
	}
	probeMemo = { key, at: now, result };
	return result;
}

/**
 * The preflight gate for autonomy: null when the run may go, else the refusal.
 * `interactive` runs ask a human for every action, so they may run unsandboxed
 * (`agentIsolation: "none"`).
 */
export async function autonomySandboxRefusal(o: {
	approvalMode: "autonomous" | "interactive";
	isolation: BwrapIsolation | undefined;
	probe?: typeof probeSandbox;
	/** Test seam for "bwrap is absent". */
	available?: () => Promise<boolean>;
}): Promise<{
	code: "sandbox_unavailable" | "sandbox_probe_failed";
	detail: string;
} | null> {
	if (o.approvalMode !== "autonomous") return null;
	if (!o.isolation) {
		return {
			code: "sandbox_unavailable",
			detail: "agentIsolation is none",
		};
	}
	if (!(await (o.available ?? bwrapAvailable)())) {
		return { code: "sandbox_unavailable", detail: "bwrap is not on PATH" };
	}
	const probed = await (o.probe ?? probeSandbox)(o.isolation);
	return probed.ok
		? null
		: { code: "sandbox_probe_failed", detail: probed.detail };
}

/** True for a path inside the private `/tmp`, i.e. one a sandbox would not otherwise see. */
export function underPrivateTmp(p: string): boolean {
	return p === "/tmp" || p.startsWith("/tmp/");
}
