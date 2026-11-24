import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

/** One rule for every key the schema does not know, at any depth: refuse, name it, list what is valid. */

const homes: string[] = [];
afterEach(async () => {
	for (const h of homes.splice(0))
		await rm(h, { recursive: true, force: true });
});

async function load(config: unknown) {
	const home = await mkdtemp(join(tmpdir(), "mfw-config-strict-"));
	homes.push(home);
	await writeFile(join(home, "config.json"), JSON.stringify(config));
	return loadConfig(home);
}

describe("an unknown config key", () => {
	test("at the top level is refused with the valid keys", async () => {
		const refused = load({ projects: [], schedulerIntervalMS: 5 });
		await expect(refused).rejects.toThrow(
			"unknown config key schedulerIntervalMS",
		);
		await expect(refused).rejects.toThrow(/valid keys: .*schedulerIntervalMs/);
	});

	test("inside a project is refused with the project's valid keys", async () => {
		const refused = load({
			projects: [
				{ name: "ok", root: "/srv/ok" },
				{ name: "old", root: "/srv/old", agentIsolation: "none" },
			],
		});
		await expect(refused).rejects.toThrow(
			"unknown config key projects[1].agentIsolation",
		);
		await expect(refused).rejects.toThrow(/valid keys: .*\bmaxConcurrent\b/);
	});

	test("deeper down is refused by its full path", async () => {
		await expect(
			load({
				projects: [
					{ name: "w", root: "/srv/w", watchdog: { idleMs: 1, typo: 2 } },
				],
			}),
		).rejects.toThrow(
			/unknown config key projects\[0\]\.watchdog\.typo; valid keys: .*\bidleMs\b/,
		);
	});

	test("a config with only known keys loads", async () => {
		expect(
			(await load({ projects: [{ name: "ok", root: "/srv/ok" }] })).projects,
		).toHaveLength(1);
	});
});
