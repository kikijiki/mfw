import { describe, expect, test } from "bun:test";
import { capacityUsage, usageDigestLines } from "../src/brain-runtime/reads.ts";
import type { UsageSubscription } from "../src/usage-monitor.ts";

const NOW = 1_000_000;
const sub = (over: Partial<UsageSubscription>): UsageSubscription => ({
	provider: "claude-cli",
	name: "Claude Code",
	accountLabel: "max",
	windows: [],
	fetchedAt: NOW,
	status: "ok",
	...over,
});

describe("brain capacity: subscription usage", () => {
	test("capacityUsage keeps only what routing needs, with minutes to reset", () => {
		const out = capacityUsage(
			[
				sub({
					windows: [
						{
							label: "5h",
							usedPercent: 91.4,
							resetsAt: NOW + 133 * 60_000,
							windowMinutes: 300,
							source: "x",
						},
						{
							label: "7d",
							usedPercent: 10,
							resetsAt: null,
							windowMinutes: 10_080,
							source: "x",
						},
					],
				}),
			],
			NOW,
		);
		expect(out).toEqual([
			{
				provider: "claude-cli",
				status: "ok",
				windows: [
					{ label: "5h", usedPercent: 91, resetsInMinutes: 133 },
					{ label: "7d", usedPercent: 10, resetsInMinutes: null },
				],
			},
		]);
	});

	test("the digest mentions windows at 80% and up, stale ones marked, and unknown providers", () => {
		const lines = usageDigestLines([
			{
				provider: "claude-cli",
				status: "ok",
				windows: [
					{ label: "5h", usedPercent: 96, resetsInMinutes: 40 },
					{ label: "7d", usedPercent: 30, resetsInMinutes: 5000 },
				],
			},
			{
				provider: "codex-cli",
				status: "stale",
				windows: [{ label: "7d", usedPercent: 85, resetsInMinutes: null }],
			},
			{ provider: "other", status: "unavailable", windows: [] },
		]);
		expect(lines).toEqual([
			"Subscription windows nearly used: claude-cli 5h 96%, resets in 40m; codex-cli 7d 85% (stale).",
			"Subscription usage unknown for: other.",
		]);
	});

	test("a quiet fleet adds nothing to the digest", () => {
		expect(
			usageDigestLines([
				{
					provider: "claude-cli",
					status: "ok",
					windows: [{ label: "5h", usedPercent: 12, resetsInMinutes: 10 }],
				},
			]),
		).toEqual([]);
	});
});
