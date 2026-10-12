import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CardAgentStrip, lastOutcome } from "./CardAgentStrip";

// Vite provides BASE_URL (AppLink reads it); bun test does not.
process.env.BASE_URL ??= "/";

const href = (runId: string) => `/p/alpha/runs/${runId}`;

const live = {
	runId: "R1",
	state: "running",
	activity: "working",
	providerId: "claude-cli",
	model: "claude-opus-4-5",
	startedAt: Date.now() - 12 * 60_000,
};

function render(props: Partial<Parameters<typeof CardAgentStrip>[0]>) {
	return renderToStaticMarkup(
		<CardAgentStrip
			runs={[]}
			pips={[]}
			isDraft={false}
			runHref={href}
			{...props}
		/>,
	);
}

describe("card agent strip", () => {
	test("a live run shows a chip with its activity, harness and model", () => {
		const html = render({ runs: [live] });
		expect(html).toContain('aria-label="working"');
		expect(html).toContain(">CC<");
		expect(html).toContain("opus");
		expect(html).toContain('href="/p/alpha/runs/R1"');
		expect(html).not.toContain("competing attempt");
	});

	test("a run asking a question reads as needing an answer, not working", () => {
		const html = render({
			runs: [{ ...live, activity: "needs_answer" }],
		});
		expect(html).toContain('aria-label="needs answer"');
	});

	test("competing live runs each get a chip, marked", () => {
		const html = render({
			runs: [
				live,
				{ ...live, runId: "R2", providerId: "codex-cli", model: "gpt-5" },
			],
		});
		expect(html.match(/competing attempt/g)?.length).toBeGreaterThanOrEqual(2);
		expect(html).toContain(">CX<");
		expect(html).toContain(">CC<");
	});

	test("a draft's live run reads as expanding", () => {
		expect(render({ runs: [live], isDraft: true })).toContain("expanding");
		expect(render({ runs: [live], isDraft: false })).not.toContain("expanding");
	});

	test("with no live run, the last outcome line and the pips show", () => {
		const html = render({
			pips: [
				{ ref: "run:A", glyph: "fail" },
				{ ref: "run:B", glyph: "ok" },
			],
		});
		expect(html).toContain("verified · 2 runs");
		expect(html).toContain('aria-label="failed: run:A"');
		expect(html).toContain('aria-label="verified: run:B"');
		expect(html).not.toContain(">CC<");
	});

	test("with a live run the outcome line gives way to the chip; pips remain", () => {
		const html = render({
			runs: [live],
			pips: [{ ref: "run:A", glyph: "fail" }],
		});
		expect(html).not.toContain("failed · 1 run");
		expect(html).toContain('aria-label="failed: run:A"');
	});

	test("a task that never ran has no strip at all", () => {
		expect(render({})).toBe("");
	});

	test("lastOutcome names the newest pip and counts runs", () => {
		expect(lastOutcome([])).toBeNull();
		expect(lastOutcome([{ ref: "run:A", glyph: "rate" }])?.line).toBe(
			"rate limited · 1 run",
		);
	});

	test("the last outcome adds when, model and cost where they are known", () => {
		const detail = {
			at: new Date(2026, 9, 12, 11),
			model: "claude-opus-4-7",
			costUsd: 0.62,
			state: "completed",
		};
		const now = new Date(2026, 9, 12, 13).getTime();
		expect(
			lastOutcome([{ ref: "run:A", glyph: "rate" }], detail, now)?.line,
		).toBe("rate limited · 1 run · 2h ago · opus · $0.62");
		const pips = [{ ref: "run:A", glyph: "ok" as const }];
		expect(render({ pips, outcomeDetail: detail })).toContain("opus · $0.62");
		// A live run replaces the outcome line altogether.
		expect(render({ pips, runs: [live], outcomeDetail: detail })).not.toContain(
			"$0.62",
		);
	});
});
