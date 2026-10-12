import { describe, expect, test } from "bun:test";

import {
	LANE,
	laneChrome,
	laneSizes,
	laneTile,
	SPACE,
	scrollLeftToReveal,
	stepFocus,
	tileContent,
	tileMetrics,
	tileNeeds,
	titleLines,
	visibleTiles,
	wheelScrollLeft,
} from "./lanes";

describe("laneSizes", () => {
	test("unmeasured stack uses the default tile", () => {
		expect(laneSizes({ available: 0, open: 5, collapsed: 3 }).tile).toBe(
			LANE.DEFAULT_TILE,
		);
	});

	test("eight open lanes at a 900px viewport fit without scrolling", () => {
		// 900 minus ~160 of app chrome and toolbar.
		const s = laneSizes({ available: 740, open: 8, collapsed: 0 });
		expect(s.scrolls).toBe(false);
		expect(s.tile).toBeGreaterThanOrEqual(LANE.MIN_TILE);
		const stack = LANE.STACK_PAD + 8 * s.laneHeight + 7 * LANE.GAP;
		expect(stack).toBeLessThanOrEqual(740);
	});

	test("collapsed lanes give their space to the open ones, up to the maximum", () => {
		const all = laneSizes({ available: 740, open: 8, collapsed: 0 });
		const six = laneSizes({ available: 740, open: 6, collapsed: 2 });
		expect(six.tile).toBeGreaterThan(all.tile);
		const few = laneSizes({ available: 740, open: 2, collapsed: 6 });
		expect(few.tile).toBe(LANE.MAX_TILE);
	});

	test("when minimum tiles do not fit, tiles stay at the minimum and the stack scrolls", () => {
		const s = laneSizes({ available: 400, open: 8, collapsed: 0 });
		expect(s.tile).toBe(LANE.MIN_TILE);
		expect(s.scrolls).toBe(true);
	});

	test("every canonical status open fits at 1080 and 900 tall viewports", () => {
		for (const available of [920, 740]) {
			expect(laneSizes({ available, open: 8, collapsed: 0 }).scrolls).toBe(
				false,
			);
		}
	});

	test("a two-line title needs a taller tile", () => {
		expect(titleLines(LANE.MIN_TILE)).toBe(1);
		expect(titleLines(LANE.MAX_TILE)).toBe(2);
	});
});

describe("spacing scale", () => {
	test("tile bounds are the content plus equal padding above and below", () => {
		expect(tileNeeds(1)).toBe(tileContent(1) + 2 * SPACE.PAD_Y);
		expect(LANE.MAX_TILE).toBe(tileContent(2) + 2 * SPACE.PAD_Y);
		// The dense minimum is shorter than the regular one-line tile.
		expect(LANE.MIN_TILE).toBeLessThan(tileNeeds(1));
		expect(tileNeeds(2) - tileNeeds(1)).toBe(SPACE.LINE_H);
		expect(LANE.TWO_LINE_TITLE).toBeLessThanOrEqual(LANE.MAX_TILE);
		expect(LANE.TWO_LINE_TITLE).toBeGreaterThan(tileNeeds(1));
	});

	test("the meta line is optional in the content block", () => {
		expect(tileContent(1) - tileContent(1, false)).toBe(
			SPACE.ROW_GAP + SPACE.META_H,
		);
	});

	test("the chrome grows by the scrollbar only while the strip overflows", () => {
		expect(laneChrome(true) - laneChrome(false)).toBe(LANE.SCROLLBAR);
		expect(laneChrome(true)).toBe(LANE.CHROME);
	});

	test("an empty open lane is one compact row, not a tile", () => {
		expect(LANE.EMPTY_OPEN).toBeLessThan(LANE.MIN_TILE);
		expect(LANE.EMPTY_OPEN).toBeGreaterThan(LANE.COLLAPSED);
	});
});

describe("laneTile", () => {
	test("short titles take the one-line tile even when the budget is generous", () => {
		expect(laneTile(LANE.MAX_TILE, ["Add dark mode", "Fix it"])).toBe(
			tileNeeds(1),
		);
		expect(laneTile(LANE.MAX_TILE, [])).toBe(tileNeeds(1));
	});

	test("a long title asks for two lines, capped by the budget", () => {
		const long = "x".repeat(LANE.WRAP_CHARS + 1);
		expect(laneTile(LANE.MAX_TILE, ["short", long])).toBe(LANE.MAX_TILE);
		expect(laneTile(LANE.MIN_TILE + 4, [long])).toBe(LANE.MIN_TILE + 4);
		expect(laneTile(tileNeeds(1) + 2, [long])).toBe(tileNeeds(1) + 2);
	});

	test("without a meta line a one-line lane gets no band for it", () => {
		expect(laneTile(LANE.MAX_TILE, ["short"], false)).toBeLessThan(
			laneTile(LANE.MAX_TILE, ["short"], true),
		);
		// two-line titles keep the two-line tile (the title lines follow tile height)
		expect(laneTile(LANE.MAX_TILE, ["x".repeat(60)], false)).toBe(
			LANE.MAX_TILE,
		);
	});

	test("never below the minimum tile", () => {
		expect(laneTile(10, ["x".repeat(80)])).toBe(LANE.MIN_TILE);
	});
});

