import { describe, expect, test } from "bun:test";
import { cronMatches, parseCron } from "../src/cron.ts";

describe("cron", () => {
	test("wildcard matches anything", () => {
		expect(cronMatches("* * * * *", new Date(2026, 5, 24, 13, 7))).toBe(true);
	});

	test("step values", () => {
		expect(cronMatches("*/15 * * * *", new Date(2026, 0, 1, 0, 30))).toBe(true);
		expect(cronMatches("*/15 * * * *", new Date(2026, 0, 1, 0, 31))).toBe(
			false,
		);
	});

	test("specific minute+hour+dow (Mon 09:30)", () => {
		// 2026-01-05 is a Monday
		expect(cronMatches("30 9 * * 1", new Date(2026, 0, 5, 9, 30))).toBe(true);
		expect(cronMatches("30 9 * * 1", new Date(2026, 0, 6, 9, 30))).toBe(false); // Tuesday
	});

	test("ranges and lists", () => {
		expect(cronMatches("0 9-17 * * 1,3,5", new Date(2026, 0, 5, 12, 0))).toBe(
			true,
		); // Mon noon
		expect(cronMatches("0 9-17 * * 1,3,5", new Date(2026, 0, 5, 18, 0))).toBe(
			false,
		); // 18:00 out of range
	});

	test("Sunday as 7 normalizes to 0", () => {
		expect(parseCron("0 0 * * 7").dow.has(0)).toBe(true);
	});

	test("rejects malformed expressions", () => {
		expect(() => parseCron("* * *")).toThrow();
	});
});
