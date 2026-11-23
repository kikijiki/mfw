import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config.ts";
import { runInitCommand } from "../src/doctor/cli.ts";
import { fixture } from "./support/doctor-fixture.ts";

const dirs: string[] = [];
const savedUmask = process.umask();
afterEach(() => {
	process.umask(savedUmask);
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
	const r = Bun.spawnSync(["git", ...args], {
		cwd,
		env: { PATH: process.env.PATH ?? "", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" },
	});
	if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

function setup() {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "mfw-init-")));
	dirs.push(base);
	const home = join(base, "home");
	const repo = join(base, "repo");
	mkdirSync(home, { mode: 0o700 });
	mkdirSync(repo);
	git(repo, "init", "-q", "-b", "main");
	const out: string[] = [];
	const err: string[] = [];
	const deps = {
		env: { PATH: "", HOST: "127.0.0.1" },
		home,
		out: (l: string) => out.push(l),
		err: (l: string) => err.push(l),
		probes: fixture({ home }),
	};
	return {
		base,
		home,
		repo,
		out,
		err,
		deps,
		config: join(home, "config.json"),
	};
}

const mode = (p: string) => statSync(p).mode & 0o777;

describe("init --write keeps config.json private", () => {
	test("the reviewer's case: a new file under umask 022 is 0600", async () => {
		const s = setup();
		process.umask(0o022);
		await runInitCommand(["--project", s.repo, "--write"], s.deps);
		expect(s.err).toEqual([]);
		expect(mode(s.config)).toBe(0o600);
	});

	test("a wider existing file is tightened", async () => {
		const s = setup();
		process.umask(0o022);
		writeFileSync(s.config, '{"projects":[]}\n');
		chmodSync(s.config, 0o644);
		await runInitCommand(["--project", s.repo, "--write"], s.deps);
		expect(mode(s.config)).toBe(0o600);
	});

	test("a stricter existing mode is preserved", async () => {
		const s = setup();
		writeFileSync(s.config, '{"projects":[]}\n');
		chmodSync(s.config, 0o400);
		await runInitCommand(["--project", s.repo, "--write"], s.deps);
		expect(mode(s.config)).toBe(0o400);
	});

	test("every other config save keeps the same rule", async () => {
		const s = setup();
		process.umask(0o022);
		await saveConfig({ projects: [] }, s.home);
		expect(mode(s.config)).toBe(0o600);
	});
});

describe("init --write refuses a save that would lose something", () => {
	test("a symlinked config is refused and left alone", async () => {
		const s = setup();
		const real = join(s.base, "dotfiles-config.json");
		writeFileSync(real, '{"projects":[]}\n');
		symlinkSync(real, s.config);
		expect(await runInitCommand(["--project", s.repo, "--write"], s.deps)).toBe(
			1,
		);
		expect(s.err.join("")).toContain("symbolic link");
		expect(lstatSync(s.config).isSymbolicLink()).toBe(true);
		expect(readFileSync(real, "utf8")).toBe('{"projects":[]}\n');
	});

	for (const [where, text, key] of [
		["top level", '{"projects":[],"myNote":"keep"}\n', "myNote"],
		[
			"project level",
			'{"projects":[{"name":"a","root":"/srv/a","futureKey":1}]}\n',
			"projects[0].futureKey",
		],
		[
			"nested",
			'{"projects":[{"name":"a","root":"/srv/a","watchdog":{"idleMs":1,"newLimit":2}}]}\n',
			"projects[0].watchdog.newLimit",
		],
	] as const) {
		test(`an unknown key at ${where} is refused, and the file is unchanged`, async () => {
			const s = setup();
			writeFileSync(s.config, text);
			expect(
				await runInitCommand(["--project", s.repo, "--write"], s.deps),
			).toBe(1);
			expect(s.err.join("")).toContain(key);
			expect(readFileSync(s.config, "utf8")).toBe(text);
		});
	}

	test("a config with only known keys is saved", async () => {
		const s = setup();
		writeFileSync(
			s.config,
			'{"projects":[{"name":"a","root":"/srv/a","watchdog":{"idleMs":1}}],"dispatchPaused":true}\n',
		);
		await runInitCommand(["--project", s.repo, "--write"], s.deps);
		expect(s.err).toEqual([]);
		const cfg = await loadConfig(s.home);
		expect(cfg.projects).toHaveLength(2);
		expect(cfg.dispatchPaused).toBe(true);
	});
});

