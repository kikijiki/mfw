import { describe, expect, test } from "bun:test";
import {
	bindRunPodSafetyDraft,
	editRunPodSafetyDraft,
	markRunPodSafetyConflict,
	runPodSafetyDraftDirty,
	runPodSafetyReview,
	validateRunPodSafetyDraft,
} from "./runpodSafetyDraft";

const policy = (maxHourlyPrice: number) => ({
	enabled: true,
	maxHourlyPrice,
	maxAggregateHourlyPrice: 2,
	maxRuntimeMinutes: 60,
	maxRunSpend: 2,
});

describe("RunPod safety draft concurrency", () => {
	test("submits against the version the operator edited, not a background refresh", () => {
		let binding = bindRunPodSafetyDraft(policy(1), 7);
		binding = editRunPodSafetyDraft(binding, "maxHourlyPrice", "0.8");

		// A query refresh may now expose version 8, but the edit is still based on 7.
		const refreshedServerVersion = 8;
		expect(binding.baseVersion).toBe(7);
		expect(binding.baseVersion).not.toBe(refreshedServerVersion);
		expect(runPodSafetyDraftDirty(binding)).toBe(true);
	});

	test("a conflict blocks retry until an explicit reload rebases the draft", () => {
		let binding = bindRunPodSafetyDraft(policy(1), 7);
		binding = editRunPodSafetyDraft(binding, "maxHourlyPrice", "0.8");
		binding = markRunPodSafetyConflict(binding);
		expect(binding.conflicted).toBe(true);
		expect(binding.baseVersion).toBe(7);

		binding = bindRunPodSafetyDraft(policy(0.9), 8);
		expect(binding).toMatchObject({ baseVersion: 8, conflicted: false });
		expect(runPodSafetyDraftDirty(binding)).toBe(false);
	});

	test("validates every spend limit before review and describes the actual diff", () => {
		const prior = validateRunPodSafetyDraft({
			maxHourlyPrice: "1",
			maxAggregateHourlyPrice: "2",
			maxRuntimeMinutes: "60",
			maxRunSpend: "2",
		});
		const proposed = validateRunPodSafetyDraft({
			maxHourlyPrice: "0.75",
			maxAggregateHourlyPrice: "2",
			maxRuntimeMinutes: "45",
			maxRunSpend: "1.5",
		});
		const review = runPodSafetyReview(proposed, prior, true);
		expect(review).toContain("Maximum per Pod $0.75/hr (was $1.00/hr)");
		expect(review).toContain("Maximum total $2.00/hr (unchanged)");
		expect(review).toContain("Maximum runtime 45 minutes (was 60 minutes)");
		expect(review).toContain("Maximum spend per run $1.50 (was $2.00)");
		expect(() =>
			validateRunPodSafetyDraft({
				maxHourlyPrice: "1",
				maxAggregateHourlyPrice: "2",
				maxRuntimeMinutes: "60",
				maxRunSpend: "0",
			}),
		).toThrow("Per-run spend limit must be greater than zero");
	});
});
