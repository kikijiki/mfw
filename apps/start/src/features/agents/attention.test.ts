import { describe, expect, test } from "bun:test";

import {
	activityAttention,
	attentionSignals,
	sortByAttention,
} from "./attention";

const live = (project: string, runId: string, startedAt: number) => ({
	project,
	runId,
	state: "running",
	startedAt,
});

describe("attention ranking", () => {
	const signals = attentionSignals({
		questions: [{ project: "alpha", runId: "Q" }],
		sessions: [
			{ project: "alpha", runId: "S" },
			{ project: "alpha", runId: null },
		],
		inbox: [{ project: "beta", runId: "F" }, { project: "beta" }],
	});

	test("needs-a-human first (most urgent reason first), then live, then the rest; newest first within a rank", () => {
		const sorted = sortByAttention(
			[
				{ ...live("alpha", "old-live", 1) },
				{ ...live("alpha", "Q", 0) },
				{ project: "beta", runId: "done", state: "completed", startedAt: 9 },
				{ ...live("alpha", "new-live", 5) },
				{ project: "beta", runId: "F", state: "failed", startedAt: 2 },
				{ project: "alpha", runId: "S", state: "failed", startedAt: 3 },
			],
			signals,
		);
		expect(sorted.map((r) => [r.runId, r.attention])).toEqual([
			["Q", "question"],
			["S", "escalated"],
			["F", "inbox"],
			["new-live", null],
			["old-live", null],
			["done", null],
		]);
	});

	test("a live run's activity is attention: question, then approval, then stalled", () => {
		const none = attentionSignals({});
		const sorted = sortByAttention(
			[
				{ ...live("alpha", "busy", 9), activity: "working" },
				{ ...live("alpha", "stuck", 8), activity: "stalled" },
				{ ...live("alpha", "gate", 1), activity: "awaiting_approval" },
				{ ...live("alpha", "ask", 0), activity: "needs_answer" },
				{ ...live("alpha", "pause", 7), activity: "idle" },
			],
			none,
		);
		expect(sorted.map((r) => [r.runId, r.attention])).toEqual([
			["ask", "question"],
			["gate", "approval"],
			["stuck", "stalled"],
			["busy", null],
			["pause", null],
		]);
	});

	test("activity counts only while the run is live, and a guessed question never pages", () => {
		const none = attentionSignals({});
		expect(
			activityAttention({
				project: "a",
				runId: "r",
				state: "completed",
				activity: "needs_answer",
			}),
		).toBeNull();
		expect(
			activityAttention({
				project: "a",
				runId: "r",
				state: "running",
				activity: "needs_answer",
				activityDetail: { questionSource: "heuristic" },
			}),
		).toBeNull();
		const sorted = sortByAttention(
			[
				{ ...live("a", "r1", 0), activity: "awaiting_approval" },
				{ ...live("a", "r2", 1), activity: "working" },
			],
			none,
		);
		expect(sorted.map((r) => [r.runId, r.attention])).toEqual([
			["r1", "approval"],
			["r2", null],
		]);
	});

	test("a signal is scoped to its project: the same run id elsewhere is not flagged", () => {
		const [row] = sortByAttention([live("beta", "Q", 0)], signals);
		expect(row?.attention).toBeNull();
	});
});
