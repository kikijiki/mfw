import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb } from "@mfw/db/client";
import { events, runSpans, runSubagents, runs } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { activityOf, emptyFold, foldActivity } from "../src/agents/activity.ts";
import type { AgentEvent } from "../src/agents/events.ts";
import { RunEventTail } from "../src/run-event-tail.ts";
import {
	parseSubRef,
	runSubagentsOf,
	subRef,
	writeRunSubagents,
} from "../src/run-subagents.ts";

/** U7-02: `run_subagents` rows folded from the transcript and written by the tail. */

function stream(...evs: Record<string, unknown>[]): AgentEvent[] {
	return evs.map(
		(e, i) =>
			({
				ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
				seq: i,
				...e,
			}) as AgentEvent,
	);
}

const agentCall = (id: string, input: Record<string, unknown> = {}) => ({
	type: "tool_call",
	id,
	name: "Agent",
	input: {
		description: "scan the repo",
		subagent_type: "Explore",
		prompt: "go",
		...input,
	},
});
const inSub = (parent: string, e: Record<string, unknown>) => ({
	...e,
	parent: { toolUseId: parent },
});

describe("subagent fold", () => {
	test("one row per Agent call with times, status, tool counts and entry seqs", () => {
		const fold = foldActivity(
			emptyFold(),
			stream(
				{ type: "message", role: "assistant", text: "starting" },
				agentCall("ag1"),
				inSub("ag1", { type: "message", role: "user", text: "go" }),
				inSub("ag1", { type: "tool_call", id: "s1", name: "Read", input: {} }),
				inSub("ag1", { type: "tool_result", id: "s1", ok: true, output: "A" }),
				inSub("ag1", { type: "tool_call", id: "s2", name: "Read", input: {} }),
				inSub("ag1", { type: "tool_call", id: "s3", name: "Grep", input: {} }),
				inSub("ag1", { type: "message", role: "assistant", text: "found" }),
				{ type: "tool_result", id: "ag1", ok: true, output: "found" },
			),
		);
		expect([...fold.subagents.values()]).toEqual([
			{
				toolUseId: "ag1",
				parentToolUseId: null,
				agentType: "Explore",
				description: "scan the repo",
				startedAt: "2026-01-01T00:00:01.000Z",
				endedAt: "2026-01-01T00:00:08.000Z",
				status: "ok",
				tools: { Read: 2, Grep: 1 },
				entryFromSeq: 1,
				entryToSeq: 7,
				background: false,
			},
		]);
	});

	test("the subagent's messages are not the run's: turns and last message ignore them", () => {
		const fold = foldActivity(
			emptyFold(),
			stream(
				{ type: "message", role: "assistant", text: "run says" },
				agentCall("ag1"),
				inSub("ag1", { type: "message", role: "assistant", text: "sub says?" }),
			),
		);
		expect(fold.turns).toBe(1);
		expect(fold.lastAssistantText).toBe("run says");
	});

	test("an erroring Agent call ends the subagent in error", () => {
		const fold = foldActivity(
			emptyFold(),
			stream(agentCall("ag1"), {
				type: "tool_result",
				id: "ag1",
				ok: false,
				output: "boom",
			}),
		);
		expect(fold.subagents.get("ag1")?.status).toBe("error");
	});

	test("still running without a result; the run's done closes it", () => {
		const open = foldActivity(emptyFold(), stream(agentCall("ag1")));
		expect(open.subagents.get("ag1")?.status).toBe("running");
		expect(open.subagents.get("ag1")?.endedAt).toBeNull();
		foldActivity(
			open,
			stream({ type: "done", reason: "complete" }).map((e) => ({
				...e,
				ts: "2026-01-01T00:05:00.000Z",
			})) as AgentEvent[],
		);
		expect(open.subagents.get("ag1")).toMatchObject({
			status: "ok",
			endedAt: "2026-01-01T00:05:00.000Z",
		});
	});

	test("a nested subagent names the one that started it", () => {
		const fold = foldActivity(
			emptyFold(),
			stream(
				agentCall("outer"),
				inSub("outer", { ...agentCall("inner", { description: "deeper" }) }),
				inSub("inner", { type: "tool_call", id: "x", name: "Bash", input: {} }),
			),
		);
		expect(fold.subagents.get("inner")).toMatchObject({
			parentToolUseId: "outer",
			description: "deeper",
			tools: { Bash: 1 },
		});
		// The outer one counted the Agent call it made as a tool.
		expect(fold.subagents.get("outer")?.tools).toEqual({ Agent: 1 });
	});

	test("a background subagent outlives its launch result and ends with its job", () => {
		const fold = foldActivity(
			emptyFold(),
			stream(
				agentCall("bg", { run_in_background: true }),
				{
					type: "tool_result",
					id: "bg",
					ok: true,
					output: "Async agent launched. ID: ab12cd",
				},
				inSub("bg", { type: "tool_call", id: "s", name: "Read", input: {} }),
			),
		);
		expect(fold.subagents.get("bg")?.status).toBe("running");
		expect(fold.background.has("bg")).toBeTrue();
		foldActivity(
			fold,
			stream({
				type: "tool_call",
				id: "kill",
				name: "TaskStop",
				input: { task_id: "ab12cd" },
			}).map((e) => ({ ...e, seq: 50 })) as AgentEvent[],
		);
		expect(fold.subagents.get("bg")?.status).toBe("ok");
	});

	test("a Codex sub-thread becomes a row keyed by its thread id", () => {
		const fold = foldActivity(
			emptyFold(),
			stream(
				{
					type: "tool_call",
					id: "c1",
					name: "command",
					input: {},
					parent: { threadId: "thread-2" },
				},
				{
					type: "tool_result",
					id: "c1",
					ok: true,
					output: "",
					parent: { threadId: "thread-2" },
				},
				{ type: "done", reason: "complete" },
			),
		);
		expect(fold.subagents.get("thread-2")).toMatchObject({
			agentType: "thread",
			tools: { command: 1 },
			status: "ok",
		});
	});

	test("a subagent's events do not make the run look stalled or ended", () => {
		const fold = foldActivity(
			emptyFold(),
			stream(
				{ type: "message", role: "user", text: "do it" },
				agentCall("ag1"),
				inSub("ag1", { type: "tool_call", id: "s", name: "Read", input: {} }),
			),
		);
		expect(
			activityOf(fold, { now: Date.UTC(2026, 0, 1, 0, 0, 5) }).activity,
		).toBe("working");
	});
});

