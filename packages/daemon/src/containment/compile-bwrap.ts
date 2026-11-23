/**
 * Compile a SandboxProfile into the Tier 1 launch command (design "Tier 1
 * bwrap profile"):
 *
 *   systemd-run --user --scope ... -- env -i bwrap --args 4 -- <command>
 *
 * Every bwrap option travels through `--args` on fd 4, never in argv: env
 * values would otherwise be readable from `/proc/<pid>/cmdline`, on the host
 * and as the sandbox's pid 1. The command stays in argv, so it must never
 * carry a secret.
 *
 * Pure over {@link CompileHost}, so the argv can be snapshotted anywhere. It
 * never degrades: a host or profile it cannot enforce gets a refusal with the
 * fix, and there is no unsandboxed or partial result.
 *
 * Mount order matters. Everything that needs a mount point on the root tmpfs
 * is created first, then `--remount-ro /`, then the workspace, caches and
 * fleet config, which keep their own access mode.
 *
 * bwrap follows a bind source that is a symlink, so every profile source must
 * already be its own real path, and is mounted from a descriptor opened at
 * launch (`--bind-fd`, see pinned-binds.ts). The caller passes the returned
 * seccomp bytes as the child's fd 3, the options as its fd 4, and each entry
 * of `pinnedBinds` on exactly its `fd`.
 */

import { posix } from "node:path";
import { egressClientEnv } from "./egress-env.ts";
import {
	type Arch,
	BWRAP_BIND_FD_MIN_VERSION,
	type BwrapValue,
	bwrapSupportsBindFd,
	type Check,
	type SystemdUserValue,
	type UsernsValue,
} from "./host-caps.ts";
import { planLimits } from "./limits.ts";
import type { PinnedBind } from "./pinned-binds.ts";
import {
	effectiveLimits,
	ProfileRejectedError,
	parseSandboxProfile,
	type SandboxProfile,
} from "./profile.ts";
import { runDirLayout, runStateRoot } from "./run-dir.ts";
import {
	DISABLE_USERNS_BWRAP_ARGS,
	generateSeccompProgram,
	SECCOMP_BWRAP_ARGS,
	SeccompUnsupportedError,
} from "./seccomp.ts";
import { type ToolchainPlan, toolchainBwrapArgs } from "./toolchain.ts";

/** Sandbox-side layout. Owned here, never configurable. */
export const SANDBOX_PATHS = {
	home: "/sandbox/agent",
	workspace: "/work",
	gitDir: "/git",
	scratch: "/scratch",
	caches: "/cache",
	fleet: "/fleet",
	egress: "/run/mfw/egress",
	runControl: "/mfw-run/control",
	runOutbox: "/mfw-run/outbox",
} as const;

const FLEET_ENV = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" } as const;

/** PATH when the profile declares no toolchain: nothing resolves. */
const EMPTY_PATH = "/nonexistent";

/** The child's descriptor for the bwrap options (3 is the seccomp program). */
export const BWRAP_ARGS_FD = 4;

/** The child's first descriptor for a pinned bind source. */
export const FIRST_PINNED_FD = 5;

export interface CompileHost {
	caps: {
		userns: Check<UsernsValue>;
		bwrap: Check<BwrapValue>;
		systemd: Check<SystemdUserValue>;
		arch: Check<Arch>;
	};
	/** Absolute: `env -i` leaves no PATH to find bwrap with. */
	bwrapPath: string;
	envPath: string;
	systemdRunPath: string;
	toolchain: ToolchainPlan;
	/** The real home and `$MFW_HOME`: never bound, whole or through an ancestor. */
	home: string;
	mfwHome: string;
	/** Project state directories holding a DB: never bound, whole or through an ancestor. */
	projectDbDirs?: readonly string[];
	/** Host directories that profile sources must sit strictly inside. */
	allowedRoots: readonly string[];
	/** `realpath`, or null when the path does not exist. */
	realpath(path: string): string | null;
	/** Scope unit name, without `.scope`. */
	unit?: string;
}

export type CompileRefusalCode =
	| "host_unsupported"
	| "invalid_profile"
	| "invalid_command"
	| "invalid_host"
	| "toolchain_unresolved"
	| "toolchain_undeclared"
	| "path_denied"
	| "path_not_canonical"
	| "path_outside_roots"
	| "bind_overlap";

export interface CompileRefusal {
	ok: false;
	code: CompileRefusalCode;
	reason: string;
	fix: string;
}

