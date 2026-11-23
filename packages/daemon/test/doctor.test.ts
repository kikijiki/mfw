import { describe, expect, test } from "bun:test";
import type { HostReaders } from "../src/containment/host-caps.ts";
import type { DoctorProbes, ProjectFacts } from "../src/doctor/probes.ts";
import {
	DOCTOR_SCHEMA_VERSION,
	type DoctorCheck,
	DoctorReportSchema,
	doctorExitCode,
	renderDoctorReport,
	sanitizeText,
} from "../src/doctor/report.ts";
import { runDoctor } from "../src/doctor/run.ts";
import {
	fixture,
	fixtureHost,
	HOME,
	healthyProject,
} from "./support/doctor-fixture.ts";

const PROJECT = {
	name: "demo",
	root: "/srv/demo",
	runWorkspace: "clone" as const,
};

const withProject = (
	facts: Partial<ProjectFacts>,
	entry: Record<string, unknown> = {},
): Partial<DoctorProbes> => ({
	config: async () => ({
		ok: true,
		config: { projects: [{ ...PROJECT, ...entry }] },
	}),
	project: async () => healthyProject(facts),
});

async function check(
	over: Partial<DoctorProbes>,
	id: string,
): Promise<DoctorCheck> {
	const report = await runDoctor(fixture(over));
	const found = report.checks.find((c) => c.id === id);
	if (!found) throw new Error(`no check ${id}`);
	return found;
}

const problems = (checks: readonly DoctorCheck[]) =>
	checks.filter((c) => c.status === "problem");

describe("a healthy host", () => {
	test("has no problems, a valid schema and exit code 0", async () => {
		const report = await runDoctor(fixture());
		expect(problems(report.checks)).toEqual([]);
		expect(report.ok).toBe(true);
		expect(DoctorReportSchema.parse(report)).toEqual(report);
		expect(doctorExitCode(report)).toBe(0);
	});

	test("the check ids and JSON keys are stable", async () => {
		const report = await runDoctor(fixture(withProject({})));
		expect(report.schemaVersion).toBe(DOCTOR_SCHEMA_VERSION);
		expect(Object.keys(report).sort()).toEqual([
			"checks",
			"ok",
			"schemaVersion",
			"summary",
		]);
		expect(report.checks.map((c) => c.id)).toEqual([
			"host.bwrap",
			"host.userns",
			"host.seccomp",
			"host.systemd",
			"host.linger",
			"host.cgroup",
			"host.tiocsti",
			"tool.tmux",
			"tool.git",
			"tool.env",
			"tool.systemd-run",
			"tool.bun",
			"tool.openssl",
			"storage.home",
			"storage.persistence",
			"storage.reflink",
			"storage.socket",
			"auth.state",
			"auth.files",
			"install.config",
			"install.build",
			"install.legacy-host",
			"install.skills",
			"exposure.bind",
			"harness.claude",
			"harness.codex",
			"egress.allowlist",
			"project.root",
			"project.git-config",
			"project.isolation",
			"project.dispatch",
			"project.push",
			"project.triggers",
			"project.egress",
			"project.untracked",
		]);
	});
});

