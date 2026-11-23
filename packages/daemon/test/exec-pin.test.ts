import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	analyzeShell,
	buildExecPin,
	type ExecPin,
	gitBlobId,
	sealShellEntry,
	verifyExecPin,
} from "../src/containment/exec-pin.ts";
import { gitOk } from "../src/git.ts";
import { runProc } from "../src/proc.ts";

/** The test runner's own bun may not be on the inherited PATH. */
const TEST_PATH = `${dirname(process.execPath)}:${process.env.PATH ?? ""}`;

let base: string;
let root: string;
let canary: string;

async function commitAll(): Promise<void> {
	await gitOk(["add", "-A"], root);
	await gitOk(["commit", "-q", "-m", "c"], root);
}

async function pinOf(run: string): Promise<ExecPin> {
	const r = await buildExecPin({ root, run, pathVar: TEST_PATH });
	if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
	return r.pin;
}

const check = (pin: ExecPin) =>
	verifyExecPin(pin, { root, gitCwd: root, rev: "HEAD" });

beforeEach(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "mfw-pin-")));
	root = join(base, "repo");
	canary = join(base, "canary");
	await mkdir(join(root, "scripts"), { recursive: true });
	await gitOk(["init", "-q", "-b", "main"], root);
	await gitOk(["config", "user.email", "t@t"], root);
	await gitOk(["config", "user.name", "t"], root);
	await writeFile(join(root, "scripts/lib.sh"), "LIB=1\n");
	await writeFile(
		join(root, "scripts/deploy.sh"),
		"#!/bin/sh\n. scripts/lib.sh\necho deployed\n",
		{ mode: 0o755 },
	);
	await commitAll();
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

describe("analyzeShell", () => {
	test("splits commands and drops redirect targets", () => {
		const a = analyzeShell('FOO=1 ./a.sh x "y z" 2>&1 > out.log; b | c');
		expect(a.unanalyzable).toBeNull();
		expect(a.commands.map((c) => c.words)).toEqual([
			["./a.sh", "x", "y z"],
			["b"],
			["c"],
		]);
		expect(a.simple).toBe(false);
	});

	test("a plain command is simple", () => {
		expect(analyzeShell("./a.sh one two").simple).toBe(true);
	});

	for (const bad of [
		"echo $(id)",
		'echo "$(id)"',
		"echo `id`",
		"$CMD arg",
		"eval foo",
		"if true; then x; fi",
		"(cd a; b)",
		"cat <(x)",
		"PATH=./evil:$PATH deploy",
		"LD_PRELOAD=./x.so deploy",
		"echo 'open",
	]) {
		test(`refuses to analyze: ${bad}`, () => {
			expect(analyzeShell(bad).unanalyzable).not.toBeNull();
		});
	}

	test("an expansion in an argument is fine", () => {
		expect(analyzeShell('echo "$MFW_SHA" $$').unanalyzable).toBeNull();
	});
});