export interface CompiledSandbox {
	ok: true;
	/** The full command, starting at `systemd-run`. Holds no bwrap option but `--args`. */
	argv: string[];
	/** Pass as the child's fd 3. */
	seccomp: Buffer;
	/** NUL-terminated bwrap options, including env values. Pass as the child's fd 4. */
	bwrapArgs: Buffer;
	/** Sources to open at launch and pass on exactly these child descriptors. */
	pinnedBinds: PinnedBind[];
	/** The run dir whose layout the launcher must verify before pinning. */
	runDirRoot?: string;
	/** The environment set inside the sandbox, for the audit trail. */
	env: Record<string, string>;
	cwd: string;
}

export type CompileResult = CompiledSandbox | CompileRefusal;

const refuse = (
	code: CompileRefusalCode,
	reason: string,
	fix: string,
): CompileRefusal => ({ ok: false, code, reason, fix });

function under(path: string, dir: string): boolean {
	return path === dir || path.startsWith(`${dir}/`);
}

function overlaps(a: string, b: string): boolean {
	return under(a, b) || under(b, a);
}

/** `dir/rel`, or null unless the result sits strictly inside `dir`. */
export function joinUnder(dir: string, rel: string): string | null {
	const full = posix.join(dir, rel);
	return full !== dir && under(full, dir) ? full : null;
}

interface SourceBind {
	label: string;
	source: string;
	writable: boolean;
}

/** Every host path the profile asks to expose. */
function profileSources(profile: SandboxProfile): SourceBind[] {
	const fs = profile.filesystem;
	const out: SourceBind[] = [];
	if (fs?.workspace) {
		const writable = fs.workspace.access === "rw";
		out.push({ label: "workspace", source: fs.workspace.source, writable });
		if (fs.workspace.gitDir) {
			out.push({ label: "gitDir", source: fs.workspace.gitDir, writable });
		}
	}
	if (fs?.runDir) {
		const layout = runDirLayout(fs.runDir.source);
		out.push({ label: "run control", source: layout.control, writable: false });
		out.push({
			label: "run outbox",
			source: layout.outbox,
			writable: fs.runDir.outbox === "rw",
		});
	}
	for (const c of fs?.caches ?? []) {
		out.push({
			label: `cache ${c.name}`,
			source: c.source,
			writable: c.access === "rw",
		});
	}
	if (fs?.fleetConfig) {
		const privateState = fs.fleetConfig.privateState;
		out.push({
			label: "fleet config",
			source: fs.fleetConfig.source,
			writable: !privateState && fs.fleetConfig.writable.length > 0,
		});
		if (privateState && fs.fleetConfig.writable.length > 0) {
			out.push({
				label: "fleet private state",
				source: privateState,
				writable: true,
			});
		}
	}
	if (profile.network?.mode === "proxy") {
		out.push({
			label: "egress socket dir",
			source: profile.network.socketDir,
			writable: false,
		});
	}
	return out;
}

function checkHost(host: CompileHost): CompileRefusal | null {
	for (const check of [
		host.caps.userns,
		host.caps.bwrap,
		host.caps.systemd,
		host.caps.arch,
	]) {
		if (!check.ok) {
			return refuse(
				"host_unsupported",
				check.detail,
				check.fix ?? "run `mfw doctor`",
			);
		}
	}
	if (!bwrapSupportsBindFd(host.caps.bwrap.value)) {
		return refuse(
			"host_unsupported",
			`bwrap ${host.caps.bwrap.value.version ?? "(unknown version)"} lacks --bind-fd and --ro-bind-fd, so bind sources cannot be pinned`,
			`upgrade bubblewrap to ${BWRAP_BIND_FD_MIN_VERSION} or newer`,
		);
	}
	for (const [name, p] of [
		["bwrapPath", host.bwrapPath],
		["envPath", host.envPath],
		["systemdRunPath", host.systemdRunPath],
		["home", host.home],
		["mfwHome", host.mfwHome],
	] as const) {
		if (!p.startsWith("/") || posix.normalize(p) !== p || p === "/") {
			return refuse(
				"invalid_host",
				`${name} must be a canonical absolute path, got ${p}`,
				"resolve the path before compiling",
			);
		}
	}
	return null;
}

