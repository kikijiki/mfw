import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { and, eq, isNull, sql } from "drizzle-orm";
import { openProjectDb, type ProjectDbHandle } from "../src/client.ts";
import { deriveKey, KEY_RE, parseTaskNum, ULID_RE, ulid } from "../src/ids.ts";
import { engineKv, runSteps, runs } from "../src/schema.ts";

async function freshDb(): Promise<{ h: ProjectDbHandle; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "mfw-v2-"));
	const h = await openProjectDb(dir);
	return { h, dir };
}

async function cleanup(h: ProjectDbHandle, dir: string) {
	h.close();
	await rm(dir, { recursive: true, force: true });
}

describe("v2 client", () => {
	test("open applies migrations and is idempotent", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mfw-v2-"));
		const h1 = await openProjectDb(dir);
		h1.close();
		const h2 = await openProjectDb(dir); // re-open: migrations no-op
		const pragmas = await h2.client.execute("PRAGMA foreign_keys");
		expect(pragmas.rows[0]?.foreign_keys).toBe(1);
		const journal = await h2.client.execute("PRAGMA journal_mode");
		expect(String(journal.rows[0]?.journal_mode)).toBe("wal");
		await cleanup(h2, dir);
	});

	test("0004 preserves old runs and gives them a nullable reasoning effort", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mfw-v2-migration-"));
		const path = join(dir, "old.db");
		const client = createClient({ url: `file:${path}` });
		await client.executeMultiple(`
			CREATE TABLE runs (
				id text PRIMARY KEY NOT NULL,
				capabilities text NOT NULL
			);
			INSERT INTO runs (id, capabilities)
			VALUES ('old-run', '{"steer":true,"verified":true}');
		`);
		const migration = await readFile(
			join(import.meta.dir, "../migrations/0004_run-launch-metadata.sql"),
			"utf8",
		);
		await client.executeMultiple(migration);
		const row = await client.execute(
			"SELECT reasoning_effort, capabilities FROM runs WHERE id = 'old-run'",
		);
		expect(row.rows[0]?.reasoning_effort).toBeNull();
		expect(JSON.parse(String(row.rows[0]?.capabilities))).toEqual({
			steer: true,
			verified: true,
		});
		client.close();
		await rm(dir, { recursive: true, force: true });
	});

	test("0006 upgrades legacy runs as local targets and journals cleanup/absence", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mfw-target-migration-"));
		const path = join(dir, "old.db");
		const client = createClient({ url: `file:${path}` });
		await client.executeMultiple(`
			PRAGMA foreign_keys=ON;
			CREATE TABLE runs (
				id text PRIMARY KEY NOT NULL,
				state text NOT NULL
			);
			INSERT INTO runs (id, state) VALUES ('legacy-run', 'completed');
		`);
		const migration = await readFile(
			join(import.meta.dir, "../migrations/0006_execution-targets.sql"),
			"utf8",
		);
		await client.executeMultiple(migration);
		const row = await client.execute(
			"SELECT execution_target, target_requested_shape, target_lifecycle_state, target_lease_ref, target_execution_path FROM runs WHERE id = 'legacy-run'",
		);
		expect(row.rows[0]).toMatchObject({
			execution_target: "local",
			target_requested_shape: "{}",
			target_lifecycle_state: "legacy",
			target_lease_ref: null,
			target_execution_path: null,
		});

		await client.execute({
			sql: `INSERT INTO run_target_journal
				(operation_id, run_id, seq, target_kind, phase, status, lifecycle_state, detail, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			args: [
				"legacy-run/dispose/intent",
				"legacy-run",
				1,
				"local",
				"dispose",
				"intent",
				"disposing",
				JSON.stringify({ reason: "reconcile" }),
				Date.now(),
			],
		});
		expect(
			(
				await client.execute(
					"SELECT COUNT(*) AS count FROM run_target_journal WHERE run_id = 'legacy-run'",
				)
			).rows[0]?.count,
		).toBe(1);
		client.close();
		await rm(dir, { recursive: true, force: true });
	});
});

describe("ulid", () => {
	test("shape, ordering, uniqueness under same-ms pressure", () => {
		const ids = Array.from({ length: 2000 }, () => ulid());
		for (const id of ids) expect(id).toMatch(ULID_RE);
		const sorted = [...ids].sort();
		expect(sorted).toEqual(ids); // monotonic even within one millisecond
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("id grammar", () => {
	test("key derivation and validation", () => {
		expect(deriveKey("my-app2")).toBe("MYAPP2");
		expect(deriveKey("42things")).toBe("P42THINGS");
		expect(deriveKey("x")).toMatch(KEY_RE);
		expect(parseTaskNum("MFW", "MFW-42")).toBe(42);
		expect(parseTaskNum("MFW", "MFW-042")).toBeNull();
		expect(parseTaskNum("MFW", "MFW-2a")).toBeNull();
		expect(parseTaskNum("MFW", "MFW-ADR-2")).toBeNull();
	});
});

describe("run_steps journal", () => {
	test("UNIQUE(run_id, step): a step journals exactly once", async () => {
		const { h, dir } = await freshDb();
		const runId = ulid();
		await h.db.insert(runs).values({
			id: runId,
			kind: "task",
			label: "t",
			model: "sonnet",
			cwd: "/tmp",
			startedAt: new Date(),
		});
		await h.db.insert(runSteps).values({
			runId,
			step: "verify",
			seq: 1,
			status: "done",
			startedAt: new Date(),
		});
		await expect(
			(async () => {
				await h.db.insert(runSteps).values({
					runId,
					step: "verify",
					seq: 2,
					status: "running",
					startedAt: new Date(),
				});
			})(),
		).rejects.toThrow();
		await cleanup(h, dir);
	});

	test("single-flight finalize claim admits one owner", async () => {
		const { h, dir } = await freshDb();
		const runId = ulid();
		await h.db.insert(runs).values({
			id: runId,
			kind: "task",
			label: "t",
			model: "sonnet",
			cwd: "/tmp",
			state: "ended",
			startedAt: new Date(),
		});
		const claim = (bootId: string) =>
			h.db
				.update(runs)
				.set({ finalizeOwner: bootId, finalizeClaimedAt: new Date() })
				.where(and(eq(runs.id, runId), isNull(runs.finalizeOwner)))
				.returning({ id: runs.id });
		const results = await Promise.all(
			Array.from({ length: 6 }, (_, i) => claim(`boot-${i}`)),
		);
		expect(results.filter((r) => r.length > 0).length).toBe(1);
		await cleanup(h, dir);
	});
});

describe("engine_kv", () => {
	test("upsert keeps the furthest hold", async () => {
		const { h, dir } = await freshDb();
		const put = (until: number) =>
			h.db
				.insert(engineKv)
				.values({
					key: "dispatch_hold",
					value: { until, reason: "rate-limit" },
					updatedAt: new Date(),
				})
				.onConflictDoUpdate({
					target: engineKv.key,
					set: {
						value: sql`CASE
							WHEN json_extract(excluded.value,'$.until') > json_extract(${engineKv.value},'$.until')
							THEN excluded.value ELSE ${engineKv.value} END`,
						updatedAt: new Date(),
					},
				});
		await put(1000);
		await put(5000);
		await put(2000); // must not regress the hold
		const [row] = await h.db.select().from(engineKv);
		expect((row?.value as { until: number }).until).toBe(5000);
		await cleanup(h, dir);
	});
});

describe("event log v2", () => {
	test("typed transactional append + post-commit fan-out + since-cursor", async () => {
		const { h, dir } = await freshDb();
		const { appendEvent, EventBus, eventsSince, latestSeq } = await import(
			"../src/eventlog.ts"
		);
		const bus = new EventBus();
		const seen: string[] = [];
		bus.subscribe((e) => seen.push(e.type));

		const stored = await h.withTx(async (tx) => {
			// No task row is seeded on purpose: `events.task_id` is a loose
			// reference to a file on the board, not a foreign key.
			return appendEvent(tx, {
				type: "task.created",
				taskId: "MFW-7",
				payload: { source: "human", title: "t" },
			});
		});
		bus.publish([stored]);
		expect(seen).toEqual(["task.created"]);

		// schema drift throws at the write site
		await expect(
			h.withTx(async (tx) =>
				appendEvent(tx, {
					type: "task.created",
					taskId: "MFW-7",
					payload: { wrong: true },
				} as unknown as Parameters<typeof appendEvent>[1]),
			),
		).rejects.toThrow();

		const since = await eventsSince(h.db, 0);
		expect(since.length).toBe(1);
		expect(since[0]?.type).toBe("task.created");
		expect(await latestSeq(h.db)).toBe(since[0]?.seq ?? -1);
		await cleanup(h, dir);
	});
});
