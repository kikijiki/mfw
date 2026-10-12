import { describe, expect, test } from "bun:test";
import { RUN_ACTIVITIES } from "@mfw/core/activity";

import {
	ACTIVITY_LOOK,
	BRAIN_LOOK,
	BRAIN_STATES,
	harnessMonogram,
	look,
	lookForRun,
	PIP_GLYPHS,
	PIP_LOOK,
	RUN_STATES_LOOKED,
	STATE_LOOK,
	shortModel,
} from "./look";

const RUN_STATES = [
	"starting",
	"running",
	"ended",
	"finalizing",
	"merging",
	"completed",
	"failed",
	"killed",
	"interrupted",
	"rate_limited",
	"needs_review",
	"finalize_error",
] as const;

describe("look() coverage", () => {
	test("every RunActivity has a look", () => {
		for (const a of RUN_ACTIVITIES) {
			expect(look({ kind: "activity", value: a }).label.length).toBeGreaterThan(
				0,
			);
		}
		expect(Object.keys(ACTIVITY_LOOK).sort()).toEqual(
			[...RUN_ACTIVITIES].sort(),
		);
	});

	test("every RunState has a look", () => {
		expect([...RUN_STATES_LOOKED].sort()).toEqual([...RUN_STATES].sort());
		for (const s of RUN_STATES) {
			expect(look({ kind: "state", value: s }).glyph.length).toBeGreaterThan(0);
		}
	});

	test("every pip glyph and brain state has a look", () => {
		expect([...PIP_GLYPHS].sort() as string[]).toEqual(
			["decision", "fail", "ok", "rate", "stopped", "winner"].sort(),
		);
		expect([...BRAIN_STATES].sort() as string[]).toEqual([
			"failed",
			"idle",
			"paused",
			"turn",
		]);
	});
});

describe("no colour-only state", () => {
	const all = [
		...Object.values(ACTIVITY_LOOK),
		...Object.values(STATE_LOOK),
		...Object.values(PIP_LOOK),
		...Object.values(BRAIN_LOOK),
	];

	test("the glyph and the label differ, and neither is empty", () => {
		for (const l of all) {
			expect(l.glyph).not.toBe("");
			expect(l.label).not.toBe("");
			expect(l.glyph).not.toBe(l.label);
		}
	});

	test("the colour is a token name, never a literal", () => {
		for (const l of all) expect(l.token).toMatch(/^--mfw-[a-z-]+$/);
	});

	test("activities that need a person are told apart by glyph and ring", () => {
		const glyphs = new Set(Object.values(ACTIVITY_LOOK).map((l) => l.glyph));
		expect(glyphs.size).toBe(Object.keys(ACTIVITY_LOOK).length);
		expect(ACTIVITY_LOOK.needs_answer.ring).toBe(true);
		expect(ACTIVITY_LOOK.awaiting_approval.ring).toBe(true);
		expect(ACTIVITY_LOOK.working.ring).toBe(false);
		expect(ACTIVITY_LOOK.needs_answer.glyph).not.toBe(
			ACTIVITY_LOOK.awaiting_approval.glyph,
		);
	});

	test("settled outcomes are three different marks", () => {
		expect(PIP_LOOK.ok.glyph).not.toBe(PIP_LOOK.fail.glyph);
		expect(PIP_LOOK.fail.glyph).not.toBe(PIP_LOOK.stopped.glyph);
		expect(PIP_LOOK.stopped.glyph).not.toBe(PIP_LOOK.rate.glyph);
	});
});

describe("lookForRun", () => {
	test("a live run shows its activity", () => {
		expect(
			lookForRun({ state: "running", activity: "needs_answer" }).label,
		).toBe("needs answer");
	});

	test("a settled run shows its state even with a stale activity", () => {
		expect(lookForRun({ state: "failed", activity: "working" }).label).toBe(
			"failed",
		);
	});

	test("an unknown or missing activity falls back to the lifecycle state", () => {
		expect(lookForRun({ state: "running", activity: "bogus" }).label).toBe(
			"running",
		);
		expect(lookForRun({ state: "merging", activity: null }).label).toBe(
			"merging",
		);
	});
});

describe("badges", () => {
	test("harness monograms", () => {
		expect(harnessMonogram("claude-cli")).toBe("CC");
		expect(harnessMonogram("codex-cli")).toBe("CX");
		expect(harnessMonogram("opencode")).toBe("OC");
		expect(harnessMonogram("pi")).toBe("PI");
		expect(harnessMonogram("codex-cli@lab")).toBe("CX");
		expect(harnessMonogram("zed-agent")).toBe("ZE");
		expect(harnessMonogram("")).toBe("??");
	});

	test("short model names", () => {
		expect(shortModel("claude-opus-4-5")).toBe("opus");
		expect(shortModel("anthropic/claude-sonnet-5")).toBe("sonnet");
		expect(shortModel("gpt-5.1-codex")).toBe("gpt-5");
		expect(shortModel("some-very-long-model-name-v2")).toBe("some-very-lon…");
		expect(shortModel(null)).toBe("");
	});
});
