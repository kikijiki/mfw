/**
 * Host capability detectors for the sandbox (the sandbox experiments, E3, E9b
 * and E10).
 *
 * Every detector is a function of an injected `HostReaders`, so the distro
 * fixtures (Ubuntu 24.04 with AppArmor, NixOS, WSL2, Debian with userns off)
 * run anywhere. Each returns a `Check`: `ok`, the observed `value`, and an
 * exact `fix` when not ok. Nothing here changes the host: a fix is text for
 * the doctor to print, never something this module applies.
 *
 * `severity` says what a failing check means for autonomous runs: `required`
 * checks refuse the bwrap profile, `advisory` ones only warn.
 */

import { constants } from "node:fs";
import {
	copyFile,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { runProc } from "../proc.ts";

export interface Check<T> {
	ok: boolean;
	severity: "required" | "advisory";
	value: T;
	/** What happened, in one line, for the doctor. */
	detail: string;
	/** The exact fix to print; present whenever `ok` is false. */
	fix?: string;
}

export interface FsInfo {
	/** `st_dev`: on btrfs every subvolume has its own. */
	dev: number;
	/** The filesystem type, such as `btrfs`, `ext4`, `tmpfs`. */
	fstype: string;
	/** The mount source, such as `/dev/nvme0n1p2[/@home]` on btrfs. */
	source: string;
}

export interface RunResult {
	code: number | null;
	stdout: string;
}

/** Everything a detector may look at; every method returns undefined when it cannot tell. */
export interface HostReaders {
	readFile(path: string): Promise<string | undefined>;
	exists(path: string): Promise<boolean>;
	/** Run a short, read-only command; undefined when it cannot start. */
	run(argv: string[]): Promise<RunResult | undefined>;
	fsInfo(path: string): Promise<FsInfo | undefined>;
	/** Try `cp --reflink=always` inside `dir`; undefined when the probe could not run. */
	reflink(dir: string): Promise<boolean | undefined>;
	arch: string;
	uid: number;
	user: string;
}

const trim = (s: string | undefined) => s?.trim();

/** The oldest bwrap with `--disable-userns`. */
export const BWRAP_MIN_VERSION = "0.8.0";

/**
 * The first upstream release with `--bind-fd` and `--ro-bind-fd`. Distributions
 * backported them to older versions, so `--help` is checked first.
 */
export const BWRAP_BIND_FD_MIN_VERSION = "0.10.0";

/** Controllers the limits need delegated to the user manager. */
export const REQUIRED_CONTROLLERS = ["cpu", "memory", "pids"] as const;

// ---------------------------------------------------------------- userns

export interface UsernsValue {
	maxUserNamespaces?: number;
	debianClone?: number;
	appArmorRestricted: boolean;
}

/** The trusted binaries the user namespace probe runs. */
export interface UsernsProbe {
	/** A trusted bwrap; null means the probe cannot run. */
	bwrap: string | null;
	/** bwrap with symlinks resolved: AppArmor attaches to this path. */
	bwrapReal?: string | null;
	trueBin: string | null;
}

const APPARMOR_PROFILE = "/etc/apparmor.d/mfw-bwrap";

/**
 * A profile that lets exactly this bwrap create user namespaces and leaves the
 * host-wide restriction on. It refuses to overwrite an existing profile.
 */
export function appArmorFix(bwrapPath: string | null | undefined): string {
	if (!bwrapPath || !/^\/[A-Za-z0-9._+/-]+$/.test(bwrapPath)) {
		return "install bubblewrap at a plain path such as /usr/bin/bwrap, then give that binary an AppArmor profile that allows userns";
	}
	const lines = [
		"abi <abi/4.0>,",
		"include <tunables/global>",
		`profile mfw-bwrap ${bwrapPath} flags=(unconfined) {`,
		"  userns,",
		"}",
	]
		.map((l) => `'${l}'`)
		.join(" ");
	return `sudo test ! -e ${APPARMOR_PROFILE} && printf '%s\\n' ${lines} | sudo tee ${APPARMOR_PROFILE} >/dev/null && sudo apparmor_parser -r ${APPARMOR_PROFILE}`;
}

const HOST_WIDE =
	"this is a host-wide change that allows user namespaces for every program, so only do it if nothing on this host relies on the restriction:";

/**
 * Whether bwrap can really create a user namespace. The kernel knobs cannot
 * say: with the AppArmor restriction on, a scoped profile makes bwrap work
 * while the knob still reads 1. They only explain a probe that failed. The
 * doctor and the launch gate both decide here.
 */
export async function detectUserns(
	r: HostReaders,
	probe: UsernsProbe,
): Promise<Check<UsernsValue>> {
	const max = trim(await r.readFile("/proc/sys/user/max_user_namespaces"));
	const clone = trim(
		await r.readFile("/proc/sys/kernel/unprivileged_userns_clone"),
	);
	const aa = trim(
		await r.readFile("/proc/sys/kernel/apparmor_restrict_unprivileged_userns"),
	);
	const value: UsernsValue = {
		maxUserNamespaces: max === undefined ? undefined : Number(max),
		debianClone: clone === undefined ? undefined : Number(clone),
		appArmorRestricted: aa === "1",
	};
	const base = { severity: "required" as const, value };
	if (!probe.bwrap || !probe.trueBin) {
		return {
			...base,
			ok: false,
			detail:
				"could not test user namespaces: no trusted bwrap or true on PATH",
			fix: `install bubblewrap ${BWRAP_MIN_VERSION} or newer in a root-owned directory on PATH`,
		};
	}
	const result = await r.run([
		probe.bwrap,
		"--unshare-user",
		"--ro-bind",
		"/",
		"/",
		probe.trueBin,
	]);
	if (result?.code === 0) {
		return {
			...base,
			ok: true,
			detail: value.appArmorRestricted
				? "bwrap can create user namespaces (AppArmor allows this binary)"
				: "unprivileged user namespaces are allowed",
		};
	}
	if (value.maxUserNamespaces === 0) {
		return {
			...base,
			ok: false,
			detail: "user namespaces are disabled (user.max_user_namespaces=0)",
			fix: `${HOST_WIDE} sudo sysctl -w user.max_user_namespaces=63304 (persist it in /etc/sysctl.d/99-userns.conf)`,
		};
	}
	if (value.debianClone === 0) {
		return {
			...base,
			ok: false,
			detail:
				"unprivileged user namespaces are disabled (kernel.unprivileged_userns_clone=0)",
			fix: `${HOST_WIDE} sudo sysctl -w kernel.unprivileged_userns_clone=1 (persist it in /etc/sysctl.d/99-userns.conf)`,
		};
	}
	if (value.appArmorRestricted) {
		return {
			...base,
			ok: false,
			detail:
				"AppArmor stops bwrap from creating user namespaces (kernel.apparmor_restrict_unprivileged_userns=1)",
			fix: appArmorFix(probe.bwrapReal ?? probe.bwrap),
		};
	}
	return {
		...base,
		ok: false,
		detail:
			result === undefined
				? "could not test user namespaces: the bwrap probe did not finish"
				: `bwrap could not create a user namespace (exit ${result.code})`,
		fix: "run `bwrap --unshare-user --ro-bind / / true` to see the error; a container or security policy may be blocking it",
	};
}

// ----------------------------------------------------------------- bwrap

export interface BwrapValue {
	version?: string;
	disableUserns: boolean;
	/** Whether `--help` lists `--bind-fd` and `--ro-bind-fd`; absent if unreadable. */
	bindFd?: boolean;
}

export function parseBwrapVersion(out: string): string | undefined {
	return /(\d+\.\d+\.\d+)/.exec(out)?.[1];
}

/** Help output wins, because of backports; otherwise the version decides. */
export function bwrapSupportsBindFd(value: BwrapValue): boolean {
	if (value.bindFd !== undefined) return value.bindFd;
	return (
		value.version !== undefined &&
		versionAtLeast(value.version, BWRAP_BIND_FD_MIN_VERSION)
	);
}

/** True when `a` is at least `b`; both are `x.y.z`. */
export function versionAtLeast(a: string, b: string): boolean {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d > 0;
	}
	return true;
}

