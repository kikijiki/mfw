import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveCompileHost } from "../src/containment/agent-launch-host.ts";
import {
	type LaunchPreflightIo,
	launchPreflight,
} from "../src/containment/launch-preflight.ts";
import { socketBase, socketRoot } from "../src/containment/socket-root.ts";
import type { DoctorProbes, PathStat } from "../src/doctor/probes.ts";
import { runDoctor } from "../src/doctor/run.ts";
import { SandboxUnavailableError } from "../src/sandbox.ts";
import {
	fixture,
	fixtureHost,
	HOME,
	healthyProject,
} from "./support/doctor-fixture.ts";

const ENV = { MFW_SOCKET_DIR: "/srv/sock" };
const BASE = socketBase({ env: ENV, uid: 1000 });
const ROOT = socketRoot(HOME, { env: ENV, uid: 1000 });

function io(over: Partial<LaunchPreflightIo> = {}): LaunchPreflightIo {
	return {
		home: HOME,
		uid: 1000,
		env: ENV,
		lstat: async () => null,
		tool: async (name) => `/usr/bin/${name}`,
		run: async () => ({ code: 0, stdout: "tmux 3.5\n" }),
		...over,
	};
}
const item = async (id: string, over: Partial<LaunchPreflightIo> = {}) => {
	const found = (await launchPreflight(io(over))).find((i) => i.id === id);
	if (!found) throw new Error(`no item ${id}`);
	return found;
};
const dir = (mode: number, uid = 1000): PathStat => ({
	kind: "dir",
	mode,
	uid,
});

describe("the shared launch preflight", () => {
	test("a host with nothing created yet passes", async () => {
		const items = await launchPreflight(io());
		expect(items.every((i) => i.ok)).toBe(true);
	});

	for (const path of [BASE, ROOT]) {
		test(`the reviewer's case: a 0777 socket directory at ${path === BASE ? "the base" : "the root"}`, async () => {
			const c = await item("socket", {
				lstat: async (p) => (p === path ? dir(0o777) : null),
			});
			expect(c.ok).toBe(false);
			expect(c.launch).toBe(true);
			expect(c.detail).toContain("private");
		});
	}

	test("a socket directory of another user, or a link, is refused", async () => {
		for (const st of [
			dir(0o700, 0),
			{ kind: "other", mode: 0o777, uid: 1000 } as PathStat,
		]) {
			const c = await item("socket", {
				lstat: async (p) => (p === BASE ? st : null),
			});
			expect(c.ok).toBe(false);
		}
	});

	test("a socket path over the limit is refused", async () => {
		const c = await item("socket", {
			env: { MFW_SOCKET_DIR: `/${"a".repeat(100)}` },
		});
		expect(c.ok).toBe(false);
		expect(c.fix).toContain("MFW_SOCKET_DIR");
	});

	for (const name of ["env", "systemd-run"]) {
		test(`a missing ${name} refuses a launch`, async () => {
			const c = await item(name, {
				tool: async (n) => (n === name ? null : `/usr/bin/${n}`),
			});
			expect(c.ok).toBe(false);
			expect(c.launch).toBe(true);
		});
	}

	test("the reviewer's case: a tmux that always exits 1", async () => {
		const c = await item("tmux", {
			run: async () => ({ code: 1, stdout: "" }),
		});
		expect(c.ok).toBe(false);
	});

	test("a tmux that cannot start is not a pass", async () => {
		const c = await item("tmux", { run: async () => undefined });
		expect(c.ok).toBe(false);
	});

	test("it only reads", async () => {
		const seen: string[][] = [];
		await launchPreflight(
			io({
				run: async (argv) => {
					seen.push(argv);
					return { code: 0, stdout: "tmux 3.5\n" };
				},
			}),
		);
		expect(seen).toEqual([["/usr/bin/tmux", "-V"]]);
	});
});

describe("the doctor and the launch gate agree", () => {
	const dirs: string[] = [];
	const saved = process.env.MFW_SOCKET_DIR;
	afterEach(() => {
		if (saved === undefined) delete process.env.MFW_SOCKET_DIR;
		else process.env.MFW_SOCKET_DIR = saved;
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	const check = async (over: Partial<DoctorProbes>, id: string) => {
		const report = await runDoctor(fixture(over));
		const c = report.checks.find((x) => x.id === id);
		if (!c) throw new Error(`no check ${id}`);
		return c;
	};

	test("doctor reports a 0777 socket directory as a blocker", async () => {
		const base = fixture();
		const root = "/run/user/1000/mfw";
		const c = await check(
			{
				stat: async (p) => (p === root ? dir(0o777) : base.stat(p)),
			},
			"storage.socket",
		);
		expect([c.status, c.severity]).toEqual(["problem", "blocker"]);
	});

	test("a real launch refuses the same directory", async () => {
		const d = realpathSync(mkdtempSync(join(tmpdir(), "mfw-sock-")));
		dirs.push(d);
		const open = join(d, "s");
		mkdirSync(open);
		chmodSync(open, 0o777);
		process.env.MFW_SOCKET_DIR = open;
		const failure = await liveCompileHost(
			{ mfwHome: join(d, "home"), cli: "claude", stateDir: join(d, "state") },
			[],
			[],
		).catch((e) => e);
		expect(failure).toBeInstanceOf(SandboxUnavailableError);
		expect(failure.message).toContain("private");
	});

	test("doctor reports a tmux that exits 1", async () => {
		const host = fixtureHost();
		const c = await check(
			{
				host: {
					...host,
					run: async (argv) =>
						argv[0]?.endsWith("tmux")
							? { code: 1, stdout: "" }
							: host.run(argv),
				},
			},
			"tool.tmux",
		);
		expect([c.status, c.severity]).toEqual(["problem", "blocker"]);
	});

	for (const name of ["env", "systemd-run"]) {
		test(`doctor reports a missing ${name}`, async () => {
			const c = await check(
				{
					tool: async (n) =>
						n === name ? { path: null } : { path: `/usr/bin/${n}` },
				},
				`tool.${name}`,
			);
			expect([c.status, c.severity]).toEqual(["problem", "blocker"]);
		});
	}

	test("a git that will not run is a blocker", async () => {
		const c = await check(
			{
				toolVersion: async (p) => (p.endsWith("git") ? undefined : "1.0.0"),
			},
			"tool.git",
		);
		expect([c.status, c.severity]).toEqual(["problem", "blocker"]);
	});

	test("a repo config host git refuses is a blocker, with no public remote", async () => {
		const c = await check(
			{
				config: async () => ({
					ok: true,
					config: {
						projects: [{ name: "demo", root: "/srv/demo" }],
					},
				}),
				project: async () =>
					healthyProject({
						gitConfigRefusal:
							"refusing to run git: the repository's config sets keys mfw does not allow (core.fsmonitor). Fix: remove them with `git config --unset`, or move them to your global git config if you set them yourself.",
					}),
			},
			"project.git-config",
		);
		expect([c.status, c.severity]).toEqual(["problem", "blocker"]);
		expect(c.detail).toContain("core.fsmonitor");
		expect(c.fix).toContain("git config --unset");
	});
});
