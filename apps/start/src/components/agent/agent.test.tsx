import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentChip } from "./AgentChip";
import { HarnessBadge } from "./HarnessBadge";
import { HistoryPips, type Pip, visiblePips } from "./HistoryPips";
import { look } from "./look";
import { StateGlyph } from "./StateGlyph";

describe("StateGlyph", () => {
	test("renders the glyph, the label as aria-label, and the token colour", () => {
		const html = renderToStaticMarkup(
			<StateGlyph subject={{ kind: "activity", value: "stalled" }} />,
		);
		expect(html).toContain('data-glyph="dashed"');
		expect(html).toContain("<svg");
		expect(html).toContain('aria-label="stalled"');
		expect(html).toContain("var(--mfw-critical)");
	});

	test("showLabel prints the word", () => {
		const html = renderToStaticMarkup(
			<StateGlyph
				subject={{ kind: "activity", value: "needs_answer" }}
				showLabel
			/>,
		);
		expect(html).toContain("needs answer</span>");
		expect(html).toContain('data-glyph="question"');
	});

	test("a working run is told by shape and label, never by motion", () => {
		const working = renderToStaticMarkup(
			<StateGlyph subject={{ kind: "state", value: "running" }} />,
		);
		const done = renderToStaticMarkup(
			<StateGlyph subject={{ kind: "state", value: "completed" }} />,
		);
		expect(working).toContain('aria-label="running"');
		expect(working).not.toContain("mfw-pulse");
		expect(done).not.toContain("mfw-pulse");
	});
});

describe("HarnessBadge", () => {
	test("shows the monogram and keeps the id in the tooltip", () => {
		const html = renderToStaticMarkup(<HarnessBadge harness="codex-cli" />);
		expect(html).toContain(">CX<");
		// The tooltip is the shared Tip (not rendered until hover): read its label.
		const el = HarnessBadge({ harness: "codex-cli" });
		expect((el.props as { tip?: string }).tip).toBe("codex-cli");
		expect(html).not.toContain("title=");
	});
});

describe("AgentChip", () => {
	test("state, harness, short model and age in one chip", () => {
		const html = renderToStaticMarkup(
			<AgentChip
				look={look({ kind: "activity", value: "working" })}
				harness="claude-cli"
				model="claude-opus-4-5"
				startedAt={Date.now() - 12 * 60_000}
			/>,
		);
		expect(html).toContain('data-glyph="dot"');
		expect(html).toContain(">CC<");
		expect(html).toContain(">opus<");
		expect(html).toMatch(/12m/);
	});

	test("a live run's cost shows as $; absent until sampled", () => {
		const l = look({ kind: "activity", value: "working" });
		const withCost = renderToStaticMarkup(
			<AgentChip look={l} harness="claude-cli" costUsd={0.4237} />,
		);
		expect(withCost).toContain(">$0.42<");
		const without = renderToStaticMarkup(
			<AgentChip look={l} harness="claude-cli" costUsd={null} />,
		);
		expect(without).not.toContain("$");
		const tiny = renderToStaticMarkup(
			<AgentChip look={l} harness="claude-cli" costUsd={0.004} />,
		);
		expect(tiny).toContain("&lt;$0.01");
	});

	test("a competing attempt carries the marker", () => {
		const html = renderToStaticMarkup(
			<AgentChip
				look={look({ kind: "activity", value: "idle" })}
				harness="pi"
				competing
			/>,
		);
		expect(html).toContain("competing attempt");
		expect(html).toContain('data-glyph="compete"');
	});
});

describe("HistoryPips", () => {
	const pip = (n: number, glyph: Pip["glyph"] = "ok"): Pip => ({
		ref: `run:${n}`,
		glyph,
	});

	test("renders one mark per pip, oldest first", () => {
		const html = renderToStaticMarkup(
			<HistoryPips pips={[pip(1, "fail"), pip(2, "stopped"), pip(3, "ok")]} />,
		);
		expect(html.indexOf('data-glyph="cross"')).toBeLessThan(
			html.indexOf('data-glyph="stop"'),
		);
		expect(html.indexOf('data-glyph="stop"')).toBeLessThan(
			html.indexOf('data-glyph="check"'),
		);
		expect(html).toContain("failed: run:1");
	});

	test("caps at 12 and says how many older ones are folded", () => {
		const pips = Array.from({ length: 15 }, (_, i) => pip(i));
		const { shown, hidden } = visiblePips(pips);
		expect(shown).toHaveLength(12);
		expect(hidden).toBe(3);
		expect(shown[0]?.ref).toBe("run:3");
		expect(renderToStaticMarkup(<HistoryPips pips={pips} />)).toContain("+3");
	});

	test("no pips render nothing; a click handler makes buttons", () => {
		expect(renderToStaticMarkup(<HistoryPips pips={[]} />)).toBe("");
		expect(
			renderToStaticMarkup(<HistoryPips pips={[pip(1)]} onSelect={() => {}} />),
		).toContain("<button");
	});
});