/** bwrap's version, and whether it knows `--disable-userns` (it needs `--unshare-user`). */
export async function detectBwrap(
	r: HostReaders,
	bwrap = "bwrap",
): Promise<Check<BwrapValue>> {
	const ver = await r.run([bwrap, "--version"]);
	const severity = "required" as const;
	if (ver?.code !== 0) {
		return {
			ok: false,
			severity,
			value: { disableUserns: false },
			detail: "bwrap was not found",
			fix: `install bubblewrap ${BWRAP_MIN_VERSION} or newer (apt install bubblewrap, dnf install bubblewrap, pacman -S bubblewrap, or nix profile install nixpkgs#bubblewrap)`,
		};
	}
	const version = parseBwrapVersion(ver.stdout);
	const help = await r.run([bwrap, "--help"]);
	const disableUserns =
		help?.stdout.includes("--disable-userns") === true ||
		(version !== undefined && versionAtLeast(version, BWRAP_MIN_VERSION));
	const helpText = help?.code === 0 ? help.stdout : undefined;
	const bindFd =
		helpText === undefined
			? undefined
			: helpText.includes("--bind-fd") && helpText.includes("--ro-bind-fd");
	const value: BwrapValue =
		bindFd === undefined
			? { version, disableUserns }
			: { version, disableUserns, bindFd };
	if (
		!disableUserns ||
		(version && !versionAtLeast(version, BWRAP_MIN_VERSION))
	) {
		return {
			ok: false,
			severity,
			value,
			detail: `bwrap ${version ?? "(unknown version)"} lacks --disable-userns`,
			fix: `upgrade bubblewrap to ${BWRAP_MIN_VERSION} or newer`,
		};
	}
	return {
		ok: true,
		severity,
		value,
		detail: `bwrap ${version}`,
	};
}

