import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { boot } from "../src/boot.ts";
import { silentLogger } from "../src/log.ts";
import { acquireDaemonLock } from "../src/resources/daemon-lock.ts";
import {
	acknowledgeLegacyHostState,
	checkLegacyHostState,
	LegacyHostStateRefusal,
	runHostCommand,
} from "../src/resources/legacy-host-state.ts";

/** Wave 2 exit review, M3: an upgrade must not silently abandon host.db. */

let home: string;

async function seedLegacy(rows = 1) {
	mkdirSync(join(home, "host"), { recursive: true });
	const db = createClient({ url: `file:${join(home, "host", "host.db")}` });
	await db.execute(
		"CREATE TABLE IF NOT EXISTS resource_definitions (id TEXT PRIMARY KEY, capacity INTEGER)",
	);
	await db.execute(
		"CREATE TABLE IF NOT EXISTS host_meta (singleton INTEGER PRIMARY KEY)",
	);
	await db.execute("INSERT OR IGNORE INTO host_meta VALUES (1)");
	for (let i = 0; i < rows; i++) {
		await db.execute({
			sql: "INSERT INTO resource_definitions VALUES (?, 1)",
			args: [`gpu-${crypto.randomUUID()}`],
		});
	}
	db.close();
}

const bootHere = () =>
	boot({ projects: [], mfwHome: home, autostart: false, log: silentLogger() });

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "mfw-legacy-host-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("legacy host state", () => {
	test("a fresh home has nothing to acknowledge", async () => {
		expect(await checkLegacyHostState(home)).toEqual({ status: "none" });
	});

	test("bookkeeping rows alone are not state", async () => {
		await seedLegacy(0);
		expect(await checkLegacyHostState(home)).toEqual({ status: "none" });
	});

	test("boot refuses seeded legacy rows, names them and releases its lock", async () => {
		await seedLegacy(2);
		const refused = await bootHere().catch((e) => e);
		expect(refused).toBeInstanceOf(LegacyHostStateRefusal);
		expect(refused.message).toContain("resource_definitions (2 rows)");
		expect(refused.message).toContain("drain");
		expect(refused.message).toContain("mfw host acknowledge-legacy --yes");
		const lock = await acquireDaemonLock(home, {
			processBootId: "after-refusal",
			timeoutMs: 500,
		});
		await lock.release();
	});

	test("after the acknowledgement boot starts and logs what it ignores", async () => {
		await seedLegacy(2);
		await acknowledgeLegacyHostState(home);
		const warnings: { obj: unknown; msg: string }[] = [];
		const log = silentLogger();
		const warn = log.warn.bind(log);
		log.warn = ((obj: unknown, msg: string) => {
			warnings.push({ obj, msg });
			return warn(obj as never, msg as never);
		}) as typeof log.warn;
		const orchestrator = await boot({
			projects: [],
			mfwHome: home,
			autostart: false,
			log,
		});
		await orchestrator.shutdown();
		const logged = warnings.find((w) => w.msg.includes("legacy host"));
		expect(logged?.obj).toEqual({
			ignoredTables: { resource_definitions: 2 },
		});
	});

	test("rows that change after the acknowledgement are refused again", async () => {
		await seedLegacy(1);
		await acknowledgeLegacyHostState(home);
		expect((await checkLegacyHostState(home)).status).toBe("acknowledged");
		await seedLegacy(1);
		await expect(checkLegacyHostState(home)).rejects.toBeInstanceOf(
			LegacyHostStateRefusal,
		);
	});

	test("the command needs --yes and refuses while a server holds the lock", async () => {
		await seedLegacy(1);
		const out: string[] = [];
		const err: string[] = [];
		const d = {
			home,
			out: (l: string) => out.push(l),
			err: (l: string) => err.push(l),
		};
		expect(await runHostCommand(["acknowledge-legacy"], d)).toBe(1);
		expect((await checkLegacyHostState(home).catch((e) => e)).name).toBe(
			"LegacyHostStateRefusal",
		);
		const lock = await acquireDaemonLock(home, {
			processBootId: "a-server",
			timeoutMs: 500,
		});
		expect(await runHostCommand(["acknowledge-legacy", "--yes"], d)).toBe(1);
		expect(err.join("\n")).toContain("the server is running");
		await lock.release();
		expect(await runHostCommand(["acknowledge-legacy", "--yes"], d)).toBe(0);
		expect(out.join("\n")).toContain("resource_definitions: 1");
		expect((await checkLegacyHostState(home)).status).toBe("acknowledged");
	});
});
