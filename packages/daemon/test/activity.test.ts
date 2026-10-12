import { describe, expect, test } from "bun:test";
import { RUN_ACTIVITIES, type RunActivity } from "@mfw/core/activity";
import {
	activityOf,
	activitySignature,
	emptyFold,
	finalActivity,
	foldActivity,
} from "../src/agents/activity.ts";
import type { AgentEvent } from "../src/agents/events.ts";

/** Event builder: fills ts/seq so fixtures read as the transcript they model. */
function stream(...events: Record<string, unknown>[]): AgentEvent[] {
	return events.map(
		(e, i) =>
			({
				ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
				seq: i,
				...e,
			}) as AgentEvent,
	);
}

const T0 = Date.UTC(2026, 0, 1);
const startTurn = [
	{ type: "hello", provider: "claude-cli", capabilities: { steer: true } },
	{
		type: "session",
		provider: "claude-cli",
		sessionId: "s",
		status: "started",
		ordinal: 0,
	},
	{ type: "message", role: "user", text: "do the task" },
	{
		type: "session",
		provider: "claude-cli",
		sessionId: "s",
		turnId: "t1",
		status: "active",
		ordinal: 1,
	},
];
const turnCompleted = {
	type: "session",
	provider: "claude-cli",
	sessionId: "s",
	turnId: "t1",
	status: "completed",
	ordinal: 1,
};

function live(events: AgentEvent[], now = T0 + 30_000, idleMs = 300_000) {
	return activityOf(foldActivity(emptyFold(), events), {
		now,
		idleMs,
		lastOutputAt: now - 1000,
	});
}

/** One fixture per vocabulary value. */
const FIXTURES: Record<RunActivity, () => RunActivity> = {
	working: () =>
		live(
			stream(...startTurn, {
				type: "tool_call",
				id: "c1",
				name: "Read",
				input: { file_path: "a.ts" },
			}),
		).activity,
	awaiting_approval: () =>
		live(
			stream(...startTurn, {
				type: "approval",
				requestId: "r1",
				kind: "command",
				status: "pending",
				summary: "rm -rf build",
			}),
		).activity,
	needs_answer: () =>
		live(
			stream(...startTurn, {
				type: "tool_call",
				id: "q1",
				name: "AskUserQuestion",
				input: {
					questions: [{ question: "Postgres or SQLite?", options: [] }],
				},
			}),
		).activity,
	stalled: () =>
		live(
			stream(
				...startTurn,
				{
					type: "tool_call",
					id: "b1",
					name: "Bash",
					input: { command: "bun test", run_in_background: true },
				},
				{
					type: "tool_result",
					id: "b1",
					ok: true,
					output: "Command running in background with ID: bash_1",
				},
				{ type: "message", role: "assistant", text: "Tests are running." },
				turnCompleted,
			),
		).activity,
	idle: () =>
		live(
			stream(
				...startTurn,
				{ type: "message", role: "assistant", text: "Done. Committed." },
				turnCompleted,
			),
		).activity,
	ended: () =>
		live(
			stream(...startTurn, turnCompleted, { type: "done", reason: "complete" }),
		).activity,
};

describe("activity vocabulary", () => {
	for (const value of RUN_ACTIVITIES) {
		test(`fixture classifies as ${value}`, () => {
			expect(FIXTURES[value]()).toBe(value);
		});
	}
});