// --------------------------------------------------------- environment

export type HostKind = "wsl2" | "container" | "native";

/** WSL2 and containers are where cgroup delegation is usually missing. */
export async function detectHostKind(r: HostReaders): Promise<HostKind> {
	const rel = trim(await r.readFile("/proc/sys/kernel/osrelease")) ?? "";
	if (/microsoft|wsl/i.test(rel)) return "wsl2";
	if (
		(await r.exists("/.dockerenv")) ||
		(await r.exists("/run/.containerenv"))
	) {
		return "container";
	}
	return "native";
}

// ------------------------------------------------------- systemd manager

export interface SystemdUserValue {
	hostKind: HostKind;
	manager: boolean;
	delegated: string[];
	missing: string[];
}

/** The systemd user manager and the controllers delegated to it (cpu, memory, pids). */
export async function detectSystemdUser(
	r: HostReaders,
): Promise<Check<SystemdUserValue>> {
	const hostKind = await detectHostKind(r);
	const state = await r.run(["systemctl", "--user", "is-system-running"]);
	const s = trim(state?.stdout);
	const manager = s === "running" || s === "degraded" || s === "starting";
	const raw = await r.readFile(
		`/sys/fs/cgroup/user.slice/user-${r.uid}.slice/user@${r.uid}.service/cgroup.controllers`,
	);
	const delegated = (trim(raw) ?? "").split(/\s+/).filter(Boolean);
	const missing = REQUIRED_CONTROLLERS.filter((c) => !delegated.includes(c));
	const value: SystemdUserValue = { hostKind, manager, delegated, missing };
	const base = { severity: "required" as const, value };
	if (!manager) {
		const fix =
			hostKind === "wsl2"
				? "enable systemd in WSL2: put `[boot]` and `systemd=true` in /etc/wsl.conf, then run `wsl --shutdown` from Windows and reopen the distro"
				: hostKind === "container"
					? "run the server on a host with a systemd user session (containers have no user manager); autonomous runs are not supported in this container"
					: "start a systemd user session (log in through a login manager or `loginctl enable-linger $USER`, and make sure XDG_RUNTIME_DIR is set)";
		return {
			...base,
			ok: false,
			detail: `no systemd user manager (${hostKind})`,
			fix,
		};
	}
	if (missing.length > 0) {
		const have = delegated.length ? delegated.join(" ") : "none";
		return {
			...base,
			ok: false,
			detail: `cgroup controllers not delegated to the user manager: ${missing.join(" ")} (delegated: ${have})`,
			fix: `delegate them (this stops if a delegate.conf already exists; merge by hand then): sudo test ! -e /etc/systemd/system/user@.service.d/delegate.conf && sudo mkdir -p /etc/systemd/system/user@.service.d && printf '[Service]\\nDelegate=cpu cpuset io memory pids\\n' | sudo tee /etc/systemd/system/user@.service.d/delegate.conf, then sudo systemctl daemon-reload and log in again (cgroup v2 is required)`,
		};
	}
	return {
		...base,
		ok: true,
		detail: `systemd user manager with ${REQUIRED_CONTROLLERS.join(" ")} delegated`,
	};
}

