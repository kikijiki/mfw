import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	type BrainDraft,
	brainPatch,
	describeBrain,
	draftFromStored,
	draftProblems,
	EMPTY_DRAFT,
	isDirty,
	moveRoute,
} from "./brainDraft";

const draft = (over: Partial<BrainDraft> = {}): BrainDraft => ({
	...EMPTY_DRAFT,
	routes: [{ provider: "claude-cli", model: "opus", effort: "" }],
	...over,
});

describe("brain draft", () => {
	test("a stored config round-trips through the draft unchanged", () => {
		const stored = {
			routes: [
				{ provider: "claude-cli", model: "opus", effort: "high" as const },
				{ provider: "codex-cli" },
			],
			heartbeatMin: 15,
			rolloverTokens: 90_000,
			turnTimeoutMs: 5 * 60_000,
			maxTurnsPerHour: 6,
			maxTurnsPerDay: 80,
		};
		expect(brainPatch(draftFromStored(stored))).toEqual(stored);
	});

	test("blank numbers are omitted so the daemon defaults apply", () => {
		expect(brainPatch(draft())).toEqual({
			routes: [{ provider: "claude-cli", model: "opus" }],
		});
	});

	test("no routes means off: the patch is null", () => {
		expect(brainPatch(draft({ routes: [] }))).toBeNull();
		expect(brainPatch(draftFromStored(null))).toBeNull();
	});

	test("minutes become milliseconds for the turn timeout", () => {
		expect(brainPatch(draft({ turnTimeoutMin: "7" }))).toMatchObject({
			turnTimeoutMs: 420_000,
		});
	});

	test("problems name what to fix; a valid draft has none", () => {
		expect(draftProblems(draft())).toEqual([]);
		expect(
			draftProblems(
				draft({
					routes: [{ provider: " ", model: "", effort: "" }],
					heartbeatMin: "0",
					maxTurnsPerDay: "many",
				}),
			),
		).toEqual([
			"Route 1 needs a provider.",
			"Heartbeat (minutes) must be a whole number of at least 1.",
			"Max turns per day must be a whole number of at least 1.",
		]);
	});

	test("dirty tracks edits; routes reorder within bounds", () => {
		const base = draft();
		expect(isDirty(base, draft())).toBe(false);
		expect(isDirty({ ...base, heartbeatMin: "5" }, base)).toBe(true);
		const two = [
			{ provider: "a", model: "", effort: "" as const },
			{ provider: "b", model: "", effort: "" as const },
		];
		expect(moveRoute(two, 0, 1).map((r) => r.provider)).toEqual(["b", "a"]);
		expect(moveRoute(two, 0, -1).map((r) => r.provider)).toEqual(["a", "b"]);
	});

	test("project settings mounts the brain section and saves through settings.update", () => {
		const read = (f: string) => readFileSync(join(import.meta.dir, f), "utf8");
		expect(read("../settings/ProjectConfig.tsx")).toContain(
			"<BrainSettings project={project} />",
		);
		const section = read("BrainSettings.tsx");
		expect(section).toContain("trpc.settings.update.mutationOptions");
		expect(section).toContain("brainPatch(draft)");
	});

	test("describe says on or off in a sentence", () => {
		expect(describeBrain(null)).toContain("Off");
		expect(
			describeBrain({
				routes: [{ provider: "claude-cli", model: "opus" }, { provider: "x" }],
			}),
		).toBe("On: claude-cli · opus (+1 fallback)");
	});
});
