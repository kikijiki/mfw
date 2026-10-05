import { describe, expect, test } from "bun:test";
import {
	cpuObservationFromHealth,
	evaluateRamFormula,
	memoryObservationFromHealth,
	memoryObservationFromSample,
	RAM_OBSERVATION_MAX_AGE_MS,
} from "../src/host-resources/index.ts";
import type {
	ObservationHealth,
	StoredObservation,
} from "../src/host-resources/types.ts";

const NOW = Date.parse("2026-08-24T00:00:10.000Z");
const identity = { processBootId: "process-current", kernelBootId: "kernel-a" };

function mfw92Health(
	overrides: Partial<ObservationHealth> = {},
	latest: Record<string, unknown> | null = {
		memTotalBytes: "34359738368",
		memAvailableBytes: "21474836480",
		swapTotalBytes: "8589934592",
		swapFreeBytes: "7516192768",
		scope: "host",
	},
): ObservationHealth {
	const checkedAt = overrides.checkedAt ?? NOW - 1_000;
	const processBootId = overrides.processBootId ?? identity.processBootId;
	const kernelBootId = overrides.kernelBootId ?? identity.kernelBootId;
	return {
		kind: "linux-memory",
		result: "ok",
		checkedAt,
		processBootId,
		kernelBootId,
		detail: {
			adapterVersion: "mfw-linux-memory-v1",
			tool: { name: "procfs", version: "linux" },
			generation: {
				processBootId,
				kernelBootId,
				sequence: "17",
			},
			freshness: {
				state: "fresh",
				checkedAt: new Date(checkedAt).toISOString(),
				expiresAt: new Date(
					checkedAt + RAM_OBSERVATION_MAX_AGE_MS,
				).toISOString(),
			},
			diagnostics: [],
			latest,
		},
		...overrides,
	};
}

function cpuHealth(
	overrides: Partial<ObservationHealth> = {},
	latest: Record<string, unknown> | null = {
		busyFraction: 0.75,
		runnableProcesses: 3,
	},
): ObservationHealth {
	const checkedAt = overrides.checkedAt ?? NOW - 1_000;
	const processBootId = overrides.processBootId ?? identity.processBootId;
	const kernelBootId = overrides.kernelBootId ?? identity.kernelBootId;
	return {
		kind: "linux-cpu",
		result: "ok",
		checkedAt,
		processBootId,
		kernelBootId,
		detail: {
			generation: {
				processBootId,
				kernelBootId,
				sequence: "19",
			},
			freshness: {
				state: "fresh",
				checkedAt: new Date(checkedAt).toISOString(),
				expiresAt: new Date(
					checkedAt + RAM_OBSERVATION_MAX_AGE_MS,
				).toISOString(),
			},
			latest,
		},
		...overrides,
	};
}

describe("RAM quantity policy", () => {
	test("evaluates the exact C/H/A/L/U/R equation", () => {
		const idle = evaluateRamFormula({
			configuredQuotaBytes: 100n,
			safetyHeadroomBytes: 10n,
			memAvailableBytes: 100n,
			durablePromisesBytes: 0n,
			attributableManagedBytes: 0n,
			requestBytes: 50n,
		});
		expect(idle).toMatchObject({
			outstandingPromiseBytes: 0n,
			quotaRemainingBytes: 100n,
			observedHeadroomBytes: 90n,
			effectiveCapacityBytes: 90n,
			allowed: true,
		});

		const attributed = evaluateRamFormula({
			configuredQuotaBytes: 100n,
			safetyHeadroomBytes: 10n,
			memAvailableBytes: 80n,
			durablePromisesBytes: 60n,
			attributableManagedBytes: 20n,
			requestBytes: 30n,
		});
		expect(attributed).toMatchObject({
			outstandingPromiseBytes: 40n,
			observedHeadroomBytes: 30n,
			effectiveCapacityBytes: 30n,
			allowed: true,
		});

		const conservative = evaluateRamFormula({
			configuredQuotaBytes: 100n,
			safetyHeadroomBytes: 10n,
			memAvailableBytes: 80n,
			durablePromisesBytes: 60n,
			attributableManagedBytes: 0n,
			requestBytes: 30n,
		});
		expect(conservative).toMatchObject({
			outstandingPromiseBytes: 60n,
			observedHeadroomBytes: 10n,
			effectiveCapacityBytes: 10n,
			allowed: false,
			blockedBy: "headroom",
		});
	});

	test("unmanaged consumption and the safety floor reduce headroom", () => {
		const low = evaluateRamFormula({
			configuredQuotaBytes: 100n,
			safetyHeadroomBytes: 20n,
			memAvailableBytes: 35n,
			durablePromisesBytes: 20n,
			attributableManagedBytes: 0n,
			requestBytes: 1n,
		});
		expect(low.observedHeadroomBytes).toBe(-5n);
		expect(low.effectiveCapacityBytes).toBe(0n);
		expect(low.allowed).toBe(false);
		expect(low.blockedBy).toBe("headroom");
	});

	test("attribution is clamped to promises and inconsistent ledgers reject", () => {
		expect(
			evaluateRamFormula({
				configuredQuotaBytes: 100n,
				safetyHeadroomBytes: 10n,
				memAvailableBytes: 20n,
				durablePromisesBytes: 5n,
				attributableManagedBytes: 99n,
				requestBytes: 10n,
			}).attributableManagedBytes,
		).toBe(5n);
		expect(() =>
			evaluateRamFormula({
				configuredQuotaBytes: 10n,
				safetyHeadroomBytes: 0n,
				memAvailableBytes: 10n,
				durablePromisesBytes: 11n,
				attributableManagedBytes: 0n,
				requestBytes: 0n,
			}),
		).toThrow("promises exceed");
	});
});

