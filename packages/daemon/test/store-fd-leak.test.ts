import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readlinkSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { openAuthDb } from "../src/auth/store.ts";
import { openResourceStore } from "../src/resources/store.ts";
import type { PoolDefinition } from "../src/resources/types.ts";
import { RunPodAccountStore } from "../src/runpod-account-store.ts";

/**
 * libsql hands its connection to each `client.transaction()` and never closes
 * it (a transaction's `close()` only rolls back), so a store using it directly
 * held two or three descriptors per transaction until the GC finalized them.
 * The stores open their client through the shared pooled helper
 * (`@mfw/db/client`). These tests count the descriptors the process holds on
 * each store's database with no collection in between.
 */

let home = "";
beforeEach(async () => {
	home = await realpath(await mkdtemp(join(tmpdir(), "mfw-store-fd-")));
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

/** Descriptors of this process that point at a file of the database. */
function dbFds(prefix: string): number {
	let n = 0;
	for (const fd of readdirSync("/proc/self/fd")) {
		try {
			if (readlinkSync(`/proc/self/fd/${fd}`).startsWith(prefix)) n++;
		} catch {
			// the descriptor of the readdir itself, already closed
		}
	}
	return n;
}

/** A few spare connections may be kept; never one per transaction. */
const SLACK = 3;

/** Run `n` committed and `n` rolled-back transactions on the store's own client. */
async function churn(client: Client, n: number): Promise<void> {
	for (let i = 0; i < n; i++) {
		const tx = await client.transaction("write");
		await tx.execute("select 1");
		await tx.commit();
		tx.close();
	}
	for (let i = 0; i < n; i++) {
		const tx = await client.transaction("read");
		await tx.execute("select 1");
		await tx.rollback();
		tx.close();
	}
}

const CPU: PoolDefinition = {
	id: "local.cpu",
	title: "CPU",
	dimensions: [{ kind: "quantity", name: "permits", unit: "permit", total: 4 }],
};

describe("stores do not strand a connection per transaction", () => {
	test("the resource store", async () => {
		const store = await openResourceStore(home);
		try {
			await store.definePool(CPU);
			const path = join(home, "host", "host.db");
			const baseline = dbFds(path);
			for (let i = 0; i < 40; i++) {
				// writes (writeNow) and the read transactions
				await store.definePool({ ...CPU, title: `CPU ${i}` });
				await store.summaries();
				await store.readLedger();
				await store.readHostConfig();
			}
			expect(dbFds(path)).toBeLessThanOrEqual(baseline + SLACK);
		} finally {
			store.close();
		}
	});

	test("the auth store", async () => {
		const db = await openAuthDb(join(home, "auth.db"));
		try {
			await churn(db.client, 1);
			const baseline = dbFds(join(home, "auth.db"));
			await churn(db.client, 40);
			expect(dbFds(join(home, "auth.db"))).toBeLessThanOrEqual(
				baseline + SLACK,
			);
			// The store's own statements still run on the main connection.
			const row = await db.client.execute("PRAGMA foreign_keys");
			expect(Object.values(row.rows[0] ?? {})[0]).toBe(1);
		} finally {
			db.close();
		}
	});

	test("the RunPod account store", async () => {
		const store = await RunPodAccountStore.open(home, "acct-1");
		try {
			const client = (store as unknown as { client: Client }).client;
			const path = RunPodAccountStore.path(home, "acct-1");
			await churn(client, 1);
			const baseline = dbFds(path);
			await churn(client, 40);
			expect(dbFds(path)).toBeLessThanOrEqual(baseline + SLACK);
		} finally {
			store.close();
		}
	});
});