describe("host checks", () => {
	test("a missing bwrap is a blocker with an install command", async () => {
		const c = await check(
			{ host: fixtureHost({ bwrapVersion: null }) },
			"host.bwrap",
		);
		expect([c.status, c.severity]).toEqual(["problem", "blocker"]);
		expect(c.fix).toContain("bubblewrap");
	});

	test("bwrap below 0.10.0 without --bind-fd is a blocker", async () => {
		const c = await check(
			{
				host: fixtureHost({
					bwrapVersion: "0.9.0",
					bwrapHelp: "--disable-userns",
				}),
			},
			"host.bwrap",
		);
		expect(c.severity).toBe("blocker");
		expect(c.status).toBe("problem");
		expect(c.fix).toContain("0.10.0");
	});

	test("an older bwrap with --bind-fd backported passes", async () => {
		const c = await check(
			{ host: fixtureHost({ bwrapVersion: "0.9.0" }) },
			"host.bwrap",
		);
		expect(c.status).toBe("ok");
	});

	test("the Ubuntu 24.04 AppArmor restriction gets its documented fix", async () => {
		const base = fixtureHost();
		const restricted = async (p: string) =>
			p === "/proc/sys/kernel/apparmor_restrict_unprivileged_userns"
				? "1\n"
				: base.readFile(p);
		const denied: HostReaders = {
			...base,
			readFile: restricted,
			run: async (argv) =>
				argv.includes("--unshare-user")
					? { code: 1, stdout: "" }
					: base.run(argv),
		};
		const c = await check({ host: denied }, "host.userns");
		expect([c.status, c.severity]).toEqual(["problem", "blocker"]);
		expect(c.fix).toContain("profile mfw-bwrap /usr/bin/bwrap");
		expect(c.fix).not.toContain("sysctl");

		// With the profile installed the knob still reads 1, and doctor passes.
		const profiled = await check(
			{ host: { ...base, readFile: restricted } },
			"host.userns",
		);
		expect(profiled.status).toBe("ok");
	});

	test("aarch64 is a blocker: the seccomp filter is x86_64 only", async () => {
		const c = await check(
			{ host: fixtureHost({ arch: "arm64" }) },
			"host.seccomp",
		);
		expect([c.status, c.severity]).toEqual(["problem", "blocker"]);
	});

	test("no systemd user manager is a blocker", async () => {
		const c = await check(
			{ host: fixtureHost({ systemd: "offline\n" }) },
			"host.systemd",
		);
		expect([c.status, c.severity]).toEqual(["problem", "blocker"]);
	});

	test("linger off is a warning with the exact command", async () => {
		const c = await check(
			{ host: fixtureHost({ existing: [] }) },
			"host.linger",
		);
		expect([c.status, c.severity]).toEqual(["problem", "warn"]);
		expect(c.fix).toBe("loginctl enable-linger owner");
	});

	test("an unknown user name never produces a wrong linger command", async () => {
		const host: HostReaders = {
			...fixtureHost({ existing: [] }),
			user: "unknown",
		};
		const c = await check({ host }, "host.linger");
		expect([c.status, c.severity]).toEqual(["problem", "warn"]);
		expect(c.detail).toContain("could not tell");
		expect(c.fix).toBe("loginctl enable-linger $USER");
	});

	test("no cgroup v2 is a blocker", async () => {
		const base = fixtureHost();
		const host: HostReaders = {
			...base,
			readFile: async (p) =>
				p === "/sys/fs/cgroup/cgroup.controllers"
					? undefined
					: base.readFile(p),
		};
		const c = await check({ host }, "host.cgroup");
		expect([c.status, c.severity]).toEqual(["problem", "blocker"]);
	});
});

