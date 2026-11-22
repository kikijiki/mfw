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
 *    after the first fsyncs the WAL. Open every connection with `synchronous=OFF`,
 *    except the host store's `host.db`, which promises FULL.
 */
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
class UndurableDatabase extends Database {
	constructor(...args: unknown[]) {
		super(...args);
		// The host store promises FULL durability and its tests assert it.
		if (typeof args[0] === "string" && /(^|\/)host\.db$/.test(args[0])) return;
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
