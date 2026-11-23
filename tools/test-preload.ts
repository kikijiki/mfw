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
 * 2. Open every libsql connection with `synchronous=OFF`, and rewrite any
 *    `PRAGMA synchronous=...` to OFF (`openDbAt` re-applies NORMAL on every
 *    replacement connection libsql opens after a transaction). A test that
 *    asserts a store's FULL/NORMAL promise sets `sqliteSync.off = false` for
 *    its duration (`test/support/real-sqlite-sync.ts`).
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

// `agent-host.ts` reads `MFW_TMUX_SOCKET` once, at module load, and the import
// below is that load: it happens before any test file's own socket import can
// run. Without a private socket here a lone `bun test <file>` would have the
// daemon launch into the default `mfw` socket (the running service's) while the
// test looks at another one. `bun run test` sets the variable for every shard;
// this makes a lone file equally self-contained, and reaps the server on exit.
const ambientSocket = process.env.MFW_TMUX_SOCKET;
if (!ambientSocket || ambientSocket === "mfw") {
	const own = `mfw-test-preload-${process.pid}`;
	process.env.MFW_TMUX_SOCKET = own;
	process.on("exit", () => {
		try {
			Bun.spawnSync(["tmux", "-L", own, "kill-server"], {
				stdout: "ignore",
				stderr: "ignore",
			});
		} catch {
			// no tmux on this machine: nothing was launched either
		}
	});
}

// The drivers wait a fixed 1.5 s after each turn for a late steer; scripted
// agents never send one, and the tests that exercise the window set their own.
const { driverTimings } = await import("../packages/daemon/src/agent-host.ts");
driverTimings.steerGraceMs = 100;