/** The protected locations, both as given and with symlinks resolved. */
function protectedRoots(host: CompileHost, profile: SandboxProfile): string[] {
	const runDir = profile.filesystem?.runDir?.source;
	const state = runDir ? runStateRoot(runDir) : null;
	const roots = [
		host.home,
		host.mfwHome,
		...(host.projectDbDirs ?? []),
		...(state ? [state] : []),
	];
	const out = new Set(roots);
	for (const p of roots) {
		const real = host.realpath(p);
		if (real) out.add(real);
	}
	return [...out];
}

/**
 * The run root stays out of every sandbox: nothing may be bound at, above or
 * inside it except its own `control/` and `outbox/`. A bind of the root or an
 * ancestor would let the sandbox rename either directory, or reach a sibling
 * run, and a bind inside it would expose host-only files.
 */
function checkRunDir(
	profile: SandboxProfile,
	host: CompileHost,
): CompileRefusal | null {
	const root = profile.filesystem?.runDir?.source;
	if (!root) return null;
	if (host.realpath(root) !== root) {
		return refuse(
			"path_not_canonical",
			`run dir ${root} is missing or reached through a symlink`,
			"create it and pass its real path",
		);
	}
	for (const s of profileSources(profile)) {
		// By label: another bind aimed at the same directory is still refused.
		if (s.label === "run control" || s.label === "run outbox") continue;
		if (overlaps(s.source, root)) {
			return refuse(
				"bind_overlap",
				`${s.label} ${s.source} overlaps the run dir ${root}`,
				"bind only the run's control and outbox",
			);
		}
	}
	return null;
}

/**
 * Every deny entry, both as written and resolved, because a bind source is
 * always a real path and a symlinked entry would otherwise never match it. A
 * missing entry resolves through its parent. If the parent cannot be resolved
 * the entry cannot be enforced, so the compile is refused.
 */
function resolveDeny(
	profile: SandboxProfile,
	host: CompileHost,
): string[] | CompileRefusal {
	const out = new Set<string>();
	for (const entry of profile.filesystem?.deny ?? []) {
		out.add(entry);
		const real = host.realpath(entry);
		if (real) {
			out.add(real);
			continue;
		}
		const parent = host.realpath(posix.dirname(entry));
		if (!parent) {
			return refuse(
				"path_denied",
				`deny entry ${entry} cannot be resolved`,
				"create its parent directory or remove the entry",
			);
		}
		out.add(posix.join(parent, posix.basename(entry)));
	}
	return [...out];
}

function checkSources(
	profile: SandboxProfile,
	host: CompileHost,
	deny: readonly string[],
): CompileRefusal | null {
	const sources = profileSources(profile);
	const guarded = protectedRoots(host, profile);

	for (const root of host.allowedRoots) {
		if (host.realpath(root) !== root) {
			return refuse(
				"path_not_canonical",
				`allowed root ${root} is not its own real path`,
				"pass resolved allowed roots",
			);
		}
		const hit = guarded.find((g) => under(g, root));
		if (hit) {
			return refuse(
				"path_denied",
				`allowed root ${root} contains the protected path ${hit}`,
				"allow only per-run directories",
			);
		}
	}

	for (const s of sources) {
		const denied = deny.find((d) => overlaps(s.source, d));
		if (denied) {
			return refuse(
				"path_denied",
				`${s.label} ${s.source} overlaps the denied path ${denied}`,
				"remove the bind or the deny entry",
			);
		}
		const hit = guarded.find((g) => under(g, s.source));
		if (hit) {
			return refuse(
				"path_denied",
				`${s.label} ${s.source} contains the protected path ${hit}`,
				"bind a per-run directory instead",
			);
		}
		if (!host.allowedRoots.some((r) => s.source !== r && under(s.source, r))) {
			return refuse(
				"path_outside_roots",
				`${s.label} ${s.source} is outside the allowed roots`,
				"place it under a per-run directory",
			);
		}
		if (host.realpath(s.source) !== s.source) {
			return refuse(
				"path_not_canonical",
				`${s.label} ${s.source} is missing or reached through a symlink`,
				"create it and pass its real path",
			);
		}
	}

	// A read-only bind and a writable alias of the same tree would defeat the
	// read-only mount, so any overlap involving a writable bind is refused.
	for (let i = 0; i < sources.length; i++) {
		for (let j = i + 1; j < sources.length; j++) {
			const a = sources[i] as SourceBind;
			const b = sources[j] as SourceBind;
			if ((a.writable || b.writable) && overlaps(a.source, b.source)) {
				return refuse(
					"bind_overlap",
					`${a.label} ${a.source} overlaps ${b.label} ${b.source}`,
					"use separate directories",
				);
			}
		}
	}

	const fleet = profile.filesystem?.fleetConfig;
	if (fleet) {
		for (const rel of fleet.writable) {
			// The shared directory is the mount point, the private one the source.
			for (const root of [fleet.source, fleet.privateState]) {
				if (!root) continue;
				const full = joinUnder(root, rel);
				if (full === null) {
					return refuse(
						"path_denied",
						`fleet directory ${rel} leaves ${root}`,
						"name a directory inside the fleet config",
					);
				}
				if (host.realpath(full) !== full) {
					return refuse(
						"path_not_canonical",
						`fleet directory ${full} is missing or reached through a symlink`,
						"create it as a real directory",
					);
				}
			}
		}
	}
	return null;
}