/** Linger: without it the user manager, and every run limit, dies at logout. */
export async function detectLinger(r: HostReaders): Promise<Check<boolean>> {
	const on = await r.exists(`/var/lib/systemd/linger/${r.user}`);
	return on
		? {
				ok: true,
				severity: "advisory",
				value: true,
				detail: "linger is enabled",
			}
		: {
				ok: false,
				severity: "advisory",
				value: false,
				detail:
					"linger is off: runs lose their limits scope if the session ends",
				fix: `loginctl enable-linger ${/^[A-Za-z0-9._-]+$/.test(r.user) && !r.user.startsWith("-") ? r.user : "$USER"}`,
			};
}

// ----------------------------------------------------------------- tty

export interface TiocstiValue {
	legacyTiocsti?: number;
	/** `--new-session` is always passed; this says whether it is the only barrier. */
	newSessionIsOnlyBarrier: boolean;
}

/** TIOCSTI: `legacy_tiocsti=0` is a second barrier next to `--new-session`. */
export async function detectTiocsti(
	r: HostReaders,
): Promise<Check<TiocstiValue>> {
	const raw = trim(await r.readFile("/proc/sys/dev/tty/legacy_tiocsti"));
	const legacyTiocsti = raw === undefined ? undefined : Number(raw);
	if (legacyTiocsti === 0) {
		return {
			ok: true,
			severity: "advisory",
			value: { legacyTiocsti, newSessionIsOnlyBarrier: false },
			detail: "TIOCSTI is disabled by the kernel",
		};
	}
	return {
		ok: false,
		severity: "advisory",
		value: { legacyTiocsti, newSessionIsOnlyBarrier: true },
		detail:
			legacyTiocsti === undefined
				? "the kernel predates dev.tty.legacy_tiocsti; --new-session is the only barrier against TIOCSTI"
				: "dev.tty.legacy_tiocsti=1; --new-session is the only barrier against TIOCSTI",
		fix: "sudo sysctl -w dev.tty.legacy_tiocsti=0 (needs Linux 6.2 or newer; persist it in /etc/sysctl.d/99-tiocsti.conf)",
	};
}

// ---------------------------------------------------------------- arch

export type Arch = "x86_64" | "aarch64" | "other";

