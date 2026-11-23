/**
 * The tables `host.db` held before the resource-core cutover. Nothing reads
 * them any more, so a daemon that just started would drop their limits on the
 * floor and could not see the leases of agents that survived the restart,
 * which can oversubscribe a GPU.
 *
 * Boot refuses while they hold rows nobody has acknowledged. The owner drains
 * runs and runs `mfw host acknowledge-legacy --yes`, which records exactly what
 * is being ignored. The data is never changed, so a rollback still has it; rows
 * that differ from the record are refused again.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { acquireDaemonLock } from "./daemon-lock.ts";

/** Holds state. `host_meta` and `host_schema_migrations` are bookkeeping. */
export const LEGACY_HOST_TABLES = [
	"projects",
	"resource_definitions",
	"resource_bindings",
	"waiters",
	"waiter_requirements",
	"leases",
	"lease_allocations",
	"observation_health",
	"observations",
	"audit",
	"host_incidents",
	"host_resource_holds",
] as const;

const ACK_TABLE = "mfw_legacy_host_ack";
/** For the doctor, which reads this table through its own read-only handle. */
export const LEGACY_ACK_TABLE = ACK_TABLE;
const ACK_COMMAND = "mfw host acknowledge-legacy --yes";

export type LegacyRows = Record<string, number>;

export type LegacyHostState =
	| { status: "none" }
	| { status: "acknowledged"; ignoredTables: LegacyRows };

export class LegacyHostStateRefusal extends Error {
	constructor(readonly rows: LegacyRows) {
		const list = Object.entries(rows)
			.map(([table, n]) => `${table} (${n} rows)`)
			.join(", ");
		super(
			`refusing to start: host.db holds state from before the resource-core upgrade that this version does not read: ${list}. Fix: drain all runs with the previous version, back up $MFW_HOME, re-enter any host resource limits after the upgrade, then run \`${ACK_COMMAND}\` to record that this data is ignored`,
		);
		this.name = "LegacyHostStateRefusal";
	}
}

const hostDbPath = (home: string) => join(home, "host", "host.db");

type Db = ReturnType<typeof createClient>;

async function tableExists(db: Db, name: string): Promise<boolean> {
	const r = await db.execute({
		sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
		args: [name],
	});
	return r.rows.length > 0;
}

async function legacyRows(db: Db): Promise<LegacyRows> {
	const rows: LegacyRows = {};
	for (const table of LEGACY_HOST_TABLES) {
		if (!(await tableExists(db, table))) continue;
		const r = await db.execute(`SELECT count(*) AS n FROM "${table}"`);
		const n = Number(r.rows[0]?.n ?? 0);
		if (n > 0) rows[table] = n;
	}
	return rows;
}

async function recordedRows(db: Db): Promise<LegacyRows | null> {
	if (!(await tableExists(db, ACK_TABLE))) return null;
	const r = await db.execute(
		`SELECT counts_json FROM ${ACK_TABLE} WHERE singleton=1`,
	);
	const json = r.rows[0]?.counts_json;
	return typeof json === "string" ? (JSON.parse(json) as LegacyRows) : null;
}

const canonical = (rows: LegacyRows) =>
	JSON.stringify(Object.entries(rows).sort(([a], [b]) => a.localeCompare(b)));

/** The rule boot applies: the record must name exactly the rows present. */
export const legacyRowsMatch = (recorded: LegacyRows, rows: LegacyRows) =>
	canonical(recorded) === canonical(rows);

/** What boot may ignore. Throws {@link LegacyHostStateRefusal} when unacknowledged. */
export async function checkLegacyHostState(
	home: string,
): Promise<LegacyHostState> {
	const path = hostDbPath(home);
	if (!existsSync(path)) return { status: "none" };
	const db = createClient({ url: `file:${path}` });
	try {
		const rows = await legacyRows(db);
		if (Object.keys(rows).length === 0) return { status: "none" };
		const recorded = await recordedRows(db);
		if (!recorded || canonical(recorded) !== canonical(rows)) {
			throw new LegacyHostStateRefusal(rows);
		}
		return { status: "acknowledged", ignoredTables: rows };
	} finally {
		db.close();
	}
}

/** Record the current legacy rows as deliberately ignored. Changes none of them. */
export async function acknowledgeLegacyHostState(
	home: string,
): Promise<LegacyRows> {
	const path = hostDbPath(home);
	if (!existsSync(path)) return {};
	const db = createClient({ url: `file:${path}` });
	try {
		const rows = await legacyRows(db);
		if (Object.keys(rows).length === 0) return rows;
		await db.batch(
			[
				`CREATE TABLE IF NOT EXISTS ${ACK_TABLE} (
					singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
					acknowledged_at INTEGER NOT NULL,
					counts_json TEXT NOT NULL
				)`,
				{
					sql: `INSERT INTO ${ACK_TABLE} (singleton, acknowledged_at, counts_json)
						VALUES (1, ?, ?)
						ON CONFLICT (singleton) DO UPDATE SET
							acknowledged_at = excluded.acknowledged_at,
							counts_json = excluded.counts_json`,
					args: [Date.now(), JSON.stringify(rows)],
				},
			],
			"write",
		);
		return rows;
	} finally {
		db.close();
	}
}

export const HOST_USAGE = [
	"usage: mfw host <command>",
	"",
	"  acknowledge-legacy --yes   record that host.db's pre-upgrade tables are ignored.",
	"                drain all runs and back up $MFW_HOME first; the server must be stopped",
].join("\n");

export interface HostCommandDeps {
	home: string;
	out: (line: string) => void;
	err: (line: string) => void;
}

/** `mfw host ...`. */
export async function runHostCommand(
	args: string[],
	d: HostCommandDeps,
): Promise<number> {
	const [command, ...rest] = args;
	if (command !== "acknowledge-legacy") {
		d.err(HOST_USAGE);
		return command === undefined ? 1 : 2;
	}
	if (rest.length !== 1 || rest[0] !== "--yes") {
		d.err(
			"mfw host: this makes the server ignore the legacy host state. Fix: drain all runs, back up $MFW_HOME, then pass --yes",
		);
		return 1;
	}
	let lock: Awaited<ReturnType<typeof acquireDaemonLock>>;
	try {
		lock = await acquireDaemonLock(d.home, {
			processBootId: `host-ack-${process.pid}`,
			timeoutMs: 500,
		});
	} catch {
		d.err("mfw host: the server is running. Fix: stop the server, then retry.");
		return 1;
	}
	try {
		const rows = await acknowledgeLegacyHostState(d.home);
		const entries = Object.entries(rows);
		if (entries.length === 0) {
			d.out("mfw host: no legacy host state to acknowledge");
			return 0;
		}
		d.out("mfw host: acknowledged; the server will ignore these rows:");
		for (const [table, n] of entries) d.out(`  ${table}: ${n}`);
		return 0;
	} finally {
		await lock.release();
	}
}
