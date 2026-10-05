import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatIecBytes,
	HostResourceCoordinator,
	type HostResourceDefinition,
	openHostResourceStore,
	parseIecBytes,
	parseIntegerQuantity,
	QuantityParseError,
	RAM_OBSERVATION_MAX_AGE_MS,
} from "../src/host-resources/index.ts";

const homes: string[] = [];

afterEach(async () => {
	for (const path of homes.splice(0)) {
		await rm(path, { recursive: true, force: true });
	}
});

async function tempHome(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "mfw-quantity-"));
	homes.push(path);
	return path;
}

function ramDefinition(
	capacity: bigint,
	safetyHeadroom: bigint,
	ignoreObservation = false,
): HostResourceDefinition {
	return {
		id: "ram",
		accounting: "quantity",
		quantityUnit: "bytes",
		capacity,
		safetyHeadroom,
		provisioning: "static",
		enabled: true,
		draining: false,
		version: 1n,
		observationKind: "linux-memory",
		ignoreObservation,
	};
}

function integerDefinition(
	id: string,
	capacity: bigint,
): HostResourceDefinition {
	return {
		id,
		accounting: "quantity",
		quantityUnit: "integer",
		capacity,
		provisioning: "static",
		enabled: true,
		draining: false,
		version: 1n,
	};
}

async function coordinator(
	path: string,
	processBootId: string,
	now: () => number,
	live = false,
) {
	const store = await openHostResourceStore(path, {
		processBootId,
		kernelBootId: "kernel-a",
		now,
	});
	return HostResourceCoordinator.create(store, {
		now,
		liveness: {
			inspect: async () => ({
				status: live ? "live" : "unavailable",
				checkedAt: now(),
				kernelBootId: "kernel-a",
			}),
		},
	});
}

async function recordMemory(
	coordinator: HostResourceCoordinator,
	now: number,
	sequence: bigint,
	memAvailableBytes: bigint,
	overrides: { result?: "ok" | "degraded" | "error" | "unsupported" } = {},
) {
	const model = coordinator.readModel();
	await coordinator.observations.recordHealth({
		kind: "linux-memory",
		result: overrides.result ?? "ok",
		checkedAt: now,
		processBootId: model.processBootId,
		kernelBootId: model.kernelBootId,
		detail: {
			adapterVersion: "mfw-linux-memory-v1",
			tool: { name: "procfs", version: "linux" },
			generation: {
				processBootId: model.processBootId,
				kernelBootId: model.kernelBootId,
				sequence: sequence.toString(),
			},
			freshness: {
				state: "fresh",
				checkedAt: new Date(now).toISOString(),
				expiresAt: new Date(now + RAM_OBSERVATION_MAX_AGE_MS).toISOString(),
			},
			diagnostics: [],
			latest:
				overrides.result && overrides.result !== "ok"
					? null
					: {
							memTotalBytes: (32n << 30n).toString(),
							memAvailableBytes: memAvailableBytes.toString(),
							swapTotalBytes: (8n << 30n).toString(),
							swapFreeBytes: (7n << 30n).toString(),
							scope: "host",
						},
		},
	});
}

describe("quantity normalization", () => {
	test("IEC RAM authoring round-trips canonically", () => {
		for (const [authored, bytes, canonical] of [
			["1 B", 1n, "1 B"],
			["2048 B", 2048n, "2 KiB"],
			["8 GiB", 8n << 30n, "8 GiB"],
			["3 TiB", 3n << 40n, "3 TiB"],
		] as const) {
			expect(parseIecBytes(authored)).toBe(bytes);
			expect(formatIecBytes(bytes)).toBe(canonical);
			expect(parseIecBytes(formatIecBytes(bytes))).toBe(bytes);
		}
	});

	for (const value of [
		"0 GiB",
		"-1 GiB",
		"1.5 GiB",
		"8 GB",
		"8GiB",
		"8 gib",
		"8",
		"8 EiB",
		8,
	]) {
		test(`rejects invalid IEC amount ${String(value)}`, () => {
			expect(() => parseIecBytes(value)).toThrow(QuantityParseError);
		});
	}

	test("integer quantities reject floats, unsafe numbers, strings, zero and negatives", () => {
		for (const value of [1.5, Number.MAX_SAFE_INTEGER + 1, "4", 0, -1]) {
			expect(() => parseIntegerQuantity(value)).toThrow(QuantityParseError);
		}
		expect(parseIntegerQuantity(4)).toBe(4n);
	});
});

