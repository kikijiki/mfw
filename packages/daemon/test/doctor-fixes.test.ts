import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "../src/doctor/fix-text.ts";
import type { DoctorProbes, PathStat } from "../src/doctor/probes.ts";
import { runDoctor } from "../src/doctor/run.ts";
import { requireHostTool } from "../src/sandbox.ts";
import { fixture, healthyProject } from "./support/doctor-fixture.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A PATH of fakes that record their argv, one NUL-separated argument list per call. */
function recorder() {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "mfw-fix-")));
	dirs.push(base);
	const bin = join(base, "bin");
	mkdirSync(bin);
	const log = join(base, "argv");
	for (const name of ["chmod", "chown", "rm", "sudo"]) {
		writeFileSync(
			join(bin, name),
			`#!/bin/sh\nprintf '%s\\0' ${name} "$@" >> '${log}'\nprintf '\\n' >> '${log}'\n`,
		);
		chmodSync(join(bin, name), 0o755);
	}
	const run = (command: string): string[] => {
		const p = Bun.spawnSync([requireHostTool("sh"), "-c", command], {
			cwd: base,
			env: { PATH: bin },
		});
		expect(p.exitCode).toBe(0);
		const out = readFileSync(log, "utf8").split("\n")[0] ?? "";
		return out.split("\0").filter((a) => a !== "");
	};
	return { base, run };
}

const HOSTILE = [
	"/srv/my proj",
	"/srv/x $(touch pwned)",
	"/srv/x`touch pwned`",
	"/srv/it's",
	'/srv/dq"uote',
	"/srv/semi;touch pwned",
	"/srv/-rf",
	"/srv/star*",
	"/srv/$HOME",
];
const UNPRINTABLE = ["/srv/new\nline", "/srv/tab\tname", "/srv/bidi‮gnp"];

const dirStat = (mode: number, uid = 1000): PathStat => ({
	kind: "dir",
	mode,
	uid,
});

/** A recognisable mfw home at `home`, with the given mode and owner. */
function homeProbes(home: string, mode: number, uid = 1000): DoctorProbes {
	return fixture({
		home,
		stat: async (p) =>
			p === home
				? dirStat(mode, uid)
				: p === join(home, "auth.db")
					? { kind: "file", mode: 0o600, uid: 1000 }
					: null,
	});
}

const fixOf = async (p: DoctorProbes, id: string) => {
	const report = await runDoctor(p);
	const c = report.checks.find((x) => x.id === id);
	if (!c) throw new Error(`no check ${id}`);
	return c.fix ?? "";
};

describe("shellQuote", () => {
	test("round-trips every hostile name through a real shell", () => {
		const r = recorder();
		for (const name of HOSTILE) {
			const p = Bun.spawnSync(
				[requireHostTool("sh"), "-c", `printf %s ${shellQuote(name)}`],
				{ cwd: r.base, env: { PATH: "" } },
			);
			expect(p.stdout.toString()).toBe(name);
		}
		expect(existsSync(join(r.base, "pwned"))).toBe(false);
	});
});

