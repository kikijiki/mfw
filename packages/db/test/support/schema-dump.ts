import type { Client } from "@libsql/client";

/**
 * A database's schema in a form that two databases built different ways can be
 * compared by: every table's columns (sorted by name, since a column added by
 * `ALTER TABLE` lands last), foreign keys, CHECK constraints and options, every
 * index's keys, uniqueness, origin and WHERE clause, every trigger and view, and
 * the file-level pragmas. Statement text is compared only with whitespace and
 * identifier quoting normalized.
 *
 * Drizzle's own `__drizzle_migrations` bookkeeping is left out.
 */
export interface SchemaDump {
	pragmas: Record<string, unknown>;
	tables: Record<string, unknown>;
	indexes: Record<string, unknown>;
	triggers: Record<string, string>;
	views: Record<string, string>;
}

const SKIP = new Set(["__drizzle_migrations", "sqlite_sequence"]);
const PRAGMAS = [
	"user_version",
	"application_id",
	"auto_vacuum",
	"encoding",
	"page_size",
] as const;

/** Whitespace collapsed, identifier quotes (`x`, "x", [x]) dropped, keywords lower-cased. */
export function normalizeSql(sql: string): string {
	return sql
		.replace(/[`"[\]]/g, "")
		.replace(/\s+/g, " ")
		.replace(/\s*([(),])\s*/g, "$1")
		.trim()
		.toLowerCase();
}

/** The CHECK constraints of a CREATE TABLE statement, normalized and sorted. */
function checksOf(createSql: string): string[] {
	const sql = normalizeSql(createSql);
	const out: string[] = [];
	let at = sql.indexOf("check(");
	while (at >= 0) {
		const named = /constraint ([a-z0-9_]+) $/.exec(sql.slice(0, at));
		let depth = 0;
		let end = at + "check".length;
		for (; end < sql.length; end++) {
			if (sql[end] === "(") depth++;
			if (sql[end] === ")" && --depth === 0) break;
		}
		out.push(`${named ? `${named[1]}: ` : ""}${sql.slice(at, end + 1)}`);
		at = sql.indexOf("check(", end);
	}
	return out.sort();
}

async function rows(client: Client, sql: string) {
	return (await client.execute(sql)).rows.map(
		(r) => ({ ...r }) as Record<string, unknown>,
	);
}

const q = (name: string) => `"${name.replaceAll('"', '""')}"`;

export async function dumpSchema(client: Client): Promise<SchemaDump> {
	const pragmas: Record<string, unknown> = {};
	for (const p of PRAGMAS) {
		const [row] = await rows(client, `PRAGMA ${p}`);
		pragmas[p] = row ? Object.values(row)[0] : null;
	}
	const master = (await rows(
		client,
		"SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
	)) as unknown as {
		type: string;
		name: string;
		tbl_name: string;
		sql: string | null;
	}[];
	const tables: Record<string, unknown> = {};
	const indexes: Record<string, unknown> = {};
	const triggers: Record<string, string> = {};
	const views: Record<string, string> = {};
	const tableList = await rows(client, "PRAGMA table_list");
	for (const entry of master) {
		if (SKIP.has(entry.name) || SKIP.has(entry.tbl_name)) continue;
		if (entry.type === "table") {
			const columns = (await rows(
				client,
				`PRAGMA table_xinfo(${q(entry.name)})`,
			)) as { name: string; cid?: unknown }[];
			const options = tableList.find((t) => t.name === entry.name);
			tables[entry.name] = {
				columns: columns
					.map(({ cid: _cid, ...c }) => c)
					.sort((a, b) => a.name.localeCompare(b.name)),
				foreignKeys: (
					await rows(client, `PRAGMA foreign_key_list(${q(entry.name)})`)
				)
					.map(({ id: _id, ...fk }) => JSON.stringify(fk))
					.sort(),
				checks: checksOf(entry.sql ?? ""),
				strict: options?.strict ?? null,
				withoutRowid: options?.wr ?? null,
				autoincrement: /\bautoincrement\b/i.test(entry.sql ?? ""),
			};
			for (const index of await rows(
				client,
				`PRAGMA index_list(${q(entry.name)})`,
			)) {
				const name = String(index.name);
				const sql = master.find(
					(m) => m.type === "index" && m.name === name,
				)?.sql;
				indexes[name] = {
					table: entry.name,
					unique: index.unique,
					origin: index.origin,
					partial: index.partial,
					keys: (await rows(client, `PRAGMA index_xinfo(${q(name)})`)).map(
						({ cid: _cid, ...k }) => k,
					),
					where: sql
						? (/ where (.*)$/.exec(normalizeSql(sql))?.[1] ?? null)
						: null,
				};
			}
		} else if (entry.type === "trigger" && entry.sql) {
			triggers[entry.name] = normalizeSql(entry.sql);
		} else if (entry.type === "view" && entry.sql) {
			views[entry.name] = normalizeSql(entry.sql);
		}
	}
	return { pragmas, tables, indexes, triggers, views };
}
