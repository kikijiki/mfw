import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
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
