import { describe, expect, test } from "bun:test";
import {
	EMPTY_TASK_COUNTS,
	type ProjectSummary,
} from "@mfw/daemon/project-summary";

import type { DispatchStatusLike } from "../dispatch/state";
import {
	formatSpend,
	idleLine,
	projectBadge,
	projectTooltip,
	type RailInput,
	statChips,
} from "./projectRail";

const dispatch = (
	over: Partial<DispatchStatusLike> = {},
): DispatchStatusLike => ({
	playing: true,
	projectPlaying: true,
	globalPlaying: true,
	running: true,
	enabled: true,
	state: "dispatching",
	reason: null,
	selfStopped: false,
	hold: null,
	...over,
});

const input = (over: Partial<RailInput> = {}): RailInput => ({
	name: "dummy-todo",
	dispatch: dispatch(),
	brain: { enabled: true, state: "idle" },
	needs: 0,
	liveRuns: 0,
	...over,
});

const NOW = 1_700_000_000_000;
const summary = (over: Partial<ProjectSummary> = {}): ProjectSummary => ({
	project: "dummy-todo",
	tasks: { ...EMPTY_TASK_COUNTS },
	sessions: { live: 0, waiting: 0 },
	worktrees: { active: 0, parked: 0 },
	needsYou: 0,
	brain: { enabled: true, state: "idle" },
	spendTodayUsd: 0,
	lastActivityAt: NOW - 3 * 3_600_000,
	...over,
});

describe("projectBadge priority", () => {
	test("needs-you outranks everything", () => {
		const b = projectBadge(
			input({
				needs: 2,
				liveRuns: 3,
				brain: { enabled: true, state: "failed" },
				dispatch: dispatch({ state: "main_red" }),
			}),
		);
		expect(b).toMatchObject({ kind: "needs", text: "2" });
	});

	test("blocked, then brain stuck, then brain paused, then live, then running", () => {
		expect(
			projectBadge(input({ dispatch: dispatch({ state: "main_red" }) }))?.kind,
		).toBe("blocked");
		expect(
			projectBadge(input({ brain: { enabled: true, state: "failed" } }))?.kind,
		).toBe("brain-stuck");
		expect(
			projectBadge(input({ brain: { enabled: true, state: "paused" } }))?.kind,
		).toBe("brain-paused");
		expect(projectBadge(input({ liveRuns: 4 }))).toMatchObject({
			kind: "live",
			text: "4",
		});
		expect(projectBadge(input())?.kind).toBe("running");
	});

	test("a manually stopped quiet project wears no badge", () => {
		expect(
			projectBadge(
				input({
					dispatch: dispatch({
						projectPlaying: false,
						state: "stopped",
						playing: false,
					}),
				}),
			),
		).toBeNull();
	});

	test("a missing brain config blocks dispatch", () => {
		expect(
			projectBadge(
				input({
					dispatch: dispatch({ blocked: "no_brain_route", state: "held" }),
				}),
			)?.label,
		).toContain("no brain configured");
	});
});

describe("projectTooltip", () => {
	test("is one sentence naming dispatch, brain and needs", () => {
		expect(projectTooltip(input({ needs: 2 }))).toBe(
			"dummy-todo — dispatch running, brain idle, 2 need you",
		);
		expect(projectTooltip(input({ needs: 1 }))).toContain("1 needs you");
	});

	test("says so when no brain is configured", () => {
		expect(
			projectTooltip(input({ brain: { enabled: false, state: "off" } })),
		).toBe("dummy-todo — dispatch running, no brain configured");
	});

	test("folds in board counts from the summary", () => {
		const s = summary({ tasks: { ...EMPTY_TASK_COUNTS, in_progress: 3 } });
		expect(projectTooltip(input(), s, NOW)).toContain("3 in progress");
	});
});

describe("statChips", () => {
	test("shows only non-zero chips with deep links", () => {
		const s = summary({
			tasks: { ...EMPTY_TASK_COUNTS, in_progress: 2, review: 1 },
			sessions: { live: 2, waiting: 1 },
			worktrees: { active: 2, parked: 1 },
			needsYou: 1,
			spendTodayUsd: 1.234,
		});
		const chips = statChips("dummy-todo", s);
		expect(chips.map((c) => c.key)).toEqual([
			"needs",
			"progress",
			"review",
			"sessions",
			"worktrees",
			"spend",
		]);
		expect(chips.find((c) => c.key === "sessions")?.label).toContain(
			"1 waiting on you",
		);
		expect(chips.find((c) => c.key === "review")?.to).toContain("gate=review");
		expect(chips.find((c) => c.key === "spend")?.text).toBe("$1.23");
	});

	test("an idle project has no chips and an idle line", () => {
		const s = summary();
		expect(statChips("dummy-todo", s)).toEqual([]);
		expect(idleLine(s, NOW)).toBe("idle · 3h ago");
		expect(idleLine(summary({ lastActivityAt: null }), NOW)).toBe("idle");
	});

	test("idle brain is not a chip; a stuck one is", () => {
		expect(statChips("p", summary()).some((c) => c.key === "brain")).toBe(
			false,
		);
		expect(
			statChips(
				"p",
				summary({ brain: { enabled: true, state: "failed" } }),
			).some((c) => c.key === "brain"),
		).toBe(true);
	});
});

describe("formatSpend", () => {
	test("scales", () => {
		expect(formatSpend(0)).toBe("$0");
		expect(formatSpend(0.004)).toBe("<$0.01");
		expect(formatSpend(0.42)).toBe("$0.42");
		expect(formatSpend(12.6)).toBe("$13");
	});
});