describe("tools", () => {
	test("missing tmux and git are blockers", async () => {
		const over = {
			tool: async (name: string) =>
				name === "tmux" || name === "git"
					? { path: null }
					: { path: `/usr/bin/${name}` },
		};
		expect((await check(over, "tool.tmux")).severity).toBe("blocker");
		expect((await check(over, "tool.git")).status).toBe("problem");
	});

	test("a missing openssl is information only", async () => {
		const c = await check(
			{
				tool: async (name) =>
					name === "openssl" ? { path: null } : { path: `/usr/bin/${name}` },
			},
			"tool.openssl",
		);
		expect([c.status, c.severity]).toEqual(["problem", "info"]);
	});

	test("a harness on an agent-writable path is never executed", async () => {
		const ran: string[] = [];
		const c = await check(
			{
				tool: async (name) =>
					name === "claude"
						? { path: null, untrustedPath: "/srv/owner/.local/bin/claude" }
						: { path: `/usr/bin/${name}` },
				toolVersion: async (path) => {
					ran.push(path);
					return "1.0.0";
				},
			},
			"harness.claude",
		);
		expect(c.status).toBe("problem");
		expect(c.detail).toContain("not run");
		expect(ran).not.toContain("/srv/owner/.local/bin/claude");
	});

	test("by default no harness binary runs, even from a trusted path", async () => {
		const ran: string[] = [];
		const report = await runDoctor(
			fixture({
				toolVersion: async (path) => {
					ran.push(path);
					return "1.0.0";
				},
			}),
		);
		expect(ran.some((p) => /claude|codex/.test(p))).toBe(false);
		const c = report.checks.find((x) => x.id === "harness.claude");
		expect(c?.status).toBe("ok");
		expect(c?.detail).toContain("not run");
	});

	test("--harness-versions opts in", async () => {
		const ran: string[] = [];
		const report = await runDoctor(
			fixture({
				toolVersion: async (path) => {
					ran.push(path);
					return "1.2.3";
				},
			}),
			{ harnessVersions: true },
		);
		expect(ran).toContain("/usr/bin/claude");
		expect(report.checks.find((x) => x.id === "harness.claude")?.detail).toBe(
			"claude 1.2.3",
		);
	});
});

describe("storage", () => {
	test("MFW_HOME under /tmp is a blocker even on a real filesystem", async () => {
		const c = await check(
			{
				home: "/tmp/mfw",
				stat: async () => ({ kind: "dir", mode: 0o700, uid: 1000 }),
			},
			"storage.home",
		);
		expect([c.status, c.severity]).toEqual(["problem", "blocker"]);
	});

	test("a group-writable MFW_HOME is a blocker with chmod", async () => {
		const c = await check(
			{
				stat: async (p) =>
					p === HOME
						? { kind: "dir", mode: 0o770, uid: 1000 }
						: { kind: "file", mode: 0o600, uid: 1000 },
			},
			"storage.home",
		);
		expect(c.severity).toBe("blocker");
		expect(c.fix).toBe(`chmod 700 -- '${HOME}'`);
	});

	test("MFW_HOME owned by another user is a blocker", async () => {
		const c = await check(
			{ stat: async () => ({ kind: "dir", mode: 0o700, uid: 0 }) },
			"storage.home",
		);
		expect([c.status, c.severity]).toEqual(["problem", "blocker"]);
	});

	test("an MFW_HOME on tmpfs is a blocker", async () => {
		const c = await check(
			{ host: fixtureHost({ fstype: "tmpfs" }) },
			"storage.persistence",
		);
		expect([c.status, c.severity]).toEqual(["problem", "blocker"]);
	});

	test("no btrfs is information only", async () => {
		const c = await check(
			{ host: fixtureHost({ fstype: "ext4" }) },
			"storage.reflink",
		);
		expect(c.severity).toBe("info");
	});

	test("a socket directory over the 107-byte limit is a blocker", async () => {
		const c = await check(
			{ env: { HOST: "127.0.0.1", MFW_SOCKET_DIR: `/${"a".repeat(100)}` } },
			"storage.socket",
		);
		expect([c.status, c.severity]).toEqual(["problem", "blocker"]);
		expect(c.fix).toContain("MFW_SOCKET_DIR");
	});
});

describe("auth", () => {
	test("no owner yet is a warning that points at setup", async () => {
		const c = await check(
			{
				auth: async () => ({
					state: "ready",
					owner: false,
					passwordSet: false,
					liveTokens: 0,
					pendingSetup: true,
				}),
			},
			"auth.state",
		);
		expect([c.status, c.severity]).toEqual(["problem", "warn"]);
		expect(c.fix).toContain("mfw auth setup-token");
	});

	test("reports the token count and never a token", async () => {
		const c = await check({}, "auth.state");
		expect(c.detail).toContain("2 live API tokens");
	});

	test("an unreadable store is reported, not passed", async () => {
		const c = await check(
			{ auth: async () => ({ state: "unreadable", reason: "locked" }) },
			"auth.state",
		);
		expect(c.status).toBe("problem");
	});

	test("a readable secret file is a blocker with chmod", async () => {
		const c = await check(
			{
				stat: async (path) =>
					path === HOME
						? { kind: "dir", mode: 0o700, uid: 1000 }
						: path.endsWith("auth.db")
							? { kind: "file", mode: 0o644, uid: 1000 }
							: null,
			},
			"auth.files",
		);
		expect(c.severity).toBe("blocker");
		expect(c.fix).toBe(`chmod 600 -- '${HOME}/auth.db'`);
	});
});

