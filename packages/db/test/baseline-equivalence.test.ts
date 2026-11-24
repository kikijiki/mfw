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
import { dumpSchema } from "./support/schema-dump.ts";

/**
 * The project database's migration chain (0000-0028) was squashed into one
 * baseline. The fixture is the final schema that chain built, as SQLite held
 * it; the baseline must build exactly that schema, so the squash lost nothing.
 */
const GOLDEN = join(import.meta.dir, "fixtures/schema-before-baseline.sql");

const clients: Client[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const c of clients.splice(0)) c.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fresh(name: string): Client {
	const dir = mkdtempSync(join(tmpdir(), "mfw-baseline-"));
	dirs.push(dir);
	const client = createClient({ url: `file:${join(dir, `${name}.db`)}` });
	clients.push(client);
	return client;
}

async function fromGolden(): Promise<Client> {
	const client = fresh("before");
	const statements = readFileSync(GOLDEN, "utf8")
		.split("--> statement-breakpoint")
		.map((s) => s.trim())
		.filter(Boolean);
	for (const statement of statements) await client.execute(statement);
	return client;
}

/** The journal cut to its first entry, so later migrations never change what this proves. */
function baselineOnly(): string {
	const dir = mkdtempSync(join(tmpdir(), "mfw-baseline-migrations-"));
	dirs.push(dir);
	const source = migrationsDir();
	const journal = JSON.parse(
		readFileSync(join(source, "meta/_journal.json"), "utf8"),
	) as { entries: { tag: string }[] };
	const [first] = journal.entries;
	expect(first?.tag).toBe("0000_baseline");
	mkdirSync(join(dir, "meta"));
	writeFileSync(
		join(dir, "meta/_journal.json"),
		JSON.stringify({ ...journal, entries: [first] }),
	);
	copyFileSync(
		join(source, "0000_baseline.sql"),
		join(dir, "0000_baseline.sql"),
	);
	return dir;
}

async function fromBaseline(): Promise<Client> {
	const client = fresh("after");
	await migrate(drizzle(client), { migrationsFolder: baselineOnly() });
	return client;
}

describe("the baseline migration", () => {
	test("builds the schema the old migration chain built", async () => {
		const before = await dumpSchema(await fromGolden());
		const after = await dumpSchema(await fromBaseline());
		expect(Object.keys(after.tables)).toHaveLength(30);
		expect(Object.keys(after.triggers)).toHaveLength(6);
		expect(after.pragmas).toEqual(before.pragmas);
		expect(after.tables).toEqual(before.tables);
		expect(after.indexes).toEqual(before.indexes);
		expect(after.triggers).toEqual(before.triggers);
		expect(after.views).toEqual(before.views);
	});

	// The comparison would prove nothing if it could not see a difference.
	test.each([
		["a dropped trigger", "DROP TRIGGER sandbox_attestations_no_update"],
		["a dropped index", "DROP INDEX ix_trigger_deliveries_state"],
		["an added column", "ALTER TABLE runs ADD COLUMN extra text"],
		[
			"an added table with a CHECK",
			"CREATE TABLE extra (a integer CHECK (a > 0))",
		],
	])("sees %s", async (_, change) => {
		const baseline = await fromBaseline();
		const reference = await dumpSchema(baseline);
		await baseline.execute(change);
		expect(await dumpSchema(baseline)).not.toEqual(reference);
	});

	test("keeps attestations append-only", async () => {
		const db = await fromBaseline();
		await db.execute(
			"INSERT INTO sandbox_attestation_uses (attestation_id, run_id, used_at) VALUES ('a', 'r', 1)",
		);
		await expect(
			db.execute("DELETE FROM sandbox_attestation_uses"),
		).rejects.toThrow(/append-only/);
		await expect(
			db.execute(
				"INSERT OR REPLACE INTO sandbox_attestation_uses (attestation_id, run_id, used_at) VALUES ('a', 'r', 2)",
			),
		).rejects.toThrow(/append-only/);
	});
});
