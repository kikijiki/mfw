import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { pooledTransactions } from "@mfw/db/client";

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
 * One schema, stamped in `PRAGMA user_version`. There is no upgrade path
 * between development versions: a file at any other version is refused, and
 * the fix is to delete it (the same recovery as above).
 */
const SCHEMA: readonly string[] = [
	// `credential_epoch` is bumped whenever existing credentials stop being
	// valid; see `issue`.
	`CREATE TABLE principals (
		id TEXT PRIMARY KEY,
		kind TEXT NOT NULL CHECK (kind = 'owner'),
		display_name TEXT NOT NULL,
		password_hash TEXT NOT NULL,
		credential_epoch INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	)`,
	// Single owner for 1.0: the database itself refuses a second one.
	"CREATE UNIQUE INDEX uq_principals_owner ON principals (kind) WHERE kind = 'owner'",
	// `passkey_id` is the passkey a session signed in with, so revoking it ends
	// that session.
	`CREATE TABLE auth_sessions (
		id TEXT PRIMARY KEY,
		token_hash TEXT NOT NULL UNIQUE,
		request_key_hash TEXT NOT NULL DEFAULT '',
		principal_id TEXT NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
		passkey_id TEXT,
		created_at INTEGER NOT NULL,
		last_seen_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL,
		revoked_at INTEGER
	)`,
	"CREATE INDEX ix_auth_sessions_principal ON auth_sessions (principal_id, created_at)",
	"CREATE INDEX ix_auth_sessions_passkey ON auth_sessions (passkey_id) WHERE passkey_id IS NOT NULL",
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
	// Scoped tokens for non-browser clients: a digest only, see `auth/tokens.ts`.
	// A token minted by a session dies with the passkey that session signed in with.
	`CREATE TABLE api_tokens (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		token_hash TEXT NOT NULL UNIQUE,
		principal_id TEXT NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
		scopes TEXT NOT NULL,
		project TEXT,
		created_by_session TEXT,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL,
		last_used_at INTEGER,
		revoked_at INTEGER
	)`,
	"CREATE INDEX ix_api_tokens_live ON api_tokens (revoked_at, expires_at)",
	"CREATE INDEX ix_api_tokens_session ON api_tokens (created_by_session) WHERE created_by_session IS NOT NULL",
	// No foreign key: the record of what a token did outlives the token.
	`CREATE TABLE token_audit (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		token_id TEXT NOT NULL,
		token_name TEXT NOT NULL,
		path TEXT NOT NULL,
		project TEXT,
		outcome TEXT NOT NULL,
		kind TEXT NOT NULL DEFAULT 'mutation',
		at INTEGER NOT NULL
	)`,
	"CREATE INDEX ix_token_audit_token ON token_audit (token_id, id)",
	"CREATE INDEX ix_token_audit_kind ON token_audit (token_id, kind, id)",
	// Refusals are a counter, so they can never push out a real action.
	`CREATE TABLE token_audit_counters (
		token_id TEXT PRIMARY KEY,
		token_name TEXT NOT NULL,
		refused INTEGER NOT NULL DEFAULT 0,
		last_refused_at INTEGER,
		last_refused_path TEXT,
		dropped INTEGER NOT NULL DEFAULT 0
	)`,
	// WebAuthn credentials: a public key only (the COSE key, base64url, as
	// `@simplewebauthn/server` verifies with it), see `auth/webauthn.ts`.
	// Deleted by sign-out-everywhere and, by default, a password change. A
	// passkey shows who added it.
	`CREATE TABLE passkeys (
		id TEXT PRIMARY KEY,
		principal_id TEXT NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
		credential_id TEXT NOT NULL UNIQUE,
		public_key TEXT NOT NULL,
		alg INTEGER NOT NULL,
		rp_id TEXT NOT NULL,
		name TEXT NOT NULL,
		sign_count INTEGER NOT NULL DEFAULT 0,
		discoverable INTEGER,
		backup_eligible INTEGER NOT NULL DEFAULT 0,
		backed_up INTEGER NOT NULL DEFAULT 0,
		transports TEXT NOT NULL DEFAULT '[]',
		created_by_session TEXT,
		created_from TEXT,
		created_at INTEGER NOT NULL,
		last_used_at INTEGER
	)`,
	"CREATE INDEX ix_passkeys_rp ON passkeys (rp_id)",
	// Passkey additions and revocations, shown to every other session until
	// THAT session acknowledges them: no session can dismiss them for another.
	`CREATE TABLE passkey_notices (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		kind TEXT NOT NULL CHECK (kind IN ('added', 'revoked')),
		passkey_id TEXT NOT NULL,
		name TEXT NOT NULL,
		rp_id TEXT NOT NULL,
		source TEXT,
		session_id TEXT,
		at INTEGER NOT NULL
	)`,
	`CREATE TABLE passkey_notice_acks (
		notice_id INTEGER NOT NULL REFERENCES passkey_notices (id) ON DELETE CASCADE,
		session_id TEXT NOT NULL,
		PRIMARY KEY (notice_id, session_id)
	)`,
];

/**
 * The stamp of {@link SCHEMA}: the number the last development schema had, so
 * a file already at this schema opens and one from any earlier build is refused.
 */
export const AUTH_SCHEMA_VERSION = 7;

/** What every connection of auth.db needs; `journal_mode` persists in the file. */
const AUTH_CONNECTION_PRAGMAS =
	"PRAGMA foreign_keys=ON;\nPRAGMA busy_timeout=5000;";

export interface AuthDb {
	client: Client;
	close: () => void;
}

/** Open (creating 0600 in a private directory if needed), with the schema on first use. */
export async function openAuthDb(path: string): Promise<AuthDb> {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	// Create with the final mode first: SQLite's -wal and -shm copy this file's.
	closeSync(openSync(path, "a", 0o600));
	chmodSync(path, 0o600);
	const url = `file:${path}`;
	const client = pooledTransactions(createClient({ url }), {
		open: () => createClient({ url }),
		pragmas: AUTH_CONNECTION_PRAGMAS,
	});
	try {
		await client.execute("PRAGMA journal_mode=WAL");
		await client.execute("PRAGMA foreign_keys=ON");
		await client.execute("PRAGMA busy_timeout=5000");
		const row = await client.execute("PRAGMA user_version");
		const current = Number(row.rows[0]?.user_version ?? 0);
		const tables = await client.execute(
			"SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'",
		);
		if (current === 0 && Number(tables.rows[0]?.n ?? 0) === 0) {
			await client.batch(
				[...SCHEMA, `PRAGMA user_version=${AUTH_SCHEMA_VERSION}`],
				"write",
			);
		} else if (current !== AUTH_SCHEMA_VERSION) {
			throw new Error(
				`${path} is at schema ${current}, not this build's ${AUTH_SCHEMA_VERSION}, and there is no upgrade between development versions. Fix: stop the server, delete ${path}, and run \`mfw auth reset --yes\``,
			);
		}
	} catch (e) {
		client.close();
		throw e;
	}
	return { client, close: () => client.close() };
}
