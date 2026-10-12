import { describe, expect, test } from "bun:test";

import {
	barRect,
	makeScale,
	panned,
	resolveWindow,
	spanRange,
	ticks,
	WINDOW_PRESETS,
	windowMs,
} from "./timeScale";

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("window presets", () => {
	test("the six presets are the designed lengths", () => {
		expect(WINDOW_PRESETS.map((p) => [p.id, p.ms])).toEqual([
			["15m", 15 * MIN],
			["1h", HOUR],
			["2h", 2 * HOUR],
			["8h", 8 * HOUR],
			["24h", 24 * HOUR],
			["7d", 7 * 24 * HOUR],
		]);
	});

	test("w is read as a preset, a custom length, all, or the default", () => {
		expect(windowMs("8h", NOW)).toBe(8 * HOUR);
		expect(windowMs("90m", NOW)).toBe(90 * MIN);
		expect(windowMs(undefined, NOW)).toBe(2 * HOUR);
		expect(windowMs("nonsense", NOW)).toBe(2 * HOUR);
		expect(windowMs("all", NOW, NOW - 3 * 24 * HOUR)).toBe(3 * 24 * HOUR);
		// an empty board still gets a readable axis
		expect(windowMs("all", NOW, NOW - MIN)).toBe(HOUR);
		expect(windowMs("all", NOW, null)).toBe(HOUR);
		// never wider than 30 days
		expect(windowMs("99w", NOW)).toBe(30 * 24 * HOUR);
		// `fit` is whatever the activity needs, and the 2h default with no data
		expect(windowMs("fit", NOW, null, 50 * MIN)).toBe(50 * MIN);
		expect(windowMs("fit", NOW)).toBe(2 * HOUR);
	});
});

describe("LIVE", () => {
	test("without t the right edge is now and follows it", () => {
		const a = resolveWindow({ w: "1h", now: NOW });
		expect(a).toEqual({ from: NOW - HOUR, to: NOW, live: true });
		const later = resolveWindow({ w: "1h", now: NOW + 5 * MIN });
		expect(later.to).toBe(NOW + 5 * MIN);
		expect(later.live).toBe(true);
	});

	test("a past t anchors the right edge and stops following", () => {
		const t = new Date(NOW - 3 * HOUR).toISOString();
		const win = resolveWindow({ w: "1h", t, now: NOW });
		expect(win.live).toBe(false);
		expect(win.to).toBe(NOW - 3 * HOUR);
		expect(win.from).toBe(NOW - 4 * HOUR);
		// the same window a minute later
		expect(resolveWindow({ w: "1h", t, now: NOW + MIN }).to).toBe(win.to);
	});

	test("a t in the future, or garbage, is live", () => {
		expect(
			resolveWindow({ t: new Date(NOW + HOUR).toISOString(), now: NOW }).live,
		).toBe(true);
		expect(resolveWindow({ t: "later", now: NOW }).live).toBe(true);
	});

	test("panning moves half a window and lands back on live at the edge", () => {
		const win = resolveWindow({ w: "2h", now: NOW });
		const back = panned(win, -1, NOW);
		expect(back).toBe(new Date(NOW - HOUR).toISOString());
		const anchored = resolveWindow({ w: "2h", t: back as string, now: NOW });
		expect(panned(anchored, 1, NOW)).toBeNull();
		expect(panned(win, 1, NOW)).toBeNull();
	});
});

describe("scale and bars", () => {
	const scale = makeScale(NOW - HOUR, NOW, 600);

	test("x and at are inverses", () => {
		expect(scale.x(NOW - HOUR)).toBe(0);
		expect(scale.x(NOW)).toBe(600);
		expect(scale.x(NOW - 30 * MIN)).toBe(300);
		expect(scale.at(300)).toBe(NOW - 30 * MIN);
	});

	test("a span inside the window is a rectangle", () => {
		const r = barRect(scale, NOW - 40 * MIN, NOW - 20 * MIN, NOW);
		expect(r).toEqual({
			x: 200,
			width: 200,
			clippedStart: false,
			clippedEnd: false,
		});
	});

	test("an open span runs to now", () => {
		const r = barRect(scale, NOW - 10 * MIN, null, NOW);
		expect(r?.x).toBe(500);
		expect(r?.width).toBe(100);
	});

	test("spans are clipped to the window and outside ones are dropped", () => {
		const r = barRect(scale, NOW - 2 * HOUR, NOW - 30 * MIN, NOW);
		expect(r?.x).toBe(0);
		expect(r?.width).toBe(300);
		expect(r?.clippedStart).toBe(true);
		expect(barRect(scale, NOW - 3 * HOUR, NOW - 2 * HOUR, NOW)).toBeNull();
		expect(barRect(scale, NOW + MIN, NOW + HOUR, NOW)).toBeNull();
	});

	test("a blip is still two pixels wide", () => {
		const r = barRect(scale, NOW - 30 * MIN, NOW - 30 * MIN, NOW);
		expect(r?.width).toBe(2);
	});
});

describe("ticks", () => {
	test("round numbers, in order, within the budget, inside the window", () => {
		const scale = makeScale(NOW - 2 * HOUR, NOW, 800);
		const t = ticks(scale, 6);
		expect(t.length).toBeGreaterThan(1);
		expect(t.length).toBeLessThanOrEqual(7);
		for (const tick of t) {
			expect(tick.at).toBeGreaterThanOrEqual(scale.from);
			expect(tick.at).toBeLessThanOrEqual(scale.to);
			expect(tick.x).toBeCloseTo(scale.x(tick.at), 5);
			expect(tick.label).toMatch(/^\d\d:\d\d$/);
			expect(new Date(tick.at).getMinutes() % 5).toBe(0);
		}
		expect(t.map((x) => x.at)).toEqual([...t.map((x) => x.at)].sort());
	});

	test("a week reads in days", () => {
		const t = ticks(makeScale(NOW - 7 * 24 * HOUR, NOW, 800), 8);
		expect(t.every((x) => /^[A-Z][a-z]{2} \d+$/.test(x.label))).toBe(true);
	});

	test("no width, no ticks", () => {
		expect(ticks(makeScale(NOW, NOW, 100), 6)).toEqual([]);
		expect(ticks(makeScale(NOW - HOUR, NOW, 100), 0)).toEqual([]);
	});
});

describe("span query range", () => {
	test("covers the window and stays put while LIVE ticks forward", () => {
		const win = resolveWindow({ w: "2h", now: NOW });
		const r = spanRange(win, NOW);
		expect(r.from).toBeLessThanOrEqual(win.from);
		expect(r.to).toBeGreaterThanOrEqual(win.to);
		const later = spanRange(
			resolveWindow({ w: "2h", now: NOW + 30_000 }),
			NOW + 30_000,
		);
		expect(later).toEqual(r);
	});

	test("moves once the window leaves its bucket", () => {
		const r = spanRange(resolveWindow({ w: "1h", now: NOW }), NOW);
		const far = spanRange(
			resolveWindow({ w: "1h", now: NOW + 2 * HOUR }),
			NOW + 2 * HOUR,
		);
		expect(far.to).toBeGreaterThan(r.to);
	});
});
