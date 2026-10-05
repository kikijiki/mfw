import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectDbHandle } from "./client.ts";
import { pruneEvents } from "./eventlog.ts";

/**
 * Nightly per-project maintenance:
 * consistent `VACUUM INTO` snapshot (keep the newest N) + event retention.
 * Scheduled by the engine's maintenance tick; both operations are safe to run
 * at any time and idempotent for a given day.
 */

const BACKUP_RE = /^mfw-(\d{4}-\d{2}-\d{2})\.db$/;

export async function backupDb(
	h: ProjectDbHandle,
	backupsDir: string,
	opts: { keep?: number; now?: Date } = {},
): Promise<{ path: string; pruned: string[] }> {
	const keep = opts.keep ?? 7;
	const day = (opts.now ?? new Date()).toISOString().slice(0, 10);
	await mkdir(backupsDir, { recursive: true });
	const path = join(backupsDir, `mfw-${day}.db`);
	// VACUUM INTO refuses to overwrite. Build beside the destination, then use
	// one atomic rename so a failed refresh never destroys today's last good
	// snapshot.
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await h.client.execute({ sql: "VACUUM INTO ?", args: [temp] });
		await rename(temp, path);
	} catch (e) {
		await rm(temp, { force: true }).catch(() => {});
		throw e;
	}

	const entries = (await readdir(backupsDir))
		.filter((f) => BACKUP_RE.test(f))
		.sort() // date-named → lexicographic == chronological
		.reverse();
	const stale = entries.slice(keep);
	for (const f of stale) await rm(join(backupsDir, f), { force: true });
	return { path, pruned: stale };
}

export async function runMaintenance(
	h: ProjectDbHandle,
	mfwDir: string,
	opts: { keepBackups?: number; now?: Date } = {},
): Promise<{
	backupPath: string;
	prunedBackups: string[];
	prunedEvents: number;
}> {
	const { path, pruned } = await backupDb(h, join(mfwDir, "backups"), {
		keep: opts.keepBackups,
		now: opts.now,
	});
	const prunedEvents = await pruneEvents(h.db);
	return { backupPath: path, prunedBackups: pruned, prunedEvents };
}
