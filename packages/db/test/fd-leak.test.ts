import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readlinkSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { openDbAt, splitStatements } from "../src/client.ts";

/**
 * Every `withTx` used to strand one libsql connection (the db file plus its
 * `-wal` and `-shm`) until the GC finalized it: the library hands its
 * connection to the transaction, and a transaction's `close()` only rolls
 * back. A long-lived daemon ran its descriptor count up with its write rate.
 * These tests count the descriptors the process holds on one database file,
 * with no GC in between.
 */

let dir = "";
beforeEach(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "mfw-fd-")));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** Descriptors of this process that point at a file of the database. */
function dbFds(path: string): number {
	let n = 0;
	for (const fd of readdirSync("/proc/self/fd")) {
		try {
			if (readlinkSync(`/proc/self/fd/${fd}`).startsWith(path)) n++;
		} catch {
			// the descriptor of the readdir itself, already closed
		}
	}
	return n;
}

describe("transactions do not leak connections", () => {
	test("descriptors stay flat across many transactions and drop to zero on close", async () => {
		const path = join(dir, "mfw.db");
		const h = await openDbAt(path);
		await h.withTx((tx) => tx.run(sql`create table if not exists t (n int)`));
		const afterOne = dbFds(path);
		for (let i = 0; i < 60; i++) {
			await h.withTx((tx) => tx.run(sql`insert into t values (${i})`));
		}
		// A few more only if a spare connection is kept; never one per transaction.
		expect(dbFds(path)).toBeLessThanOrEqual(afterOne + 3);
		// a rolled-back transaction frees its connection too
		for (let i = 0; i < 20; i++) {
			await h
				.withTx(async (tx) => {
					await tx.run(sql`insert into t values (-1)`);
					throw new Error("abort");
				})
				.catch(() => {});
		}
		expect(dbFds(path)).toBeLessThanOrEqual(afterOne + 3);
		const rows = await h.client.execute("select count(*) as c from t");
		expect(Number(rows.rows[0]?.c)).toBe(60);

		h.close();
		// libsql releases a closed connection's descriptors a little after
		// `close()` returns (even with no transaction ever run), and only once
		// the collector has run, so give it that, bounded. The count above is
		// the guard against a leak: it is taken with no collection at all.
		const deadline = Date.now() + 5_000;
		while (dbFds(path) > 0 && Date.now() < deadline) {
			Bun.gc(true);
			await Bun.sleep(20);
		}
		expect(dbFds(path)).toBe(0);
	});
});

describe("a transaction a caller only closes", () => {
	test("keeps its connection for the next one instead of closing it", async () => {
		const path = join(dir, "mfw.db");
		const h = await openDbAt(path);
		try {
			await h.client.execute("create table t (n int)");
			const first = await h.client.transaction("read");
			await first.execute("select 1");
			first.close();
			await Bun.sleep(10);
			const afterOne = dbFds(path);
			for (let i = 0; i < 60; i++) {
				const tx = await h.client.transaction("read");
				await tx.execute("select count(*) from t");
				tx.close();
			}
			await Bun.sleep(10);
			expect(dbFds(path)).toBeLessThanOrEqual(afterOne + 3);
		} finally {
			h.close();
		}
	});

	test("executeMultiple runs a script inside the transaction and rolls back with it", async () => {
		const h = await openDbAt(join(dir, "mfw.db"));
		try {
			const tx = await h.client.transaction("write");
			await tx.executeMultiple(
				"create table s (v text); insert into s values ('a;b'); insert into s values ('c');",
			);
			const rows = await tx.execute("select count(*) c from s");
			expect(Number(rows.rows[0]?.c)).toBe(2);
			await tx.rollback();
			tx.close();
			const left = await h.client.execute(
				"select name from sqlite_master where name='s'",
			);
			expect(left.rows).toHaveLength(0);
		} finally {
			h.close();
		}
	});
});

describe("splitStatements", () => {
	test("splits at semicolons outside quotes", () => {
		expect(splitStatements("a; b ;\n c 'x;y' ';' ; ")).toEqual([
			"a",
			"b",
			"c 'x;y' ';'",
		]);
	});

	test("refuses a comment or a trigger", () => {
		expect(() => splitStatements("select 1; -- note")).toThrow();
		expect(() =>
			splitStatements(
				"create trigger t before insert on x begin select 1; end",
			),
		).toThrow();
		expect(() =>
			splitStatements("insert into x values ('-- not a comment')"),
		).not.toThrow();
	});
});
