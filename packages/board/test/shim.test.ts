import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardCliArgv } from "./support/cli-argv.ts";

const CLI = join(import.meta.dir, "../src/cli.ts");

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function run(args: string[], path?: string) {
	const p = Bun.spawn(boardCliArgv(CLI, args), {
		cwd: tmpdir(),
		env: { ...process.env, ...(path ? { PATH: path } : {}) },
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

describe("mfw-board shim", () => {
	test("installs an executable launcher once, and the launcher runs the CLI", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mfw-board-shim-"));
		dirs.push(dir);
		const target = join(dir, "bin dir 'q'"); // spaces and a quote in the path
		expect((await run(["shim", "status", "--dir", target])).stdout).toContain(
			"missing",
		);
		expect(
			(await run(["shim", "install", "--dir", target, "--dry-run"])).stdout,
		).toContain("would install");
		expect((await run(["shim", "status", "--dir", target])).stdout).toContain(
			"missing",
		);
		expect((await run(["shim", "install", "--dir", target])).stdout).toContain(
			"installed",
		);
		expect((await run(["shim", "install", "--dir", target])).stdout).toContain(
			"up-to-date",
		);
		expect((await stat(join(target, "mfw-board"))).mode & 0o111).not.toBe(0);
		const p = Bun.spawn([join(target, "mfw-board"), "--help"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await p.exited).toBe(0);
		expect(await new Response(p.stdout).text()).toContain("usage: mfw-board");
	});

	test("never overwrites a file it did not write, and notices a stale launcher", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mfw-board-shim-"));
		dirs.push(dir);
		await writeFile(join(dir, "mfw-board"), "#!/bin/sh\necho mine\n");
		const r = await run(["shim", "install", "--dir", dir]);
		expect(r.code).toBe(1);
		expect(await readFile(join(dir, "mfw-board"), "utf8")).toContain(
			"echo mine",
		);
		await rm(join(dir, "mfw-board"));
		await run(["shim", "install", "--dir", dir]);
		const text = await readFile(join(dir, "mfw-board"), "utf8");
		await writeFile(join(dir, "mfw-board"), text.replace("cli.ts", "gone.ts"));
		expect((await run(["shim", "status", "--dir", dir])).stdout).toContain(
			"outdated",
		);
		expect((await run(["shim", "install", "--dir", dir])).stdout).toContain(
			"installed",
		);
	});

	test("treats symlinks, directories and lookalikes as foreign", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mfw-board-shim-"));
		dirs.push(dir);
		await symlink(join(dir, "nowhere"), join(dir, "mfw-board")); // dangling
		expect((await run(["shim", "install", "--dir", dir])).code).toBe(1);
		await expect(stat(join(dir, "nowhere"))).rejects.toThrow();
		await rm(join(dir, "mfw-board"));
		await mkdir(join(dir, "mfw-board"));
		expect((await run(["shim", "install", "--dir", dir])).code).toBe(1);
		await rm(join(dir, "mfw-board"), { recursive: true });
		await writeFile(
			join(dir, "mfw-board"),
			"#!/bin/sh\n# mine\n# mfw-board-shim (written by `mfw-board shim install`)\n",
		);
		expect((await run(["shim", "status", "--dir", dir])).stdout).toContain(
			"foreign",
		);
		expect(
			(await run(["shim", "install", "--dir", dir, "--dry-run"])).code,
		).toBe(1);
	});

	test("usage errors, ~ in --dir, --json, and PATH matching", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mfw-board-shim-"));
		dirs.push(dir);
		expect((await run(["shim"])).code).toBe(2);
		expect((await run(["shim", "install", "extra"])).code).toBe(2);
		expect(
			(await run(["shim", "install", "--dir", "~/bin", "--dry-run"])).code,
		).toBe(2);
		const onPath = await run(
			["shim", "status", "--dir", dir, "--json"],
			`/usr/bin:${dir}/:`,
		);
		expect(JSON.parse(onPath.stdout)).toMatchObject({
			state: "missing",
			onPath: true,
		});
		const off = await run(["shim", "install", "--dir", dir], "/usr/bin");
		expect(off.stderr).toContain("not on PATH");
	});
});
