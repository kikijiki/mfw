import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import {
	clarifications,
	decisions,
	events,
	reviewVerdicts,
	runs,
} from "@mfw/db/schema";
import {
	type StoryEntry,
	type StoryRunEntry,
	taskStory,
} from "../src/story.ts";

const T = "MFW-7";
const t0 = Date.parse("2026-10-01T00:00:00Z");
const at = (s: number) => new Date(t0 + s * 1000);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

async function open(): Promise<ProjectDbHandle> {
	const dir = await mkdtemp(join(tmpdir(), "mfw-story-"));
	const handle = await openProjectDb(dir);
	cleanups.push(async () => {
		handle.close();
		await rm(dir, { recursive: true, force: true });
	});
	return handle;
}

type RunInsert = typeof runs.$inferInsert;
const run = (
	id: string,
	s: number,
	over: Partial<RunInsert> = {},
): RunInsert => ({
	id,
	kind: "task",
	taskId: T,
	label: T,
	model: "sonnet",
	providerId: "claude-cli",
	cwd: "/w",
	state: "completed",
	startedAt: at(s),
	finishedAt: at(s + 5),
	...over,
});

async function event(
	h: ProjectDbHandle,
	s: number,
	type: string,
	payload: Record<string, unknown>,
	ids: { taskId?: string; runId?: string } = {},
) {
	await h.db.insert(events).values({
		ts: at(s),
		type,
		taskId: ids.taskId ?? null,
		runId: ids.runId ?? null,
		payload,
	});
}

/**
 * Task MFW-7: a fresh run that failed, repaired by a `#repair` child, an
 * `#answer` child continuing that, a critic decision and a verdict on the
 * repair, a status move to review, and a merge. Run lifecycle events carry no
 * task id, exactly as the engine writes them.
 */
async function seed(h: ProjectDbHandle) {
	await event(
		h,
		0,
		"task.created",
		{ source: "human", title: "t" },
		{ taskId: T },
	);
	await h.db.insert(runs).values([
		run("R1", 10, { state: "failed", note: "verify failed" }),
		run("R2", 30, {
			label: `${T}#repair`,
			parentRunId: "R1",
			usage: { costUsd: 0.42 },
		}),
		run("R3", 50, {
			label: `${T}#answer`,
			parentRunId: "R2",
			state: "running",
			finishedAt: null,
		}),
		// A different task's run must never leak in.
		run("X1", 15, { taskId: "OTHER-1", label: "OTHER-1" }),
	]);
	await event(
		h,
		10,
		"run.started",
		{ kind: "task", model: "sonnet" },
		{ runId: "R1" },
	);
	await event(
		h,
		15,
		"run.state_changed",
		{ from: "running", to: "failed" },
		{ runId: "R1" },
	);
	await event(
		h,
		16,
		"run.state_changed",
		{ from: "running", to: "failed" },
		{ runId: "X1" },
	);
	await event(
		h,
		35,
		"run.state_changed",
		{ from: "running", to: "completed" },
		{ runId: "R2" },
	);
	await event(
		h,
		36,
		"verify.check",
		{ check: "typecheck", passed: true },
		{ taskId: T, runId: "R2" },
	);
	await h.db.insert(decisions).values({
		id: 1,
		ts: at(37),
		role: "critic",
		taskId: T,
		subjectRunId: "R2",
		model: "opus",
		status: "ok",
		action: "accept",
		reason: "criteria met",
	});
	await h.db.insert(reviewVerdicts).values({
		id: "V1",
		taskId: T,
		subjectRunId: "R2",
		decisionId: 1,
		mode: "critic",
		round: 0,
		verdict: "merge",
		createdAt: at(38),
	});
	await h.db.insert(clarifications).values({
		runId: "R2",
		kind: "task",
		items: [{ question: "keep v1 keys?", answer: "yes" }],
		createdAt: at(40),
		resolvedAt: at(45),
	});
	await event(
		h,
		60,
		"task.status_changed",
		{ from: "in_progress", to: "review", actor: "verifier" },
		{ taskId: T },
	);
	await event(
		h,
		70,
		"merge.completed",
		{ sha: "abc123", target: "main" },
		{ taskId: T, runId: "R2" },
	);
}

const kinds = (entries: StoryEntry[]) => entries.map((e) => e.kind);

