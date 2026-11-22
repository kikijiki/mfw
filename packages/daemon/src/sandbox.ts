import {
	accessSync,
	existsSync,
	constants as fsConstants,
	mkdirSync,
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
 * Residuals, stated plainly: the network namespace is shared, so abstract unix
 * sockets of the host (which tmpfs masks cannot hide) stay reachable until
 * E7b's netns; and sockets under `$HOME` (for example an agent's own IPC dir)
 * are inside the writable home. Nothing here degrades: callers refuse when
 * `bwrap` is missing.
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

const pinned = new Map<string, { pathVar: string | undefined; path: string }>();

/**
 * Host tools (`bwrap`, `tmux`, `env`, `bash`) resolved from a trusted `PATH`.
 * A hit is remembered for as long as `PATH` is unchanged, so a launch cannot
 * be redirected later by a planted binary; a miss is never remembered.
 */
export function pinnedTool(name: string): string | null {
	const pathVar = process.env.PATH;
	const hit = pinned.get(name);
	if (hit && hit.pathVar === pathVar) return hit.path;
	const path = pinnedToolIn(name, pathVar);
	if (path) pinned.set(name, { pathVar, path });
	else pinned.delete(name);
	return path;
}

/**
 * A pinned host tool, or a refusal. Used where a missing tool must stop the
 * operation rather than fall back to a `PATH` lookup an agent can steer
 * (security review X8).
 */
export function requireHostTool(name: string): string {
	const path = pinnedTool(name);
	if (!path) {
		throw new SandboxUnavailableError(`${name} is not on a trusted PATH`);
	}
	return path;
}

/**
 * The sandbox's `PATH` for the agent: the trusted entries first, then every
 * other entry of the daemon's `PATH`. An entry an agent can write (in `$HOME`,
 * `/tmp`) can therefore never shadow a trusted tool, so a run cannot plant a
 * binary that the next run starts with its secrets (security review X7).
 */
export function agentSandboxPath(pathVar: string | undefined): string {
	const trusted = trustedPathEntries(pathVar);
	const rest = (pathVar ?? "")
		.split(":")
		.filter((e) => e.startsWith("/") && !trusted.includes(e));
	return [...new Set([...trusted, ...rest])].join(":");
}

/** The host-only control directory (`run.sh`, secret FIFOs, exit records): masked in every sandbox. */
export function controlRootPath(uid: number = process.getuid?.() ?? 0): string {
	return join(tmpdir(), `mfw-control-${uid}`);
}

let cachedSafePath: { pathVar: string | undefined; value: string } | undefined;

