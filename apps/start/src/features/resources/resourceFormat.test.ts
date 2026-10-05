import { describe, expect, test } from "bun:test";
import {
	formatCapacity,
	formatHoldReason,
	isObservationStale,
	observationFreshness,
} from "./resourceFormat";

describe("host resource presentation", () => {
	test("never formats missing observation as configured or effective capacity", () => {
		expect(formatCapacity(null, null)).toBe("Not observed");
		expect(formatCapacity(8n, "integer")).toBe("8");
		expect(formatCapacity(8n * 1024n * 1024n * 1024n, "bytes")).toBe("8 GiB");
		expect(formatCapacity(1536n, "bytes")).toBe("1.5 KiB");
		expect(formatCapacity(18_504_421_376n, "bytes")).toBe("17.2 GiB");
	});

	test("recognizes every identity/freshness stale reason", () => {
		for (const reason of [
			"observation-stale",
			"observation-not-current-process",
			"observation-not-current-kernel",
		]) {
			expect(isObservationStale(reason)).toBe(true);
		}
		expect(isObservationStale("observation-failed")).toBe(false);
		expect(isObservationStale(null)).toBe(false);
	});

	test("derives freshness from both admission reasons and wall-clock expiry", () => {
		const observation = {
			observedAt: 1_000,
			expiresAt: 2_000,
			policy: "required" as const,
		};
		expect(observationFreshness(observation, null, 1_500)).toBe("fresh");
		expect(observationFreshness(observation, null, 2_000)).toBe("stale");
		expect(observationFreshness(observation, "observation-failed", 1_500)).toBe(
			"unavailable",
		);
		expect(observationFreshness(null, "observation-missing", 1_500)).toBe(
			"unavailable",
		);
		expect(observationFreshness(null, null, 1_500)).toBe("not-required");
		expect(
			observationFreshness(
				{ ...observation, policy: "ignored-explicitly" },
				null,
				1_500,
			),
		).toBe("ignored");
	});

	test("renders policy reasons as operator-facing explanations", () => {
		expect(formatHoldReason("observation-inconsistent")).toBe(
			"Hardware observation data is inconsistent",
		);
		expect(formatHoldReason("unknown-occupancy")).toBe(
			"GPU occupancy cannot be verified",
		);
		expect(formatHoldReason("future-policy-reason")).toBe(
			"future policy reason",
		);
	});
});
