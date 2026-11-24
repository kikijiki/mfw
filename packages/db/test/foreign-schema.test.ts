import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { openDbAt } from "../src/client.ts";

/** No migration path between development versions: another version's mfw.db is refused, never read. */

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "mfw-foreign-schema-"));
	dirs.push(dir);
	return join(dir, "mfw.db");
}

describe("a project database from another development version", () => {
	test("is refused with the fix, whatever its recorded migrations", async () => {
		const path = dbPath();
		const raw = createClient({ url: `file:${path}` });
		await raw.executeMultiple(`
			CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric);
			INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('old', 1786230235114);
			INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('newer', 9999999999999);
		`);
		raw.close();
		const refused = openDbAt(path);
		await expect(refused).rejects.toThrow(
			"was written by another development version of mfw",
		);
		await expect(openDbAt(path)).rejects.toThrow(`delete ${path}`);
	});

	test("a database this version created opens again", async () => {
		const path = dbPath();
		(await openDbAt(path)).close();
		const again = await openDbAt(path);
		again.close();
	});
});