describe("tail hands subagents out when they change", () => {
	test("shape changes at once; counts alone are throttled", async () => {
		const lines: AgentEvent[] = [];
		const push = (...e: Record<string, unknown>[]) =>
			lines.push(...stream(...e));
		const text = () =>
			`${lines.map((l, i) => JSON.stringify({ ...l, seq: i })).join("\n")}\n`;
		const tail = new RunEventTail(async (_run, offset) => {
			const all = text();
			const chunk = Buffer.from(all).subarray(offset).toString();
			return { chunk, size: Buffer.byteLength(all), complete: true };
		});
		push(agentCall("ag1"));
		await tail.fold("r");
		const first = tail.takeSubagents("r", 1_000);
		expect(first?.map((s) => s.status)).toEqual(["running"]);
		expect(tail.takeSubagents("r", 1_001)).toBeNull();
		// A tool call changes counts only: held back until the sample window passes.
		push(inSub("ag1", { type: "tool_call", id: "s", name: "Read", input: {} }));
		await tail.fold("r");
		expect(tail.takeSubagents("r", 2_000)).toBeNull();
		expect(tail.takeSubagents("r", 20_000)?.[0]?.tools).toEqual({ Read: 1 });
		// The subagent finishing is announced immediately.
		push({ type: "tool_result", id: "ag1", ok: true, output: "x" });
		await tail.fold("r");
		expect(tail.takeSubagents("r", 20_001)?.[0]?.status).toBe("ok");
	});
});

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
	for (const c of cleanups) await c();
});

async function db() {
	const dir = await mkdtemp(join(tmpdir(), "mfw-subagents-"));
	const handle = await openProjectDb(dir);
	cleanups.push(async () => {
		handle.close();
		await rm(dir, { recursive: true, force: true });
	});
	await handle.db.insert(runs).values({
		id: "r1",
		kind: "task",
		taskId: "T-1",
		label: "r1",
		model: "sonnet",
		cwd: "/w",
		state: "running",
		startedAt: new Date(Date.UTC(2026, 0, 1)),
		relation: "fresh",
	});
	return handle;
}

describe("run_subagents table", () => {
	test("writes one row per subagent, upserts, and announces only start and finish", async () => {
		const handle = await db();
		const fold = foldActivity(emptyFold(), stream(agentCall("ag1")));
		const subs = () => [...fold.subagents.values()];
		const write = () =>
			handle.withTx((tx) => writeRunSubagents(tx, "r1", subs()));

		const started = await write();
		expect(started).toMatchObject({
			type: "run.subagents_changed",
			runId: "r1",
			taskId: "T-1",
			payload: { total: 1, running: 1 },
		});
		// Same again: idempotent, silent.
		expect(await write()).toBeNull();
		// A tool count moves: the row updates, no event.
		foldActivity(
			fold,
			stream(
				{ type: "message", role: "assistant", text: "x" },
				inSub("ag1", { type: "tool_call", id: "s", name: "Read", input: {} }),
			).map((e, i) => ({ ...e, seq: 10 + i })) as AgentEvent[],
		);
		expect(await write()).toBeNull();
		expect((await runSubagentsOf(handle.db, "r1"))[0]?.tools).toEqual({
			Read: 1,
		});
		// It finishes.
		foldActivity(
			fold,
			stream({ type: "tool_result", id: "ag1", ok: true, output: "ok" }).map(
				(e) => ({ ...e, seq: 20 }),
			) as AgentEvent[],
		);
		expect(await write()).toMatchObject({
			payload: { total: 1, running: 0 },
		});
		const rows = await handle.db.select().from(runSubagents);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			runId: "r1",
			toolUseId: "ag1",
			agentType: "Explore",
			status: "ok",
		});
		expect(rows[0]?.endedAt).toBeInstanceOf(Date);
		// The announcement is in the audit log, and no span was opened by it.
		const logged = await handle.db
			.select()
			.from(events)
			.where(eq(events.type, "run.subagents_changed"));
		expect(logged).toHaveLength(2);
		expect(await handle.db.select().from(runSpans)).toHaveLength(0);
	});

	test("an unknown run writes nothing", async () => {
		const handle = await db();
		const fold = foldActivity(emptyFold(), stream(agentCall("ag1")));
		const event = await handle.withTx((tx) =>
			writeRunSubagents(tx, "ghost", [...fold.subagents.values()]),
		);
		expect(event).toBeNull();
		expect(await handle.db.select().from(runSubagents)).toHaveLength(0);
	});

	test("sub refs round-trip and keep slashes in the call id", () => {
		expect(subRef("r1", "toolu_01")).toBe("sub:r1/toolu_01");
		expect(parseSubRef("sub:r1/a/b")).toEqual({
			runId: "r1",
			toolUseId: "a/b",
		});
		expect(parseSubRef("run:r1")).toBeNull();
	});
});
