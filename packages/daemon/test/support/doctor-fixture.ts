import type {
	FsInfo,
	HostReaders,
	RunResult,
} from "../../src/containment/host-caps.ts";
import type { DoctorProbes, ProjectFacts } from "../../src/doctor/probes.ts";

/** A host where every check passes. Tests change one fact at a time. */
export function fixtureHost(over: Partial<HostFixture> = {}): HostReaders {
	const f: HostFixture = {
		files: {
			"/proc/sys/user/max_user_namespaces": "63304\n",
			"/proc/sys/dev/tty/legacy_tiocsti": "0\n",
			"/proc/sys/kernel/osrelease": "6.12.0\n",
			"/sys/fs/cgroup/cgroup.controllers": "cpu memory pids io\n",
			"/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/cgroup.controllers":
				"cpu memory pids\n",
		},
		existing: ["/var/lib/systemd/linger/owner"],
		bwrapVersion: "0.11.0",
		bwrapHelp: "--disable-userns --bind-fd --ro-bind-fd",
		systemd: "running\n",
		arch: "x64",
		fstype: "btrfs",
		...over,
	};
	const fs: FsInfo = { dev: 1, fstype: f.fstype, source: "/dev/sda1[/@]" };
	return {
		readFile: async (p) => f.files[p],
		exists: async (p) => f.existing.includes(p),
		run: async (argv): Promise<RunResult | undefined> => {
			const bin = argv[0] ?? "";
			if (bin.endsWith("bwrap")) {
				if (f.bwrapVersion === null) return undefined;
				return argv[1] === "--version"
					? { code: 0, stdout: `bubblewrap ${f.bwrapVersion}\n` }
					: { code: 0, stdout: f.bwrapHelp };
			}
			if (bin.endsWith("systemctl")) return { code: 0, stdout: f.systemd };
			if (bin.endsWith("tmux")) return { code: 0, stdout: "tmux 3.5\n" };
			return undefined;
		},
		fsInfo: async () => fs,
		reflink: async () => f.fstype === "btrfs",
		arch: f.arch,
		uid: 1000,
		user: "owner",
	};
}

export interface HostFixture {
	files: Record<string, string>;
	existing: string[];
	bwrapVersion: string | null;
	bwrapHelp: string;
	systemd: string;
	arch: string;
	fstype: string;
}

export const HOME = "/srv/mfw-home";

export function healthyProject(over: Partial<ProjectFacts> = {}): ProjectFacts {
	return {
		rootExists: true,
		isGit: true,
		devEnv: { state: "none", detail: "none declared" },
		gitConfigRefusal: null,
		remotes: [],
		untracked: { count: 0, sample: [], truncated: false },
		ignoredState: { count: 0, sample: [], truncated: false },
		boardPush: null,
		triggers: { armedCurrent: 0, drifted: [], quarantined: [], unarmed: 0 },
		...over,
	};
}

export function fixture(over: Partial<DoctorProbes> = {}): DoctorProbes {
	const home = over.home ?? HOME;
	return {
		env: { HOST: "127.0.0.1", XDG_RUNTIME_DIR: "/run/user/1000" },
		home: HOME,
		uid: 1000,
		bunVersion: "1.3.13",
		host: fixtureHost(),
		tool: async (name) => ({ path: `/usr/bin/${name}` }),
		toolVersion: async (path) =>
			path.endsWith("tmux") ? "3.5" : path.endsWith("git") ? "2.50.1" : "1.0.0",
		// The socket directories do not exist yet on a fresh host.
		stat: async (path) =>
			path.startsWith("/run/user/")
				? null
				: {
						kind: path === home ? "dir" : "file",
						mode: path === home ? 0o700 : 0o600,
						uid: 1000,
					},
		config: async () => ({ ok: true, config: { projects: [] } }),
		auth: async () => ({
			state: "ready",
			owner: true,
			passwordSet: true,
			liveTokens: 2,
			pendingSetup: false,
		}),
		build: async () => ({ kind: "source" }),
		exposure: () => ({ problem: null, warnings: [] }),
		project: async () => healthyProject(),
		...over,
	};
}
