import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, mutateConfig } from "../src/config.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("boardRoot: the board can live outside the code repo", () => {
	test("a project's boardRoot round-trips through save/load", async () => {
		const home = await mkdtemp(join(tmpdir(), "mfw-config-boardroot-"));
		try {
			await mutateConfig(home, (config) => {
				config.projects.push({
					name: "app",
					root: "/home/user/dev/app",
					boardRoot: "/home/user/docs/projects/app",
				});
			});
			const loaded = await loadConfig(home);
			expect(loaded.projects[0]?.boardRoot).toBe(
				"/home/user/docs/projects/app",
			);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("boardRoot is optional and omitted stays undefined", async () => {
		const home = await mkdtemp(join(tmpdir(), "mfw-config-boardroot-"));
		try {
			await mutateConfig(home, (config) => {
				config.projects.push({ name: "mfw", root: "/home/user/dev/mfw" });
			});
			const loaded = await loadConfig(home);
			expect(loaded.projects[0]?.boardRoot).toBeUndefined();
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("config mutation serialization", () => {
	test("an unreadable existing config aborts mutation without replacement", async () => {
		const home = await mkdtemp(join(tmpdir(), "mfw-config-unreadable-"));
		try {
			await mutateConfig(home, (config) => {
				config.projects.push({ name: "must-survive", root: "/tmp/original" });
			});
			const path = join(home, "config.json");
			const before = await readFile(path, "utf8");
			await chmod(path, 0o000);
			await expect(
				mutateConfig(home, (config) => {
					config.projects.push({ name: "must-not-appear", root: "/tmp/new" });
				}),
			).rejects.toMatchObject({ code: "EACCES" });
			await chmod(path, 0o600);
			expect(await readFile(path, "utf8")).toBe(before);
			expect((await loadConfig(home)).projects.map((p) => p.name)).toEqual([
				"must-survive",
			]);
		} finally {
			await chmod(join(home, "config.json"), 0o600).catch(() => {});
			await rm(home, { recursive: true, force: true });
		}
	});

	test("a queued mutation reads the preceding commit and cannot lose it", async () => {
		const home = await mkdtemp(join(tmpdir(), "mfw-config-race-"));
		const entered = deferred();
		const release = deferred();
		let secondEntered = false;
		try {
			const first = mutateConfig(home, async (config) => {
				config.dispatchPaused = true;
				entered.resolve();
				await release.promise;
			});
			await entered.promise;

			const second = mutateConfig(home, (config) => {
				secondEntered = true;
				expect(config.dispatchPaused).toBe(true);
				config.schedulerIntervalMs = 1234;
			});
			// The second callback cannot even read until the first write commits.
			await Promise.resolve();
			expect(secondEntered).toBe(false);

			release.resolve();
			await Promise.all([first, second]);
			expect(await loadConfig(home)).toMatchObject({
				dispatchPaused: true,
				schedulerIntervalMs: 1234,
			});
		} finally {
			release.resolve();
			await rm(home, { recursive: true, force: true });
		}
	});

	test("different MFW homes have independent mutation queues", async () => {
		const firstHome = await mkdtemp(join(tmpdir(), "mfw-config-home-a-"));
		const secondHome = await mkdtemp(join(tmpdir(), "mfw-config-home-b-"));
		const entered = deferred();
		const release = deferred();
		try {
			const blocked = mutateConfig(firstHome, async () => {
				entered.resolve();
				await release.promise;
			});
			await entered.promise;
			await mutateConfig(secondHome, (config) => {
				config.dispatchPaused = true;
			});
			expect((await loadConfig(secondHome)).dispatchPaused).toBe(true);
			release.resolve();
			await blocked;
		} finally {
			release.resolve();
			await Promise.all([
				rm(firstHome, { recursive: true, force: true }),
				rm(secondHome, { recursive: true, force: true }),
			]);
		}
	});
});
