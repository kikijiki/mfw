import { describe, expect, test } from "bun:test";
import { buildFleetSummary, type FleetInputs } from "../src/fleet.ts";
import {
	describeHostHealth,
	HostHealthTracker,
	overallHealth,
	STALE_AFTER_MS,
	TRANSIENT_FAILURES,
} from "../src/host-health.ts";

const NOW = 1_800_000_000_000;

function stored(
	kind: string,
	result: string,
	diagnostics: Array<{ code: string; message: string }> = [],
	checkedAt = NOW - 1000,
) {
	return { kind, result, checkedAt, detail: { diagnostics } };
}

describe("HostHealthTracker", () => {
	test("keeps since for a steady state, resets it on change, counts failures", () => {
		const t = new HostHealthTracker();
		t.record("amd-gpu", "ok", 100);
		t.record("amd-gpu", "error", 200);
		t.record("amd-gpu", "error", 300);
		expect(t.snapshot()["amd-gpu"]).toEqual({
			result: "error",
			since: 200,
			lastOkAt: 100,
			consecutiveFailures: 2,
		});
		t.record("amd-gpu", "ok", 400);
		expect(t.snapshot()["amd-gpu"]).toEqual({
			result: "ok",
			since: 400,
			lastOkAt: 400,
			consecutiveFailures: 0,
		});
	});
});

describe("describeHostHealth", () => {
	test("a degraded AMD probe in KFD fallback names tool-missing, not a bare 'degraded'", () => {
		const item = describeHostHealth(
			stored("amd-gpu", "degraded", [
				{
					code: "partial-observation",
					message:
						"amd-smi is unavailable; KFD sysfs evidence cannot prove device idleness",
				},
				{
					code: "tool-missing",
					message: "amd-smi is not installed; reading KFD instead",
				},
			]),
			{
				result: "degraded",
				since: NOW - 60_000,
				lastOkAt: null,
				consecutiveFailures: 9,
			},
			NOW,
		);
		expect(item).toMatchObject({
			kind: "amd-gpu",
			status: "degraded",
			code: "tool-missing",
			summary: "AMD GPU probe: tool not installed",
			since: NOW - 60_000,
			lastOkAt: null,
			consecutiveFailures: 9,
			transient: false,
		});
		expect(item.affects).toContain("GPU slots are held");
		expect(item.affects).toContain("CPU and RAM-only work is not affected");
		expect(item.hint).toContain("amd-smi");
		expect(item.message).toContain("not installed");
	});

	test("a partial observation says so and carries the probe's sentence", () => {
		const item = describeHostHealth(
			stored("amd-gpu", "error", [
				{
					code: "partial-observation",
					message: "AMD device or process list changed during bounded capture",
				},
			]),
			{
				result: "error",
				since: NOW - 5000,
				lastOkAt: NOW - 6000,
				consecutiveFailures: 1,
			},
			NOW,
		);
		expect(item.summary).toBe("AMD GPU probe: partial observation");
		expect(item.message).toContain("changed during bounded capture");
		expect(item.hint).toContain("clears by itself");
		expect(item.lastOkAt).toBe(NOW - 6000);
	});

	test("a first failure is transient; a repeated or long one is not", () => {
		const one = describeHostHealth(
			stored("amd-gpu", "error", [
				{ code: "partial-observation", message: "churn" },
			]),
			{
				result: "error",
				since: NOW - 5000,
				lastOkAt: NOW - 6000,
				consecutiveFailures: 1,
			},
			NOW,
		);
		expect(one.transient).toBe(true);
		const many = describeHostHealth(
			stored("amd-gpu", "error", [
				{ code: "partial-observation", message: "churn" },
			]),
			{
				result: "error",
				since: NOW - 5000,
				lastOkAt: NOW - 6000,
				consecutiveFailures: TRANSIENT_FAILURES,
			},
			NOW,
		);
		expect(many.transient).toBe(false);
		// A probe that has never been ok (boot warm-up) is transient the same way.
		const never = describeHostHealth(
			stored("amd-gpu", "error", []),
			{
				result: "error",
				since: NOW - 5000,
				lastOkAt: null,
				consecutiveFailures: 1,
			},
			NOW,
		);
		expect(never.transient).toBe(true);
		// ... but not once it has gone on for minutes.
		const old = describeHostHealth(
			stored("amd-gpu", "error", []),
			{
				result: "error",
				since: NOW - 10 * 60_000,
				lastOkAt: null,
				consecutiveFailures: 2,
			},
			NOW,
		);
		expect(old.transient).toBe(false);
	});

	test("an old 'ok' row is reported stale", () => {
		const item = describeHostHealth(
			stored("linux-memory", "ok", [], NOW - STALE_AFTER_MS - 1000),
			undefined,
			NOW,
		);
		expect(item).toMatchObject({ status: "degraded", code: "stale" });
		expect(item.summary).toBe("Memory probe: stale reading");
		expect(item.affects).toContain("RAM-gated");
	});

	test("overall status is the worst item; transient and unsupported items do not count", () => {
		const ok = describeHostHealth(stored("linux-cpu", "ok"), undefined, NOW);
		const bad = describeHostHealth(
			stored("amd-gpu", "degraded", [{ code: "tool-missing", message: "x" }]),
			undefined,
			NOW,
		);
		const unsupported = describeHostHealth(
			stored("nvidia-gpu", "unsupported", [
				{ code: "tool-missing", message: "nvidia-smi missing" },
			]),
			undefined,
			NOW,
		);
		expect(overallHealth([ok, unsupported])).toBe("ok");
		expect(overallHealth([ok, bad, unsupported])).toBe("degraded");
		expect(overallHealth([ok, { ...bad, transient: true }])).toBe("ok");
		expect(overallHealth([])).toBe("unknown");
	});
});

