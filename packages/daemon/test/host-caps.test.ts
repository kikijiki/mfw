import { describe, expect, test } from "bun:test";
import {
	bwrapSupportsBindFd,
	detectArch,
	detectBwrap,
	detectHostCaps,
	detectHostKind,
	detectLinger,
	detectPersistence,
	detectSystemdUser,
	detectTiocsti,
	detectUserns,
	type FsInfo,
	type HostReaders,
	liveHostReaders,
	parseBwrapVersion,
	versionAtLeast,
} from "../src/containment/host-caps.ts";

/**
 * HCAP: the pure detector layer. Fixtures stand in for Ubuntu 24.04 with
 * AppArmor, NixOS, WSL2, a container and Debian with userns off, so every
 * "exact fix" is asserted without touching the host.
 */

interface Fixture {
	files?: Record<string, string>;
	exists?: string[];
	run?: Record<string, { code: number; stdout: string }>;
	fs?: Record<string, FsInfo>;
	reflink?: boolean;
	arch?: string;
}

const SYSTEMD_OK = {
	"systemctl --user is-system-running": { code: 0, stdout: "running\n" },
};
const CG =
	"/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/cgroup.controllers";
const BWRAP_OK = {
	"bwrap --version": { code: 0, stdout: "bubblewrap 0.13.1\n" },
	"bwrap --help": { code: 0, stdout: "  --disable-userns\n" },
	"bwrap --unshare-user --ro-bind / / true": { code: 0, stdout: "" },
};
const USERNS_DENIED = {
	"bwrap --unshare-user --ro-bind / / true": { code: 1, stdout: "" },
};
const PROBE = { bwrap: "bwrap", trueBin: "true" };

function readers(f: Fixture): HostReaders {
	return {
		readFile: async (p) => f.files?.[p],
		exists: async (p) => f.exists?.includes(p) ?? false,
		run: async (argv) => f.run?.[argv.join(" ")],
		fsInfo: async (p) => f.fs?.[p],
		reflink: async () => f.reflink,
		arch: f.arch ?? "x64",
		uid: 1000,
		user: "dev",
	};
}

const nixos: Fixture = {
	files: {
		"/proc/sys/user/max_user_namespaces": "63304\n",
		"/proc/sys/dev/tty/legacy_tiocsti": "0\n",
		[CG]: "cpu io memory pids\n",
	},
	exists: ["/var/lib/systemd/linger/dev"],
	run: { ...SYSTEMD_OK, ...BWRAP_OK },
	fs: {
		"/srv/dev/.local/share/mfw": {
			dev: 7,
			fstype: "btrfs",
			source: "/dev/nvme0n1p2[/@home]",
		},
		"/srv/dev/dev/repo": {
			dev: 7,
			fstype: "btrfs",
			source: "/dev/nvme0n1p2[/@home]",
		},
	},
	reflink: true,
};

const caps = (f: Fixture) =>
	detectHostCaps(readers(f), {
		mfwHome: "/srv/dev/.local/share/mfw",
		repoRoot: "/srv/dev/dev/repo",
	});