/**
 * What a profile actually gets from the host's toolchain plan:
 *
 * - no section or an empty binary list: nothing, not even `/usr`, and a PATH
 *   that resolves nothing;
 * - declared binaries: their own binds, plus the fixed system, Nix and `/etc`
 *   binds that dynamic linking, shebangs and TLS need. Those are read-only and
 *   hold no user data.
 *
 * HOME toolchain roots that no declared binary lives in are dropped, because
 * the plan adds every root that exists on the host. PATH is rebuilt from the
 * declared binaries, in declared order.
 */
function declaredToolchain(
	profile: SandboxProfile,
	plan: ToolchainPlan,
): ToolchainPlan {
	const declared = profile.filesystem?.toolchain?.binaries ?? [];
	if (declared.length === 0) {
		return { binds: [], resolved: [], unresolved: [], pathDirs: [] };
	}
	const resolved = declared.flatMap((name) =>
		plan.resolved.filter((b) => b.name === name),
	);
	return {
		binds: plan.binds.filter((b) => !(b.source === "home" && b.optional)),
		resolved,
		unresolved: [],
		pathDirs: [...new Set(resolved.map((b) => posix.dirname(b.path)))],
	};
}

function checkToolchain(
	profile: SandboxProfile,
	host: CompileHost,
	deny: readonly string[],
): CompileRefusal | null {
	const declared = profile.filesystem?.toolchain?.binaries;
	if (!declared) return null;
	const resolved = new Set(host.toolchain.resolved.map((b) => b.name));
	for (const name of declared) {
		if (!resolved.has(name)) {
			const why = host.toolchain.unresolved.find((u) => u.name === name);
			return refuse(
				"toolchain_unresolved",
				`binary ${name} is unavailable: ${why?.reason ?? "not in the plan"}`,
				"install it in a known toolchain root or remove it from the profile",
			);
		}
	}
	const undeclared = host.toolchain.resolved.find(
		(b) => !declared.includes(b.name),
	);
	if (undeclared) {
		return refuse(
			"toolchain_undeclared",
			`the toolchain plan holds ${undeclared.name}, which the profile does not declare`,
			"discover the toolchain from the profile's binary list",
		);
	}
	const guarded = protectedRoots(host, profile);
	// Toolchain roots legitimately sit inside the real home, never inside MFW_HOME.
	const homes = new Set([host.home, host.realpath(host.home)]);
	const mounted = new Set(
		declaredToolchain(profile, host.toolchain).binds.map((b) => b.path),
	);
	// The protected-path checks cover the whole plan: a plan holding a bind of
	// HOME is wrong even when this profile would not mount that entry.
	for (const b of host.toolchain.binds) {
		const real = host.realpath(b.path) ?? b.path;
		const denied = mounted.has(b.path)
			? deny.find((d) => overlaps(b.path, d) || overlaps(real, d))
			: undefined;
		if (denied) {
			return refuse(
				"path_denied",
				`toolchain bind ${b.path} overlaps the denied path ${denied}`,
				"remove the deny entry or the binary",
			);
		}
		const hit = guarded.find((g) => under(g, b.path));
		if (hit) {
			return refuse(
				"path_denied",
				`toolchain bind ${b.path} contains the protected path ${hit}`,
				"move the protected path out of the toolchain root",
			);
		}
		const inside = guarded.find((g) => !homes.has(g) && under(b.path, g));
		if (inside) {
			return refuse(
				"path_denied",
				`toolchain bind ${b.path} is inside ${inside}`,
				"install the toolchain outside MFW_HOME",
			);
		}
	}
	return null;
}

