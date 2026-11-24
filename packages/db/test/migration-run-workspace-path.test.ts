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
 * 0028: every run works in a private clone, so a run's path is its workspace
 * path, and the columns that told worktree runs apart (`workspace_kind`,
 * `approval_mode`) go.
 */

interface Entry {
	idx: number;
	version: string;
	when: number;
	tag: string;
	breakpoints: boolean;
}

const BEFORE = "0027_merge_verified_sha";
const CHANGE = "0028_run_workspace_path";
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

describe("0028 names the run's workspace path and drops the worktree-era columns", () => {
	test("it sorts after 0027", () => {
		const entries = journal().entries;
		const before = entries.find((e) => e.tag === BEFORE) as Entry;
		const change = entries.find((e) => e.tag === CHANGE) as Entry;
		expect(change.idx).toBe(before.idx + 1);
		expect(change.when).toBeGreaterThan(before.when);
	});

	test("its snapshot follows 0027 and changes only those columns", () => {
		const snapshot = (name: string) =>
			JSON.parse(
				readFileSync(
					join(migrationsDir(), "meta", `${name}_snapshot.json`),
					"utf8",
				),
			) as {
				id: string;
				prevId: string;
				tables: { runs: { columns: Record<string, { name: string }> } };
			};
		const before = snapshot("0027");
		const after = snapshot("0028");
		expect(after.prevId).toBe(before.id);
		const {
			worktree_path: old,
			workspace_kind: _kind,
			approval_mode: _mode,
			...kept
		} = before.tables.runs.columns;
		const { workspace_path: renamed, ...rest } = after.tables.runs.columns;
		expect(renamed).toEqual({ ...old, name: "workspace_path" } as never);
		expect(rest).toEqual(kept);
	});

	test("a database at 0027 upgrades and keeps each run's path", async () => {
		const root = mkdtempSync(join(tmpdir(), "mfw-migrate-workspace-"));
		dirs.push(root);
		const all = journal().entries;
		const upTo = all.slice(0, all.findIndex((e) => e.tag === BEFORE) + 1);
		const client = createClient({ url: `file:${join(root, "mfw.db")}` });
		clients.push(client);
		const db = drizzle(client);
		await migrate(db, { migrationsFolder: folder(root, "old", upTo) });
		await client.execute("PRAGMA foreign_keys = OFF");
		const columns = await client.execute("PRAGMA table_info(runs)");
		const required = columns.rows.filter(
			(c) => c.notnull === 1 && c.dflt_value === null,
		);
		const names = [
			...required.map((c) => String(c.name)),
			"worktree_path",
			"workspace_kind",
			"approval_mode",
		];
		await client.execute({
			sql: `INSERT INTO runs (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
			args: [
				...required.map((c) =>
					c.name === "id" ? "r1" : c.type === "integer" ? 1 : "[]",
				),
				"/ws/r1/tree",
				"clone",
				"interactive",
			],
		});
		await client.execute("PRAGMA foreign_keys = ON");

		await migrate(db, { migrationsFolder: folder(root, "new", all) });
		const rows = await client.execute(
			"SELECT id, workspace_path FROM runs WHERE id = 'r1'",
		);
		expect(rows.rows[0]?.workspace_path).toBe("/ws/r1/tree");
		const after = (await client.execute("PRAGMA table_info(runs)")).rows.map(
			(c) => String(c.name),
		);
		expect(after).not.toContain("worktree_path");
		expect(after).not.toContain("workspace_kind");
		expect(after).not.toContain("approval_mode");
		const check = await client.execute("PRAGMA foreign_key_check");
		expect(check.rows).toHaveLength(0);
		await migrate(db, { migrationsFolder: folder(root, "again", all) });
	});
});