describe("init validates what it would write", () => {
	const write = (s: ReturnType<typeof setup>, ...extra: string[]) =>
		runInitCommand(["--project", s.repo, ...extra, "--write"], s.deps);

	for (const name of [
		"../../evil name",
		"a/b",
		"-x",
		"a b",
		"",
		"a\nb",
		"x".repeat(65),
	]) {
		test(`the project name ${JSON.stringify(name.slice(0, 20))} is refused`, async () => {
			const s = setup();
			expect(await write(s, "--name", name)).not.toBe(0);
			expect(existsSync(s.config)).toBe(false);
		});
	}

	for (const branch of [
		"-x;touch pwn",
		"a b",
		"a..b",
		"x.lock",
		"$(touch pwn)",
		"@{-1}",
	]) {
		test(`the branch ${JSON.stringify(branch)} is refused`, async () => {
			const s = setup();
			expect(await write(s, "--branch", branch)).not.toBe(0);
			expect(existsSync(s.config)).toBe(false);
		});
	}

	test("a directory name that is not a valid project name asks for --name", async () => {
		const s = setup();
		const odd = join(s.base, "my repo");
		mkdirSync(odd);
		git(odd, "init", "-q", "-b", "main");
		expect(await runInitCommand(["--project", odd], s.deps)).not.toBe(0);
		expect(s.err.join("")).toContain("--name");
	});

	test("the reviewer's case: the same repository through a symlink", async () => {
		const s = setup();
		await write(s);
		const link = join(s.base, "link");
		symlinkSync(s.repo, link);
		const code = await runInitCommand(
			["--project", link, "--name", "other", "--write"],
			s.deps,
		);
		expect(code).toBe(1);
		expect(s.err.join("")).toContain("already uses");
		expect((await loadConfig(s.home)).projects).toHaveLength(1);
	});

	test("an entry stored through a symlink is still a duplicate", async () => {
		const s = setup();
		const link = join(s.base, "link");
		symlinkSync(s.repo, link);
		writeFileSync(
			s.config,
			JSON.stringify({ projects: [{ name: "a", root: link }] }),
		);
		expect(await write(s, "--name", "b")).toBe(1);
		expect(s.err.join("")).toContain("already uses");
	});

	test("the entry stores the resolved root", async () => {
		const s = setup();
		const link = join(s.base, "link");
		symlinkSync(s.repo, link);
		await runInitCommand(["--project", link, "--name", "x", "--write"], s.deps);
		expect((await loadConfig(s.home)).projects[0]?.root).toBe(s.repo);
	});

	test("a project root containing MFW_HOME is refused", async () => {
		const s = setup();
		git(s.base, "init", "-q", "-b", "main");
		const code = await runInitCommand(
			["--project", s.base, "--name", "x", "--write"],
			s.deps,
		);
		expect(code).toBe(1);
		expect(s.err.join("")).toContain("MFW_HOME");
		expect(existsSync(s.config)).toBe(false);
	});

	test("a project root inside MFW_HOME is refused", async () => {
		const s = setup();
		const inner = join(s.home, "inner");
		mkdirSync(inner);
		git(inner, "init", "-q", "-b", "main");
		const code = await runInitCommand(
			["--project", inner, "--name", "x", "--write"],
			s.deps,
		);
		expect(code).toBe(1);
		expect(s.err.join("")).toContain("MFW_HOME");
	});

	test("L3: a refused repo config is named, and --branch does not bypass it", async () => {
		const s = setup();
		writeFileSync(
			join(s.repo, ".git", "config"),
			"[core]\n\tsshCommand = /bin/false\n",
		);
		expect(await write(s, "--branch", "main")).toBe(1);
		expect(s.err.join("")).toContain("core.sshcommand");
		expect(s.err.join("")).not.toContain("detached");
		expect(existsSync(s.config)).toBe(false);
	});
});
