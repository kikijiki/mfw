import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import {
	migrationsDir,
	openDbAt,
	openProjectDb,
	type ProjectDbHandle,
} from "../src/client.ts";
import { deriveKey, KEY_RE, parseTaskNum, ULID_RE, ulid } from "../src/ids.ts";
import {
	backfillAttemptOutcomes,
	backfillAttemptOutcomesOnce,
	listAttemptOutcomes,
	OUTCOMES_BACKFILL_KEY,
	outcomePrior,
	recordAttemptOutcome,
	summarizeOutcomes,
	summarizeReviewers,
} from "../src/outcomes.ts";
import {
	engineKv,
	mergeJobs,
	reviewVerdicts,
	runSteps,
	runs,
	taskAttemptOutcomes,
} from "../src/schema.ts";

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

	test("0009 applies on a 0008 database: old rows read NULL outcome facts", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mfw-0009-"));
		// A migrations folder that stops at 0008, so the DB is exactly what a
		// pre-outcomes daemon would have left behind.
		const old = join(dir, "migrations-0008");
		await cp(migrationsDir(), old, { recursive: true });
		await rm(join(old, "0009_outcomes.sql"));
		const journalPath = join(old, "meta", "_journal.json");
		const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
			entries: { idx: number }[];
		};
		journal.entries = journal.entries.filter((e) => e.idx <= 8);
		await writeFile(journalPath, JSON.stringify(journal));
		const path = join(dir, "mfw.db");
		const client = createClient({ url: `file:${path}` });
		await migrate(drizzle(client), { migrationsFolder: old });
		await client.execute({
			sql: `INSERT INTO runs (id, kind, task_id, label, model, cwd, argv, capabilities, started_at)
				VALUES ('old-run', 'task', 'MFW-1', 'MFW-1', 'sonnet', '/w', '[]', '{}', ?)`,
			args: [Date.now()],
		});
		const before = await client.execute("PRAGMA table_info(runs)");
		expect(before.rows.some((r) => r.name === "harness")).toBe(false);
		client.close();

		const h = await openDbAt(path);
		const [row] = await h.db.select().from(runs).where(eq(runs.id, "old-run"));
		expect(row).toMatchObject({
			harness: null,
			modelVendor: null,
			taskSize: null,
			taskType: null,
			modelTier: null,
			hostId: null,
			activity: null,
		});
		expect(await h.db.select().from(taskAttemptOutcomes)).toEqual([]);
		expect(await h.db.select().from(reviewVerdicts)).toEqual([]);
		const decisionCols = await h.client.execute("PRAGMA table_info(decisions)");
		expect(decisionCols.rows.some((r) => r.name === "usage")).toBe(true);
		await cleanup(h, dir);
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