function inputs(over: Partial<FleetInputs>): FleetInputs {
	return {
		now: NOW,
		runs: [],
		sshHosts: [],
		hostModel: {
			definitions: [],
			effectiveCapacities: [],
			leases: [],
			health: [],
		},
		holds: {},
		budgets: [],
		spend: {},
		spendSince: NOW,
		runpod: {
			enabled: false,
			accountId: "main",
			credential: {
				ready: false,
				checkedAt: null,
				validatedAt: null,
				validationError: null,
			},
			gate: { open: true, reason: null, changedAt: NOW },
			settings: { dispatchPaused: false, updatedAt: NOW, reason: "" },
			inventory: { observedAt: null, error: null },
			pods: [],
		} as never,
		openrouter: {
			credential: { ready: false, validatedAt: null, validationError: null },
			checkedAt: null,
			fresh: false,
			error: null,
			key: null,
			credits: { remainingCredits: null },
		} as never,
		...over,
	};
}

describe("fleet local health items", () => {
	test("groups per-probe items, worst overall, with cause and what it affects", () => {
		const s = buildFleetSummary(
			inputs({
				hostModel: {
					definitions: [],
					effectiveCapacities: [],
					leases: [],
					health: [
						{
							...stored("linux-cpu", "ok"),
							processBootId: "p",
							kernelBootId: null,
						},
						{
							...stored("amd-gpu", "degraded", [
								{ code: "tool-missing", message: "amd-smi is not installed" },
							]),
							processBootId: "p",
							kernelBootId: null,
						},
					],
				} as never,
				hostHealthTrack: {
					"amd-gpu": {
						result: "degraded",
						since: NOW - 3_600_000,
						lastOkAt: null,
						consecutiveFailures: 700,
					},
				},
			}),
		);
		const health = s.hosts.find((h) => h.id === "local")?.health;
		expect(health?.state).toBe("degraded");
		expect(health?.detail).toBe("AMD GPU probe: tool not installed");
		expect(health?.items.map((i) => [i.kind, i.status])).toEqual([
			["amd-gpu", "degraded"],
			["linux-cpu", "ok"],
		]);
		expect(health?.items[0]).toMatchObject({
			code: "tool-missing",
			since: NOW - 3_600_000,
			consecutiveFailures: 700,
		});
		expect(health?.items[0]?.affects).toContain("GPU slots are held");
	});

	test("a lone transient probe failure does not turn the machine degraded", () => {
		const s = buildFleetSummary(
			inputs({
				hostModel: {
					definitions: [],
					effectiveCapacities: [],
					leases: [],
					health: [
						{
							...stored("amd-gpu", "error", [
								{ code: "partial-observation", message: "list changed" },
							]),
							processBootId: "p",
							kernelBootId: null,
						},
					],
				} as never,
				hostHealthTrack: {
					"amd-gpu": {
						result: "error",
						since: NOW - 2000,
						lastOkAt: NOW - 7000,
						consecutiveFailures: 1,
					},
				},
			}),
		);
		const health = s.hosts.find((h) => h.id === "local")?.health;
		expect(health?.state).toBe("ok");
		expect(health?.detail).toBeNull();
		expect(health?.items[0]).toMatchObject({
			status: "degraded",
			transient: true,
		});
	});

	test("an unreachable SSH host explains itself", () => {
		const s = buildFleetSummary(
			inputs({
				sshHosts: [
					{
						config: { id: "box", slots: 1 },
						observed: {
							checkedAt: NOW,
							health: "unreachable",
							problems: ["timeout"],
						},
						schedulable: false,
						reason: "is unreachable",
						harnesses: [],
						slots: { resourceId: "remote.box.slots", capacity: 1, inUse: 0 },
					} as never,
				],
			}),
		);
		const item = s.hosts.find((h) => h.id === "box")?.health.items[0];
		expect(item).toMatchObject({ status: "unavailable", code: "unreachable" });
		expect(item?.message).toBe("timeout");
		expect(item?.affects).toContain("No runs are placed");
		expect(item?.hint).toContain("SSH");
	});
});