describe("distro fixtures", () => {
	test("NixOS: everything passes", async () => {
		const r = await caps(nixos);
		expect(r.autonomyOk).toBe(true);
		expect(r.fixes).toEqual([]);
		expect(r.bwrap.value.version).toBe("0.13.1");
		expect(r.persistence.value.reflink).toBe(true);
	});

	test("Ubuntu 24.04 with AppArmor: userns refused with the profile fix", async () => {
		const r = await caps({
			...nixos,
			run: { ...nixos.run, ...USERNS_DENIED },
			files: {
				...nixos.files,
				"/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1\n",
			},
		});
		expect(r.userns.ok).toBe(false);
		expect(r.userns.value.appArmorRestricted).toBe(true);
		expect(r.userns.fix).not.toContain("sysctl");
		// The fixture names bwrap bare; the exact profile is in userns-probe.test.ts.
		expect(r.userns.fix).toContain("AppArmor profile");
		expect(r.autonomyOk).toBe(false);
		expect(r.fixes[0]).toBe(r.userns.fix as string);
	});

	test("Ubuntu with the restriction off passes", async () => {
		const c = await detectUserns(
			readers({
				run: BWRAP_OK,
				files: {
					"/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "0\n",
				},
			}),
			PROBE,
		);
		expect(c.ok).toBe(true);
	});

	test("Debian with userns 0: sysctl fix", async () => {
		const c = await detectUserns(
			readers({
				run: USERNS_DENIED,
				files: { "/proc/sys/user/max_user_namespaces": "0\n" },
			}),
			PROBE,
		);
		expect(c.ok).toBe(false);
		expect(c.fix).toContain("user.max_user_namespaces=63304");
		const d = await detectUserns(
			readers({
				run: USERNS_DENIED,
				files: { "/proc/sys/kernel/unprivileged_userns_clone": "0\n" },
			}),
			PROBE,
		);
		expect(d.ok).toBe(false);
		expect(d.fix).toContain("kernel.unprivileged_userns_clone=1");
	});

	test("WSL2: no user manager, systemd fix in wsl.conf", async () => {
		const f: Fixture = {
			...nixos,
			files: {
				...nixos.files,
				"/proc/sys/kernel/osrelease": "5.15.153.1-microsoft-standard-WSL2\n",
			},
			run: {
				...BWRAP_OK,
				"systemctl --user is-system-running": { code: 1, stdout: "offline\n" },
			},
		};
		expect(await detectHostKind(readers(f))).toBe("wsl2");
		const c = await detectSystemdUser(readers(f));
		expect(c.ok).toBe(false);
		expect(c.value.hostKind).toBe("wsl2");
		expect(c.fix).toContain("/etc/wsl.conf");
		expect(c.fix).toContain("wsl --shutdown");
	});

	test("container: no user manager, run elsewhere", async () => {
		const f: Fixture = { exists: ["/.dockerenv"], run: {} };
		const c = await detectSystemdUser(readers(f));
		expect(c.value.hostKind).toBe("container");
		expect(c.ok).toBe(false);
		expect(c.fix).toContain("container");
	});

	test("controllers missing: names them and the Delegate fix", async () => {
		const c = await detectSystemdUser(
			readers({ run: SYSTEMD_OK, files: { [CG]: "memory\n" } }),
		);
		expect(c.ok).toBe(false);
		expect(c.value.missing).toEqual(["cpu", "pids"]);
		expect(c.fix).toContain("Delegate=cpu cpuset io memory pids");
	});
});

describe("single detectors", () => {
	test("bwrap missing, too old, and current", async () => {
		expect((await detectBwrap(readers({}))).fix).toContain(
			"install bubblewrap",
		);
		const old = await detectBwrap(
			readers({
				run: {
					"bwrap --version": { code: 0, stdout: "bubblewrap 0.6.2\n" },
					"bwrap --help": { code: 0, stdout: "--unshare-user\n" },
				},
			}),
		);
		expect(old.ok).toBe(false);
		expect(old.fix).toContain("0.8.0");
		expect((await detectBwrap(readers({ run: BWRAP_OK }))).ok).toBe(true);
	});

	test("bind-fd support comes from help, then from the version", async () => {
		const detect = async (version: string, help?: string) =>
			(
				await detectBwrap(
					readers({
						run: {
							"bwrap --version": {
								code: 0,
								stdout: `bubblewrap ${version}\n`,
							},
							...(help === undefined
								? {}
								: { "bwrap --help": { code: 0, stdout: help } }),
						},
					}),
				)
			).value;
		const both = "--disable-userns --bind-fd FD DEST --ro-bind-fd FD DEST";
		// A distribution backport: an old version whose help lists the flags.
		expect(bwrapSupportsBindFd(await detect("0.8.0", both))).toBe(true);
		expect(
			bwrapSupportsBindFd(await detect("0.11.0", "--disable-userns")),
		).toBe(false);
		expect(
			bwrapSupportsBindFd(
				await detect("0.11.0", "--disable-userns --ro-bind-fd FD DEST"),
			),
		).toBe(false);
		// Unreadable help: the upstream version decides.
		expect(bwrapSupportsBindFd(await detect("0.10.0"))).toBe(true);
		expect(bwrapSupportsBindFd(await detect("0.9.0"))).toBe(false);
	});

	test("version helpers", () => {
		expect(parseBwrapVersion("bubblewrap 0.13.1")).toBe("0.13.1");
		expect(parseBwrapVersion("nonsense")).toBeUndefined();
		expect(versionAtLeast("0.13.1", "0.8.0")).toBe(true);
		expect(versionAtLeast("0.7.9", "0.8.0")).toBe(false);
		expect(versionAtLeast("0.8.0", "0.8.0")).toBe(true);
	});

	test("linger", async () => {
		expect(
			(await detectLinger(readers({ exists: ["/var/lib/systemd/linger/dev"] })))
				.ok,
		).toBe(true);
		const off = await detectLinger(readers({}));
		expect(off.ok).toBe(false);
		expect(off.fix).toBe("loginctl enable-linger dev");
		expect(off.severity).toBe("advisory");
	});

	test("tiocsti: 0 is a second barrier, 1 and absent leave --new-session alone", async () => {
		const z = await detectTiocsti(
			readers({ files: { "/proc/sys/dev/tty/legacy_tiocsti": "0" } }),
		);
		expect(z.ok).toBe(true);
		expect(z.value.newSessionIsOnlyBarrier).toBe(false);
		const one = await detectTiocsti(
			readers({ files: { "/proc/sys/dev/tty/legacy_tiocsti": "1" } }),
		);
		expect(one.ok).toBe(false);
		expect(one.value.newSessionIsOnlyBarrier).toBe(true);
		expect(
			(await detectTiocsti(readers({}))).value.legacyTiocsti,
		).toBeUndefined();
	});

	test("arch", () => {
		expect(detectArch(readers({ arch: "x64" })).value).toBe("x86_64");
		expect(detectArch(readers({ arch: "arm64" })).value).toBe("aarch64");
		const o = detectArch(readers({ arch: "riscv64" }));
		expect(o.ok).toBe(false);
		expect(o.severity).toBe("required");
	});
});

