import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireKernelLock, KernelLockError } from "../src/kernel-lock.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("kernel lock", () => {
	test("excludes a separate process and releases without replacing or unlinking its inode", async () => {
		const root = await mkdtemp(join(tmpdir(), "mfw-kernel-lock-"));
		roots.push(root);
		const path = join(root, "owner.lock");
		const first = await acquireKernelLock(path, {
			metadata: { owner: "first" },
		});
		const inode = (await stat(path)).ino;

		const child = Bun.spawn(
			[
				"bun",
				"-e",
				`import { acquireKernelLock } from "./packages/daemon/src/kernel-lock.ts";
				 try { const lock = await acquireKernelLock(process.env.TEST_LOCK, {timeoutMs:250}); await lock.release(); process.exit(9); }
				 catch (error) { console.log(error.name + ":" + error.message); }`,
			],
			{
				cwd: process.cwd(),
				env: { ...process.env, TEST_LOCK: path },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const output = await new Response(child.stdout).text();
		expect(await child.exited).toBe(0);
		expect(output).toContain("KernelLockError");

		await first.release();
		expect((await stat(path)).ino).toBe(inode);
		const second = await acquireKernelLock(path, {
			metadata: { owner: "second" },
		});
		expect((await stat(path)).ino).toBe(inode);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			owner: "second",
		});
		await second.release();
		expect((await stat(path)).ino).toBe(inode);
	});

	test("reports fail-fast contention as a typed human error", async () => {
		const root = await mkdtemp(join(tmpdir(), "mfw-kernel-lock-error-"));
		roots.push(root);
		const path = join(root, "owner.lock");
		const first = await acquireKernelLock(path);
		try {
			await expect(
				acquireKernelLock(path, {
					busyMessage: "another deployment owns this output",
				}),
			).rejects.toMatchObject({
				name: KernelLockError.name,
				lockPath: path,
			});
			await expect(
				acquireKernelLock(path, {
					busyMessage: "another deployment owns this output",
				}),
			).rejects.toThrow("another deployment owns this output");
		} finally {
			await first.release();
		}
	});
});
