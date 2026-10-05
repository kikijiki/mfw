import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
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

/** Test/backup entry: open a specific db file with the same setup. */
export async function openDbAt(dbPath: string): Promise<ProjectDbHandle> {
	await mkdir(dirname(dbPath), { recursive: true });
	const client = createClient({ url: `file:${dbPath}` });
	await client.executeMultiple(
		[
			"PRAGMA journal_mode=WAL;",
			"PRAGMA synchronous=NORMAL;",
			"PRAGMA foreign_keys=ON;",
			"PRAGMA busy_timeout=5000;",
		].join("\n"),
	);
	const db = drizzle(client, { schema });
	await migrate(db, { migrationsFolder: migrationsDir() });

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
