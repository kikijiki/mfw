import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDbAt, openProjectDb } from "../src/client.ts";
import { ulid } from "../src/ids.ts";
import { backupDb, runMaintenance } from "../src/maintenance.ts";
import { runs } from "../src/schema.ts";

describe("v2 maintenance", () => {
	test("VACUUM INTO produces an openable, consistent snapshot", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mfw-maint-"));
		const h = await openProjectDb(dir);
		await h.db.insert(runs).values({
			id: ulid(),
			kind: "task",
			label: "snapshot me",
			model: "sonnet",
			cwd: dir,
			startedAt: new Date(),
		});

		const { path } = await backupDb(h, join(dir, "backups"));
		const snap = await openDbAt(path); // migrations no-op on a snapshot
		const rows = await snap.db.select({ label: runs.label }).from(runs);
		expect(rows).toEqual([{ label: "snapshot me" }]);
		snap.close();
		h.close();
		await rm(dir, { recursive: true, force: true });
	});

	test("keeps only the newest N backups; same-day rerun is idempotent", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mfw-maint-"));
		const h = await openProjectDb(dir);
		const backups = join(dir, "backups");
		// simulate 9 old dated snapshots
		await rm(backups, { recursive: true, force: true });
		await (await import("node:fs/promises")).mkdir(backups, {
			recursive: true,
		});
		for (let d = 1; d <= 9; d++) {
			await writeFile(
				join(backups, `mfw-2026-07-0${d}.db`),
				"old snapshot stub",
			);
		}
		await backupDb(h, backups, { keep: 7, now: new Date("2026-08-09") });
		await backupDb(h, backups, { keep: 7, now: new Date("2026-08-09") }); // rerun same day
		const files = (await readdir(backups)).sort();
		expect(files.length).toBe(7);
		expect(files.at(-1)).toBe("mfw-2026-08-09.db");
		expect(files[0]).toBe("mfw-2026-07-04.db"); // oldest three pruned
		h.close();
		await rm(dir, { recursive: true, force: true });
	});

	test("runMaintenance returns a coherent report", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mfw-maint-"));
		const h = await openProjectDb(dir);
		const report = await runMaintenance(h, dir);
		expect(report.backupPath.endsWith(".db")).toBe(true);
		expect(report.prunedEvents).toBe(0);
		h.close();
		await rm(dir, { recursive: true, force: true });
	});
});