/** The machine architecture, normalised; the seccomp filter has tables for the first two. */
export function detectArch(r: HostReaders): Check<Arch> {
	const a = r.arch.toLowerCase();
	const value: Arch =
		a === "x64" || a === "x86_64" || a === "amd64"
			? "x86_64"
			: a === "arm64" || a === "aarch64"
				? "aarch64"
				: "other";
	return value === "other"
		? {
				ok: false,
				severity: "required",
				value,
				detail: `architecture ${r.arch} has no seccomp table`,
				fix: "autonomous runs support x86_64 and aarch64 only; run on one of them",
			}
		: {
				ok: true,
				severity: "required",
				value,
				detail: `architecture ${value}`,
			};
}

// ---------------------------------------------------------- persistence

export interface PersistenceValue {
	home?: FsInfo;
	repo?: FsInfo;
	ephemeral: boolean;
	reflink?: boolean;
	sameFilesystem?: boolean;
	sameSubvolume?: boolean;
}

const EPHEMERAL_FS = new Set(["tmpfs", "ramfs", "overlay"]);

/** `/dev/x[/@home]` and `/dev/x[/@]` are one filesystem; only the bracket names the subvolume. */
function deviceOf(source: string): string {
	return source.replace(/\[.*\]$/, "");
}

/**
 * Where `$MFW_HOME` lives: not on tmpfs, reflink-capable, and (for snapshots)
 * on the same filesystem and subvolume as the repo. Only an ephemeral home is
 * required to pass; the others are advisory because the seed falls back to a
 * plain clone.
 */
export async function detectPersistence(
	r: HostReaders,
	mfwHome: string,
	repoRoot: string,
): Promise<Check<PersistenceValue>> {
	const home = await r.fsInfo(mfwHome);
	const repo = await r.fsInfo(repoRoot);
	const ephemeral = home !== undefined && EPHEMERAL_FS.has(home.fstype);
	const reflink = await r.reflink(mfwHome);
	const sameFilesystem =
		home && repo ? deviceOf(home.source) === deviceOf(repo.source) : undefined;
	const sameSubvolume = home && repo ? home.dev === repo.dev : undefined;
	const value: PersistenceValue = {
		home,
		repo,
		ephemeral,
		reflink,
		sameFilesystem,
		sameSubvolume,
	};
	if (ephemeral) {
		return {
			ok: false,
			severity: "required",
			value,
			detail: `$MFW_HOME is on ${home?.fstype}: workspaces, run dirs and WIP refs would vanish at reboot`,
			fix: "point MFW_HOME at a persistent filesystem, such as a directory under your home (MFW_HOME=$HOME/.local/share/mfw)",
		};
	}
	const notes: string[] = [];
	const fixes: string[] = [];
	if (reflink === false) {
		notes.push("no reflink here, so seeds are real copies");
		fixes.push(
			"put MFW_HOME on btrfs, XFS (reflink=1) or APFS to make workspace seeds instant",
		);
	}
	if (sameFilesystem === false) {
		notes.push("$MFW_HOME and the repo are on different filesystems");
		fixes.push(
			"put MFW_HOME on the same filesystem as your repos for reflink seeds",
		);
	} else if (sameSubvolume === false) {
		notes.push(
			"$MFW_HOME and the repo are on different subvolumes (no snapshot seed)",
		);
		fixes.push(
			"put MFW_HOME in the same subvolume as your repos for snapshot seeds",
		);
	}
	if (notes.length > 0) {
		return {
			ok: false,
			severity: "advisory",
			value,
			detail: notes.join("; "),
			fix: fixes.join("; "),
		};
	}
	return {
		ok: true,
		severity: "advisory",
		value,
		detail: "$MFW_HOME is persistent and reflink-capable",
	};
}

// --------------------------------------------------------------- report

export interface HostCapsReport {
	userns: Check<UsernsValue>;
	bwrap: Check<BwrapValue>;
	systemd: Check<SystemdUserValue>;
	linger: Check<boolean>;
	tiocsti: Check<TiocstiValue>;
	arch: Check<Arch>;
	persistence: Check<PersistenceValue>;
	/** True when every `required` check passed. */
	autonomyOk: boolean;
	/** Every failing check's fix, required ones first. */
	fixes: string[];
}