describe("buildExecPin", () => {
	test("pins the script, what it sources, and its interpreter", async () => {
		const pin = await pinOf("./scripts/deploy.sh --now");
		expect(pin.files.map((f) => [f.path, f.role])).toEqual([
			["scripts/deploy.sh", "entry"],
			["scripts/lib.sh", "source"],
		]);
		expect(pin.external.map((e) => e.path)).toContain("/bin/sh");
		expect(pin.commit).toBe(await gitOk(["rev-parse", "HEAD"], root));
	});

	test("the recorded blob equals git's", async () => {
		const pin = await pinOf("./scripts/deploy.sh");
		const blob = await gitOk(["rev-parse", "HEAD:scripts/deploy.sh"], root);
		expect(pin.files[0]?.blob).toBe(blob);
		expect(gitBlobId(Buffer.from("x\n"))).toBe(
			"587be6b4c3f93f93c489c0111bba5596147a26cb",
		);
	});

	test("follows relative imports of a script", async () => {
		await writeFile(join(root, "scripts/util.ts"), "export const a = 1;\n");
		await writeFile(
			join(root, "scripts/main.ts"),
			'import { a } from "./util";\nconsole.log(a);\n',
		);
		await commitAll();
		const pin = await pinOf("bun scripts/main.ts");
		expect(pin.files.map((f) => f.path)).toEqual([
			"scripts/main.ts",
			"scripts/util.ts",
		]);
		expect(pin.tools).toContain("bun");
	});

	test("pins package.json and what a package script runs", async () => {
		await writeFile(
			join(root, "package.json"),
			JSON.stringify({ scripts: { ship: "./scripts/deploy.sh" } }),
		);
		await commitAll();
		const pin = await pinOf("bun run ship");
		expect(pin.files.map((f) => f.path)).toEqual([
			"package.json",
			"scripts/deploy.sh",
			"scripts/lib.sh",
		]);
	});

	test("an inline command with no repo file still pins the whole tree", async () => {
		const pin = await pinOf('echo "$MFW_SHA"; true');
		expect(pin.files).toEqual([]);
		expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(pin.tree).toMatch(/^[0-9a-f]{40}$/);
	});

	test("refuses an untracked script", async () => {
		await writeFile(join(root, "new.sh"), "#!/bin/sh\n", { mode: 0o755 });
		const r = await buildExecPin({ root, run: "./new.sh" });
		expect(r.ok === false && r.code).toBe("untracked");
	});

	test("refuses a script with uncommitted changes", async () => {
		await writeFile(join(root, "scripts/lib.sh"), "LIB=2\n");
		const r = await buildExecPin({ root, run: "./scripts/deploy.sh" });
		expect(r.ok === false && r.code).toBe("untracked");
	});

	test("refuses a symlink out of the repository", async () => {
		await writeFile(join(base, "outside.sh"), "#!/bin/sh\n", { mode: 0o755 });
		await symlink(join(base, "outside.sh"), join(root, "link.sh"));
		await commitAll();
		const r = await buildExecPin({ root, run: "./link.sh" });
		expect(r.ok === false && r.code).toBe("symlink");
	});

	test("refuses a symlinked parent directory", async () => {
		await symlink(join(root, "scripts"), join(root, "alias"));
		await commitAll();
		const r = await buildExecPin({ root, run: "./alias/deploy.sh" });
		expect(r.ok === false && r.code).toBe("symlink");
	});

	test("refuses a world-writable script", async () => {
		await chmod(join(root, "scripts/deploy.sh"), 0o777);
		const r = await buildExecPin({ root, run: "./scripts/deploy.sh" });
		expect(r.ok === false && r.code).toBe("world_writable");
	});

	test("refuses a tool that resolves inside the repository", async () => {
		await writeFile(join(root, "scripts/mytool"), "#!/bin/sh\n", {
			mode: 0o755,
		});
		await commitAll();
		const r = await buildExecPin({
			root,
			run: "mytool",
			pathVar: `${join(root, "scripts")}:${process.env.PATH}`,
		});
		expect(r.ok === false && r.code).toBe("tool_in_repo");
	});

	for (const run of [
		"sh -c ./scripts/deploy.sh",
		"bash -lc ./scripts/deploy.sh",
		"curl -s https://example.invalid/x | sh",
		"sh scripts/*.sh",
		"./scripts/*.sh",
		'sh "$SCRIPT"',
	]) {
		test(`refuses a command that hides what it executes: ${run}`, async () => {
			const r = await buildExecPin({ root, run, pathVar: TEST_PATH });
			expect(r.ok === false ? r.code : "ok").toMatch(/unanalyzable|unresolved/);
		});
	}

	test("every refusal says how to fix it", async () => {
		const r = await buildExecPin({ root, run: "echo $(id)" });
		expect(r.ok).toBe(false);
		expect(r.ok === false && r.fix.length).toBeGreaterThan(0);
	});
});