describe("installation", () => {
	test("a malformed config is a blocker", async () => {
		const c = await check(
			{ config: async () => ({ ok: false, error: "bad json" }) },
			"install.config",
		);
		expect([c.status, c.severity]).toEqual(["problem", "blocker"]);
	});

	test("a build with a bad manifest is a blocker", async () => {
		const c = await check(
			{
				build: async () => ({
					kind: "build",
					hostScripts: "the built x does not match its manifest hash",
					migrations: null,
				}),
			},
			"install.build",
		);
		expect([c.status, c.severity]).toEqual(["problem", "blocker"]);
		expect(c.fix).toContain("bun run build");
	});

	test("a source checkout is not a failure", async () => {
		const c = await check({}, "install.build");
		expect(c.status).toBe("ok");
		expect(c.detail).toContain("source");
	});

	test("unacknowledged legacy host rows are a blocker", async () => {
		const c = await check(
			{
				legacyHost: async () => ({
					state: "unacknowledged",
					rows: { leases: 3 },
				}),
			},
			"install.legacy-host",
		);
		expect(c.severity).toBe("blocker");
		expect(c.fix).toContain("mfw host acknowledge-legacy --yes");
	});

	test("an old skill copy is a warning", async () => {
		const c = await check(
			{
				legacySkills: async () => ({
					available: true,
					paths: ["/srv/x/.claude/skills/mfwb/SKILL.md"],
				}),
			},
			"install.skills",
		);
		expect([c.status, c.severity]).toEqual(["problem", "warn"]);
	});

	test("no detector is reported as skipped", async () => {
		const c = await check(
			{ legacySkills: async () => ({ available: false, paths: [] }) },
			"install.skills",
		);
		expect(c.status).toBe("skipped");
	});
});

describe("exposure", () => {
	test("the server's own refusal is a blocker", async () => {
		const c = await check(
			{
				exposure: () => ({
					problem: "HOST=10.0.0.1 is not loopback and has no TLS.",
					warnings: [],
				}),
			},
			"exposure.bind",
		);
		expect([c.status, c.severity]).toEqual(["problem", "blocker"]);
	});

	test("the loopback-proxy warning is a warning", async () => {
		const c = await check(
			{
				exposure: () => ({
					problem: null,
					warnings: ["MFW_TRUSTED_PROXIES trusts a loopback address"],
				}),
			},
			"exposure.bind",
		);
		expect([c.status, c.severity]).toEqual(["problem", "warn"]);
	});

	test("no policy available is skipped, never a pass", async () => {
		const { exposure: _omit, ...rest } = fixture();
		const report = await runDoctor(rest);
		expect(report.checks.find((c) => c.id === "exposure.bind")?.status).toBe(
			"skipped",
		);
	});
});

