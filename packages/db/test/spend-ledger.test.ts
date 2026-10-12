import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openProjectDb, type ProjectDbHandle } from "../src/client.ts";
import { decisions, runs, spendLedger } from "../src/schema.ts";
import {
	cumulativeDelta,
	recordBrainUsage,
	recordRunUsage,
	recordSpend,
	spendTotals,
} from "../src/spend.ts";

async function withDb(
	fn: (h: ProjectDbHandle) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "mfw-spend-"));
	const h = await openProjectDb(dir);
	try {
		await fn(h);
	} finally {
		h.close();
		await rm(dir, { recursive: true, force: true });
	}
}

const since = new Date(0);

describe("spend ledger", () => {
	test("run usage ingest writes one row per run and is idempotent on run_id + source", async () => {
		await withDb(async (h) => {
			const usage = { inputTokens: 100, outputTokens: 40, costUsd: 0.25 };
			await recordRunUsage(h.db, {
				runId: "run-a",
				taskId: "T-1",
				accountKey: "claude-cli",
				usage,
			});
			// Finalize resumes after a crash and ingests again, once with a later total.
			await recordRunUsage(h.db, {
				runId: "run-a",
				taskId: "T-1",
				accountKey: "claude-cli",
				usage,
			});
			await recordRunUsage(h.db, {
				runId: "run-a",
				taskId: "T-1",
				accountKey: "claude-cli",
				usage: { ...usage, costUsd: 0.3 },
			});
			await recordRunUsage(h.db, {
				runId: "run-b",
				accountKey: "codex-cli",
				usage: { inputTokens: 5, outputTokens: 1 },
			});

			const rows = await h.db.select().from(spendLedger);
			expect(rows.filter((r) => r.runId === "run-a")).toHaveLength(1);
			const a = rows.find((r) => r.runId === "run-a");
			expect(a).toMatchObject({
				kind: "agent",
				source: "run_usage",
				accountKey: "claude-cli",
				taskId: "T-1",
				usd: 0.3,
				tokensIn: 100,
				tokensOut: 40,
				estimated: false,
			});
			// No dollars reported: tokens still count, and the row is flagged.
			expect(rows.find((r) => r.runId === "run-b")).toMatchObject({
				usd: null,
				tokensIn: 5,
				estimated: true,
			});
			expect(rows).toHaveLength(2);
		});
	});

	test("a run with no usage writes no row", async () => {
		await withDb(async (h) => {
			await recordRunUsage(h.db, {
				runId: "run-x",
				accountKey: "claude-cli",
				usage: null,
			});
			await recordRunUsage(h.db, {
				runId: "run-y",
				accountKey: "claude-cli",
				usage: {},
			});
			expect(await h.db.select().from(spendLedger)).toHaveLength(0);
		});
	});

	test("a resumed brain session reporting cumulative 1.20 after 0.50 writes 0.70", async () => {
		await withDb(async (h) => {
			await recordBrainUsage(h.db, {
				runId: "turn-1",
				accountKey: "claude-cli",
				brainSessionId: "bs-1",
				cumulative: { costUsd: 0.5, inputTokens: 1000, outputTokens: 200 },
			});
			const second = await recordBrainUsage(h.db, {
				runId: "turn-2",
				accountKey: "claude-cli",
				brainSessionId: "bs-1",
				cumulative: { costUsd: 1.2, inputTokens: 2500, outputTokens: 500 },
				previous: { costUsd: 0.5, inputTokens: 1000, outputTokens: 200 },
			});
			expect(second?.usd).toBeCloseTo(0.7, 9);

			const rows = await h.db
				.select()
				.from(spendLedger)
				.where(eq(spendLedger.brainSessionId, "bs-1"));
			const byRun = new Map(rows.map((r) => [r.runId, r]));
			expect(byRun.get("turn-1")?.usd).toBe(0.5);
			expect(byRun.get("turn-2")?.usd).toBeCloseTo(0.7, 9);
			expect(byRun.get("turn-2")).toMatchObject({
				kind: "brain",
				source: "brain_usage",
				tokensIn: 1500,
				tokensOut: 300,
			});
			// The ledger sum is the conversation's cumulative total, not the sum of totals.
			const total = await spendTotals(h.db, { since, kind: "brain" });
			expect(total.usd).toBeCloseTo(1.2, 9);
		});
	});

	test("a cumulative total that goes backwards is a restarted session: all of it is new", async () => {
		expect(cumulativeDelta(1.2, 0.5)).toBeCloseTo(0.7, 9);
		expect(cumulativeDelta(0.3, 1.2)).toBe(0.3);
		expect(cumulativeDelta(0.4, null)).toBe(0.4);
		expect(cumulativeDelta(null, 0.4)).toBeNull();
	});

	test("rows without a run id never collide; spendTotals windows by account and ts", async () => {
		await withDb(async (h) => {
			const t0 = new Date("2026-01-01T00:00:00Z");
			const t1 = new Date("2026-01-02T00:00:00Z");
			for (const ts of [t0, t0]) {
				await recordSpend(h.db, {
					kind: "resource",
					accountKey: "runpod:main",
					source: "runpod_billing",
					usd: 1.5,
					ts,
				});
			}
			await recordSpend(h.db, {
				kind: "resource",
				accountKey: "runpod:main",
				source: "runpod_billing",
				usd: 2,
				ts: t1,
			});
			await recordSpend(h.db, {
				kind: "agent",
				accountKey: "claude-cli",
				source: "run_usage",
				runId: "r",
				usd: 9,
				ts: t1,
			});
			const all = await spendTotals(h.db, {
				since: t0,
				accountKey: "runpod:main",
			});
			expect(all).toMatchObject({ usd: 5, rows: 3 });
			const late = await spendTotals(h.db, {
				since: t1,
				accountKey: "runpod:main",
			});
			expect(late).toMatchObject({ usd: 2, rows: 1 });
		});
	});
});

describe("migration 0010 is additive", () => {
	test("decisions and runs keep working with the new columns unset", async () => {
		await withDb(async (h) => {
			await h.db.insert(decisions).values({
				ts: new Date(),
				role: "critic",
				model: "m",
			});
			const [d] = await h.db.select().from(decisions);
			expect(d).toMatchObject({
				brainSessionId: null,
				turnRunId: null,
				kind: null,
				alternatives: null,
				confidence: null,
				contextRefs: null,
				harness: null,
				outcome: null,
				overriddenBy: null,
			});
			await h.db
				.update(decisions)
				.set({
					role: "brain",
					kind: "action",
					confidence: "high",
					alternatives: [{ option: "wait", why_not: "idle capacity" }],
					contextRefs: { events: [3, 4], runs: ["r1"] },
					overriddenBy: 7,
				})
				.where(eq(decisions.id, d?.id ?? 0));
			const [after] = await h.db.select().from(decisions);
			expect(after).toMatchObject({
				role: "brain",
				kind: "action",
				overriddenBy: 7,
				contextRefs: { events: [3, 4], runs: ["r1"] },
			});
			expect((await h.db.select().from(runs)).length).toBe(0);
		});
	});
});
