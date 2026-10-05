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
import { join, resolve } from "node:path";

const CLI = join(import.meta.dir, "../src/cli.ts");
// Installed copies have the checkout placeholder filled in with the real path.
const PACKAGED = readFileSync(
	join(import.meta.dir, "../skill/SKILL.md"),
	"utf8",
).replaceAll("<mfw-checkout>", resolve(import.meta.dir, "../../.."));

const roots: string[] = [];
interface Sandbox {
	root: string;
	home: string;
	cwd: string;
	bin: string;
}
function sandbox(): Sandbox {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "mfwb-skill-")));
	roots.push(root);
	const s = {
		root,
		home: join(root, "home"),
		cwd: join(root, "cwd"),
		bin: join(root, "bin"),
	};
	for (const d of [s.home, s.cwd, s.bin]) mkdirSync(d);
	return s;
}
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** Fake executable on the sandbox PATH makes a tool "detected". */
function fakeExe(s: Sandbox, name: string): void {
	const p = join(s.bin, name);
	writeFileSync(p, "#!/bin/sh\n");
	chmodSync(p, 0o755);
}

async function run(
	s: Sandbox,
	args: string[],
	extra: Record<string, string> = {},
) {
	const env: Record<string, string> = {
		HOME: s.home,
		PATH: s.bin,
		...extra,
	};
	const p = Bun.spawn([process.execPath, "run", CLI, ...args], {
		cwd: s.cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}

const skillPath = (base: string) => join(base, "mfwb", "SKILL.md");
const has = (p: string) => existsSync(p);

describe("skill install: detection and targets", () => {
	test("detected by PATH executable; only detected tools get installs", async () => {
		const s = sandbox();
		fakeExe(s, "codex");
		const r = await run(s, ["skill", "install"]);
		expect(r.code).toBe(0);
		const p = skillPath(join(s.cwd, ".agents/skills"));
		expect(r.stdout).toBe(`installed codex -> ${p}`);
		expect(readFileSync(p, "utf8")).toBe(PACKAGED);
		expect(has(join(s.cwd, ".claude"))).toBe(false);
	});

	test("detected by config dir", async () => {
		const s = sandbox();
		mkdirSync(join(s.home, ".pi/agent"), { recursive: true });
		const r = await run(s, ["skill", "install"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("installed pi -> ");
		expect(has(skillPath(join(s.cwd, ".pi/skills")))).toBe(true);
	});

	test("config dirs honor env overrides for detection", async () => {
		const s = sandbox();
		const x = join(s.root, "xdg");
		mkdirSync(join(x, "opencode"), { recursive: true });
		const r = await run(s, ["skill", "install"], { XDG_CONFIG_HOME: x });
		expect(r.stdout).toContain("installed opencode -> ");
	});

	test("nothing detected exits 1 and lists the tools", async () => {
		const s = sandbox();
		const r = await run(s, ["skill", "install"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("claude, codex, opencode, pi");
		expect(r.stderr).toContain("--target");
		expect(has(join(s.cwd, ".claude"))).toBe(false);
	});

	test("unknown target exits 2", async () => {
		const s = sandbox();
		const r = await run(s, ["skill", "install", "--target", "claude,vim"]);
		expect(r.code).toBe(2);
	});

	test("--target all, explicit list, and works without a board", async () => {
		const s = sandbox();
		const r = await run(s, ["skill", "install", "--target", "all"]);
		expect(r.code).toBe(0);
		expect(r.stdout.split("\n")).toHaveLength(4);
		const e = sandbox();
		const r2 = await run(e, [
			"skill",
			"install",
			"--target",
			"pi, opencode".replace(" ", ""),
		]);
		expect(r2.code).toBe(0);
		expect(has(skillPath(join(e.cwd, ".claude/skills")))).toBe(false);
	});
});

describe("skill install: locations", () => {
	test("project scope, pi+opencode install both natives", async () => {
		const s = sandbox();
		const r = await run(s, ["skill", "install", "--target", "pi,opencode"]);
		expect(r.code).toBe(0);
		expect(r.stdout.split("\n")).toEqual([
			`installed pi -> ${skillPath(join(s.cwd, ".pi/skills"))}`,
			`installed opencode -> ${skillPath(join(s.cwd, ".opencode/skills"))}`,
		]);
	});

	test("global paths with defaults", async () => {
		const s = sandbox();
		const r = await run(s, [
			"skill",
			"install",
			"--global",
			"--target",
			"claude,codex,opencode,pi",
		]);
		expect(r.code).toBe(0);
		// opencode is covered by ~/.claude/skills; pi and codex have distinct globals.
		for (const base of [".claude/skills", ".codex/skills", ".pi/agent/skills"])
			expect(readFileSync(skillPath(join(s.home, base)), "utf8")).toBe(
				PACKAGED,
			);
		expect(r.stdout).toContain(
			`covered opencode by ${skillPath(join(s.home, ".claude/skills"))}`,
		);
		expect(has(join(s.home, ".config/opencode"))).toBe(false);
	});

	test("global paths with env overrides", async () => {
		const s = sandbox();
		const env = {
			CLAUDE_CONFIG_DIR: join(s.root, "c1"),
			CODEX_HOME: join(s.root, "c2"),
			XDG_CONFIG_HOME: join(s.root, "c3"),
			PI_CODING_AGENT_DIR: join(s.root, "c4"),
		};
		const r = await run(
			s,
			["skill", "install", "--global", "--target", "claude,codex,pi"],
			env,
		);
		expect(r.code).toBe(0);
		expect(has(skillPath(join(env.CLAUDE_CONFIG_DIR, "skills")))).toBe(true);
		expect(has(skillPath(join(env.CODEX_HOME, "skills")))).toBe(true);
		expect(has(skillPath(join(env.PI_CODING_AGENT_DIR, "skills")))).toBe(true);
		const r2 = await run(
			s,
			["skill", "install", "--global", "--target", "opencode"],
			env,
		);
		expect(r2.stdout).toBe(
			`installed opencode -> ${skillPath(join(env.XDG_CONFIG_HOME, "opencode/skills"))}`,
		);
		expect(has(join(s.home, ".claude"))).toBe(false);
	});
});

describe("skill install: coverage rule", () => {
	test("claude+opencode installs claude only", async () => {
		const s = sandbox();
		const r = await run(s, ["skill", "install", "--target", "claude,opencode"]);
		const p = skillPath(join(s.cwd, ".claude/skills"));
		expect(r.stdout.split("\n")).toEqual([
			`installed claude -> ${p}`,
			`covered opencode by ${p}`,
		]);
		expect(has(join(s.cwd, ".opencode"))).toBe(false);
	});

	test("codex+pi (project) installs .agents once", async () => {
		const s = sandbox();
		const r = await run(s, ["skill", "install", "--target", "codex,pi"]);
		const p = skillPath(join(s.cwd, ".agents/skills"));
		expect(r.stdout.split("\n")).toEqual([
			`installed codex -> ${p}`,
			`covered pi by ${p}`,
		]);
		expect(has(join(s.cwd, ".pi"))).toBe(false);
	});

	test("all four, project scope", async () => {
		const s = sandbox();
		const r = await run(s, ["skill", "install", "--target", "all"]);
		const c = skillPath(join(s.cwd, ".claude/skills"));
		const a = skillPath(join(s.cwd, ".agents/skills"));
		expect(r.stdout.split("\n")).toEqual([
			`installed claude -> ${c}`,
			`installed codex -> ${a}`,
			`covered pi by ${a}`,
			`covered opencode by ${c}`,
		]);
	});

	test("all four, global scope", async () => {
		const s = sandbox();
		const r = await run(s, ["skill", "install", "--global", "--target", "all"]);
		const c = skillPath(join(s.home, ".claude/skills"));
		expect(r.stdout.split("\n")).toEqual([
			`installed claude -> ${c}`,
			`installed codex -> ${skillPath(join(s.home, ".codex/skills"))}`,
			`installed pi -> ${skillPath(join(s.home, ".pi/agent/skills"))}`,
			`covered opencode by ${c}`,
		]);
	});

	test("global: opencode's Claude-compat location follows CLAUDE_CONFIG_DIR", async () => {
		const s = sandbox();
		const moved = join(s.root, "elsewhere");
		const r = await run(
			s,
			["skill", "install", "--global", "--target", "claude,opencode"],
			{ CLAUDE_CONFIG_DIR: moved },
		);
		expect(r.stdout).toContain(
			`covered opencode by ${skillPath(join(moved, "skills"))}`,
		);
		expect(has(skillPath(join(s.home, ".claude/skills")))).toBe(false);
		expect(has(join(s.home, ".config/opencode"))).toBe(false);
	});

	test("project scope installs at the nearest .git ancestor, not a subdirectory", async () => {
		const s = sandbox();
		mkdirSync(join(s.cwd, ".git"));
		const sub = join(s.cwd, "a", "b");
		mkdirSync(sub, { recursive: true });
		const sb = { ...s, cwd: sub };
		const r = await run(sb, ["skill", "install", "--target", "claude"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toBe(
			`installed claude -> ${skillPath(join(s.cwd, ".claude/skills"))}`,
		);
		expect(r.stderr).toContain(`project root: ${s.cwd}`);
		expect(has(skillPath(join(sub, ".claude/skills")))).toBe(false);
	});

	test(".git may be a file (worktree); no .git falls back to cwd", async () => {
		const s = sandbox();
		writeFileSync(join(s.cwd, ".git"), "gitdir: x\n");
		const sub = join(s.cwd, "d");
		mkdirSync(sub);
		const r = await run({ ...s, cwd: sub }, [
			"skill",
			"install",
			"--target",
			"claude",
		]);
		expect(has(skillPath(join(s.cwd, ".claude/skills")))).toBe(true);
		const t = sandbox();
		const sub2 = join(t.cwd, "d");
		mkdirSync(sub2);
		await run({ ...t, cwd: sub2 }, ["skill", "install", "--target", "claude"]);
		expect(has(skillPath(join(sub2, ".claude/skills")))).toBe(true);
		expect(r.code).toBe(0);
	});

	test("--here forces the cwd", async () => {
		const s = sandbox();
		mkdirSync(join(s.cwd, ".git"));
		const sub = join(s.cwd, "a");
		mkdirSync(sub);
		const r = await run({ ...s, cwd: sub }, [
			"skill",
			"install",
			"--here",
			"--target",
			"claude",
		]);
		expect(r.code).toBe(0);
		expect(has(skillPath(join(sub, ".claude/skills")))).toBe(true);
		expect(has(skillPath(join(s.cwd, ".claude/skills")))).toBe(false);
	});
});

describe("skill install: idempotence, dry-run, status", () => {
	test("second run is up-to-date; stale file is rewritten", async () => {
		const s = sandbox();
		const args = ["skill", "install", "--target", "claude"];
		await run(s, args);
		const p = skillPath(join(s.cwd, ".claude/skills"));
		expect((await run(s, args)).stdout).toBe(`up-to-date claude -> ${p}`);
		writeFileSync(p, "old");
		expect((await run(s, args)).stdout).toBe(`installed claude -> ${p}`);
		expect(readFileSync(p, "utf8")).toBe(PACKAGED);
	});

	test("--dry-run writes nothing", async () => {
		const s = sandbox();
		const r = await run(s, [
			"skill",
			"install",
			"--target",
			"all",
			"--dry-run",
		]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("would install claude -> ");
		expect(has(join(s.cwd, ".claude"))).toBe(false);
		expect(has(join(s.cwd, ".agents"))).toBe(false);
	});

	test("status text and json: missing, installed, stale, covered", async () => {
		const s = sandbox();
		fakeExe(s, "claude");
		const missing = await run(s, ["skill", "status"]);
		expect(missing.code).toBe(0);
		const c = skillPath(join(s.cwd, ".claude/skills"));
		expect(missing.stdout).toContain(`claude detected ${c} missing`);
		expect(missing.stdout).toContain(
			`pi not detected ${skillPath(join(s.cwd, ".pi/skills"))} missing (covered by ${skillPath(join(s.cwd, ".agents/skills"))})`,
		);
		await run(s, ["skill", "install", "--target", "claude"]);
		const j = JSON.parse((await run(s, ["--json", "skill", "status"])).stdout);
		expect(j.map((x: { tool: string }) => x.tool)).toEqual([
			"claude",
			"codex",
			"opencode",
			"pi",
		]);
		expect(j[0]).toEqual({
			tool: "claude",
			detected: true,
			scope: "project",
			path: c,
			state: "installed",
			coveredBy: null,
		});
		expect(j[2].coveredBy).toBe(c);
		expect(j[2].state).toBe("installed");
		writeFileSync(c, "changed");
		const t = await run(s, ["skill", "status", "--target", "claude"]);
		expect(t.stdout).toBe(`claude detected ${c} stale`);
	});
});