describe("persisted linux-memory policy input", () => {
	test("parses MFW-92 decimal-string health without Number conversion", () => {
		const result = memoryObservationFromHealth({
			health: mfw92Health(),
			now: NOW,
			identity,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.memAvailableBytes).toBe(21_474_836_480n);
		expect(result.value.attributableManagedBytes).toBe(0n);
		expect(result.value.diagnostic).toMatchObject({
			sequence: 17n,
			ageMs: 1_000,
			maxAgeMs: RAM_OBSERVATION_MAX_AGE_MS,
			reuse: "serialized-while-fresh",
			policy: "required",
		});
	});

	test("uses only verified managed attribution and otherwise U=0", () => {
		const unavailable = memoryObservationFromHealth({
			health: mfw92Health(
				{},
				{
					memAvailableBytes: "1000",
					scope: "host",
					managedAttribution: {
						state: "unavailable",
					},
				},
			),
			now: NOW,
			identity,
		});
		expect(unavailable.ok && unavailable.value.attributableManagedBytes).toBe(
			0n,
		);
		const verified = memoryObservationFromHealth({
			health: mfw92Health(
				{},
				{
					memAvailableBytes: "1000",
					scope: "host",
					managedAttribution: {
						state: "verified",
						residents: [
							{
								leaseId: "lease-a",
								runId: "run-a",
								pid: 123,
								processStartTime: "98765",
								residentBytes: "900",
							},
						],
					},
				},
			),
			now: NOW,
			identity,
		});
		expect(verified.ok && verified.value.attributableManagedBytes).toBe(900n);
	});

	for (const [name, health, expected] of [
		[
			"stale",
			mfw92Health({ checkedAt: NOW - RAM_OBSERVATION_MAX_AGE_MS - 1 }),
			"observation-stale",
		],
		["failed", mfw92Health({ result: "error" }, null), "observation-failed"],
		[
			"wrong process",
			mfw92Health({ processBootId: "process-old" }),
			"observation-not-current-process",
		],
		[
			"wrong kernel",
			mfw92Health({ kernelBootId: "kernel-old" }),
			"observation-not-current-kernel",
		],
	] as const) {
		test(`fails closed for a ${name} sample`, () => {
			const result = memoryObservationFromHealth({
				health,
				now: NOW,
				identity,
			});
			expect(result).toMatchObject({ ok: false, reason: expected });
		});
	}

	test("rejects impossible readings, wrong kinds, numbers, and missing sequence", () => {
		for (const health of [
			mfw92Health(
				{},
				{
					memTotalBytes: "10",
					memAvailableBytes: "11",
					scope: "host",
				},
			),
			mfw92Health({}, { memAvailableBytes: 10, scope: "host" }),
			mfw92Health(
				{},
				{
					memAvailableBytes: "10",
					scope: "host",
					managedAttribution: {
						state: "verified",
						managedResidentBytes: "9",
					},
				},
			),
			{ ...mfw92Health(), kind: "linux-cpu" },
			{
				...mfw92Health(),
				detail: { ...mfw92Health().detail, generation: {} },
			},
		] as ObservationHealth[]) {
			expect(
				memoryObservationFromHealth({ health, now: NOW, identity }),
			).toMatchObject({ ok: false, reason: "observation-inconsistent" });
		}
	});

	test("explicit ignore policy is visible and never fabricates observed capacity", () => {
		const result = memoryObservationFromHealth({
			health: mfw92Health({ result: "unsupported" }, null),
			now: NOW,
			identity,
			ignoreObservation: true,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toMatchObject({
			ignored: true,
			memAvailableBytes: 0n,
			attributableManagedBytes: 0n,
			diagnostic: { policy: "ignored-explicitly" },
		});
	});

	test("explicit ignore consistently covers stale and unsupported observations", () => {
		for (const health of [
			mfw92Health({ checkedAt: NOW - RAM_OBSERVATION_MAX_AGE_MS - 1 }),
			mfw92Health({ result: "unsupported" }, null),
		]) {
			const required = memoryObservationFromHealth({
				health,
				now: NOW,
				identity,
			});
			expect(required.ok).toBe(false);
			const ignored = memoryObservationFromHealth({
				health,
				now: NOW,
				identity,
				ignoreObservation: true,
			});
			expect(ignored).toMatchObject({
				ok: true,
				value: {
					ignored: true,
					memAvailableBytes: 0n,
					diagnostic: { policy: "ignored-explicitly" },
				},
			});
		}
	});

	test("binding samples also require decimal strings or bigint, never JS numbers", () => {
		const sample: StoredObservation = {
			bindingId: "ram:host",
			kind: "linux-memory",
			sequence: 1n,
			result: "ok",
			processBootId: identity.processBootId,
			kernelBootId: identity.kernelBootId,
			observedAt: NOW,
			durationMs: 1,
			metrics: { memAvailableBytes: 1024, scope: "host" },
			occupants: [],
			warnings: [],
		};
		expect(
			memoryObservationFromSample({ sample, now: NOW, identity }),
		).toMatchObject({ ok: false, reason: "observation-inconsistent" });
	});
});

describe("persisted linux-cpu policy input", () => {
	test("keeps configured integer permits while pressure gates admission", () => {
		const result = cpuObservationFromHealth({
			health: cpuHealth(),
			now: NOW,
			identity,
			configuredPermits: 8n,
			policy: { maxBusyFraction: 0.8, maxRunnableProcesses: 4 },
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toMatchObject({
			blocked: false,
			pressure: {
				configuredPermits: 8n,
				busyFraction: 0.75,
				runnableProcesses: 3,
				busyBlocked: false,
				runnableBlocked: false,
			},
		});

		const pressured = cpuObservationFromHealth({
			health: cpuHealth({}, { busyFraction: 0.81, runnableProcesses: 5 }),
			now: NOW,
			identity,
			configuredPermits: 8n,
			policy: { maxBusyFraction: 0.8, maxRunnableProcesses: 4 },
		});
		expect(pressured.ok && pressured.value.blocked).toBe(true);
	});

	for (const [name, health, expected] of [
		[
			"stale",
			cpuHealth({ checkedAt: NOW - RAM_OBSERVATION_MAX_AGE_MS - 1 }),
			"observation-stale",
		],
		["error", cpuHealth({ result: "error" }, null), "observation-failed"],
		[
			"unsupported",
			cpuHealth({ result: "unsupported" }, null),
			"observation-failed",
		],
		[
			"old process",
			cpuHealth({ processBootId: "process-old" }),
			"observation-not-current-process",
		],
		[
			"old kernel",
			cpuHealth({ kernelBootId: "kernel-old" }),
			"observation-not-current-kernel",
		],
	] as const) {
		test(`fails closed for ${name}`, () => {
			expect(
				cpuObservationFromHealth({
					health,
					now: NOW,
					identity,
					configuredPermits: 8n,
					policy: { maxBusyFraction: 0.8 },
				}),
			).toMatchObject({ ok: false, reason: expected });
		});
	}

	test("explicit ignore is typed and degraded without inventing pressure", () => {
		const result = cpuObservationFromHealth({
			health: cpuHealth({ result: "unsupported" }, null),
			now: NOW,
			identity,
			configuredPermits: 8n,
			policy: { maxBusyFraction: 0.8 },
			ignoreObservation: true,
		});
		expect(result).toMatchObject({
			ok: true,
			value: {
				ignored: true,
				degraded: true,
				blocked: false,
				pressure: null,
				diagnostic: { policy: "ignored-explicitly" },
			},
		});
	});
});