describe("activityOf", () => {
	test("an approval resolved later is no longer awaited", () => {
		const r = live(
			stream(
				...startTurn,
				{
					type: "approval",
					requestId: "r1",
					kind: "command",
					status: "pending",
					summary: "x",
				},
				{
					type: "approval",
					requestId: "r1",
					kind: "command",
					status: "accepted",
					summary: "x",
				},
			),
		);
		expect(r.activity).toBe("working");
		expect(r.detail.pendingApprovals).toEqual([]);
	});

	test("pending approval detail names the request and its summary", () => {
		const r = live(
			stream(...startTurn, {
				type: "approval",
				requestId: "r9",
				kind: "file_change",
				status: "pending",
				summary: "write src/x.ts",
			}),
		);
		expect(r.detail.pendingApprovals).toEqual(["r9"]);
		expect(r.detail.approvalSummary).toBe("write src/x.ts");
	});

	test("a Codex user_input request is a question, not an approval", () => {
		const r = live(
			stream(...startTurn, {
				type: "approval",
				requestId: "u1",
				kind: "user_input",
				status: "pending",
				summary: "Which branch?",
			}),
		);
		expect(r.activity).toBe("needs_answer");
		expect(r.detail.question).toBe("Which branch?");
		expect(r.detail.questionSource).toBe("user_input");
		expect(r.detail.pendingApprovals).toEqual([]);
	});

	test("AskUserQuestion carries question and options until its result", () => {
		const asked = stream(...startTurn, {
			type: "tool_call",
			id: "q1",
			name: "AskUserQuestion",
			input: {
				questions: [
					{
						question: "Postgres or SQLite?",
						options: [{ label: "Postgres" }, { label: "SQLite" }],
					},
				],
			},
		});
		const r = live(asked);
		expect(r.detail.question).toBe("Postgres or SQLite?");
		expect(r.detail.options).toEqual(["Postgres", "SQLite"]);
		const answered = [
			...asked,
			...stream({ type: "tool_result", id: "q1", ok: false, output: "denied" }),
		];
		expect(live(answered).activity).toBe("working");
	});

	test("silence past half the idle limit is an early stall warning", () => {
		const fold = foldActivity(emptyFold(), stream(...startTurn));
		const r = activityOf(fold, {
			now: T0 + 200_000,
			idleMs: 300_000,
			lastOutputAt: T0,
		});
		expect(r.activity).toBe("stalled");
		expect(r.detail.stallCause).toBe("silent");
		// ...but not under half of it.
		expect(
			activityOf(fold, { now: T0 + 100_000, idleMs: 300_000, lastOutputAt: T0 })
				.activity,
		).toBe("working");
		// and never with the idle watchdog off.
		expect(
			activityOf(fold, { now: T0 + 10_000_000, idleMs: 0, lastOutputAt: T0 })
				.activity,
		).toBe("working");
	});

	test("a background job seen finishing (BashOutput completed) does not stall the turn", () => {
		const r = live(
			stream(
				...startTurn,
				{
					type: "tool_call",
					id: "b1",
					name: "Bash",
					input: { command: "bun test", run_in_background: true },
				},
				{
					type: "tool_result",
					id: "b1",
					ok: true,
					output: "Command running in background with ID: bash_1",
				},
				{
					type: "tool_call",
					id: "p1",
					name: "BashOutput",
					input: { bash_id: "bash_1" },
				},
				{
					type: "tool_result",
					id: "p1",
					ok: true,
					output: "<status>completed</status><exit_code>0</exit_code>",
				},
				turnCompleted,
			),
		);
		expect(r.activity).toBe("idle");
		expect(r.detail.background).toEqual([]);
	});

	test("a background job killed with KillShell does not stall the turn", () => {
		const r = live(
			stream(
				...startTurn,
				{
					type: "tool_call",
					id: "b1",
					name: "Bash",
					input: { command: "bun dev", run_in_background: true },
				},
				{
					type: "tool_result",
					id: "b1",
					ok: true,
					output: "Command running in background with ID: bash_7",
				},
				{
					type: "tool_call",
					id: "k1",
					name: "KillShell",
					input: { shell_id: "bash_7" },
				},
				turnCompleted,
			),
		);
		expect(r.activity).toBe("idle");
	});

	test("a steer after the turn ended means the agent is working again", () => {
		const r = live(
			stream(
				...startTurn,
				{ type: "message", role: "assistant", text: "Shall I continue?" },
				turnCompleted,
				{ type: "message", role: "user", text: "yes" },
			),
		);
		expect(r.activity).toBe("working");
	});

	test("the signature ignores turns and timestamps, not the activity", () => {
		const a = live(stream(...startTurn));
		const b = live(
			stream(...startTurn, { type: "message", role: "assistant", text: "hi" }),
		);
		expect(activitySignature(a)).toBe(activitySignature(b));
		expect(activitySignature(a)).not.toBe(
			activitySignature({ ...a, activity: "idle" }),
		);
	});
});

describe("finalActivity", () => {
	const fold = (...extra: Record<string, unknown>[]) =>
		foldActivity(emptyFold(), stream(...startTurn, ...extra, turnCompleted));

	test("a report question wins and keeps its options", () => {
		const r = finalActivity(fold(), {
			question: "Drop the legacy table?",
			options: ["yes", "no"],
		});
		expect(r.activity).toBe("needs_answer");
		expect(r.detail).toMatchObject({
			question: "Drop the legacy table?",
			questionSource: "report",
			options: ["yes", "no"],
		});
	});

	test("background jobs the turn ended on label the run stalled", () => {
		const r = finalActivity(
			fold({
				type: "tool_call",
				id: "a1",
				name: "Agent",
				input: { description: "survey", run_in_background: true },
			}),
			null,
		);
		expect(r.activity).toBe("stalled");
		expect(r.detail.stallCause).toBe("background");
		expect(r.detail.background[0]).toMatchObject({
			callId: "a1",
			tool: "Agent",
			summary: "survey",
		});
	});

	test("a final message ending in a question is a heuristic label", () => {
		const r = finalActivity(
			fold({
				type: "message",
				role: "assistant",
				text: "I found two options.\nWhich one do you want?",
			}),
			null,
		);
		expect(r.activity).toBe("needs_answer");
		expect(r.detail.questionSource).toBe("heuristic");
	});

	test("a plain finish is ended", () => {
		expect(
			finalActivity(
				fold({ type: "message", role: "assistant", text: "Done." }),
				null,
			).activity,
		).toBe("ended");
	});
});