describe("every printed command is safe to paste", () => {
	for (const home of HOSTILE) {
		test(`chmod on the home: ${home}`, async () => {
			const r = recorder();
			const fix = await fixOf(homeProbes(home, 0o770), "storage.home");
			expect(r.run(fix)).toEqual(["chmod", "700", "--", home]);
			expect(existsSync(join(r.base, "pwned"))).toBe(false);
		});

		test(`chown of a recognised home: ${home}`, async () => {
			const r = recorder();
			const fix = await fixOf(homeProbes(home, 0o700, 0), "storage.home");
			expect(r.run(fix)).toEqual([
				"sudo",
				"chown",
				"-hR",
				"--preserve-root",
				"--",
				"1000",
				home,
			]);
			expect(existsSync(join(r.base, "pwned"))).toBe(false);
		});

		test(`chmod on a secret file: ${home}`, async () => {
			const r = recorder();
			const file = join(home, "auth.db");
			const fix = await fixOf(
				fixture({
					home,
					stat: async (p) =>
						p === home
							? dirStat(0o700)
							: p === file
								? { kind: "file", mode: 0o644, uid: 1000 }
								: null,
				}),
				"auth.files",
			);
			expect(r.run(fix)).toEqual(["chmod", "600", "--", file]);
		});

		test(`rm of an old skill: ${home}`, async () => {
			const r = recorder();
			const skill = `${home}/mfwb/SKILL.md`;
			const report = await runDoctor(
				fixture({
					legacySkills: async () => ({ available: true, paths: [skill] }),
				}),
			);
			const fix =
				report.checks.find((c) => c.id === "install.skills")?.fix ?? "";
			const command = fix.slice(fix.indexOf("rm "));
			expect(r.run(command)).toEqual(["rm", "--", skill]);
			expect(existsSync(join(r.base, "pwned"))).toBe(false);
		});
	}

	for (const home of UNPRINTABLE) {
		test(`a name that cannot be printed gets no command: ${JSON.stringify(home)}`, async () => {
			for (const fix of [
				await fixOf(homeProbes(home, 0o770), "storage.home"),
				await fixOf(homeProbes(home, 0o700, 0), "storage.home"),
			]) {
				expect(fix).not.toMatch(/\b(chmod|chown)\b/);
				expect(fix).toContain("rename");
			}
		});
	}
});

describe("a recursive chown is only printed for a recognisable mfw home", () => {
	for (const home of [
		"/usr",
		"/",
		"/etc",
		"/home",
		"/usr/local",
		"/nix/store/x",
	]) {
		test(`MFW_HOME=${home} gets no chown or chmod`, async () => {
			for (const probes of [
				homeProbes(home, 0o700, 0),
				homeProbes(home, 0o777),
			]) {
				const fix = await fixOf(probes, "storage.home");
				expect(fix).not.toMatch(/\b(chown|chmod)\b/);
				expect(fix).toContain("MFW_HOME");
			}
		});
	}

	test("a directory with no mfw marker gets no chown", async () => {
		const fix = await fixOf(
			fixture({
				home: "/srv/data",
				stat: async (p) => (p === "/srv/data" ? dirStat(0o700, 0) : null),
			}),
			"storage.home",
		);
		expect(fix).not.toContain("chown");
		expect(fix).toContain("MFW_HOME");
	});
});

describe("fixes that were harmful if followed blindly", () => {
	const project = (facts: Parameters<typeof healthyProject>[0]) =>
		fixture({
			config: async () => ({
				ok: true,
				config: {
					projects: [
						{
							name: "x $(touch pwned)",
							root: "/srv/x $(touch pwned)",
							runWorkspace: "clone",
						},
					],
				},
			}),
			project: async () => healthyProject(facts),
		});

	test("a missing .git is never answered with git init", async () => {
		const fix = await fixOf(project({ isGit: false }), "project.root");
		expect(fix).not.toContain("git -C");
		expect(fix).not.toContain("init");
		expect(fix).not.toContain("$(");
	});

	test("pushUrl is never copied from repo config", async () => {
		const fix = await fixOf(
			project({
				remotes: [
					{ name: "origin", url: "https://bot:s3cret@github.com/o/r.git" },
				],
			}),
			"project.push",
		);
		expect(fix).not.toContain("github.com");
		expect(fix).not.toContain("***");
		expect(fix).toContain('"pushOnMerge": false');
		expect(fix).toContain("verif");
		expect(fix).not.toContain("$(");
	});

	test("auth reset says what it removes", async () => {
		const fix = await fixOf(
			fixture({
				auth: async () => ({
					state: "ready",
					owner: true,
					passwordSet: false,
					liveTokens: 0,
					pendingSetup: false,
				}),
			}),
			"auth.state",
		);
		expect(fix).toContain("mfw auth reset --yes");
		expect(fix).toContain("removes the owner");
	});

	test("the delegate drop-in is never overwritten", async () => {
		const base = fixture().host;
		const fix = await fixOf(
			fixture({
				host: {
					...base,
					readFile: async (p) =>
						p.endsWith("user@1000.service/cgroup.controllers")
							? "cpu\n"
							: base.readFile(p),
				},
			}),
			"host.systemd",
		);
		expect(fix).toContain(
			"sudo test ! -e /etc/systemd/system/user@.service.d/delegate.conf",
		);
	});
});