describe("tileMetrics", () => {
	test("regular tiles keep the scale and centre the content with equal padding", () => {
		for (const tile of [tileNeeds(1), tileNeeds(1) + 5, LANE.MAX_TILE]) {
			const m = tileMetrics(tile);
			expect(m.gap).toBe(SPACE.ROW_GAP);
			expect(m.padY).toBeLessThanOrEqual(SPACE.PAD_Y);
			// content + padding above and below never exceeds the tile
			expect(tileContent(m.lines) + 2 * m.padY).toBeLessThanOrEqual(tile);
		}
		expect(tileMetrics(LANE.MAX_TILE).lines).toBe(2);
		expect(tileMetrics(tileNeeds(1)).padY).toBe(SPACE.PAD_Y);
	});

	test("the dense minimum tightens gap and padding together and still fits", () => {
		const m = tileMetrics(LANE.MIN_TILE);
		expect(m.lines).toBe(1);
		expect(m.gap).toBeLessThan(SPACE.ROW_GAP);
		const content = SPACE.ROW_H + m.gap + SPACE.LINE_H + m.gap + SPACE.META_H;
		expect(content + 2 * m.padY).toBeLessThanOrEqual(LANE.MIN_TILE);
	});
});

describe("laneSizes with empty lanes", () => {
	test("empty open lanes cost one compact row, leaving more for tiles", () => {
		const asTiles = laneSizes({ available: 600, open: 4, collapsed: 2 });
		const withEmpty = laneSizes({
			available: 600,
			open: 2,
			collapsed: 2,
			empty: 2,
		});
		expect(withEmpty.tile).toBeGreaterThanOrEqual(asTiles.tile);
	});
});

describe("visibleTiles", () => {
	test("counts whole tiles", () => {
		expect(visibleTiles(0)).toBe(0);
		expect(visibleTiles(LANE.TILE_W)).toBe(1);
		expect(visibleTiles(LANE.TILE_W * 2 + LANE.TILE_GAP)).toBe(2);
		expect(visibleTiles(LANE.TILE_W * 2 + LANE.TILE_GAP - 1)).toBe(1);
	});
});

describe("wheelScrollLeft", () => {
	const base = {
		deltaX: 0,
		deltaY: 100,
		scrollLeft: 0,
		scrollWidth: 2000,
		clientWidth: 800,
	};
	test("a vertical wheel scrolls an overflowing lane sideways", () => {
		expect(wheelScrollLeft(base)).toBe(100);
	});
	test("clamps to the end and yields at the edge so the page can scroll", () => {
		expect(wheelScrollLeft({ ...base, scrollLeft: 1150 })).toBe(1200);
		expect(wheelScrollLeft({ ...base, scrollLeft: 1200 })).toBeNull();
		expect(wheelScrollLeft({ ...base, deltaY: -50, scrollLeft: 0 })).toBeNull();
	});
	test("a lane that does not overflow, or a horizontal gesture, is left alone", () => {
		expect(wheelScrollLeft({ ...base, scrollWidth: 800 })).toBeNull();
		expect(wheelScrollLeft({ ...base, deltaX: 200, deltaY: 10 })).toBeNull();
	});
});

describe("scrollLeftToReveal", () => {
	const v = { viewport: 500, width: 272 };
	test("leaves a visible card alone", () => {
		expect(scrollLeftToReveal({ ...v, scrollLeft: 100, left: 200 })).toBe(100);
	});
	test("scrolls left or right just enough", () => {
		expect(scrollLeftToReveal({ ...v, scrollLeft: 300, left: 100 })).toBe(92);
		expect(scrollLeftToReveal({ ...v, scrollLeft: 0, left: 600 })).toBe(380);
	});
});

describe("stepFocus", () => {
	const counts = [3, 0, 2, 0, 5];
	test("left and right walk the lane and stop at its ends", () => {
		expect(stepFocus(counts, { lane: 0, index: 0 }, "ArrowRight")).toEqual({
			lane: 0,
			index: 1,
		});
		expect(stepFocus(counts, { lane: 0, index: 2 }, "ArrowRight")).toBeNull();
		expect(stepFocus(counts, { lane: 0, index: 0 }, "ArrowLeft")).toBeNull();
		expect(stepFocus(counts, { lane: 0, index: 1 }, "End")).toEqual({
			lane: 0,
			index: 2,
		});
		expect(stepFocus(counts, { lane: 0, index: 1 }, "Home")).toEqual({
			lane: 0,
			index: 0,
		});
	});
	test("up and down skip empty lanes and clamp the position", () => {
		expect(stepFocus(counts, { lane: 0, index: 2 }, "ArrowDown")).toEqual({
			lane: 2,
			index: 1,
		});
		expect(stepFocus(counts, { lane: 2, index: 1 }, "ArrowDown")).toEqual({
			lane: 4,
			index: 1,
		});
		expect(stepFocus(counts, { lane: 4, index: 3 }, "ArrowUp")).toEqual({
			lane: 2,
			index: 1,
		});
		expect(stepFocus(counts, { lane: 0, index: 0 }, "ArrowUp")).toBeNull();
		expect(stepFocus(counts, { lane: 4, index: 0 }, "ArrowDown")).toBeNull();
	});
});