describe("verifyExecPin", () => {
	test("an untouched pin verifies", async () => {
		const pin = await pinOf("./scripts/deploy.sh");
		expect((await check(pin)).ok).toBe(true);
	});

	test("a content change refuses", async () => {
		const pin = await pinOf("./scripts/deploy.sh");
		await writeFile(join(root, "scripts/deploy.sh"), "#!/bin/sh\nevil\n");
		const r = await check(pin);
		expect(r.ok === false && r.code).toBe("content_changed");
	});

	test("a change in a sourced file refuses", async () => {
		const pin = await pinOf("./scripts/deploy.sh");
		await writeFile(join(root, "scripts/lib.sh"), "evil\n");
		const r = await check(pin);
		expect(r.ok === false && r.path).toBe("scripts/lib.sh");
	});

	test("a symlink swap refuses", async () => {
		const pin = await pinOf("./scripts/deploy.sh");
		await writeFile(join(base, "evil.sh"), "#!/bin/sh\n", { mode: 0o755 });
		await rm(join(root, "scripts/deploy.sh"));
		await symlink(join(base, "evil.sh"), join(root, "scripts/deploy.sh"));
		const r = await check(pin);
		expect(r.ok === false && r.code).toBe("symlink");
	});

	test("a parent directory swapped for a symlink refuses", async () => {
		const pin = await pinOf("./scripts/deploy.sh");
		await rename(join(root, "scripts"), join(base, "moved"));
		await symlink(join(base, "moved"), join(root, "scripts"));
		const r = await check(pin);
		expect(r.ok === false && r.code).toBe("symlink");
	});

	test("a permission change refuses", async () => {
		const pin = await pinOf("./scripts/deploy.sh");
		await chmod(join(root, "scripts/deploy.sh"), 0o700);
		const r = await check(pin);
		expect(r.ok === false && r.code).toBe("mode_changed");
	});

	test("a world-writable flip refuses", async () => {
		const pin = await pinOf("./scripts/deploy.sh");
		await chmod(join(root, "scripts/deploy.sh"), 0o757);
		const r = await check(pin);
		expect(r.ok === false && r.code).toBe("world_writable");
	});

	test("a deleted file refuses", async () => {
		const pin = await pinOf("./scripts/deploy.sh");
		await rm(join(root, "scripts/lib.sh"));
		const r = await check(pin);
		expect(r.ok === false && r.code).toBe("missing");
	});

	test("a FIFO in place of the script refuses without blocking", async () => {
		const pin = await pinOf("./scripts/deploy.sh");
		await rm(join(root, "scripts/deploy.sh"));
		await gitOk(["status", "--short"], root);
		Bun.spawnSync(["mkfifo", join(root, "scripts/deploy.sh")]);
		const r = await check(pin);
		expect(r.ok === false && r.code).toBe("not_regular");
	});

	test("a commit that changes the file refuses even with the old bytes on disk", async () => {
		const pin = await pinOf("./scripts/deploy.sh");
		const original = await Bun.file(join(root, "scripts/lib.sh")).text();
		await writeFile(join(root, "scripts/lib.sh"), "LIB=2\n");
		await commitAll();
		await writeFile(join(root, "scripts/lib.sh"), original);
		const r = await check(pin);
		expect(r.ok === false && r.code).toBe("tree_changed");
	});

	test("a changed interpreter refuses", async () => {
		const interp = join(base, "interp");
		await writeFile(interp, "#!/bin/sh\n", { mode: 0o755 });
		await writeFile(join(root, "scripts/x.sh"), `#!${interp}\n`, {
			mode: 0o755,
		});
		await commitAll();
		const pin = await pinOf("./scripts/x.sh");
		await writeFile(interp, "#!/bin/sh\nevil\n");
		const r = await check(pin);
		expect(r.ok === false && r.code).toBe("interpreter_changed");
	});

	test("a tool that moves into the repository refuses", async () => {
		const pin = await pinOf("true; ls");
		await writeFile(join(root, "ls"), "#!/bin/sh\n", { mode: 0o755 });
		const r = await verifyExecPin(pin, {
			root,
			pathVar: `${root}:${process.env.PATH}`,
		});
		expect(r.ok === false && r.code).toBe("tool_in_repo");
	});
});

describe("sealed execution", () => {
	test("a swap after verification still runs the verified bytes", async () => {
		await writeFile(
			join(root, "scripts/run.sh"),
			'#!/bin/sh\necho "ok:$0:$1"\n',
			{ mode: 0o755 },
		);
		await commitAll();
		const run = "./scripts/run.sh arg1";
		const pin = await pinOf(run);
		const verified = await verifyExecPin(pin, {
			root,
			afterVerify: async () => {
				// The TOCTOU attacker: rewrite in place, right after the hash.
				await writeFile(
					join(root, "scripts/run.sh"),
					`#!/bin/sh\ntouch "${canary}"\n`,
				);
			},
		});
		if (!verified.ok) throw new Error(verified.reason);
		const sealed = await sealShellEntry(
			run,
			verified.entry,
			pin,
			root,
			join(base, "seal"),
		);
		if (!sealed) throw new Error("expected a sealed exec");
		const r = await runProc(sealed.argv, {
			cwd: root,
			env: { PATH: process.env.PATH, ...sealed.env },
		});
		await sealed.dispose();
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe("ok:./scripts/run.sh:arg1");
		expect(existsSync(canary)).toBe(false);
	});

	test("the sealed copy is removed and private", async () => {
		await writeFile(join(root, "scripts/run.sh"), "#!/bin/sh\nexit 7\n", {
			mode: 0o755,
		});
		await commitAll();
		const pin = await pinOf("./scripts/run.sh");
		const verified = await verifyExecPin(pin, { root });
		if (!verified.ok) throw new Error(verified.reason);
		const sealed = await sealShellEntry(
			"./scripts/run.sh",
			verified.entry,
			pin,
			root,
			join(base, "seal"),
		);
		if (!sealed) throw new Error("expected a sealed exec");
		const file = sealed.env.MFW_SEALED_ENTRY as string;
		expect((await Bun.file(file).stat()).mode & 0o777).toBe(0o400);
		const r = await runProc(sealed.argv, {
			cwd: root,
			env: { PATH: process.env.PATH, ...sealed.env },
		});
		expect(r.exitCode).toBe(7);
		await sealed.dispose();
		expect(existsSync(file)).toBe(false);
	});

	test("a compound command is not sealed", async () => {
		const run = "./scripts/deploy.sh && true";
		const pin = await pinOf(run);
		const verified = await verifyExecPin(pin, { root });
		if (!verified.ok) throw new Error(verified.reason);
		expect(
			await sealShellEntry(run, verified.entry, pin, root, join(base, "seal")),
		).toBeNull();
	});
});