describe("taskStory", () => {
	test("folds runs, run states, decisions, verdicts, status moves and merges in order", async () => {
		const h = await open();
		await seed(h);
		const page = await taskStory(h.db, {
			taskId: T,
			transcriptAvailable: (id) => id === "R2",
		});

		expect(kinds(page.entries)).toEqual([
			"created",
			"run", // R1 (+ nested R2, R3)
			"decision",
			"question",
			"status",
			"merge",
		]);
		expect(page.cursor).toBeNull();

		// R2 and R3 nest under R1; X1 (another task) is absent.
		const r1 = page.entries[1] as StoryRunEntry;
		expect(r1.ref).toBe("run:R1");
		expect(r1.summary).toMatchObject({
			role: "task",
			relation: "fresh",
			state: "failed",
			harness: "claude-cli",
		});
		expect(r1.transcriptAvailable).toBe(false);
		expect(r1.states).toEqual([{ at: at(15), from: "running", to: "failed" }]);
		expect(r1.children.map((c) => [c.ref, c.summary.relation])).toEqual([
			["run:R2", "repair"],
			["run:R3", "answer"],
		]);

		const r2 = r1.children[0] as StoryRunEntry;
		expect(r2.transcriptAvailable).toBe(true);
		expect(r2.summary.costUsd).toBe(0.42);
		expect(r2.states.map((s) => s.to)).toEqual(["completed"]);
		expect(r2.verify).toEqual([{ check: "typecheck", passed: true }]);
		expect(r2.verdicts).toMatchObject([
			{ id: "V1", verdict: "merge", mode: "critic", decisionId: 1 },
		]);

		const decision = page.entries[2];
		expect(decision).toMatchObject({
			kind: "decision",
			role: "critic",
			tool: "accept",
			subjectRunId: "R2",
			target: `task:${T}`,
			rationale: "criteria met",
		});
		expect(page.entries[3]).toMatchObject({
			kind: "question",
			question: "keep v1 keys?",
			answer: "yes",
			runRef: "run:R2",
		});
		expect(page.entries[4]).toMatchObject({
			kind: "status",
			from: "in_progress",
			to: "review",
			actor: "verifier",
		});
		expect(page.entries[5]).toMatchObject({
			kind: "merge",
			state: "completed",
			sha: "abc123",
			runRef: "run:R2",
		});
	});

	test("a repair-labelled run whose parent is not this task's run stays top level", async () => {
		const h = await open();
		await h.db.insert(runs).values([
			// parent_run_id is "subject run" on a critic run, not a continuation
			run("P1", 1, { taskId: "OTHER-1", label: "OTHER-1" }),
			run("C1", 2, { kind: "brain", label: "critic", parentRunId: "P1" }),
			run("K1", 3, { label: `${T}#repair`, parentRunId: "GONE" }),
		]);
		const page = await taskStory(h.db, { taskId: T });
		expect(page.entries.map((e) => (e as StoryRunEntry).ref)).toEqual([
			"run:C1",
			"run:K1",
		]);
	});

	test("cursor paging is stable across inserts", async () => {
		const h = await open();
		await seed(h);
		const first = await taskStory(h.db, { taskId: T, limit: 3 });
		expect(kinds(first.entries)).toEqual(["question", "status", "merge"]);
		expect(first.cursor).not.toBeNull();

		// New activity lands after the first page was read.
		await event(
			h,
			200,
			"task.status_changed",
			{ from: "review", to: "done", actor: "human" },
			{ taskId: T },
		);
		await h.db
			.insert(runs)
			.values(run("R9", 150, { label: `${T}#resume`, parentRunId: "R3" }));

		const older = await taskStory(h.db, {
			taskId: T,
			limit: 3,
			before: first.cursor as string,
		});
		expect(kinds(older.entries)).toEqual(["created", "run", "decision"]);
		expect(older.cursor).toBeNull();

		// The first page re-read with the same cursor-free query now ends later,
		// but the page before the cursor is exactly what it was.
		const reread = await taskStory(h.db, {
			taskId: T,
			limit: 3,
			before: first.cursor as string,
		});
		expect(reread).toEqual(older);
	});

	test("kind filter keeps only the requested top-level entries", async () => {
		const h = await open();
		await seed(h);
		const page = await taskStory(h.db, {
			taskId: T,
			kinds: ["status", "merge"],
		});
		expect(kinds(page.entries)).toEqual(["status", "merge"]);
	});
});
