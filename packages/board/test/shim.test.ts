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

const CLI = join(import.meta.dir, "../src/cli.ts");

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function run(args: string[], path?: string) {
	const p = Bun.spawn([process.execPath, "run", CLI, ...args], {
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

describe("mfwb shim", () => {
	test("installs an executable launcher once, and the launcher runs the CLI", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mfwb-shim-"));
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
		expect((await stat(join(target, "mfwb"))).mode & 0o111).not.toBe(0);
		const p = Bun.spawn([join(target, "mfwb"), "--help"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await p.exited).toBe(0);
		expect(await new Response(p.stdout).text()).toContain("usage: mfwb");
	});

	test("never overwrites a file it did not write, and notices a stale launcher", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mfwb-shim-"));
		dirs.push(dir);
		await writeFile(join(dir, "mfwb"), "#!/bin/sh\necho mine\n");
		const r = await run(["shim", "install", "--dir", dir]);
		expect(r.code).toBe(1);
		expect(await readFile(join(dir, "mfwb"), "utf8")).toContain("echo mine");
		await rm(join(dir, "mfwb"));
		await run(["shim", "install", "--dir", dir]);
		const text = await readFile(join(dir, "mfwb"), "utf8");
		await writeFile(join(dir, "mfwb"), text.replace("cli.ts", "gone.ts"));
		expect((await run(["shim", "status", "--dir", dir])).stdout).toContain(
			"outdated",
		);
		expect((await run(["shim", "install", "--dir", dir])).stdout).toContain(
			"installed",
		);
	});

	test("treats symlinks, directories and lookalikes as foreign", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mfwb-shim-"));
		dirs.push(dir);
		await symlink(join(dir, "nowhere"), join(dir, "mfwb")); // dangling
		expect((await run(["shim", "install", "--dir", dir])).code).toBe(1);
		await expect(stat(join(dir, "nowhere"))).rejects.toThrow();
		await rm(join(dir, "mfwb"));
		await mkdir(join(dir, "mfwb"));
		expect((await run(["shim", "install", "--dir", dir])).code).toBe(1);
		await rm(join(dir, "mfwb"), { recursive: true });
		await writeFile(
			join(dir, "mfwb"),
			"#!/bin/sh\n# mine\n# mfwb-shim (written by `mfwb shim install`)\n",
		);
		expect((await run(["shim", "status", "--dir", dir])).stdout).toContain(
			"foreign",
		);
		expect(
			(await run(["shim", "install", "--dir", dir, "--dry-run"])).code,
		).toBe(1);
	});

	test("usage errors, ~ in --dir, --json, and PATH matching", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mfwb-shim-"));
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
