import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MfwEvent } from "@mfw/core/events";
import { asc } from "drizzle-orm";
import { openProjectDb, type ProjectDbHandle } from "../src/client.ts";
import { appendEvent } from "../src/eventlog.ts";
import { events, runSpans } from "../src/schema.ts";
import { backfillSpansFromEvents, foldSpans } from "../src/spans-backfill.ts";

/**
 * Golden: one recorded run (and its task) as events. Live writing
 * (`appendEvent`) and the replay fold (`foldSpans`, the boot backfill) must
 * produce the same spans for this sequence.
 */
interface Rec {
	at: number;
	event: MfwEvent;
}
const T0 = 1_700_000_000_000;
const RECORDED: Rec[] = [
	{
		at: T0,
		event: {
			type: "task.status_changed",
			taskId: "T-1",
			payload: { from: "ready", to: "in_progress", actor: "scheduler" },
		},
	},
	{
		at: T0 + 1,
		event: {
			type: "run.started",
			runId: "R1",
			taskId: "T-1",
			payload: { kind: "task", model: "m", taskId: "T-1" },
		},
	},
	{
		at: T0 + 1_000,
		event: {
			type: "run.state_changed",
			runId: "R1",
			taskId: "T-1",
			payload: { from: "starting", to: "running" },
		},
	},
	{
		at: T0 + 2_000,
		event: {
			type: "run.activity_changed",
			runId: "R1",
			taskId: "T-1",
			payload: { from: null, to: "working" },
		},
	},
	{
		at: T0 + 5_000,
		event: {
			type: "run.activity_changed",
			runId: "R1",
			taskId: "T-1",
			payload: { from: "working", to: "needs_answer", question: "Keep v1?" },
		},
	},
	{
		at: T0 + 9_000,
		event: {
			type: "run.activity_changed",
			runId: "R1",
			taskId: "T-1",
			payload: { from: "needs_answer", to: "working" },
		},
	},
	{
		at: T0 + 12_000,
		event: {
			type: "run.state_changed",
			runId: "R1",
			taskId: "T-1",
			payload: { from: "running", to: "ended" },
		},
	},
	{
		at: T0 + 13_000,
		event: {
			type: "run.state_changed",
			runId: "R1",
			taskId: "T-1",
			payload: { from: "ended", to: "completed" },
		},
	},
	{
		at: T0 + 14_000,
		event: {
			type: "task.status_changed",
			taskId: "T-1",
			payload: { from: "in_progress", to: "done", actor: "verifier" },
		},
	},
];

const envs: { dir: string; handle: ProjectDbHandle }[] = [];
async function freshDb() {
	const dir = await mkdtemp(join(tmpdir(), "mfw-spans-"));
	const handle = await openProjectDb(dir);
	envs.push({ dir, handle });
	return handle;
}
afterEach(async () => {
	for (const e of envs.splice(0)) {
		e.handle.close();
		await rm(e.dir, { recursive: true, force: true });
	}
});

async function readSpans(h: ProjectDbHandle) {
	const rows = await h.db
		.select()
		.from(runSpans)
		.orderBy(asc(runSpans.subject), asc(runSpans.lane), asc(runSpans.startTs));
	return rows.map((r) => ({
		subject: r.subject,
		lane: r.lane,
		value: r.value,
		startTs: r.startTs.getTime(),
		endTs: r.endTs?.getTime() ?? null,
		detail: r.detail,
	}));
}

const EXPECTED = [
	{
		subject: "run:R1",
		lane: "activity",
		value: "working",
		startTs: T0 + 2_000,
		endTs: T0 + 5_000,
		detail: null,
	},
	{
		subject: "run:R1",
		lane: "activity",
		value: "needs_answer",
		startTs: T0 + 5_000,
		endTs: T0 + 9_000,
		detail: { question: "Keep v1?" },
	},
	{
		subject: "run:R1",
		lane: "activity",
		value: "working",
		startTs: T0 + 9_000,
		endTs: T0 + 13_000, // closed by the terminal transition
		detail: null,
	},
	{
		subject: "run:R1",
		lane: "state",
		value: "starting",
		startTs: T0 + 1,
		endTs: T0 + 1_000,
		detail: null,
	},
	{
		subject: "run:R1",
		lane: "state",
		value: "running",
		startTs: T0 + 1_000,
		endTs: T0 + 12_000,
		detail: null,
	},
	{
		subject: "run:R1",
		lane: "state",
		value: "ended",
		startTs: T0 + 12_000,
		endTs: T0 + 13_000,
		detail: null,
	},
	{
		subject: "run:R1",
		lane: "state",
		value: "completed",
		startTs: T0 + 13_000,
		endTs: T0 + 13_000,
		detail: null,
	},
	{
		subject: "task:T-1",
		lane: "status",
		value: "in_progress",
		startTs: T0,
		endTs: T0 + 14_000,
		detail: { from: "ready", actor: "scheduler" },
	},
	{
		subject: "task:T-1",
		lane: "status",
		value: "done",
		startTs: T0 + 14_000,
		endTs: null,
		detail: { from: "in_progress", actor: "verifier" },
	},
];

describe("spans: live writing and replay agree (golden)", () => {
	test("live appendEvent produces the golden spans", async () => {
		const h = await freshDb();
		for (const r of RECORDED) {
			await h.withTx((tx) => appendEvent(tx, r.event, r.at));
		}
		expect(await readSpans(h)).toEqual(EXPECTED);
	});

	test("folding the same events gives the same spans", async () => {
		const folded = foldSpans(
			RECORDED.map((r, i) => ({
				type: r.event.type,
				taskId: "taskId" in r.event ? r.event.taskId : undefined,
				runId: "runId" in r.event ? r.event.runId : undefined,
				payload: r.event.payload,
				seq: i + 1,
				ts: r.at,
			})),
		);
		const sorted = folded
			.map((s) => ({
				subject: s.subject,
				lane: s.lane,
				value: s.value,
				startTs: s.startTs,
				endTs: s.endTs,
				detail: s.detail,
			}))
			.sort(
				(a, b) =>
					a.subject.localeCompare(b.subject) ||
					a.lane.localeCompare(b.lane) ||
					a.startTs - b.startTs,
			);
		expect(sorted).toEqual(EXPECTED);
	});

	test("boot backfill over events recorded without spans matches live, once", async () => {
		const h = await freshDb();
		// Events as an old database holds them: rows in `events`, no spans.
		await h.db.insert(events).values(
			RECORDED.map((r) => ({
				ts: new Date(r.at),
				type: r.event.type,
				taskId: "taskId" in r.event ? (r.event.taskId ?? null) : null,
				runId: "runId" in r.event ? (r.event.runId ?? null) : null,
				payload: r.event.payload as Record<string, unknown>,
			})),
		);
		expect(await readSpans(h)).toEqual([]);
		expect(await backfillSpansFromEvents(h.db)).toBe(EXPECTED.length);
		expect(await readSpans(h)).toEqual(EXPECTED);
		// idempotent
		expect(await backfillSpansFromEvents(h.db)).toBe(0);
		expect(await readSpans(h)).toEqual(EXPECTED);
	});
});