describe("task attempt outcomes", () => {
	const t0 = Date.parse("2026-10-01T00:00:00Z");
	type RunInsert = typeof runs.$inferInsert;
	function run(
		id: string,
		over: Partial<RunInsert> & { at: number },
	): RunInsert {
		const { at, ...rest } = over;
		return {
			id,
			kind: "task",
			taskId: "MFW-1",
			label: "MFW-1",
			model: "sonnet",
			providerId: "claude-cli",
			cwd: "/w",
			state: "completed",
			outcome: "completed",
			startedAt: new Date(t0 + at),
			finishedAt: new Date(t0 + at + 1000),
			...rest,
		};
	}
	async function step(
		h: ProjectDbHandle,
		runId: string,
		name: string,
		seq: number,
		result: unknown,
	) {
		await h.db.insert(runSteps).values({
			runId,
			step: name,
			seq,
			status: "done",
			result,
			startedAt: new Date(t0),
			finishedAt: new Date(t0),
		});
	}
	async function merged(h: ProjectDbHandle, runId: string, taskId = "MFW-1") {
		await h.db.insert(mergeJobs).values({
			runId,
			taskId,
			branch: `mfw/${runId}`,
			targetBranch: "main",
			state: "merged",
			enqueuedAt: new Date(t0 + 50_000),
			updatedAt: new Date(t0 + 60_000),
		});
	}

	/**
	 * A verify failure spawns a repair that merges. The repair child carries the
	 * same `attempt` as its root (as unblock children and recovered rows can),
	 * so only lineage says it is a repair.
	 */
	async function repairedChain(h: ProjectDbHandle) {
		await h.db.insert(runs).values([
			run("root", {
				at: 0,
				state: "failed",
				usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.5 },
			}),
			run("child", {
				at: 10_000,
				parentRunId: "root",
				label: "MFW-1#repair",
				attempt: 1,
				usage: {
					inputTokens: 50,
					outputTokens: 5,
					costUsd: 0.25,
					cachedInputTokens: 7,
				},
			}),
		]);
		await step(h, "root", "verify", 1, { passed: false });
		await step(h, "root", "spawn_repair", 2, { childRunId: "child" });
		await step(h, "child", "verify", 1, { passed: true });
		await step(h, "child", "critic", 2, { status: "ok", flagged: false });
		await merged(h, "child");
	}

	test("first_pass is false when a repair exists, counted from lineage", async () => {
		const { h, dir } = await freshDb();
		await repairedChain(h);
		const row = await recordAttemptOutcome(h.db, "child");
		expect(row).toMatchObject({
			rootRunId: "root",
			harness: "claude-cli",
			modelVendor: "anthropic",
			runs: 2,
			repairs: 1,
			final: "merged",
			firstPass: false,
			verdicts: { "critic:accepted": 1 },
			tokensIn: 150,
			tokensOut: 15,
			tokensCached: 7,
			costUsd: 0.75,
			costComplete: true,
		});
		// Recording through either member lands on the same single row.
		await recordAttemptOutcome(h.db, "root");
		expect(await h.db.select().from(taskAttemptOutcomes)).toHaveLength(1);
		await cleanup(h, dir);
	});

	test("review verdicts count once: a fix round is a review round, not a critic:* tally", async () => {
		const { h, dir } = await freshDb();
		await h.db
			.insert(runs)
			.values([
				run("r1", { at: 0 }),
				run("r2", { at: 10_000, parentRunId: "r1", label: "MFW-1#repair" }),
			]);
		await step(h, "r1", "verify", 1, { passed: true });
		await step(h, "r1", "critic", 2, { status: "ok", verdict: "fix" });
		await step(h, "r1", "spawn_repair", 3, { childRunId: "r2" });
		await step(h, "r2", "verify", 1, { passed: true });
		await step(h, "r2", "critic", 2, { status: "ok", verdict: "merge" });
		const verdict = (
			id: string,
			subject: string,
			v: "fix" | "merge",
			round: number,
		) => ({
			id,
			taskId: "MFW-1",
			subjectRunId: subject,
			mode: "critic" as const,
			reviewerHarness: "claude-cli",
			reviewerModel: "opus",
			round,
			verdict: v,
			independent: true,
			createdAt: new Date(t0),
		});
		await h.db
			.insert(reviewVerdicts)
			.values([verdict("v1", "r1", "fix", 1), verdict("v2", "r2", "merge", 2)]);
		await merged(h, "r2");
		const row = await recordAttemptOutcome(h.db, "r2");
		expect(row).toMatchObject({
			final: "merged",
			reviewRounds: 1,
			firstPass: false,
		});
		// Exact: no `critic:*` tally next to the verdicts they duplicate.
		expect(row?.verdicts).toEqual({ fix: 1, merge: 1 });
		const reviewers = summarizeReviewers(
			await h.db.select().from(reviewVerdicts),
		);
		expect(reviewers).toEqual([
			{
				mode: "critic",
				harness: "claude-cli",
				model: "opus",
				verdicts: 2,
				verdictMix: { fix: 1, merge: 1 },
				independent: 2,
			},
		]);
		await cleanup(h, dir);
	});

	test("a clean merge is first pass; an open chain has no final", async () => {
		const { h, dir } = await freshDb();
		await h.db.insert(runs).values([
			run("clean", { at: 0 }),
			run("live", {
				at: 5_000,
				taskId: "MFW-2",
				state: "running",
				outcome: null,
				finishedAt: null,
			}),
		]);
		await merged(h, "clean");
		expect(await recordAttemptOutcome(h.db, "clean")).toMatchObject({
			repairs: 0,
			final: "merged",
			firstPass: true,
			costComplete: false, // no usage reported
		});
		expect(await recordAttemptOutcome(h.db, "live")).toMatchObject({
			final: null,
			firstPass: false,
			finishedAt: null,
		});
		await cleanup(h, dir);
	});

	test("closed non-merged chains read their final off the leaf", async () => {
		const { h, dir } = await freshDb();
		await h.db.insert(runs).values([
			run("rev", { at: 0, taskId: "T-rev" }),
			run("blk", { at: 0, taskId: "T-blk", state: "failed" }),
			run("wd", {
				at: 0,
				taskId: "T-wd",
				state: "killed",
				outcome: "killed_watchdog",
				killReason: "watchdog-idle",
			}),
			run("rl", {
				at: 0,
				taskId: "T-rl",
				state: "rate_limited",
				outcome: "rate_limited",
			}),
			run("stop", {
				at: 0,
				taskId: "T-stop",
				state: "killed",
				outcome: "killed_manual",
			}),
		]);
		await step(h, "rev", "release_task", 1, { released: true, to: "review" });
		await step(h, "blk", "release_task", 1, { released: true, to: "blocked" });
		const finals: Record<string, unknown> = {};
		for (const id of ["rev", "blk", "wd", "rl", "stop"])
			finals[id] = (await recordAttemptOutcome(h.db, id))?.final;
		expect(finals).toEqual({
			rev: "review_human",
			blk: "blocked",
			wd: "killed_watchdog",
			rl: "rate_limited",
			stop: "abandoned",
		});
		await cleanup(h, dir);
	});

	test("non-task runs are not attempt chains", async () => {
		const { h, dir } = await freshDb();
		await h.db
			.insert(runs)
			.values([
				run("recovery", { at: 0, kind: "repair", label: "recovery:1" }),
				run("plan", { at: 0, kind: "plan", taskId: null }),
			]);
		expect(await recordAttemptOutcome(h.db, "recovery")).toBeNull();
		expect(await recordAttemptOutcome(h.db, "plan")).toBeNull();
		expect(await backfillAttemptOutcomes(h.db)).toBe(0);
		await cleanup(h, dir);
	});

	test("backfill is idempotent: run twice, same rows", async () => {
		const { h, dir } = await freshDb();
		await repairedChain(h);
		await h.db.insert(runs).values([
			run("other", { at: 20_000, taskId: "MFW-9", state: "failed" }),
			// A fresh dispatch after the first chain ended is its own chain.
			run("again", {
				at: 30_000,
				state: "running",
				outcome: null,
				finishedAt: null,
			}),
		]);
		let tick = 0;
		const clock = () => new Date(t0 + 1_000_000 + tick++ * 1000);
		expect(await backfillAttemptOutcomesOnce(h.db, clock)).toBe(3);
		const first = await h.db.select().from(taskAttemptOutcomes);
		expect(first.map((r) => r.rootRunId).sort()).toEqual([
			"again",
			"other",
			"root",
		]);
		// The marker short-circuits; the unconditional fold rewrites nothing.
		expect(await backfillAttemptOutcomesOnce(h.db, clock)).toBeNull();
		expect(await backfillAttemptOutcomes(h.db, clock)).toBe(3);
		expect(await h.db.select().from(taskAttemptOutcomes)).toEqual(first);
		const [marker] = await h.db
			.select()
			.from(engineKv)
			.where(eq(engineKv.key, OUTCOMES_BACKFILL_KEY));
		expect(marker?.value).toEqual({ version: 2, chains: 3 });
		await cleanup(h, dir);
	});

	test("summaries group closed chains and keep open ones out of rates", async () => {
		const { h, dir } = await freshDb();
		await repairedChain(h);
		await h.db.insert(runs).values([
			run("clean", { at: 40_000, taskId: "MFW-3" }),
			run("live", {
				at: 50_000,
				taskId: "MFW-4",
				state: "running",
				outcome: null,
				finishedAt: null,
			}),
			run("codex", {
				at: 60_000,
				taskId: "MFW-5",
				providerId: "codex-cli",
				model: "gpt-5.6-sol",
				state: "failed",
			}),
		]);
		await merged(h, "clean", "MFW-3");
		await backfillAttemptOutcomes(h.db);
		const rows = await listAttemptOutcomes(h.db);
		const groups = summarizeOutcomes(rows, ["harness", "model"]);
		expect(groups).toHaveLength(2);
		expect(groups[0]).toMatchObject({
			key: { harness: "claude-cli", model: "sonnet" },
			attempts: 2,
			open: 1,
			merged: 2,
			firstPass: 1,
			firstPassRate: 0.5,
			repairs: 1,
			verdictMix: { "critic:accepted": 1 },
			finals: { merged: 2 },
			medianCostPerMerge: 0.75,
		});
		expect(groups[1]).toMatchObject({
			key: { harness: "codex-cli", model: "gpt-5.6-sol" },
			attempts: 1,
			firstPassRate: 0,
			mergeRate: 0,
		});
		expect(outcomePrior(rows, { harness: "claude-cli" }, 2)).toEqual({
			n: 2,
			firstPassRate: 0.5,
			costPerMerge: 0.75,
			usable: true,
		});
		expect(outcomePrior(rows, { harness: "claude-cli" }).usable).toBe(false);
		await cleanup(h, dir);
	});
});
