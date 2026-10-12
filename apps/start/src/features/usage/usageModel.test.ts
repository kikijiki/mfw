import { describe, expect, test } from "bun:test";
import type { UsageSubscription, UsageWindow } from "@mfw/daemon/usage-monitor";

import {
	formatResetIn,
	meterOf,
	resetPhrase,
	severityOf,
	subscriptionOf,
} from "./usageModel";

const NOW = Date.UTC(2027, 0, 20, 12, 0, 0);
const MIN = 60_000;

describe("severityOf", () => {
	test("warns at 80, critical at 95, never earlier", () => {
		expect(severityOf(0)).toBe("ok");
		expect(severityOf(79.9)).toBe("ok");
		expect(severityOf(80)).toBe("warn");
		expect(severityOf(94.9)).toBe("warn");
		expect(severityOf(95)).toBe("critical");
		expect(severityOf(100)).toBe("critical");
	});
});

describe("formatResetIn", () => {
	test("minutes, hours with minutes, days with hours", () => {
		expect(formatResetIn(NOW + 45 * MIN, NOW)).toBe("45m");
		expect(formatResetIn(NOW + (2 * 60 + 13) * MIN, NOW)).toBe("2h13m");
		expect(formatResetIn(NOW + (2 * 60 + 5) * MIN, NOW)).toBe("2h05m");
		expect(formatResetIn(NOW + 3 * 60 * MIN, NOW)).toBe("3h");
		expect(formatResetIn(NOW + (4 * 24 * 60 + 3 * 60 + 30) * MIN, NOW)).toBe(
			"4d 3h",
		);
		expect(formatResetIn(NOW + 2 * 24 * 60 * MIN, NOW)).toBe("2d");
	});

	test("under a minute, in the past, and unknown", () => {
		expect(formatResetIn(NOW + 20_000, NOW)).toBe("<1m");
		expect(formatResetIn(NOW - 1, NOW)).toBe("now");
		expect(formatResetIn(null, NOW)).toBeNull();
		expect(resetPhrase(NOW + 133 * MIN, NOW)).toBe("resets in 2h13m");
		expect(resetPhrase(NOW - 5, NOW)).toBe("resetting now");
		expect(resetPhrase(null, NOW)).toBeNull();
	});
});

const sub = (over: Partial<UsageSubscription> = {}): UsageSubscription => ({
	provider: "claude-cli",
	name: "Claude Code",
	accountLabel: "max",
	fetchedAt: NOW - 5 * MIN,
	status: "ok",
	windows: [
		{
			label: "7d",
			usedPercent: 82.4,
			resetsAt: NOW + 3 * 24 * 60 * MIN,
			windowMinutes: 10_080,
			source: "t",
		},
		{
			label: "5h",
			usedPercent: 21,
			resetsAt: NOW + 133 * MIN,
			windowMinutes: 300,
			source: "t",
		},
	],
	...over,
});

describe("meterOf", () => {
	test("rounds, carries a sentence with severity word and reset", () => {
		const m = meterOf(sub().windows[0] as UsageWindow, NOW, "ok");
		expect(m.percent).toBe(82);
		expect(m.severity).toBe("warn");
		expect(m.text).toBe("7d window: 82% used (high), resets in 3d");
	});

	test("critical names itself and a stale read says so", () => {
		const m = meterOf(
			{ ...(sub().windows[1] as UsageWindow), usedPercent: 97 },
			NOW,
			"stale",
		);
		expect(m.text).toContain("nearly out");
		expect(m.text).toContain("stale");
		expect(m.stale).toBe(true);
	});
});

describe("subscriptionOf", () => {
	test("orders windows short to long and finds the worst", () => {
		const v = subscriptionOf(sub(), NOW);
		expect(v.meters.map((m) => m.label)).toEqual(["5h", "7d"]);
		expect(v.worst?.label).toBe("7d");
		expect(v.note).toBeNull();
		expect(v.summary).toBe("Claude Code (max): 5h 21%, 7d 82%");
	});

	test("unavailable shows the reason and no numbers", () => {
		const v = subscriptionOf(
			sub({
				status: "unavailable",
				windows: [],
				error: "sign-in expired (run claude once to renew)",
			}),
			NOW,
		);
		expect(v.meters).toEqual([]);
		expect(v.worst).toBeNull();
		expect(v.note).toBe(
			"usage unavailable: sign-in expired (run claude once to renew)",
		);
	});

	test("stale keeps numbers but says how old", () => {
		const v = subscriptionOf(
			sub({ status: "stale", error: "usage endpoint unreachable" }),
			NOW,
		);
		expect(v.meters).toHaveLength(2);
		expect(v.note).toBe("stale, read 5m ago (usage endpoint unreachable)");
		expect(v.meters.every((m) => m.stale)).toBe(true);
	});
});
