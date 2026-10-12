import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { BrainGlyphLink, BrainHeaderChip } from "./BrainBadge";
import type { BrainStateRow } from "./brain";

process.env.BASE_URL ??= "/";

const row = (over: Partial<BrainStateRow> = {}): BrainStateRow =>
	({
		project: "alpha",
		enabled: true,
		state: "idle",
		generation: 1,
		liveTurnRunId: null,
		failures: 0,
		error: null,
		...over,
	}) as BrainStateRow;

describe("the project header's brain chip", () => {
	test("thinking is static and links to the brain inspector", () => {
		const html = renderToStaticMarkup(
			<BrainHeaderChip project="alpha" row={row({ state: "turn" })} />,
		);
		expect(html).toContain("thinking");
		expect(html).not.toContain("mfw-pulse");
		expect(html).toContain("node=brain");
	});

	test("stuck shows the cross in the critical tone", () => {
		const html = renderToStaticMarkup(
			<BrainHeaderChip
				project="alpha"
				row={row({ state: "failed", failures: 3, error: "boom" })}
			/>,
		);
		expect(html).toContain("stuck");
		expect(html).toContain('data-glyph="stuck"');
		expect(html).toContain("--mfw-critical");
	});

	test("no brain configured: a quiet hint pointing at settings, no glyph", () => {
		const html = renderToStaticMarkup(
			<BrainHeaderChip
				project="alpha"
				row={row({ enabled: false, state: "off" })}
			/>,
		);
		expect(html).toContain("Brain: off");
		expect(html).toContain("configure brain.routes in project settings");
		expect(html).toContain("/p/alpha/settings");
		expect(html).not.toContain("data-glyph");
	});

	test("unknown yet draws nothing", () => {
		expect(
			renderToStaticMarkup(<BrainHeaderChip project="alpha" row={undefined} />),
		).toBe("");
	});
});

describe("the rail glyph", () => {
	test("off or unknown draws nothing, a brain draws its state", () => {
		expect(
			renderToStaticMarkup(
				<BrainGlyphLink
					project="alpha"
					row={row({ enabled: false, state: "off" })}
				/>,
			),
		).toBe("");
		expect(
			renderToStaticMarkup(<BrainGlyphLink project="alpha" row={undefined} />),
		).toBe("");
		const html = renderToStaticMarkup(
			<BrainGlyphLink project="alpha" row={row({ state: "paused" })} />,
		);
		expect(html).toContain("brain paused");
	});
});