function buildEnv(
	profile: SandboxProfile,
	host: CompileHost,
): Record<string, string> {
	const home = SANDBOX_PATHS.home;
	const { pathDirs } = declaredToolchain(profile, host.toolchain);
	const env: Record<string, string> = {
		PATH: pathDirs.length > 0 ? pathDirs.join(":") : EMPTY_PATH,
		HOME: home,
		USER: "agent",
		LOGNAME: "agent",
		TERM: "dumb",
		LANG: "C.UTF-8",
		TMPDIR: "/tmp",
		XDG_CACHE_HOME: `${home}/.cache`,
		XDG_CONFIG_HOME: `${home}/.config`,
		XDG_DATA_HOME: `${home}/.local/share`,
		XDG_STATE_HOME: `${home}/.local/state`,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
	};
	const fs = profile.filesystem;
	if (fs?.workspace?.gitDir) {
		env.GIT_DIR = SANDBOX_PATHS.gitDir;
		env.GIT_WORK_TREE = SANDBOX_PATHS.workspace;
	}
	if (fs?.fleetConfig) {
		env[FLEET_ENV[fs.fleetConfig.cli]] =
			`${SANDBOX_PATHS.fleet}/${fs.fleetConfig.cli}`;
	}
	if (fs?.runDir) {
		env.MFW_RUN_CONTROL = SANDBOX_PATHS.runControl;
		env.MFW_RUN_OUTBOX = SANDBOX_PATHS.runOutbox;
	}
	if (profile.network?.mode === "proxy") Object.assign(env, egressClientEnv());
	// The schema rejects reserved names; the spread order is a second guard.
	return { ...(profile.process?.env ?? {}), ...env };
}

function buildMounts(
	profile: SandboxProfile,
	host: CompileHost,
): { before: string[]; after: string[]; pinnedBinds: PinnedBind[] } {
	const fs = profile.filesystem;
	const pinnedBinds: PinnedBind[] = [];
	const pin = (
		label: string,
		writable: boolean,
		source: string,
		dest: string,
	): string[] => {
		const fd = FIRST_PINNED_FD + pinnedBinds.length;
		pinnedBinds.push({ fd, source, dest, writable, label });
		return [writable ? "--bind-fd" : "--ro-bind-fd", String(fd), dest];
	};
	const before: string[] = [
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--tmpfs",
		"/tmp",
		"--tmpfs",
		"/run",
		"--tmpfs",
		"/run/user",
		"--perms",
		"0700",
		"--tmpfs",
		SANDBOX_PATHS.home,
	];
	before.push(
		...toolchainBwrapArgs(declaredToolchain(profile, host.toolchain)),
	);
	if (fs?.scratch) before.push("--tmpfs", SANDBOX_PATHS.scratch);

	const after: string[] = [];
	const mount = (
		label: string,
		access: "ro" | "rw",
		src: string,
		dest: string,
	) => {
		before.push("--dir", dest);
		after.push(...pin(label, access === "rw", src, dest));
	};
	if (fs?.workspace) {
		mount(
			"workspace",
			fs.workspace.access,
			fs.workspace.source,
			SANDBOX_PATHS.workspace,
		);
		if (fs.workspace.gitDir) {
			mount(
				"gitDir",
				fs.workspace.access,
				fs.workspace.gitDir,
				SANDBOX_PATHS.gitDir,
			);
		}
	}
	if (fs?.runDir) {
		// The mount points sit on the root tmpfs, which is remounted read-only.
		const layout = runDirLayout(fs.runDir.source);
		mount("run control", "ro", layout.control, SANDBOX_PATHS.runControl);
		mount(
			"run outbox",
			fs.runDir.outbox,
			layout.outbox,
			SANDBOX_PATHS.runOutbox,
		);
	}
	for (const c of fs?.caches ?? []) {
		mount(
			`cache ${c.name}`,
			c.access,
			c.source,
			`${SANDBOX_PATHS.caches}/${c.name}`,
		);
	}
	if (fs?.fleetConfig) {
		const dest = `${SANDBOX_PATHS.fleet}/${fs.fleetConfig.cli}`;
		mount("fleet config", "ro", fs.fleetConfig.source, dest);
		// Sorted, so a parent is mounted before its children.
		for (const rel of [...fs.fleetConfig.writable].sort()) {
			after.push(
				...pin(
					`fleet directory ${rel}`,
					true,
					// checkSources refused any path that leaves the source.
					joinUnder(
						fs.fleetConfig.privateState ?? fs.fleetConfig.source,
						rel,
					) as string,
					joinUnder(dest, rel) as string,
				),
			);
		}
	}
	if (profile.network?.mode === "proxy") {
		mount(
			"egress socket dir",
			"ro",
			profile.network.socketDir,
			SANDBOX_PATHS.egress,
		);
	}
	return { before, after, pinnedBinds };
}

