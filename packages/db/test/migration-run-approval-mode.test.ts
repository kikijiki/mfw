import { afterEach, describe, expect, test } from "bun:test";
import {
	copyFileSync,
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
 * Drizzle applies only entries newer than the last applied `when`, so a
 * database already at 0025 gets the column only if 0026 sorts later.
 */

interface Entry {
	idx: number;
	version: string;
	when: number;
	tag: string;
	breakpoints: boolean;
}

const BEFORE = "0025_drop_resource_slots";
const ADD = "0026_run_approval_mode";
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

describe("0026 adds the run's approval mode", () => {
	test("it sorts after 0025", () => {
		const entries = journal().entries;
		const before = entries.find((e) => e.tag === BEFORE) as Entry;
		const add = entries.find((e) => e.tag === ADD) as Entry;
		expect(add.idx).toBe(before.idx + 1);
		expect(add.when).toBeGreaterThan(before.when);
	});

	test("its snapshot follows 0025 and adds only the column", () => {
		const snapshot = (name: string) =>
			JSON.parse(
				readFileSync(
					join(migrationsDir(), "meta", `${name}_snapshot.json`),
					"utf8",
				),
			) as {
				id: string;
				prevId: string;
				tables: { runs: { columns: Record<string, unknown> } };
			};
		const before = snapshot("0025");
		const after = snapshot("0026");
		expect(after.prevId).toBe(before.id);
		const { approval_mode: added, ...kept } = after.tables.runs.columns;
		expect(added).toBeDefined();
		expect(kept).toEqual(before.tables.runs.columns);
	});

	test("a database at 0025 upgrades, keeps its runs and reads them as unset", async () => {
		const root = mkdtempSync(join(tmpdir(), "mfw-migrate-approval-"));
		dirs.push(root);
		const all = journal().entries;
		const upTo = all.slice(0, all.findIndex((e) => e.tag === BEFORE) + 1);
		const client = createClient({ url: `file:${join(root, "mfw.db")}` });
		clients.push(client);
		const db = drizzle(client);
		await migrate(db, { migrationsFolder: folder(root, "old", upTo) });
		await client.execute("PRAGMA foreign_keys = OFF");
		// Every required column, so the row survives whatever 0025 requires.
		const columns = await client.execute("PRAGMA table_info(runs)");
		const required = columns.rows.filter(
			(c) => c.notnull === 1 && c.dflt_value === null,
		);
		await client.execute({
			sql: `INSERT INTO runs (${required.map((c) => `"${c.name}"`).join(", ")}) VALUES (${required.map(() => "?").join(", ")})`,
			args: required.map((c) =>
				c.name === "id" ? "r1" : c.type === "integer" ? 1 : "[]",
			),
		});
		await client.execute("PRAGMA foreign_keys = ON");

		await migrate(db, { migrationsFolder: folder(root, "new", all) });
		const rows = await client.execute(
			"SELECT id, approval_mode FROM runs WHERE id = 'r1'",
		);
		expect(rows.rows).toHaveLength(1);
		expect(rows.rows[0]?.approval_mode).toBeNull();
		const check = await client.execute("PRAGMA foreign_key_check");
		expect(check.rows).toHaveLength(0);
		// Idempotent: a second start applies nothing.
		await migrate(db, { migrationsFolder: folder(root, "again", all) });
	});
});
