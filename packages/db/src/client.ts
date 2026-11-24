import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Client, createClient, type Transaction } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import {
	sourceMigrationsDir,
	withVerifiedMigrations,
} from "./migration-source.ts";
import * as schema from "./schema.ts";

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

/** The source tree's migrations. A production build never reads these. */
export function migrationsDir(): string {
	return sourceMigrationsDir(import.meta.url);
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

/**
 * Split a schema script into statements at the semicolons outside single
 * quotes. Only for plain DDL and DML: a comment or a trigger body holds
 * semicolons that are not statement ends, so such a script is refused rather
 * than run in pieces.
 */
export function splitStatements(script: string): string[] {
	if (/--|\/\*|\btrigger\b/i.test(script.replace(/'(?:[^']|'')*'/g, "''"))) {
		throw new Error(
			"a script with a comment or a trigger cannot run inside a transaction",
		);
	}
	const out: string[] = [];
	let current = "";
	let quoted = false;
	for (const ch of script) {
		if (ch === "'") quoted = !quoted;
		if (ch === ";" && !quoted) {
			if (current.trim()) out.push(current.trim());
			current = "";
		} else {
			current += ch;
		}
	}
	if (current.trim()) out.push(current.trim());
	return out;
}

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
	return pooledTransactions(raw, {
		open: () => createClient({ url }),
		pragmas: CONNECTION_PRAGMAS,
	});
}

export interface PooledTransactionsOptions {
	/** A new client on the same database, with the same options as `raw`. */
	open: () => Client;
	/** Connection-level pragmas, applied to each dedicated client and on `reconnect()`. */
	pragmas: string;
}

/**
 * Wrap `raw` so `transaction()` runs on a dedicated, pooled client and never
 * takes over (and strands) the main connection; see {@link withConnectionPragmas}
 * for why. Every store that opens its own libsql client uses this, so none
 * leaks a connection per transaction.
 */
export function pooledTransactions(
	raw: Client,
	options: PooledTransactionsOptions,
): Client {
	const { pragmas } = options;
	const idle: Client[] = [];
	const open = new Set<Client>();
	let closed = false;

	const dedicated = async (): Promise<Client> => {
		const reused = idle.pop();
		if (reused) return reused;
		const c = options.open();
		open.add(c);
		try {
			await c.executeMultiple(pragmas);
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
			// libsql's own executeMultiple rolls back an open transaction when it
			// ends, so a script runs statement by statement instead.
			executeMultiple: async (script) => {
				const c = live();
				for (const stmt of splitStatements(script)) await c.execute(stmt);
			},
			rollback: async () => {
				if (!done) await finish("ROLLBACK");
			},
			commit: () => finish("COMMIT"),
			close: () => {
				if (done) return;
				done = true;
				// A read-only caller only closes. End the transaction and keep the
				// connection: closing a libsql connection frees its descriptors only
				// when the collector runs, so a close per read would strand them.
				conn.execute("ROLLBACK").then(
					() => release(conn, true),
					() => release(conn, false),
				);
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
					await target.executeMultiple(pragmas);
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
	await withVerifiedMigrations(import.meta.url, (migrationsFolder) =>
		migrate(db, { migrationsFolder }),
	);

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
