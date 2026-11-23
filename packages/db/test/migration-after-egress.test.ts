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
 * Drizzle applies only journal entries newer than the last applied `when`, so
 * a database already at P6's 0023 receives 0024 only if 0024's stamp is later.
 */

interface Entry {
	idx: number;
	version: string;
	when: number;
	tag: string;
	breakpoints: boolean;
}

const EGRESS = "0023_run_egress";
const IMPORT = "0024_run_result_import";
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

/** A migrations folder holding these journal entries and their SQL. */
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

/** A database migrated through P6's 0023, holding one existing fact. */
async function atEgress() {
	const root = mkdtempSync(join(tmpdir(), "mfw-migrate-p6-"));
	dirs.push(root);
	const all = journal().entries;
	const upTo = all.slice(0, all.findIndex((e) => e.tag === EGRESS) + 1);
	const client = createClient({ url: `file:${join(root, "mfw.db")}` });
	clients.push(client);
	const db = drizzle(client);
	await migrate(db, { migrationsFolder: folder(root, "p6", upTo) });
	await client.execute(
		"INSERT INTO run_facts (run_id, fact, provenance, value, source, first_observed_at, observed_at) VALUES ('r1', 'report', 'sandbox-reported', '{}', 'report-file', 1, 1)",
	);
	const insertClaim = () =>
		client.execute(
			"INSERT INTO run_facts (run_id, fact, provenance, value, source, first_observed_at, observed_at) VALUES ('r1', 'wip_claim', 'sandbox-reported', '{}', 'outbox-wip-ack', 1, 1)",
		);
	return { root, all, client, db, insertClaim };
}

describe("the run-facts migration on a database already at P6", () => {
	test("is journaled after P6, with a later timestamp", () => {
		const entries = journal().entries;
		const egress = entries.find((e) => e.tag === EGRESS) as Entry;
		const result = entries.find((e) => e.tag === IMPORT) as Entry;
		expect(result.idx).toBe(egress.idx + 1);
		expect(result.when).toBeGreaterThan(egress.when);
	});

	test("the full journal applies it and keeps existing rows and P6's table", async () => {
		const d = await atEgress();
		await expect(d.insertClaim()).rejects.toThrow();
		await migrate(d.db, { migrationsFolder: migrationsDir() });
		await d.insertClaim();
		const facts = await d.client.execute(
			"SELECT fact FROM run_facts ORDER BY fact",
		);
		expect(facts.rows.map((r) => r.fact)).toEqual(["report", "wip_claim"]);
		const egress = await d.client.execute(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_egress'",
		);
		expect(egress.rows).toHaveLength(1);
		await expect(
			d.client.execute(
				"INSERT INTO run_facts (run_id, fact, provenance, value, source, first_observed_at, observed_at) VALUES ('r2', 'wip_claim', 'host-observed', '{}', 'finalize', 1, 1)",
			),
		).rejects.toThrow();
	});

	test("control: with a timestamp before P6's, drizzle would skip it", async () => {
		const d = await atEgress();
		const egress = d.all.find((e) => e.tag === EGRESS) as Entry;
		const stale = d.all.map((e) =>
			e.tag === IMPORT ? { ...e, when: egress.when - 1 } : e,
		);
		await migrate(d.db, {
			migrationsFolder: folder(d.root, "stale", stale),
		});
		await expect(d.insertClaim()).rejects.toThrow();
	});
});