describe("persistence", () => {
	const home = "/h/mfw";
	const repo = "/r/repo";
	const btrfs = (sub: string, dev: number): FsInfo => ({
		dev,
		fstype: "btrfs",
		source: `/dev/sda2[/${sub}]`,
	});

	test("tmpfs home is required to fail", async () => {
		const c = await detectPersistence(
			readers({
				fs: {
					[home]: { dev: 1, fstype: "tmpfs", source: "tmpfs" },
					[repo]: btrfs("@", 2),
				},
			}),
			home,
			repo,
		);
		expect(c.ok).toBe(false);
		expect(c.severity).toBe("required");
		expect(c.value.ephemeral).toBe(true);
		expect(c.fix).toContain("MFW_HOME");
	});

	test("cross-subvolume on one btrfs: advisory, same filesystem", async () => {
		const c = await detectPersistence(
			readers({
				fs: { [home]: btrfs("@home", 5), [repo]: btrfs("@", 6) },
				reflink: true,
			}),
			home,
			repo,
		);
		expect(c.ok).toBe(false);
		expect(c.severity).toBe("advisory");
		expect(c.value.sameFilesystem).toBe(true);
		expect(c.value.sameSubvolume).toBe(false);
		expect(c.detail).toContain("subvolumes");
	});

	test("cross-filesystem and no reflink", async () => {
		const c = await detectPersistence(
			readers({
				fs: {
					[home]: { dev: 1, fstype: "ext4", source: "/dev/sda1" },
					[repo]: { dev: 2, fstype: "ext4", source: "/dev/sdb1" },
				},
				reflink: false,
			}),
			home,
			repo,
		);
		expect(c.ok).toBe(false);
		expect(c.value.sameFilesystem).toBe(false);
		expect(c.detail).toContain("no reflink");
		expect(c.detail).toContain("different filesystems");
	});

	test("an unreadable probe does not warn", async () => {
		const c = await detectPersistence(
			readers({ fs: { [home]: btrfs("@home", 5), [repo]: btrfs("@home", 5) } }),
			home,
			repo,
		);
		expect(c.ok).toBe(true);
		expect(c.value.reflink).toBeUndefined();
	});
});

describe("live readers", () => {
	test("read-only facts about this host are well-formed", async () => {
		const r = liveHostReaders();
		expect(await r.readFile("/definitely/not/here")).toBeUndefined();
		expect(await r.exists("/proc")).toBe(true);
		expect(await r.run(["/definitely/not/here"])).toBeUndefined();
		const fs = await r.fsInfo("/proc");
		expect(fs?.fstype).toBeTruthy();
	});
});
