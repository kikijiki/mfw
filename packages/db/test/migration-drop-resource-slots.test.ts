import { afterEach, describe, expect, test } from "bun:test";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { migrationsDir } from "../src/client.ts";

/**
 * The resource core replaced project `resource_slots`. Drizzle applies only
 * entries newer than the last applied `when`, so a project database already at
 * the latest integration migration receives the drop only if it sorts later.
 */

interface Entry {
	idx: number;
	version: string;
	when: number;
	tag: string;
	breakpoints: boolean;
}

const BEFORE = "0024_run_result_import";
const DROP = "0025_drop_resource_slots";
const dirs: string[] = [];
const clients: Client[] = [];

afterEach(() => {
	for (const c of clients.splice(0)) c.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const journal = () =>
	JSON.parse(
		readFileSync(join(migrationsDir(), "meta/_journal.json"), "utf8"),
	) as { version: string; dialect: string; entries: Entry[] };

function folder(root: string, name: string, entries: Entry[]): string {
	const dir = join(root, name);
	mkdirSync(join(dir, "meta"), { recursive: true });
	for (const e of entries) {
		copyFileSync(
			join(migrationsDir(), `${e.tag}.sql`),
			join(dir, `${e.tag}.sql`),
		);
	}
	writeFileSync(
		join(dir, "meta/_journal.json"),
		JSON.stringify({ ...journal(), entries }),
	);
	return dir;
}

async function hasTable(client: Client, name: string): Promise<boolean> {
	const found = await client.execute({
		sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
		args: [name],
	});
	return found.rows.length === 1;
}

/** A project database at the latest integration migration, with data. */
async function atLatestIntegration() {
	const root = mkdtempSync(join(tmpdir(), "mfw-migrate-slots-"));
	dirs.push(root);
	const all = journal().entries;
	const upTo = all.slice(0, all.findIndex((e) => e.tag === BEFORE) + 1);
	const client = createClient({ url: `file:${join(root, "mfw.db")}` });
	clients.push(client);
	const db = drizzle(client);
	await migrate(db, { migrationsFolder: folder(root, "integ", upTo) });
	await client.execute(
		"INSERT INTO run_facts (run_id, fact, provenance, value, source, first_observed_at, observed_at) VALUES ('r1', 'report', 'sandbox-reported', '{}', 'report-file', 1, 1)",
	);
	await client.execute("PRAGMA foreign_keys = OFF");
	await client.execute(
		"INSERT INTO resource_slots (resource_id, slot, run_id, locked_at) VALUES ('gpu', 0, 'r1', 1)",
	);
	await client.execute("PRAGMA foreign_keys = ON");
	return { root, all, client, db };
}

describe("dropping resource_slots from the project database", () => {
	test("follows its predecessor, with a later timestamp", () => {
		const entries = journal().entries;
		const before = entries.find((e) => e.tag === BEFORE) as Entry;
		const drop = entries.find((e) => e.tag === DROP) as Entry;
		expect(drop.idx).toBe(before.idx + 1);
		expect(drop.when).toBeGreaterThan(before.when);
		// Later migrations may follow it; none may sort before it.
		for (const e of entries.slice(drop.idx + 1)) {
			expect(e.when).toBeGreaterThan(drop.when);
		}
	});

	test("every journal entry is ordered, unique and has its SQL", () => {
		const entries = journal().entries;
		expect(new Set(entries.map((e) => e.tag)).size).toBe(entries.length);
		for (const [index, entry] of entries.entries()) {
			expect(entry.idx).toBe(index);
			expect(existsSync(join(migrationsDir(), `${entry.tag}.sql`))).toBe(true);
			if (index > 0) {
				expect(entry.when).toBeGreaterThan((entries[index - 1] as Entry).when);
			}
		}
	});

	test("its snapshot follows the previous one and lacks only the table", () => {
		const snapshot = (name: string) =>
			JSON.parse(
				readFileSync(
					join(migrationsDir(), "meta", `${name}_snapshot.json`),
					"utf8",
				),
			) as { id: string; prevId: string; tables: Record<string, unknown> };
		const before = snapshot("0024");
		const after = snapshot("0025");
		expect(after.prevId).toBe(before.id);
		expect(after.id).not.toBe(before.id);
		const { resource_slots: dropped, ...kept } = before.tables;
		expect(dropped).toBeDefined();
		expect(after.tables).toEqual(kept);
	});

	test("the full journal applies it to a database at the latest integration migration", async () => {
		const d = await atLatestIntegration();
		expect(await hasTable(d.client, "resource_slots")).toBe(true);
		await migrate(d.db, { migrationsFolder: migrationsDir() });
		expect(await hasTable(d.client, "resource_slots")).toBe(false);
		for (const table of ["resources", "runs", "run_egress", "run_facts"]) {
			expect(await hasTable(d.client, table)).toBe(true);
		}
		const facts = await d.client.execute("SELECT run_id FROM run_facts");
		expect(facts.rows.map((r) => r.run_id)).toEqual(["r1"]);
		// Applying it again is a no-op.
		await migrate(d.db, { migrationsFolder: migrationsDir() });
		expect(await hasTable(d.client, "resource_slots")).toBe(false);
	});

	test("control: with a timestamp before the latest, drizzle would skip it", async () => {
		const d = await atLatestIntegration();
		const before = d.all.find((e) => e.tag === BEFORE) as Entry;
		const stale = d.all.map((e) =>
			e.tag === DROP ? { ...e, when: before.when - 1 } : e,
		);
		await migrate(d.db, { migrationsFolder: folder(d.root, "stale", stale) });
		expect(await hasTable(d.client, "resource_slots")).toBe(true);
	});
});
