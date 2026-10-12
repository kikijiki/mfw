import { describe, expect, test } from "bun:test";

import {
	boardAgents,
	runsForTask,
	taskLiveRuns,
	taskNeedsHuman,
} from "./boardAgents";

describe("board cards' agent facts", () => {
	test("live runs are keyed by run id for this project only; asking tasks come from task questions", () => {
		const agents = boardAgents(
			"alpha",
			[
				{
					project: "alpha",
					runId: "R1",
					state: "running",
					activity: "stalled",
				},
				{ project: "beta", runId: "R2", state: "running", activity: "working" },
			],
			[
				{ project: "alpha", runId: "Q1", kind: "task", taskId: "MFW-7" },
				// A planner's questions are not the card's own run asking.
				{ project: "alpha", runId: "P1", kind: "planner", taskId: "MFW-8" },
				{ project: "beta", runId: "Q2", kind: "task", taskId: "MFW-9" },
				{ project: "alpha", runId: "Q3", kind: "task", taskId: null },
			],
		);
		expect([...agents.runs.keys()]).toEqual(["R1"]);
		expect(agents.runs.get("R1")?.activity).toBe("stalled");
		expect([...agents.asking.entries()]).toEqual([["MFW-7", "Q1"]]);
	});

	test("missing caches mean no agent facts, not a crash", () => {
		const agents = boardAgents("alpha", undefined, undefined);
		expect(agents.runs.size).toBe(0);
		expect(agents.asking.size).toBe(0);
		expect(agents.byTask.size).toBe(0);
		expect(agents.pips).toEqual({});
	});

	test("live runs are grouped per task (competing attempts are several), oldest first", () => {
		const agents = boardAgents(
			"alpha",
			[
				{
					project: "alpha",
					runId: "B",
					state: "running",
					taskId: "MFW-1",
					startedAt: 200,
					providerId: "codex-cli",
					model: "gpt-5",
				},
				{
					project: "alpha",
					runId: "A",
					state: "running",
					taskId: "MFW-1",
					startedAt: 100,
					providerId: "claude-cli",
					model: "claude-opus-4-5",
				},
				{ project: "alpha", runId: "C", state: "running", taskId: "MFW-2" },
				{ project: "alpha", runId: "D", state: "running", taskId: null },
			],
			[],
		);
		expect(agents.byTask.get("MFW-1")?.map((r) => r.runId)).toEqual(["A", "B"]);
		expect(agents.byTask.get("MFW-2")?.map((r) => r.runId)).toEqual(["C"]);
		const task = { id: "MFW-1", claimedByRunId: "A" };
		expect(taskLiveRuns(agents, task)).toBe(2);
	});

	test("a claimed run runs.active has not attributed by task still shows on its card", () => {
		const agents = boardAgents(
			"alpha",
			[{ project: "alpha", runId: "X", state: "running", taskId: null }],
			[],
		);
		expect(
			runsForTask(agents, { id: "MFW-3", claimedByRunId: "X" }).map(
				(r) => r.runId,
			),
		).toEqual(["X"]);
		expect(runsForTask(agents, { id: "MFW-3", claimedByRunId: null })).toEqual(
			[],
		);
	});

	test("an ended run is not counted live", () => {
		const agents = boardAgents(
			"alpha",
			[{ project: "alpha", runId: "E", state: "ended", taskId: "MFW-4" }],
			[],
		);
		expect(taskLiveRuns(agents, { id: "MFW-4", claimedByRunId: null })).toBe(0);
	});

	test("pips are carried per task from runs.pipsByTask", () => {
		const agents = boardAgents("alpha", [], [], {
			"MFW-1": [
				{ ref: "run:A", glyph: "fail" },
				{ ref: "run:B", glyph: "ok" },
			],
		});
		expect(agents.pips["MFW-1"]?.map((p) => p.glyph)).toEqual(["fail", "ok"]);
	});

	test("a task needs a person when its run asked or a live run's activity asks", () => {
		const agents = boardAgents(
			"alpha",
			[
				{
					project: "alpha",
					runId: "S",
					state: "running",
					taskId: "MFW-5",
					activity: "stalled",
				},
				{
					project: "alpha",
					runId: "W",
					state: "running",
					taskId: "MFW-6",
					activity: "working",
				},
			],
			[{ project: "alpha", runId: "Q", kind: "task", taskId: "MFW-7" }],
		);
		const t = (id: string) => ({ id, claimedByRunId: null });
		expect(taskNeedsHuman(agents, "alpha", t("MFW-5"))).toBe(true);
		expect(taskNeedsHuman(agents, "alpha", t("MFW-6"))).toBe(false);
		expect(taskNeedsHuman(agents, "alpha", t("MFW-7"))).toBe(true);
	});
});

describe("the brain's intents on cards", () => {
	test("intents are keyed by task; none means an empty map", () => {
		expect(boardAgents("alpha", [], []).intents.size).toBe(0);
		const agents = boardAgents("alpha", [], [], {}, [
			{
				taskId: "MFW-1",
				decisionId: 4,
				tool: "spawn",
				rationale: "deps merged",
				confidence: "high",
				state: "proposed",
			},
		]);
		expect(agents.intents.get("MFW-1")?.tool).toBe("spawn");
		expect(agents.intents.get("MFW-2")).toBeUndefined();
	});
});
