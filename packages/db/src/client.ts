import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Client, createClient, type Transaction } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { backfillLineage } from "./lineage-backfill.ts";
import * as schema from "./schema.ts";
import { backfillSpansFromEvents } from "./spans-backfill.ts";

export type ProjectDb = LibSQLDatabase<typeof schema>;
/** The transaction type accepted by every v2 mutation helper. */
export type ProjectDbTx = Parameters<
	Parameters<ProjectDb["transaction"]>[0]
>[0];

export interface ProjectDbHandle {
	db: ProjectDb;
	client: Client;
	close: () => void;
	/** Run `fn` in a serialized interactive transaction. libSQL cannot interleave them on one connection; single writer per project. */
	withTx: <T>(fn: (tx: ProjectDbTx) => Promise<T>) => Promise<T>;
}

/**
 * `import.meta.dir` alone cannot locate migrations: in a bundled build it points
 * at a chunk directory with no SQL. Try the co-located path, then walk up to the
 * source tree, with an explicit env override.
 */
const MIGRATIONS_FROM_ROOT = join("packages", "db", "migrations");

function findUp(start: string, rel: string): string | null {
	let dir = start;
	for (;;) {
		const candidate = join(dir, rel);
		if (existsSync(join(candidate, "meta", "_journal.json"))) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

let migrationsDirCache: string | null = null;

export function migrationsDir(): string {
	if (migrationsDirCache) return migrationsDirCache;

	const override = process.env.MFW_MIGRATIONS_DIR;
	if (override) {
		if (!existsSync(join(override, "meta", "_journal.json"))) {
			throw new Error(
				`MFW_MIGRATIONS_DIR="${override}" has no meta/_journal.json; unset it or point it at packages/db/migrations`,
			);
		}
		migrationsDirCache = override;
		return override;
	}

	// `import.meta.dir` is Bun-only; undefined under vite's SSR transform, where
	// `join(undefined, ...)` would throw before the fallbacks run.
	const here = typeof import.meta.dir === "string" ? import.meta.dir : null;
	if (here) {
		const colocated = join(here, "../../migrations");
		if (existsSync(join(colocated, "meta", "_journal.json"))) {
			migrationsDirCache = colocated;
			return colocated;
		}
	}

	for (const start of [here, process.cwd()].filter((s) => s !== null)) {
		const found = findUp(start, MIGRATIONS_FROM_ROOT);
		if (found) {
			migrationsDirCache = found;
			return found;
		}
	}

	throw new Error(
		`cannot locate ${MIGRATIONS_FROM_ROOT}: no parent of ` +
			`${here ?? "(import.meta.dir unavailable)"} or ${process.cwd()} ` +
			"contains it. Set MFW_MIGRATIONS_DIR to its absolute path.",
	);
}

/**
 * Open (or create) a project's DB at `<mfwDir>/mfw.db`: WAL, NORMAL sync,
 * enforced FKs, busy timeout, migrations applied first. A failed migration
 * throws so the project never runs on a wrong schema.
 */
export async function openProjectDb(mfwDir: string): Promise<ProjectDbHandle> {
	await mkdir(mfwDir, { recursive: true });
	return openDbAt(join(mfwDir, "mfw.db"));
}

/**
 * Connection-level pragmas. `journal_mode=WAL` persists in the file; the rest
 * belong to the connection and must be on every connection the client opens.
 */
const CONNECTION_PRAGMAS = [
	"PRAGMA synchronous=NORMAL;",
	"PRAGMA foreign_keys=ON;",
	"PRAGMA busy_timeout=5000;",
].join("\n");

/** What libsql's `Client.transaction` takes. */
type TxMode = "write" | "read" | "deferred";

const BEGIN: Record<TxMode, string> = {
	write: "BEGIN IMMEDIATE",
	read: "BEGIN TRANSACTION READONLY",
	deferred: "BEGIN DEFERRED",
};

/** Spare transaction connections kept open; withTx serializes, so one is the norm. */
const IDLE_TX_CONNECTIONS = 2;

/**
 * libsql's file client hands its connection to each `transaction()` and opens a
 * bare replacement lazily on next use (`reconnect()` does the same), dropping
 * every connection-level pragma: synchronous reverted to FULL, busy_timeout to
 * 0 (SQLITE_BUSY under contention) and foreign_keys to off. And the taken-over
 * connection is never closed: `Transaction.close()` only rolls back, so each
 * transaction stranded a native connection (the db file, `-wal` and `-shm`
 * descriptors) until the GC finalized it.
 *
 * So `transaction()` is not used on the library's client at all. A transaction
 * runs on a dedicated client of its own, opened with the pragmas, that stays
 * the owner of its one connection: `BEGIN` / `COMMIT` / `ROLLBACK` are plain
 * statements on it, and when the transaction ends the client goes back to a
 * small pool (or is closed, which closes the connection). The main client's
 * connection is never taken, so its pragmas hold without re-applying them.
 * `reconnect()` still replaces the connection and gets the pragmas again.
 */
function withConnectionPragmas(raw: Client, url: string): Client {
	const idle: Client[] = [];
	const open = new Set<Client>();
	let closed = false;

	const dedicated = async (): Promise<Client> => {
		const reused = idle.pop();
		if (reused) return reused;
		const c = createClient({ url });
		open.add(c);
		try {
			await c.executeMultiple(CONNECTION_PRAGMAS);
		} catch (e) {
			open.delete(c);
			c.close();
			throw e;
		}
		return c;
	};
	const release = (c: Client, clean: boolean) => {
		if (clean && !closed && idle.length < IDLE_TX_CONNECTIONS) {
			idle.push(c);
			return;
		}
		open.delete(c);
		c.close();
	};

	const begin = async (mode: TxMode = "write"): Promise<Transaction> => {
		if (closed) throw new Error("The client is closed");
		const conn = await dedicated();
		try {
			await conn.execute(BEGIN[mode]);
		} catch (e) {
			release(conn, false);
			throw e;
		}
		let done = false;
		const finish = async (stmt: "COMMIT" | "ROLLBACK") => {
			if (done) throw new Error("The transaction is closed");
			try {
				await conn.execute(stmt);
				done = true;
				release(conn, true);
			} catch (e) {
				// A failed COMMIT leaves the transaction open: end it, then drop the connection.
				done = true;
				await conn.execute("ROLLBACK").catch(() => {});
				release(conn, false);
				throw e;
			}
		};
		const live = () => {
			if (done) throw new Error("The transaction is closed");
			return conn;
		};
		return {
			get closed() {
				return done;
			},
			execute: (stmt) => live().execute(stmt),
			batch: async (stmts) => {
				const c = live();
				const out = [];
				for (const stmt of stmts) out.push(await c.execute(stmt));
				return out;
			},
			// libsql's own executeMultiple rolls back an open transaction when it ends.
			executeMultiple: () =>
				Promise.reject(
					new Error("executeMultiple is not available inside a transaction"),
				),
			rollback: async () => {
				if (!done) await finish("ROLLBACK");
			},
			commit: () => finish("COMMIT"),
			close: () => {
				if (done) return;
				done = true;
				// Rolls back with the connection; nothing to hand back to the pool.
				release(conn, false);
			},
		};
	};

	return new Proxy(raw, {
		get(target, prop) {
			if (prop === "transaction") return begin;
			if (prop === "close") {
				return () => {
					closed = true;
					for (const c of open) c.close();
					open.clear();
					idle.length = 0;
					target.close();
				};
			}
			if (prop === "reconnect") {
				return async () => {
					await target.reconnect();
					await target.executeMultiple(CONNECTION_PRAGMAS);
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** Test/backup entry: open a specific db file with the same setup. */
export async function openDbAt(dbPath: string): Promise<ProjectDbHandle> {
	await mkdir(dirname(dbPath), { recursive: true });
	const url = `file:${dbPath}`;
	const client = withConnectionPragmas(createClient({ url }), url);
	await client.executeMultiple(
		`PRAGMA journal_mode=WAL;\n${CONNECTION_PRAGMAS}`,
	);
	const db = drizzle(client, { schema });
	await migrate(db, { migrationsFolder: migrationsDir() });
	// Rows from before typed lineage get `relation`/`chain_root_id`; a no-op once filled.
	await backfillLineage(db);
	// Old events become spans once; afterwards `appendEvent` writes them live.
	await backfillSpansFromEvents(db);

	let queue: Promise<unknown> = Promise.resolve();
	const withTx = <T>(fn: (tx: ProjectDbTx) => Promise<T>): Promise<T> => {
		const next = queue.then(
			() => db.transaction(fn),
			() => db.transaction(fn), // a failed predecessor never blocks the queue
		);
		// The caller still gets the rejection via `next`; this only keeps the chain settled.
		queue = next.catch(() => {});
		return next;
	};

	return { db, client, close: () => client.close(), withTx };
}