/** `PATH` for host-side shells: trusted entries only. */
export function safeHostPath(): string {
	const pathVar = process.env.PATH;
	if (cachedSafePath && cachedSafePath.pathVar === pathVar) {
		return cachedSafePath.value;
	}
	const value = trustedPathEntries(pathVar).join(":");
	cachedSafePath = { pathVar, value };
	return value;
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
 * `/tmp/tmux-<uid>`, plus the nix daemon socket directory. Only paths that exist are masked; bwrap cannot create a
 * mount point on a read-only root, and an absent path holds nothing to leak.
 */
export function maskedRuntimePaths(
	env: NodeJS.ProcessEnv = process.env,
	uid: number = process.getuid?.() ?? 0,
	exists: (p: string) => boolean = existsSync,
): string[] {
	const tmuxBase = env.TMUX_TMPDIR?.startsWith("/") ? env.TMUX_TMPDIR : "/tmp";
	const candidates = [
		// The nix daemon socket gives root-equivalent builds to anyone who can reach it.
		"/nix/var/nix/daemon-socket",
		`/run/user/${uid}`,
		env.TMUX_TMPDIR,
		join(tmuxBase, `tmux-${uid}`),
		`/tmp/tmux-${uid}`,
	];
	const out = candidates.filter(
		(p): p is string => typeof p === "string" && p.startsWith("/") && exists(p),
	);
	const unique = [...new Set(out)];
	// A mask inside another mask is redundant and would leave a mount point behind in the outer tmpfs.
	return unique.filter((p) => !unique.some((o) => o !== p && within(p, o)));
}

/**
 * Create the tmux socket directory (`$TMUX_TMPDIR/tmux-<uid>`, default under
 * `/tmp`) with mode 0700 before masks are computed. On a first launch it does
 * not exist yet, would be skipped by `maskedRuntimePaths`, and tmux would then
 * create it where the sandbox can reach it (security review G8).
 */
export function ensureTmuxSocketDir(
	env: NodeJS.ProcessEnv = process.env,
	uid: number = process.getuid?.() ?? 0,
): string {
	const base = env.TMUX_TMPDIR?.startsWith("/") ? env.TMUX_TMPDIR : "/tmp";
	const dir = join(base, `tmux-${uid}`);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
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
		// Own pid namespace (security review G7): host processes of the same uid,
		// the daemon and other runs can no longer be signalled, and /proc/1 is the
		// sandbox's own init, which makes the probe's /proc/1/environ check real.
		"--unshare-pid",
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

export function probeScriptFor(
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

interface SandboxPlan {
	core: string[];
	/** Names handed over by value (never `PATH`); the values come from the launching shell. */
	names: string[];
	/** The probe, then `PATH` switched to the agent's, then `cmd`. */
	inner: (cmd: string) => string;
	/** Absolute pinned paths. */
	envPath: string;
	shell: string;
	/** What the probe and the shell itself see: trusted entries only. */
	trustedPath: string;
}

/**
 * The one place a sandbox invocation is built, for a real launch and for the
 * preflight probe alike, so the probe cannot pass with binds a launch does not
 * have (security review X13).
 */
function planSandbox(o: {
	cwd: string;
	runDir: string;
	isolation: BwrapIsolation;
	passEnv: readonly string[];
	readOnly?: readonly string[];
	env?: NodeJS.ProcessEnv;
}): SandboxPlan {
	const bwrapPath = pinnedTool("bwrap");
	const envPath = pinnedTool("env");
	const shell = pinnedTool("bash");
	if (!bwrapPath || !envPath || !shell) {
		throw new SandboxUnavailableError(
			"bwrap, env or bash is not on a trusted PATH",
		);
	}
	const env = o.env ?? process.env;
	const control = controlRootPath();
	// The control directory holds run scripts and exit records: always masked.
	const isolation: BwrapIsolation = {
		...o.isolation,
		hidePaths: [
			...new Set([
				...o.isolation.hidePaths,
				...(existsSync(control) ? [control] : []),
			]),
		],
	};
	const masks = maskedRuntimePaths(env);
	const names = [...new Set([...SANDBOX_ENV_ALLOWLIST, ...o.passEnv])].filter(
		(n) => n !== "PATH",
	);
	const core = bwrapCore({
		bwrapPath,
		cwd: o.cwd,
		runDir: o.runDir,
		isolation,
		masks,
		readOnly: o.readOnly,
	});
	const agentPath = agentSandboxPath(env.PATH);
	return {
		core,
		names,
		envPath,
		shell,
		trustedPath: safeHostPath(),
		inner: (cmd) =>
			// The probe runs with the trusted `PATH` only; the agent's `PATH` is set after it.
			`${probeScriptFor(isolation, [...names, "PATH"], masks)}\nPATH=${q(agentPath)}; export PATH\n${cmd}`,
	};
}

/**
 * Wrap a shell command in `bwrap`: host filesystem read-only, `$HOME`
 * re-bound read-write, `isolation.hidePaths` and the runtime and tmux dirs
 * masked, the environment cleared and rebuilt from the allowlist plus
 * `passEnv`, and the minimal probe run first (exit 78 on any failure).
 *
 * The returned text is a bash fragment for `run.sh`. Environment VALUES are
 * read from the shell at run time, so secrets handed over by the FIFO never
 * appear in the script, and they reach `bwrap` through an inherited pipe
 * (`--args`), never its argv, where any local user could read them from
 * `/proc/<pid>/cmdline` (security review X6). `--die-with-parent` ties the
 * sandbox to `run.sh` so a killed run leaks no `bwrap` process. Network is shared.
 */
export function wrapWithBwrap(
	cmd: string,
	cwd: string,
	runDir: string,
	isolation: BwrapIsolation,
	passEnv: readonly string[] = [],
	extra: { readOnly?: readonly string[] } = {},
): string {
	const plan = planSandbox({
		cwd,
		runDir,
		isolation,
		passEnv,
		readOnly: extra.readOnly,
	});
	return [
		"_mfw_env=()",
		`_mfw_env+=(--setenv ${PROBE_SENTINEL} 1)`,
		`for _n in ${plan.names.join(" ")}; do`,
		// biome-ignore lint/suspicious/noTemplateCurlyInString: bash indirect expansion, not a JS template
		'  if [ -n "${!_n+x}" ]; then _mfw_env+=(--setenv "$_n" "${!_n}"); fi',
		"done",
		`_mfw_env+=(--setenv PATH ${q(plan.trustedPath)})`,
		// The values ride a pipe made by a builtin, so no process ever has them in its argv.
		`${q(plan.envPath)} -i PATH="$PATH" ${plan.core.map(q).join(" ")} --args 3 -- ${q(plan.shell)} -c ${q(plan.inner(cmd))} 3< <(printf '%s\\0' "\${_mfw_env[@]}")`,
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
	let plan: SandboxPlan;
	try {
		plan = planSandbox({
			cwd: scratch,
			runDir: scratch,
			isolation,
			passEnv: [],
			env,
		});
	} catch (error) {
		return {
			ok: false,
			detail: error instanceof Error ? error.message : String(error),
		};
	}
	const argv = [
		plan.envPath,
		"-i",
		`PATH=${plan.trustedPath}`,
		...plan.core,
		...cleanEnvSetenvArgs(env, plan.names),
		"--setenv",
		"PATH",
		plan.trustedPath,
		"--setenv",
		PROBE_SENTINEL,
		"1",
		"--",
		plan.shell,
		"-c",
		plan.inner("true"),
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
