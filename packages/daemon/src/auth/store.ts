import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { type Client, createClient } from "@libsql/client";

/**
 * The machine-wide auth database, `$MFW_HOME/auth.db`.
 *
 * It is separate from the per-project `mfw.db` because there is one owner per
 * install, not one per project, and a project database can be deleted or
 * rebuilt without signing anyone out. Deleting this file (with the server
 * stopped) is the documented password recovery: the next start is a first run.
 *
 * Secrets are never stored in the clear: the password is an argon2id hash, and
 * session and setup tokens are SHA-256 digests of 256-bit random values.
 *
 * Versioned with `PRAGMA user_version`, so its numbering is independent of the
 * project migrations.
 */
const MIGRATIONS: readonly (readonly string[])[] = [
	[
		`CREATE TABLE principals (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL CHECK (kind = 'owner'),
			display_name TEXT NOT NULL,
			password_hash TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		// Single owner for 1.0: the database itself refuses a second one.
		"CREATE UNIQUE INDEX uq_principals_owner ON principals (kind) WHERE kind = 'owner'",
		`CREATE TABLE auth_sessions (
			id TEXT PRIMARY KEY,
			token_hash TEXT NOT NULL UNIQUE,
			principal_id TEXT NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
			created_at INTEGER NOT NULL,
			last_seen_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			revoked_at INTEGER
		)`,
		"CREATE INDEX ix_auth_sessions_principal ON auth_sessions (principal_id, created_at)",
		`CREATE TABLE setup_tokens (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			token_hash TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL
		)`,
		`CREATE TABLE auth_throttle (
			scope TEXT PRIMARY KEY,
			failures INTEGER NOT NULL,
			locked_until INTEGER NOT NULL,
			last_failure_at INTEGER NOT NULL
		)`,
	],
];

export const AUTH_SCHEMA_VERSION = MIGRATIONS.length;

export interface AuthDb {
	client: Client;
	close: () => void;
}

/** Open (creating 0600 in a private directory if needed) and migrate. */
export async function openAuthDb(path: string): Promise<AuthDb> {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	// Create with the final mode first: SQLite's -wal and -shm copy this file's.
	closeSync(openSync(path, "a", 0o600));
	chmodSync(path, 0o600);
	const client = createClient({ url: `file:${path}` });
	try {
		await client.execute("PRAGMA journal_mode=WAL");
		await client.execute("PRAGMA foreign_keys=ON");
		await client.execute("PRAGMA busy_timeout=5000");
		const row = await client.execute("PRAGMA user_version");
		const current = Number(row.rows[0]?.user_version ?? 0);
		if (current > MIGRATIONS.length)
			throw new Error(
				`auth.db is at schema ${current}, newer than this build (${MIGRATIONS.length}); upgrade mfw`,
			);
		for (let v = current; v < MIGRATIONS.length; v++) {
			await client.batch(
				[
					...(MIGRATIONS[v] as readonly string[]),
					`PRAGMA user_version=${v + 1}`,
				],
				"write",
			);
		}
	} catch (e) {
		client.close();
		throw e;
	}
	return { client, close: () => client.close() };
}
