import { describe, expect, test } from "bun:test";

import {
	fitWindowMs,
	kindsOf,
	type LaneItem,
	layoutMarks,
	MARK_PITCH,
} from "./laneLayout";

const MIN = 60_000;

/** A small deterministic PRNG so a failing case is reproducible. */
function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

function randomItems(seed: number, n: number, span: number): LaneItem[] {
	const next = rng(seed);
	return Array.from({ length: n }, (_, i) => ({
		key: `k${i}`,
		at: Math.floor(next() * span),
	}));
}

describe("layoutMarks (property style)", () => {
	const widths = [120, 400, 820, 960];
	for (const seed of [1, 2, 3, 5, 8, 13, 21, 34]) {
		for (const width of widths) {
			test(`seed ${seed}, ${width}px: no overlap, every event in exactly one cluster`, () => {
				const span = 2 * 60 * MIN;
				const items = randomItems(seed, 10 + ((seed * 17) % 120), span);
				const clusters = layoutMarks(items, { from: 0, to: span, width });

				// conservation: each kept item appears once
				const seen = clusters.flatMap((c) => c.members.map((m) => m.key));
				expect(seen.length).toBe(items.length);
				expect(new Set(seen).size).toBe(items.length);
				expect(clusters.reduce((n, c) => n + c.members.length, 0)).toBe(
					items.length,
				);

				// no two clusters closer than the icon pitch (so no two icons overlap)
				for (let i = 1; i < clusters.length; i++) {
					const a = clusters[i - 1];
					const b = clusters[i];
					expect((b?.x ?? 0) - (a?.x ?? 0)).toBeGreaterThanOrEqual(
						MARK_PITCH - 1e-9,
					);
				}
				// and every centre keeps its icon inside the lane
				for (const c of clusters) {
					expect(c.x).toBeGreaterThanOrEqual(0);
					expect(c.x).toBeLessThanOrEqual(width);
				}
			});
		}
	}

	test("events outside the window are dropped, not clamped onto the edge", () => {
		const items: LaneItem[] = [
			{ key: "before", at: -1 },
			{ key: "in", at: 50 },
			{ key: "after", at: 101 },
		];
		const out = layoutMarks(items, { from: 0, to: 100, width: 500 });
		expect(out.map((c) => c.key)).toEqual(["in"]);
	});

	test("zooming in (a narrower window over the same events) never merges clusters", () => {
		const items = randomItems(99, 60, 60 * MIN);
		const wide = layoutMarks(items, { from: 0, to: 60 * MIN, width: 800 });
		// the same pixels over a quarter of the time: fewer events, more spread
		const zoomed = layoutMarks(items, { from: 0, to: 15 * MIN, width: 800 });
		const inZoom = items.filter((i) => i.at <= 15 * MIN).length;
		expect(zoomed.reduce((n, c) => n + c.members.length, 0)).toBe(inZoom);
		const wideInZoomRange = layoutMarks(
			items.filter((i) => i.at <= 15 * MIN),
			{ from: 0, to: 60 * MIN, width: 800 },
		);
		expect(zoomed.length).toBeGreaterThanOrEqual(wideInZoomRange.length);
		expect(wide.length).toBeGreaterThan(0);
	});

	test("two events on the same instant are one cluster; a lone event is its own", () => {
		const out = layoutMarks(
			[
				{ key: "a", at: 10 },
				{ key: "b", at: 10 },
				{ key: "c", at: 90 },
			],
			{ from: 0, to: 100, width: 1000 },
		);
		expect(out.map((c) => c.members.length)).toEqual([2, 1]);
		expect(out[0]?.key).toBe("a");
	});

	test("a cluster's key is its first member's, so it is stable as the window scrolls", () => {
		const items = [
			{ key: "a", at: 100 },
			{ key: "b", at: 101 },
		];
		const one = layoutMarks(items, { from: 0, to: 1000, width: 500 });
		const two = layoutMarks(items, { from: 50, to: 1050, width: 500 });
		expect(one[0]?.key).toBe(two[0]?.key);
	});

	test("kindsOf counts a cluster's members by kind, most frequent first", () => {
		const items = [
			{ key: "a", at: 1, kind: "human" },
			{ key: "b", at: 2, kind: "decision" },
			{ key: "c", at: 3, kind: "decision" },
		];
		const [c] = layoutMarks(items, { from: 0, to: 100, width: 500 });
		expect(kindsOf(c as NonNullable<typeof c>)).toEqual([
			{ kind: "decision", count: 2 },
			{ kind: "human", count: 1 },
		]);
	});
});

describe("fitWindowMs", () => {
	const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);

	test("frames the first event with a little air, to now", () => {
		const ms = fitWindowMs([NOW - 90 * MIN, NOW - 10 * MIN], NOW);
		expect(ms).toBeGreaterThan(90 * MIN);
		expect(ms).toBeLessThan(100 * MIN);
	});

	test("never narrower than 15 minutes, never wider than a week", () => {
		expect(fitWindowMs([NOW - 2 * MIN], NOW)).toBe(15 * MIN);
		expect(
			fitWindowMs([NOW - 3 * 24 * 60 * MIN], NOW, {
				lookbackMs: 30 * 24 * 60 * MIN,
				maxMs: 24 * 60 * MIN,
			}),
		).toBe(24 * 60 * MIN);
	});

	test("an old run does not squeeze today's work: only the last day counts", () => {
		const ms = fitWindowMs([NOW - 40 * 24 * 60 * MIN, NOW - 30 * MIN], NOW);
		expect(ms).toBeLessThan(40 * MIN);
	});

	test("nothing recent means the 2h fallback", () => {
		expect(fitWindowMs([], NOW)).toBe(120 * MIN);
		expect(fitWindowMs([NOW - 10 * 24 * 60 * MIN], NOW)).toBe(120 * MIN);
	});

	test("ignores stamps in the future and non-finite ones", () => {
		expect(fitWindowMs([NOW + MIN, Number.NaN], NOW)).toBe(120 * MIN);
	});
});
