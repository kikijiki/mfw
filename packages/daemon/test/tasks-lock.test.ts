import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyedLock } from "../src/tasks/lock.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function lockDir(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "mfw-keyed-lock-"));
	roots.push(root);
	const dir = join(root, "locks");
	await mkdir(dir);
	return dir;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("KeyedLock", () => {
	test("acquires promptly over empty and malformed persistent lock files", async () => {
		const dir = await lockDir();
		await writeFile(join(dir, "MFW-1.lock"), "");
		await writeFile(join(dir, "MFW-2.lock"), "{not-json");
		const lock = new KeyedLock(dir, { timeoutMs: 250 });
		const entered: string[] = [];

		await lock.with("MFW-1", async () => {
			entered.push("empty");
		});
		await lock.with("MFW-2", async () => {
			entered.push("malformed");
		});

		expect(entered).toEqual(["empty", "malformed"]);
	});

	test("releases ownership when the owning process crashes", async () => {
		const dir = await lockDir();
		const ready = join(dir, "child-ready");
		const child = Bun.spawn(
			[
				"bun",
				"-e",
				`import { KeyedLock } from "./packages/daemon/src/tasks/lock.ts";
				 const lock = new KeyedLock(process.env.TEST_LOCK_DIR, { timeoutMs: 1000 });
				 await lock.with("MFW-1", async () => {
				   await Bun.write(process.env.TEST_READY, "ready");
				   await new Promise(() => {});
				 });`,
			],
			{
				cwd: process.cwd(),
				env: {
					...process.env,
					TEST_LOCK_DIR: dir,
					TEST_READY: ready,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		for (let attempts = 0; attempts < 100; attempts++) {
			if (
				await stat(ready)
					.then(() => true)
					.catch(() => false)
			)
				break;
			await Bun.sleep(10);
		}
		expect(
			await stat(ready)
				.then(() => true)
				.catch(() => false),
		).toBe(true);

		child.kill();
		await child.exited;
		let entered = false;
		await new KeyedLock(dir, { timeoutMs: 500 }).with("MFW-1", async () => {
			entered = true;
		});
		expect(entered).toBe(true);
	});

	test("times out without displacing a proven-live owner solely by age", async () => {
		const dir = await lockDir();
		const release = deferred();
		const entered = deferred();
		const owner = new KeyedLock(dir, { staleMs: 1, timeoutMs: 500 });
		const holding = owner.with("MFW-1", async () => {
			entered.resolve();
			await release.promise;
		});
		await entered.promise;
		await Bun.sleep(10);

		let contenderEntered = false;
		const started = performance.now();
		await expect(
			new KeyedLock(dir, { staleMs: 1, timeoutMs: 50 }).with(
				"MFW-1",
				async () => {
					contenderEntered = true;
				},
			),
		).rejects.toThrow("lock acquisition timed out");
		expect(performance.now() - started).toBeLessThan(500);
		expect(contenderEntered).toBe(false);

		release.resolve();
		await holding;
	});

	test("a former owner cannot unlink or release its successor", async () => {
		const dir = await lockDir();
		const releaseFirst = deferred();
		const firstEntered = deferred();
		const first = new KeyedLock(dir, { staleMs: 1, timeoutMs: 1_000 });
		const firstRun = first.with("MFW-1", async () => {
			firstEntered.resolve();
			await releaseFirst.promise;
		});
		await firstEntered.promise;
		await Bun.sleep(10);

		const releaseSecond = deferred();
		const secondEntered = deferred();
		const second = new KeyedLock(dir, { staleMs: 1, timeoutMs: 1_000 });
		const secondRun = second.with("MFW-1", async () => {
			secondEntered.resolve();
			await releaseSecond.promise;
		});
		// Give the old age-based implementation time to displace the first owner
		// before its callback completes; the kernel-backed implementation waits.
		await Bun.sleep(100);
		releaseFirst.resolve();
		await firstRun;
		await secondEntered.promise;

		await expect(stat(join(dir, "MFW-1.lock"))).resolves.toBeDefined();
		let thirdEntered = false;
		await expect(
			new KeyedLock(dir, { staleMs: 60_000, timeoutMs: 50 }).with(
				"MFW-1",
				async () => {
					thirdEntered = true;
				},
			),
		).rejects.toThrow("lock acquisition timed out");
		expect(thirdEntered).toBe(false);

		releaseSecond.resolve();
		await secondRun;
	});
});