/**
 * Compile a profile and a command into the launch argv, or refuse. The profile
 * is parsed again here: the type alone proves nothing, because a cast can
 * carry a path traversal or a loader variable past the schema.
 */
export function compileBwrap(
	input: SandboxProfile,
	command: readonly string[],
	host: CompileHost,
): CompileResult {
	let profile: SandboxProfile;
	try {
		profile = parseSandboxProfile(input);
	} catch (err) {
		if (!(err instanceof ProfileRejectedError)) throw err;
		return refuse(
			"invalid_profile",
			err.message,
			"fix the profile so it passes the schema",
		);
	}

	const bad = command.length === 0 || command[0] === "";
	if (bad || command.some((a) => a.includes("\0"))) {
		return refuse(
			"invalid_command",
			"the command is empty or contains NUL",
			"pass a non-empty argv",
		);
	}

	const hostRefusal = checkHost(host);
	if (hostRefusal) return hostRefusal;
	const deny = resolveDeny(profile, host);
	if (!Array.isArray(deny)) return deny;
	const refusal =
		checkSources(profile, host, deny) ??
		checkRunDir(profile, host) ??
		checkToolchain(profile, host, deny);
	if (refusal) return refusal;

	let seccomp: Buffer;
	try {
		seccomp = generateSeccompProgram(
			host.caps.arch.value === "x86_64" ? "x64" : host.caps.arch.value,
		);
	} catch (err) {
		if (!(err instanceof SeccompUnsupportedError)) throw err;
		return refuse(
			"host_unsupported",
			err.message,
			"run autonomous work on an x86_64 host",
		);
	}

	let limits: ReturnType<typeof planLimits>;
	try {
		limits = planLimits(
			host.caps.systemd,
			{ ...effectiveLimits(profile), unit: host.unit },
			host.systemdRunPath,
		);
	} catch (err) {
		if (!(err instanceof RangeError)) throw err;
		return refuse("invalid_host", err.message, "pass a valid scope unit name");
	}
	if (!limits.ok) {
		return refuse("host_unsupported", limits.reason, limits.fix);
	}

	const env = buildEnv(profile, host);
	const cwd = profile.filesystem?.workspace
		? SANDBOX_PATHS.workspace
		: SANDBOX_PATHS.home;
	const { before, after, pinnedBinds } = buildMounts(profile, host);
	const setenv = Object.keys(env)
		.sort()
		.flatMap((k) => ["--setenv", k, env[k] as string]);

	const options = [
		"--unshare-all",
		"--unshare-user",
		...DISABLE_USERNS_BWRAP_ARGS,
		"--die-with-parent",
		"--new-session",
		"--cap-drop",
		"ALL",
		...SECCOMP_BWRAP_ARGS,
		...before,
		"--remount-ro",
		"/",
		...after,
		// Last, so the egress mount point exists but cannot be renamed or replaced.
		// `/run/user` is its own tmpfs and stays writable.
		"--remount-ro",
		"/run",
		...setenv,
		"--chdir",
		cwd,
	];
	// A NUL would end one option and start another in the `--args` stream. The
	// schema keeps it out of profile values; this also covers host-derived paths.
	if (options.some((o) => o.includes("\0"))) {
		return refuse(
			"invalid_host",
			"a bwrap option contains NUL",
			"remove the NUL from the toolchain or host path",
		);
	}

	return {
		ok: true,
		argv: [
			...limits.argv,
			host.envPath,
			"-i",
			host.bwrapPath,
			"--args",
			String(BWRAP_ARGS_FD),
			"--",
			...command,
		],
		seccomp,
		bwrapArgs: Buffer.from(options.map((o) => `${o}\0`).join("")),
		pinnedBinds,
		...(profile.filesystem?.runDir
			? { runDirRoot: profile.filesystem.runDir.source }
			: {}),
		env,
		cwd,
	};
}
