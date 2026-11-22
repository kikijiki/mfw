import { open } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * Test-process-only durability switch-off, loaded by `bunfig.toml` for
 * `bun test` and by nothing in production.
 *
 * Nothing in a test pulls the plug, so the fsyncs that make the daemon's files
 * and database crash-safe buy nothing, yet on a journaled or encrypted disk
 * each costs 10-50 ms and they serialise across shards: a fixture that creates
 * a dozen tasks used to spend seconds waiting on the disk.
 *
 * 1. `writeFileAtomic` fsyncs the temp file and then its directory. Make
 *    `FileHandle.sync()` a no-op.
 * 2. libsql hands the connection to each transaction and opens a fresh one
 *    afterwards, which silently reverts the per-connection
 *    `PRAGMA synchronous=NORMAL` that `openDbAt` sets to FULL: every commit
 *    after the first fsyncs the WAL. Open every connection with `synchronous=OFF`.
 *    A test that asserts a store's FULL promise sets `sqliteSync.off = false`
 *    for its duration (`test/support/real-sqlite-sync.ts`).
 */
const flags = globalThis as { __mfwTestSqliteSync?: { off: boolean } };
const sqliteSync = flags.__mfwTestSqliteSync ?? { off: true };
flags.__mfwTestSqliteSync = sqliteSync;

const probe = await open("/dev/null", "r");
const handleProto = Object.getPrototypeOf(probe) as {
	sync: () => Promise<void>;
};
await probe.close();
handleProto.sync = async () => {};

const here = createRequire(
	join(import.meta.dir, "../packages/db/package.json"),
);
const clientDir = here.resolve("@libsql/client/package.json");
const libsqlPath = createRequire(clientDir).resolve("libsql");
const Database = createRequire(libsqlPath)(libsqlPath);
// A store that opens with its own `PRAGMA synchronous=FULL` (the host, resource
// and RunPod account stores do) would otherwise undo the default below.
const unsyncPragma = (sql: unknown): unknown =>
	sqliteSync.off && typeof sql === "string"
		? sql.replace(
				/\bpragma\s+synchronous\s*=\s*\w+/gi,
				"PRAGMA synchronous=OFF",
			)
		: sql;
class UndurableDatabase extends Database {
	exec(sql: unknown, ...rest: unknown[]) {
		return super.exec(unsyncPragma(sql), ...rest);
	}
	prepare(sql: unknown, ...rest: unknown[]) {
		return super.prepare(unsyncPragma(sql), ...rest);
	}
	constructor(...args: unknown[]) {
		super(...args);
		if (!sqliteSync.off) return;
		try {
			this.exec("PRAGMA synchronous=OFF");
		} catch {
			// A corrupt or foreign file: let the caller's own first statement
			// report it, as it would without this preload.
		}
	}
}
const cached = require.cache[libsqlPath];
if (cached) cached.exports = UndurableDatabase;

// The drivers wait a fixed 1.5 s after each turn for a late steer; scripted
// agents never send one, and the tests that exercise the window set their own.
const { driverTimings } = await import("../packages/daemon/src/agent-host.ts");
driverTimings.steerGraceMs = 100;