describe("project checks", () => {
	test("the default worktree with bwrap cannot dispatch", async () => {
		const c = await check(
			withProject({}, { runWorkspace: undefined }),
			"project.dispatch",
		);
		expect([c.status, c.severity]).toEqual(["problem", "blocker"]);
		expect(c.fix).toContain('"runWorkspace": "clone"');
		expect(c.project).toBe("demo");
	});

	test("an .envrc blocks a clone project", async () => {
		const c = await check(withProject({ hasEnvrc: true }), "project.dispatch");
		expect(c.severity).toBe("blocker");
		expect(c.detail).toContain(".envrc");
	});

	test("autonomous without a sandbox is a blocker", async () => {
		const c = await check(
			withProject({}, { agentIsolation: "none" }),
			"project.isolation",
		);
		expect([c.status, c.severity]).toEqual(["problem", "blocker"]);
	});

	test("a remote without pushUrl warns and hides URL credentials", async () => {
		const c = await check(
			withProject({
				remotes: [
					{ name: "origin", url: "https://bot:s3cret@github.com/o/r.git" },
				],
			}),
			"project.push",
		);
		expect([c.status, c.severity]).toEqual(["problem", "warn"]);
		expect(JSON.stringify(c)).not.toContain("s3cret");
		expect(c.fix).toContain("pushUrl");
	});

	test("a drifted trigger is a warning naming it", async () => {
		const c = await check(
			withProject({
				triggers: {
					armedCurrent: 1,
					drifted: ["deploy"],
					quarantined: [],
					unarmed: 0,
				},
			}),
			"project.triggers",
		);
		expect([c.status, c.severity]).toEqual(["problem", "warn"]);
		expect(c.detail).toContain("deploy");
	});

	test("a per-destination budget over the total warns", async () => {
		const c = await check(
			withProject(
				{},
				{
					agentEgressUploadBudget: {
						perDestinationBytes: 10,
						totalBytes: 5,
					},
				},
			),
			"project.egress",
		);
		expect([c.status, c.severity]).toEqual(["problem", "warn"]);
	});

	test("untracked files on a public forge are reported", async () => {
		const c = await check(
			withProject({
				remotes: [{ name: "origin", url: "git@github.com:o/r.git" }],
				untracked: { count: 2, sample: [".env", "notes.md"], truncated: false },
				ignoredState: { count: 1, sample: [".mfw/x"], truncated: false },
			}),
			"project.untracked",
		);
		expect([c.status, c.severity]).toEqual(["problem", "warn"]);
		expect(c.detail).toContain("2 untracked");
		expect(c.detail).toContain("visibility was not checked");
	});

	test("a private remote skips the untracked report", async () => {
		const c = await check(
			withProject({
				remotes: [{ name: "origin", url: "git@git.internal:o/r.git" }],
				untracked: { count: 2, sample: [".env"], truncated: false },
			}),
			"project.untracked",
		);
		expect(c.status).toBe("skipped");
	});
});

describe("fail closed", () => {
	test("a probe that throws is a blocker, never a pass", async () => {
		const report = await runDoctor(
			fixture({
				legacyHost: async () => {
					throw new Error("disk error");
				},
			}),
		);
		const c = report.checks.find((x) => x.id === "install.legacy-host");
		expect([c?.status, c?.severity]).toEqual(["problem", "blocker"]);
		expect(doctorExitCode(report)).toBe(1);
	});
});

describe("output", () => {
	test("exit code is 1 with a blocker and 0 with only warnings", async () => {
		const blocked = await runDoctor(
			fixture({ host: fixtureHost({ bwrapVersion: null }) }),
		);
		expect(doctorExitCode(blocked)).toBe(1);
		const warned = await runDoctor(
			fixture({ host: fixtureHost({ existing: [] }) }),
		);
		expect(warned.summary.warn).toBeGreaterThan(0);
		expect(doctorExitCode(warned)).toBe(0);
	});

	test("human output is grouped and prints each fix", async () => {
		const report = await runDoctor(
			fixture({ host: fixtureHost({ existing: [] }) }),
		);
		const text = renderDoctorReport(report);
		expect(text).toContain("Host");
		expect(text).toContain("fix: loginctl enable-linger owner");
	});

	test("sanitizeText strips terminal escapes and URL credentials", () => {
		expect(sanitizeText("a\u001b[31mb\u0007c")).toBe("a[31mbc");
		expect(sanitizeText("https://u:p@host/x")).toBe("https://***@host/x");
	});
});
