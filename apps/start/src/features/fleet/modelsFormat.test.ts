import { describe, expect, test } from "bun:test";

import { formatRate, sinceFor, verdictList } from "./modelsFormat";

describe("models view helpers", () => {
	test("windows map to a lower bound; all time has none", () => {
		const now = Date.parse("2026-10-11T00:00:00Z");
		expect(sinceFor("7d", now)).toBe(now - 7 * 86_400_000);
		expect(sinceFor("all", now)).toBeUndefined();
	});

	test("rates round to whole percents and null is a dash", () => {
		expect(formatRate(0.666)).toBe("67%");
		expect(formatRate(0)).toBe("0%");
		expect(formatRate(null)).toBe("—");
	});

	test("verdicts list review verdicts before critic ones and drop zeros", () => {
		expect(
			verdictList({ "critic:flagged": 1, merge: 2, fix: 1, reject: 0 }),
		).toEqual([
			{ label: "fix", count: 1 },
			{ label: "merge", count: 2 },
			{ label: "critic:flagged", count: 1 },
		]);
	});
});
