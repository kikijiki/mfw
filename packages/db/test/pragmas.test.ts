import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { openDbAt, type ProjectDbHandle } from "../src/client.ts";

// The test preload forces `synchronous=OFF` on every connection (see
// tools/test-preload.ts). These tests assert the real setting, so they opt in.
const sqliteSync = (globalThis as { __mfwTestSqliteSync?: { off: boolean } })
	.__mfwTestSqliteSync;
let wasOff = true;

let dir: string;
const handles: ProjectDbHandle[] = [];

beforeEach(async () => {
	wasOff = sqliteSync?.off ?? true;
	if (sqliteSync) sqliteSync.off = false;
	dir = await mkdtemp(join(tmpdir(), "mfw-pragmas-"));
});

afterEach(async () => {
	for (const h of handles.splice(0)) h.close();
	if (sqliteSync) sqliteSync.off = wasOff;
	await rm(dir, { recursive: true, force: true });
});

async function open(name = "mfw.db"): Promise<ProjectDbHandle> {
	const h = await openDbAt(join(dir, name));
	handles.push(h);
	return h;
}

async function pragmas(h: ProjectDbHandle): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = {};
	for (const p of [
		"journal_mode",
		"synchronous",
		"foreign_keys",
		"busy_timeout",
	]) {
		const r = await h.client.execute(`PRAGMA ${p}`);
		out[p] = Object.values(r.rows[0] ?? {})[0] ?? r.rows[0]?.[0];
	}
	return out;
}

const INTENDED = {
	journal_mode: "wal",
	synchronous: 1, // NORMAL
	foreign_keys: 1,
	busy_timeout: 5000,
};

describe("openDbAt connection pragmas", () => {
	test("a freshly opened handle has the intended pragmas", async () => {
		expect(await pragmas(await open())).toEqual(INTENDED);
	});

	test("pragmas survive several transactions (libsql reconnects after each)", async () => {
		const h = await open();
		for (let i = 0; i < 4; i++) {
			await h.withTx(async (tx) => {
				await tx.run(sql`SELECT ${i}`);
			});
			expect(await pragmas(h)).toEqual(INTENDED);
		}
		// raw client transactions reconnect too
		const t = await h.client.transaction("write");
		await t.commit();
		expect(await pragmas(h)).toEqual(INTENDED);
	});

	test("pragmas hold inside a later transaction", async () => {
		const h = await open();
		await h.withTx(async () => {});
		await h.withTx(async (tx) => {
			const sync = await tx.all<{ synchronous: number }>(
				sql`PRAGMA synchronous`,
			);
			const fk = await tx.all<{ foreign_keys: number }>(
				sql`PRAGMA foreign_keys`,
			);
			expect(sync[0]?.synchronous).toBe(1);
			expect(fk[0]?.foreign_keys).toBe(1);
		});
	});

	test("pragmas survive an explicit reconnect", async () => {
		const h = await open();
		await h.client.reconnect();
		expect(await pragmas(h)).toEqual(INTENDED);
	});

	// SQLite's busy wait blocks the calling thread, so contention needs a second
	// process: a lock holder in the same one could never release.
	const CLIENT = join(import.meta.dir, "../src/client.ts");

	async function child(
		script: string,
	): Promise<Bun.Subprocess<"ignore", "pipe", "pipe">> {
		return Bun.spawn([process.execPath, "-e", script], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, DB_PATH: join(dir, "mfw.db"), CLIENT },
		});
	}

	test("a writer waits for another process's lock instead of failing busy after reconnecting", async () => {
		const b = await open();
		await b.withTx(async () => {}); // b now runs on a replacement connection
		const holder = await child(`
			const { openDbAt } = await import(process.env.CLIENT);
			const h = await openDbAt(process.env.DB_PATH);
			await h.withTx(async () => {
				console.log("locked");
				await Bun.sleep(400);
			});
			h.close();
		`);
		const reader = holder.stdout.getReader();
		await reader.read(); // "locked"
		const started = Date.now();
		await b.withTx(async (tx) => {
			await tx.run(sql`CREATE TABLE IF NOT EXISTS contended (n INTEGER)`);
		});
		expect(Date.now() - started).toBeGreaterThan(100);
		expect(await holder.exited).toBe(0);
	});

	test("concurrent writer processes all commit with the intended pragmas", async () => {
		const first = await open();
		await first.withTx(async (tx) => {
			await tx.run(sql`CREATE TABLE IF NOT EXISTS hits (n INTEGER)`);
		});
		const procs = await Promise.all(
			[0, 1, 2].map((i) =>
				child(`
					const { openDbAt } = await import(process.env.CLIENT);
					const { sql } = await import("drizzle-orm");
					const h = await openDbAt(process.env.DB_PATH);
					for (let j = 0; j < 10; j++)
						await h.withTx(async (tx) => { await tx.run(sql\`INSERT INTO hits (n) VALUES (\${${i} * 100 + j})\`); });
					const r = await h.client.execute("PRAGMA synchronous");
					console.log("sync=" + Object.values(r.rows[0])[0]);
					h.close();
				`),
			),
		);
		for (const p of procs) {
			const [out, err] = await Promise.all([
				new Response(p.stdout).text(),
				new Response(p.stderr).text(),
			]);
			expect(await p.exited, err).toBe(0);
			expect(out).toContain("sync=2".replace("2", "1"));
		}
		const rows = await first.client.execute("SELECT count(*) AS c FROM hits");
		expect(Number(rows.rows[0]?.c)).toBe(30);
	});
});
