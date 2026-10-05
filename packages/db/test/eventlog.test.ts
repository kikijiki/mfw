import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MfwEvent } from "@mfw/core/events";
import { openProjectDb, type ProjectDbHandle } from "../src/client.ts";
import { appendEvent, listEvents, type StoredEvent } from "../src/eventlog.ts";

/**
 * `listEvents` backs the HISTORY timeline. The properties worth defending are
 * paging correctness under concurrent appends (a seq cursor, never an offset)
 * and that the filters compose.
 */

interface Env {
	dir: string;
	handle: ProjectDbHandle;
	emit: (event: MfwEvent) => Promise<number>;
}

const envs: Env[] = [];

/** `StoredEvent` is a union; only some members carry these refs. */
const taskIdOf = (e: StoredEvent | undefined) =>
	e && "taskId" in e ? e.taskId : undefined;
const runIdOf = (e: StoredEvent | undefined) =>
	e && "runId" in e ? e.runId : undefined;

async function freshEnv(): Promise<Env> {
	const dir = await mkdtemp(join(tmpdir(), "mfw-eventlog-"));
	const handle = await openProjectDb(dir);
	const env: Env = {
		dir,
		handle,
		emit: async (event) =>
			(await handle.withTx((tx) => appendEvent(tx, event))).seq,
	};
	envs.push(env);
	return env;
}

afterEach(async () => {
	for (const env of envs.splice(0)) {
		env.handle.close();
		await rm(env.dir, { recursive: true, force: true });
	}
});

/** 12 events: alternating task ids, three distinct types. */
async function seed(env: Env): Promise<number[]> {
	const seqs: number[] = [];
	for (let i = 0; i < 12; i++) {
		const taskId = i % 2 === 0 ? "MFW-1" : "MFW-2";
		seqs.push(
			await env.emit(
				i % 3 === 0
					? {
							type: "task.created",
							taskId,
							payload: { source: "human", title: taskId },
						}
					: i % 3 === 1
						? {
								type: "task.status_changed",
								taskId,
								payload: { from: "backlog", to: "ready", actor: "scheduler" },
							}
						: {
								type: "task.edited",
								taskId,
								payload: { source: "api", fields: ["title"], rev: i },
							},
			),
		);
	}
	return seqs;
}

describe("listEvents", () => {
	test("defaults to newest-first and caps the page size", async () => {
		const env = await freshEnv();
		const seqs = await seed(env);

		const page = await listEvents(env.handle.db, { limit: 5 });
		expect(page.events.map((e) => e.seq)).toEqual(seqs.slice(-5).reverse());
		expect(page.cursor.hasMore).toBe(true);
		expect(page.cursor.nextBeforeSeq).toBe(seqs.at(-5) as number);
		expect(page.cursor.nextSinceSeq).toBe(seqs.at(-1) as number);

		// limit is clamped to the documented maximum, not honoured blindly.
		const wide = await listEvents(env.handle.db, { limit: 10_000 });
		expect(wide.events).toHaveLength(12);
		expect(wide.cursor.hasMore).toBe(false);
		expect(wide.cursor.nextBeforeSeq).toBeNull();
	});

	test("beforeSeq paging visits every row exactly once", async () => {
		const env = await freshEnv();
		const seqs = await seed(env);

		const walked: number[] = [];
		let before: number | null | undefined;
		for (let guard = 0; guard < 10; guard++) {
			const page = await listEvents(env.handle.db, {
				limit: 5,
				...(before === null || before === undefined
					? {}
					: { beforeSeq: before }),
			});
			walked.push(...page.events.map((e) => e.seq));
			before = page.cursor.nextBeforeSeq;
			if (!page.cursor.hasMore) break;
		}
		expect(walked).toEqual([...seqs].reverse());
		expect(new Set(walked).size).toBe(seqs.length);
	});

	test("the cursor is stable while new events keep arriving", async () => {
		const env = await freshEnv();
		const seqs = await seed(env);

		const first = await listEvents(env.handle.db, { limit: 5 });
		// The daemon does not stop while a human scrolls: five more events land
		// between pages. An offset cursor would now re-serve rows already shown;
		// a seq cursor cannot.
		for (let i = 0; i < 5; i++) {
			await env.emit({ type: "main.green", payload: {} });
		}
		const second = await listEvents(env.handle.db, {
			limit: 5,
			beforeSeq: first.cursor.nextBeforeSeq as number,
		});

		const shown = [...first.events, ...second.events].map((e) => e.seq);
		expect(new Set(shown).size).toBe(shown.length); // no duplicates
		expect(shown).toEqual([...seqs].reverse().slice(0, 10)); // no gaps

		// Tailing forward from the first page's head picks up exactly the new
		// rows, oldest-first.
		const tail = await listEvents(env.handle.db, {
			sinceSeq: first.cursor.nextSinceSeq,
		});
		expect(tail.events).toHaveLength(5);
		expect(tail.events.map((e) => e.type)).toEqual(Array(5).fill("main.green"));
		expect(tail.events.map((e) => e.seq)).toEqual(
			[...tail.events].map((e) => e.seq).sort((a, b) => a - b),
		);
	});

	test("filters by type and by task, and composes with paging", async () => {
		const env = await freshEnv();
		await seed(env);

		const edits = await listEvents(env.handle.db, { types: ["task.edited"] });
		expect(edits.events).toHaveLength(4);
		expect(edits.events.every((e) => e.type === "task.edited")).toBe(true);

		const two = await listEvents(env.handle.db, {
			types: ["task.created", "task.edited"],
		});
		expect(two.events).toHaveLength(8);

		const forTask = await listEvents(env.handle.db, { taskId: "MFW-1" });
		expect(forTask.events).toHaveLength(6);
		expect(forTask.events.every((e) => taskIdOf(e) === "MFW-1")).toBe(true);

		const both = await listEvents(env.handle.db, {
			taskId: "MFW-1",
			types: ["task.edited"],
			limit: 1,
		});
		expect(both.events).toHaveLength(1);
		expect(both.events[0]).toMatchObject({
			type: "task.edited",
			taskId: "MFW-1",
		});
		expect(both.cursor.hasMore).toBe(true);

		// An empty result still returns a usable cursor rather than undefined.
		const none = await listEvents(env.handle.db, {
			types: ["merge.completed"],
		});
		expect(none.events).toEqual([]);
		expect(none.cursor).toEqual({
			nextBeforeSeq: null,
			nextSinceSeq: 0,
			hasMore: false,
		});
	});

	test("payload, taskId and ts survive the round-trip", async () => {
		const env = await freshEnv();
		await env.emit({
			type: "task.edited",
			taskId: "MFW-2",
			payload: { source: "api", fields: ["title", "body"], rev: 7 },
		});
		const [row] = (await listEvents(env.handle.db)).events;
		expect(row).toMatchObject({
			type: "task.edited",
			taskId: "MFW-2",
			payload: { source: "api", fields: ["title", "body"], rev: 7 },
		});
		expect(runIdOf(row)).toBeUndefined();
		expect(typeof row?.ts).toBe("number");
	});
});
