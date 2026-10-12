import { describe, expect, test } from "bun:test";
import {
	buildProjectSummary,
	collectProjectSummary,
	type SummarySource,
} from "@mfw/daemon/project-summary";

const source = (over: Partial<SummarySource> = {}): SummarySource => ({
	name: "demo",
	tasks: {
		list: async () => [
			{ status: "in_progress" },
			{ status: "in_progress" },
			{ status: "ready" },
			{ status: "blocked" },
			{ status: "review" },
			{ status: "done" },
		],
	},
	registry: {
		list: async () => [
			{ id: "r1", kind: "task", state: "running" },
			{ id: "r2", kind: "task", state: "running" },
			{ id: "b1", kind: "brain", state: "running" },
			{ id: "r3", kind: "task", state: "ended" },
		],
	},
	workspace: {
		worktrees: async () => [
			{ runId: "r1", state: "running" },
			{ runId: "r2", state: "running" },
			{ runId: "r3", state: "ended" },
		],
	},
	inbox: { list: async () => [{ runId: "r2" }, {}] },
	brainState: async () => ({ enabled: true, state: "idle" }),
	spendSince: async () => 1.25,
	lastEventAt: async () => 1_700_000_000_000,
	...over,
});

describe("projects.summary", () => {
	test("counts tasks by role, live sessions, worktrees, needs-you, brain, spend", async () => {
		const s = await collectProjectSummary(source());
		expect(s.project).toBe("demo");
		expect(s.tasks).toMatchObject({
			in_progress: 2,
			ready: 1,
			blocked: 1,
			review: 1,
			done: 1,
			draft: 0,
		});
		// The brain turn is not a session.
		expect(s.sessions).toEqual({ live: 2, waiting: 1 });
		expect(s.worktrees).toEqual({ active: 2, parked: 1 });
		expect(s.needsYou).toBe(2);
		expect(s.brain).toEqual({ enabled: true, state: "idle" });
		expect(s.spendTodayUsd).toBe(1.25);
		expect(s.lastActivityAt).toBe(1_700_000_000_000);
	});

	test("a failing side read degrades to a quiet default instead of failing the call", async () => {
		const s = await collectProjectSummary(
			source({
				workspace: {
					worktrees: async () => {
						throw new Error("boom");
					},
				},
				lastEventAt: async () => {
					throw new Error("boom");
				},
			}),
		);
		expect(s.worktrees).toEqual({ active: 0, parked: 0 });
		expect(s.lastActivityAt).toBeNull();
	});

	test("an empty project is all zeros", () => {
		const s = buildProjectSummary({
			project: "p",
			taskStatuses: [],
			runs: [],
			worktrees: [],
			inboxItems: [],
			brain: { enabled: false, state: "off" },
			spendTodayUsd: 0,
			lastActivityAt: null,
		});
		expect(Object.values(s.tasks).every((n) => n === 0)).toBe(true);
		expect(s.sessions.live).toBe(0);
	});

	test("the router is registered as projects.summary", async () => {
		const { appRouter } = await import("../src/root.ts");
		const procedures = appRouter._def.procedures as Record<string, unknown>;
		expect(procedures["projects.summary"]).toBeDefined();
	});
});