/** Run every detector. Pure over `r`; the doctor and preflight both call this. */
export async function detectHostCaps(
	r: HostReaders,
	opts: {
		mfwHome: string;
		repoRoot: string;
		bwrap?: string;
		trueBin?: string | null;
	},
): Promise<HostCapsReport> {
	const [userns, bwrap, systemd, linger, tiocsti, persistence] =
		await Promise.all([
			detectUserns(r, {
				bwrap: opts.bwrap ?? "bwrap",
				trueBin: opts.trueBin === undefined ? "true" : opts.trueBin,
			}),
			detectBwrap(r, opts.bwrap),
			detectSystemdUser(r),
			detectLinger(r),
			detectTiocsti(r),
			detectPersistence(r, opts.mfwHome, opts.repoRoot),
		]);
	const arch = detectArch(r);
	const all: Check<unknown>[] = [
		userns,
		bwrap,
		systemd,
		linger,
		tiocsti,
		arch,
		persistence,
	];
	const failing = all.filter((c) => !c.ok);
	const rank = (c: Check<unknown>) => (c.severity === "required" ? 0 : 1);
	failing.sort((a, b) => rank(a) - rank(b));
	return {
		userns,
		bwrap,
		systemd,
		linger,
		tiocsti,
		arch,
		persistence,
		autonomyOk: failing.every((c) => c.severity !== "required"),
		fixes: failing.flatMap((c) => (c.fix ? [c.fix] : [])),
	};
}

// ----------------------------------------------------------------- live

async function liveRun(argv: string[]): Promise<RunResult | undefined> {
	try {
		const res = await runProc(argv, {
			timeoutMs: 5_000,
			maxOutputBytes: 64 * 1024,
		});
		// 127 is the shell-style "command not found" runProc reports for a missing binary.
		if (res.timedOut || res.exitCode === 127) return undefined;
		return { code: res.exitCode, stdout: res.stdout };
	} catch {
		return undefined;
	}
}

async function liveFsInfo(path: string): Promise<FsInfo | undefined> {
	try {
		const st = await stat(path);
		const out = await liveRun([
			"findmnt",
			"-n",
			"-o",
			"SOURCE,FSTYPE",
			"-T",
			path,
		]);
		const line = out?.stdout.trim().split("\n")[0] ?? "";
		const m = /^(\S+)\s+(\S+)$/.exec(line);
		return { dev: st.dev, source: m?.[1] ?? "", fstype: m?.[2] ?? "unknown" };
	} catch {
		return undefined;
	}
}

async function liveReflink(dir: string): Promise<boolean | undefined> {
	let tmp: string | undefined;
	try {
		tmp = await mkdtemp(join(dir, ".mfw-reflink-"));
		const src = join(tmp, "a");
		await writeFile(src, "x".repeat(8192));
		await copyFile(src, join(tmp, "b"), constants.COPYFILE_FICLONE_FORCE);
		return true;
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		// EOPNOTSUPP, EXDEV and ENOSYS mean "no reflink here"; anything else means we could not tell.
		return code === "ENOTSUP" ||
			code === "EOPNOTSUPP" ||
			code === "EXDEV" ||
			code === "ENOSYS" ||
			code === "EINVAL"
			? false
			: undefined;
	} finally {
		if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
	}
}

/** The real readers. Read-only apart from the throwaway reflink probe inside `$MFW_HOME`. */
export function liveHostReaders(): HostReaders {
	return {
		readFile: (p) => readFile(p, "utf8").catch(() => undefined),
		exists: (p) =>
			stat(p).then(
				() => true,
				() => false,
			),
		run: liveRun,
		fsInfo: liveFsInfo,
		reflink: liveReflink,
		arch: process.arch,
		uid: process.getuid?.() ?? userInfo().uid,
		user: userInfo().username,
	};
}