describe("durable quantity admission", () => {
	test("two projects cannot spend the same quota or observation promise", async () => {
		const path = await tempHome();
		const clock = Date.parse("2026-08-24T00:00:00Z");
		const now = () => clock;
		const a = await coordinator(path, "process-current", now);
		const b = await coordinator(path, "process-current", now);
		const GiB = 1n << 30n;
		await a.putDefinition(ramDefinition(20n * GiB, 2n * GiB));
		await recordMemory(a, clock, 1n, 12n * GiB);
		const first = await a.putWaiter({
			requestKey: "project-a/run",
			projectId: "project-a",
			requirements: [{ resourceId: "ram", amount: 6n * GiB }],
		});
		const second = await b.putWaiter({
			requestKey: "project-b/run",
			projectId: "project-b",
			requirements: [{ resourceId: "ram", amount: 6n * GiB }],
		});
		const generation = (await a.store.readModel()).generation;
		const raced = await Promise.all([
			a.tryGrant(first.id, generation),
			b.tryGrant(second.id, generation),
		]);
		expect(raced.filter((result) => !("kind" in result))).toHaveLength(1);

		const loser = raced[0] && "kind" in raced[0] ? first : second;
		const held = await a.tryGrant(loser.id, a.readModel().generation);
		expect(held).toMatchObject({
			kind: "held",
			reason: "headroom",
			blockedBy: ["ram"],
			diagnostics: [
				{
					reason: "headroom-exhausted",
					requestedAmount: 6n * GiB,
					durablePromises: 6n * GiB,
					effectiveCapacity: 4n * GiB,
				},
			],
		});
		const live = await a.store.liveLeases();
		expect(live).toHaveLength(1);
		expect(live[0]?.allocations[0]?.amount).toBe(6n * GiB);
		a.close();
		b.close();
	});

	test("integer quantities sum exactly while slot requests remain indivisible", async () => {
		const path = await tempHome();
		const now = () => Date.parse("2026-08-24T00:00:00Z");
		const c = await coordinator(path, "process-current", now);
		await c.putDefinition(integerDefinition("cpu", 7n));
		await c.putDefinition({
			id: "gpu",
			accounting: "slot",
			provisioning: "static",
			capacity: 2n,
			enabled: true,
			draining: false,
			version: 1n,
		});
		const cpu = await c.putWaiter({
			requestKey: "cpu-4",
			projectId: "a",
			requirements: [{ resourceId: "cpu", amount: 4n }],
		});
		expect("kind" in (await c.tryGrant(cpu.id, cpu.generation))).toBe(false);
		const moreCpu = await c.putWaiter({
			requestKey: "cpu-more",
			projectId: "b",
			requirements: [{ resourceId: "cpu", amount: 4n }],
		});
		expect(await c.tryGrant(moreCpu.id, moreCpu.generation)).toMatchObject({
			kind: "held",
			reason: "capacity",
		});
		const invalidSlot = await c.putWaiter({
			requestKey: "gpu-quantity",
			projectId: "b",
			requirements: [{ resourceId: "gpu", amount: 2n }],
		});
		expect(
			await c.tryGrant(invalidSlot.id, invalidSlot.generation),
		).toMatchObject({
			kind: "held",
			reason: "definition",
		});
		c.close();
	});

	test("restart preserves amount, adopts a live owner, and fences stale mutations", async () => {
		const path = await tempHome();
		let clock = Date.parse("2026-08-24T00:00:00Z");
		const now = () => clock;
		let c = await coordinator(path, "process-a", now, true);
		await c.putDefinition(integerDefinition("cpu", 16n));
		const waiter = await c.putWaiter({
			requestKey: "durable-amount",
			projectId: "project-a",
			requirements: [{ resourceId: "cpu", amount: 11n }],
		});
		const grant = await c.tryGrant(waiter.id, waiter.generation);
		if ("kind" in grant) throw new Error("expected grant");
		await c.activate(grant.id, grant.fence, {
			runId: "run-a",
			runDir: "/runs/a",
			pid: 123,
			processStartTime: "fixture-start",
			kernelBootId: "kernel-a",
		});
		c.close();
		clock += 1_000;
		c = await coordinator(path, "process-b", now, true);
		expect((await c.reconcile("startup")).adopted).toBe(1);
		const adopted = c.readModel().leases.find((lease) => lease.id === grant.id);
		expect(adopted).toMatchObject({
			state: "active",
			allocations: [{ resourceId: "cpu", amount: 11n }],
			ownerProcessBootId: "process-b",
		});
		await expect(
			c.cancelOrRelease(grant.id, grant.fence - 1n, "stale"),
		).rejects.toMatchObject({ code: "STALE_FENCE" });
		expect(
			c.readModel().leases.find((lease) => lease.id === grant.id)?.state,
		).toBe("active");
		c.close();
	});

	test("provisional quantity grants are reclaimed exactly once before new dispatch", async () => {
		const path = await tempHome();
		const now = () => Date.parse("2026-08-24T00:00:00Z");
		let c = await coordinator(path, "process-a", now);
		await c.putDefinition(integerDefinition("cpu", 8n));
		const waiter = await c.putWaiter({
			requestKey: "crashed-provisional",
			projectId: "a",
			requirements: [{ resourceId: "cpu", amount: 8n }],
		});
		expect("kind" in (await c.tryGrant(waiter.id, waiter.generation))).toBe(
			false,
		);
		c.close();
		c = await coordinator(path, "process-b", now);
		expect((await c.reconcile("startup")).reclaimed).toBe(1);
		expect((await c.reconcile("manual")).reclaimed).toBe(0);
		const next = await c.putWaiter({
			requestKey: "after-recovery",
			projectId: "b",
			requirements: [{ resourceId: "cpu", amount: 8n }],
		});
		expect("kind" in (await c.tryGrant(next.id, next.generation))).toBe(false);
		c.close();
	});

	test("restart makes persisted RAM observations diagnostic-only until reinjected", async () => {
		const path = await tempHome();
		let clock = Date.parse("2026-08-24T00:00:00Z");
		const now = () => clock;
		const GiB = 1n << 30n;
		let c = await coordinator(path, "process-a", now, true);
		await c.putDefinition(ramDefinition(16n * GiB, 2n * GiB));
		await recordMemory(c, clock, 1n, 20n * GiB);
		const first = await c.putWaiter({
			requestKey: "before-restart",
			projectId: "a",
			requirements: [{ resourceId: "ram", amount: 4n * GiB }],
		});
		const grant = await c.tryGrant(first.id, first.generation);
		if ("kind" in grant) throw new Error("expected grant");
		await c.activate(grant.id, grant.fence, {
			runId: "run-a",
			runDir: "/runs/a",
			kernelBootId: "kernel-a",
		});
		c.close();

		clock += 1_000;
		c = await coordinator(path, "process-b", now, true);
		await c.reconcile("startup");
		const second = await c.putWaiter({
			requestKey: "after-restart",
			projectId: "b",
			requirements: [{ resourceId: "ram", amount: 4n * GiB }],
		});
		expect(await c.tryGrant(second.id, second.generation)).toMatchObject({
			kind: "held",
			reason: "observation",
			diagnostics: [{ reason: "observation-not-current-process" }],
		});
		await recordMemory(c, clock, 1n, 20n * GiB);
		expect(
			"kind" in (await c.tryGrant(second.id, c.readModel().generation)),
		).toBe(false);
		c.close();
	});

	test("effective capacity and low-headroom incident are typed, durable, and deduplicated", async () => {
		const path = await tempHome();
		let clock = Date.parse("2026-08-24T00:00:00Z");
		const now = () => clock;
		const c = await coordinator(path, "process-current", now);
		const GiB = 1n << 30n;
		await c.putDefinition(ramDefinition(16n * GiB, 4n * GiB));
		await recordMemory(c, clock, 1n, 20n * GiB);
		const waiter = await c.putWaiter({
			requestKey: "active-ram",
			projectId: "a",
			requirements: [{ resourceId: "ram", amount: 8n * GiB }],
		});
		const grant = await c.tryGrant(waiter.id, waiter.generation);
		if ("kind" in grant) throw new Error("expected RAM grant");
		await c.activate(grant.id, grant.fence, {
			runId: "run-a",
			runDir: "/runs/a",
			kernelBootId: "kernel-a",
		});

		clock += 1_000;
		await recordMemory(c, clock, 2n, 6n * GiB);
		let model = c.readModel();
		expect(model.effectiveCapacities[0]).toMatchObject({
			resourceId: "ram",
			enforcement: { mode: "admission-control", kernelEnforced: false },
			configuredQuota: 16n * GiB,
			durablePromises: 8n * GiB,
			effectiveCapacity: 0n,
			holdReason: "headroom-exhausted",
			ramFormula: {
				observedHeadroomBytes: -6n * GiB,
				attributableManagedBytes: 0n,
			},
		});
		expect(model.incidents).toHaveLength(1);
		expect(model.incidents[0]).toMatchObject({
			key: "ram-low-headroom:ram",
			state: "open",
			context: {
				memAvailableBytes: 6n * GiB,
				durablePromisesBytes: 8n * GiB,
				observationSequence: 2n,
			},
		});
		await c.putDefinition(ramDefinition(16n * GiB, 4n * GiB, true));
		expect(c.readModel().incidents[0]?.state).toBe("open");
		await c.putDefinition(ramDefinition(16n * GiB, 4n * GiB));

		clock += 1_000;
		await recordMemory(c, clock, 3n, 5n * GiB);
		expect(
			c.readModel().incidents.filter((item) => item.state === "open"),
		).toHaveLength(1);
		expect(
			(await c.store.auditEntries()).filter(
				(entry) => entry.action === "incident.opened",
			),
		).toHaveLength(1);
		const blocked = await c.putWaiter({
			requestKey: "blocked-after-pressure",
			projectId: "b",
			requirements: [{ resourceId: "ram", amount: GiB }],
		});
		expect(await c.tryGrant(blocked.id, blocked.generation)).toMatchObject({
			kind: "held",
			reason: "headroom",
		});

		clock += 1_000;
		await recordMemory(c, clock, 4n, 20n * GiB);
		model = c.readModel();
		expect(model.incidents[0]?.state).toBe("resolved");
		expect(model.leases.find((lease) => lease.id === grant.id)?.state).toBe(
			"active",
		);
		expect(
			(await c.store.auditEntries()).filter(
				(entry) => entry.action === "incident.resolved",
			),
		).toHaveLength(1);
		c.close();
	});

	test("explicit ignore policy remains quota-capped and visible", async () => {
		const path = await tempHome();
		const now = () => Date.parse("2026-08-24T00:00:00Z");
		const c = await coordinator(path, "process-current", now);
		await c.putDefinition(ramDefinition(10n, 2n, true));
		const waiter = await c.putWaiter({
			requestKey: "ignored-observation",
			projectId: "a",
			requirements: [{ resourceId: "ram", amount: 7n }],
		});
		expect("kind" in (await c.tryGrant(waiter.id, waiter.generation))).toBe(
			false,
		);
		const capacity = c.readModel().effectiveCapacities[0];
		expect(capacity).toMatchObject({
			effectiveCapacity: 3n,
			observation: { policy: "ignored-explicitly" },
			ramFormula: null,
		});
		const audit = await c.store.auditEntries();
		expect(
			audit.find((entry) => entry.action === "definition.put")?.detail,
		).toMatchObject({ ignoreObservation: true });
		c.close();
	});

	test("missing observation fails closed unless explicit ignore is audited", async () => {
		const path = await tempHome();
		const now = () => Date.parse("2026-08-24T00:00:00Z");
		const c = await coordinator(path, "process-current", now);
		await c.putDefinition(ramDefinition(10n, 2n));
		const waiter = await c.putWaiter({
			requestKey: "missing-observation",
			projectId: "a",
			requirements: [{ resourceId: "ram", amount: 7n }],
		});
		expect(await c.tryGrant(waiter.id, waiter.generation)).toMatchObject({
			kind: "held",
			reason: "observation",
			diagnostics: [{ reason: "observation-missing" }],
		});
		await c.putDefinition(ramDefinition(10n, 2n, true));
		const grant = await c.tryGrant(waiter.id, c.readModel().generation);
		expect("kind" in grant).toBe(false);
		expect(c.readModel().effectiveCapacities[0]).toMatchObject({
			effectiveCapacity: 3n,
			observation: { policy: "ignored-explicitly", sequence: null },
			ramFormula: null,
		});
		c.close();
	});

	test("ambiguous binding observations fail closed unless explicitly ignored", async () => {
		const path = await tempHome();
		const timestamp = Date.parse("2026-08-24T00:00:00Z");
		const now = () => timestamp;
		const c = await coordinator(path, "process-current", now);
		await c.putDefinition(ramDefinition(10n, 2n));
		for (const id of ["ram:a", "ram:b"]) {
			await c.putBinding({
				id,
				resourceId: "ram",
				stableKey: id,
				enabled: true,
				version: 1n,
			});
			await c.observations.recordSample({
				bindingId: id,
				kind: "linux-memory",
				sequence: 1n,
				result: "ok",
				processBootId: "process-current",
				kernelBootId: "kernel-a",
				observedAt: timestamp,
				durationMs: 1,
				metrics: { memAvailableBytes: "10", scope: "host" },
				occupants: [],
				warnings: [],
			});
		}
		const waiter = await c.putWaiter({
			requestKey: "ambiguous-observation",
			projectId: "a",
			requirements: [{ resourceId: "ram", amount: 1n }],
		});
		expect(await c.tryGrant(waiter.id, waiter.generation)).toMatchObject({
			kind: "held",
			diagnostics: [{ reason: "observation-ambiguous" }],
		});
		await c.putDefinition(ramDefinition(10n, 2n, true));
		expect(
			"kind" in (await c.tryGrant(waiter.id, c.readModel().generation)),
		).toBe(false);
		c.close();
	});
});
