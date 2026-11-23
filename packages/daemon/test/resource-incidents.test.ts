import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	HostResourceBinding,
	HostResourceDefinition,
	ObservationHealth,
	StoredObservation,
} from "../src/resources/host-types.ts";
import { RAM_OBSERVATION_MAX_AGE_MS } from "../src/resources/quantity.ts";
import {
	openResourceStore,
	type ResourceStore,
} from "../src/resources/store.ts";
import { type LedgerFixture, openTestLedger } from "./support/host-ledger.ts";

const KEY = "ram-low-headroom:local.ram";
const POOL = {
	id: "local.ram",
	title: "RAM",
	providerHardLimit: false,
	dimensions: [
		{ kind: "quantity" as const, name: "mib", unit: "mib", total: 1024 },
	],
};

describe("durable pool incidents", () => {
	let home: string;
	let store: ResourceStore;
	let now: number;

	const open = () =>
		openResourceStore(home, { now: () => now, processBootId: "boot-a" });

	const lowHeadroom = (observedHeadroomBytes: bigint) => ({
		key: KEY,
		kind: "ram-low-headroom" as const,
		poolId: POOL.id,
		context: { observedHeadroomBytes },
	});

	const transitions = async () =>
		(await store.auditEntries())
			.map((entry) => entry.action)
			.filter((action) => action.startsWith("incident."));

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "mfw-resource-incidents-"));
		now = 1_000;
		store = await open();
		await store.definePool(POOL);
	});

	afterEach(async () => {
		store.close();
		await rm(home, { recursive: true, force: true });
	});

	test("a repeated condition stays one incident with one audit entry", async () => {
		expect(await store.setIncident(lowHeadroom(-5n))).toBe("opened");
		now = 2_000;
		expect(await store.setIncident(lowHeadroom(-9n))).toBe("updated");
		expect(await store.incidents()).toMatchObject([
			{
				key: KEY,
				kind: "ram-low-headroom",
				poolId: POOL.id,
				state: "open",
				openedAt: 1_000,
				updatedAt: 2_000,
				resolvedAt: null,
				context: { observedHeadroomBytes: -9n },
			},
		]);
		expect(await transitions()).toEqual(["incident.opened"]);
	});

	test("recovery resolves once and a relapse reopens with a new start", async () => {
		await store.setIncident(lowHeadroom(-5n));
		now = 2_000;
		expect(await store.setIncident({ ...lowHeadroom(0n), context: null })).toBe(
			"resolved",
		);
		expect(await store.setIncident({ ...lowHeadroom(0n), context: null })).toBe(
			"unchanged",
		);
		expect((await store.incidents())[0]).toMatchObject({
			state: "resolved",
			resolvedAt: 2_000,
		});
		now = 3_000;
		expect(await store.setIncident(lowHeadroom(-1n))).toBe("opened");
		expect((await store.incidents())[0]).toMatchObject({
			state: "open",
			openedAt: 3_000,
			resolvedAt: null,
		});
		expect(await transitions()).toEqual([
			"incident.opened",
			"incident.resolved",
			"incident.opened",
		]);
	});

	test("a condition that never opened records nothing", async () => {
		expect(await store.setIncident({ ...lowHeadroom(0n), context: null })).toBe(
			"unchanged",
		);
		expect(await store.incidents()).toEqual([]);
		expect(await transitions()).toEqual([]);
	});

	test("an open incident and its exact amounts survive a restart", async () => {
		const exact = -(2n ** 62n) - 1n;
		await store.setIncident(lowHeadroom(exact));
		store.close();
		store = await open();
		expect((await store.incidents())[0]).toMatchObject({
			state: "open",
			context: { observedHeadroomBytes: exact },
		});
		expect(await store.setIncident(lowHeadroom(exact))).toBe("updated");
		expect(await transitions()).toEqual(["incident.opened"]);
	});
});

describe("RAM incidents from live observations", () => {
	const GiB = 1n << 30n;
	let home: string;
	let fixture: LedgerFixture;

	const definition = (ignoreObservation = false): HostResourceDefinition => ({
		id: "ram",
		accounting: "quantity",
		quantityUnit: "bytes",
		capacity: 16n * GiB,
		safetyHeadroom: 4n * GiB,
		provisioning: "static",
		enabled: true,
		draining: false,
		version: 1n,
		observationKind: "linux-memory",
		ignoreObservation,
	});

	async function recordMemory(sequence: bigint, memAvailableBytes: bigint) {
		const { ledger, clock } = fixture;
		const model = ledger.readModel();
		const now = clock.now();
		await ledger.observations.recordHealth({
			kind: "linux-memory",
			result: "ok",
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
				latest: {
					memTotalBytes: (32n * GiB).toString(),
					memAvailableBytes: memAvailableBytes.toString(),
					swapTotalBytes: (8n * GiB).toString(),
					swapFreeBytes: (7n * GiB).toString(),
					scope: "host",
				},
			},
		});
		await ledger.applyObservations();
	}

	async function activeRamLease() {
		const { coordinator } = fixture.ledger;
		const waiter = await coordinator.putWaiter({
			requestKey: "active-ram",
			projectId: "a",
			claims: [{ poolId: "local.ram", dimension: "mib", amount: 8 * 1024 }],
		});
		const grant = await coordinator.tryGrant(waiter.id);
		if ("kind" in grant) throw new Error(`held: ${grant.status}`);
		await coordinator.activate(grant, { runId: "run-a" });
		await fixture.ledger.applyObservations();
	}

	const opened = async (action: string) =>
		(await fixture.ledger.coordinator.store.auditEntries()).filter(
			(entry) => entry.action === action,
		);

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "mfw-ram-incidents-"));
		fixture = await openTestLedger(home, { processBootId: "boot-a" });
		await fixture.ledger.putDefinition(definition());
		await recordMemory(1n, 20n * GiB);
		await activeRamLease();
	});

	afterEach(async () => {
		fixture.close();
		await rm(home, { recursive: true, force: true });
	});

	test("low headroom opens once, keeps exact context and resolves on proof", async () => {
		fixture.clock.advance(1_000);
		await recordMemory(2n, 6n * GiB);
		expect(fixture.ledger.readModel().incidents).toMatchObject([
			{
				key: "ram-low-headroom:ram",
				resourceId: "ram",
				state: "open",
				context: {
					memAvailableBytes: 6n * GiB,
					durablePromisesBytes: 8n * GiB,
					observationSequence: 2n,
				},
			},
		]);
		fixture.clock.advance(1_000);
		await recordMemory(3n, 5n * GiB);
		expect(fixture.ledger.readModel().effectiveCapacities[0]).toMatchObject({
			resourceId: "ram",
			configuredQuota: 16n * GiB,
			durablePromises: 8n * GiB,
			effectiveCapacity: 0n,
			holdReason: "headroom-exhausted",
			ramFormula: { attributableManagedBytes: 0n },
		});
		expect(await opened("incident.opened")).toHaveLength(1);
		fixture.clock.advance(1_000);
		await recordMemory(4n, 20n * GiB);
		expect(fixture.ledger.readModel().incidents[0]?.state).toBe("resolved");
		expect(await opened("incident.resolved")).toHaveLength(1);
	});

	test("an explicit ignore policy is not evidence of recovery", async () => {
		fixture.clock.advance(1_000);
		await recordMemory(2n, 6n * GiB);
		await fixture.ledger.putDefinition(definition(true));
		fixture.clock.advance(1_000);
		await recordMemory(3n, 20n * GiB);
		expect(fixture.ledger.readModel().incidents[0]?.state).toBe("open");
	});

	test("expired evidence is not evidence of recovery", async () => {
		fixture.clock.advance(1_000);
		await recordMemory(2n, 6n * GiB);
		fixture.clock.advance(RAM_OBSERVATION_MAX_AGE_MS + 1);
		await fixture.ledger.applyObservations();
		expect(fixture.ledger.readModel().incidents[0]?.state).toBe("open");
	});
});

describe("CPU and GPU incidents from live observations", () => {
	const BOOT = { processBootId: "boot-a", kernelBootId: "kernel-a" };
	let home: string;
	let fixture: LedgerFixture;
	let sequence = 0n;

	const healthOf = (
		kind: string,
		latest?: Record<string, unknown>,
	): ObservationHealth => {
		const now = fixture.clock.now();
		return {
			kind,
			result: "ok",
			checkedAt: now,
			...BOOT,
			detail: {
				generation: { ...BOOT, sequence: sequence.toString() },
				freshness: {
					state: "fresh",
					checkedAt: new Date(now).toISOString(),
					expiresAt: new Date(now + 30_000).toISOString(),
				},
				...(latest ? { latest } : {}),
			},
		};
	};

	async function recordCpu(busyFraction: number) {
		sequence++;
		fixture.clock.advance(100);
		await fixture.ledger.facts.recordObservationBatch(
			healthOf("linux-cpu", { busyFraction, runnableProcesses: 1 }),
			[],
		);
		await fixture.ledger.applyObservations();
	}

	type Device = "idle" | "unknown" | { pid: number; start: string };

	function sample(bindingId: string, device: Device): StoredObservation {
		const occupied = typeof device === "object";
		const evidence = {
			kind: "device-memory",
			source: "nvidia-smi-processes",
			admission: "blocking",
			residentBytes: "10",
			memoryKind: "framebuffer",
		};
		return {
			bindingId,
			kind: "nvidia-gpu",
			sequence,
			result: "ok",
			...BOOT,
			observedAt: fixture.clock.now(),
			durationMs: 1,
			metrics: {
				identity: {
					key: bindingId,
					vendor: "nvidia",
					pciAddress: "0000:65:00.0",
					uuid: bindingId,
					partition: null,
					displayIndex: null,
				},
				gpuUtilization: 0,
				memoryUsedBytes: occupied ? "10" : "0",
				occupancy: {
					state: occupied ? "occupied" : device,
					blocksExclusiveAdmission: occupied,
					deviceEvidence: [],
				},
			},
			occupants: occupied
				? [
						{
							pid: device.pid,
							attribution: "unknown",
							pidStart: {
								status: "verified",
								pid: device.pid,
								startTimeTicks: device.start,
								kernelBootId: BOOT.kernelBootId,
							},
							evidence: [evidence],
						},
					]
				: [],
			warnings: [],
			adapterVersion: "test-1",
		};
	}

	async function recordGpus(devices: Record<string, Device>) {
		sequence++;
		fixture.clock.advance(100);
		await fixture.ledger.facts.recordObservationBatch(
			healthOf("nvidia-gpu"),
			Object.entries(devices).map(([id, device]) => sample(id, device)),
		);
		await fixture.ledger.applyObservations();
	}

	const binding = (id: string): HostResourceBinding => ({
		id,
		resourceId: "gpu",
		stableKey: id,
		enabled: true,
		version: 1n,
	});

	async function lease(
		poolId: string,
		dimension: string,
		run: { runId: string; pid?: number; processStartTime?: string },
	) {
		const { coordinator } = fixture.ledger;
		const waiter = await coordinator.putWaiter({
			requestKey: `lease-${run.runId}`,
			projectId: "a",
			claims: [{ poolId, dimension, amount: 1 }],
		});
		const grant = await coordinator.tryGrant(waiter.id);
		if ("kind" in grant) throw new Error(`held: ${grant.status}`);
		const active = await coordinator.activate(grant, run);
		await fixture.ledger.applyObservations();
		return active;
	}

	const incident = (key: string) =>
		fixture.ledger.readModel().incidents.find((item) => item.key === key);

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "mfw-observed-incidents-"));
		fixture = await openTestLedger(home, BOOT);
		sequence = 0n;
	});

	afterEach(async () => {
		fixture.close();
		await rm(home, { recursive: true, force: true });
	});

	async function defineCpu() {
		await fixture.ledger.putDefinition({
			id: "cpu",
			accounting: "quantity",
			quantityUnit: "integer",
			provisioning: "static",
			capacity: 4n,
			enabled: true,
			draining: false,
			version: 1n,
			observationKind: "linux-cpu",
			cpuPressure: { maxBusyFraction: 0.8 },
		});
		await recordCpu(0.1);
	}

	async function defineGpus() {
		await fixture.ledger.putDefinition({
			id: "gpu",
			accounting: "slot",
			provisioning: "static",
			capacity: 2n,
			enabled: true,
			draining: false,
			version: 1n,
			observationKind: "nvidia-gpu",
		});
		await fixture.ledger.putBinding(binding("gpu-a"));
		await fixture.ledger.putBinding(binding("gpu-b"));
		await recordGpus({ "gpu-a": "idle", "gpu-b": "idle" });
	}

	test("CPU pressure over a live lease opens and resolves one incident", async () => {
		await defineCpu();
		await recordCpu(0.95);
		expect(incident("cpu-pressure:cpu")).toBeUndefined();
		await recordCpu(0.1);
		const held = await lease("local.cpu", "permits", { runId: "run-cpu" });
		await recordCpu(0.95);
		expect(incident("cpu-pressure:cpu")).toMatchObject({
			state: "open",
			context: {
				reason: "cpu-pressure",
				leaseIds: [held.id],
				cpuPressure: { busyFraction: 0.95, busyBlocked: true },
			},
		});
		await recordCpu(0.1);
		expect(incident("cpu-pressure:cpu")?.state).toBe("resolved");
	});

	test("a foreign process on a leased GPU opens a conflict", async () => {
		await defineGpus();
		const held = await lease("local.gpu", "slot", {
			runId: "run-gpu",
			pid: 100,
			processStartTime: "111",
		});
		const [unit] = (
			await fixture.ledger.coordinator.store.allocations("local.gpu")
		).flatMap((allocation) => allocation.units);
		if (!unit) throw new Error("expected a GPU unit");
		const other = unit === "gpu-a" ? "gpu-b" : "gpu-a";

		// The run's own process, and a stranger on the unleased device: no conflict.
		await recordGpus({
			[unit]: { pid: 100, start: "111" },
			[other]: { pid: 900, start: "999" },
		});
		expect(incident("gpu-occupancy-conflict:gpu")).toBeUndefined();

		await recordGpus({
			[unit]: { pid: 900, start: "999" },
			[other]: "idle",
		});
		expect(incident("gpu-occupancy-conflict:gpu")).toMatchObject({
			state: "open",
			context: {
				reason: "external-occupancy",
				leaseIds: [held.id],
				blockedUnits: [unit],
				gpuOccupancy: [
					{ bindingId: unit, occupants: [{ attribution: "external" }] },
				],
			},
		});

		// An unknown device proves nothing, so the conflict stays open.
		await recordGpus({ [unit]: "unknown", [other]: "idle" });
		expect(incident("gpu-occupancy-conflict:gpu")?.state).toBe("open");

		await recordGpus({ [unit]: { pid: 100, start: "111" }, [other]: "idle" });
		expect(incident("gpu-occupancy-conflict:gpu")?.state).toBe("resolved");
	});

	test("an occupant without a verified start is an unknown, never ours", async () => {
		await defineGpus();
		await lease("local.gpu", "slot", {
			runId: "run-gpu",
			pid: 100,
			processStartTime: "111",
		});
		const [unit] = (
			await fixture.ledger.coordinator.store.allocations("local.gpu")
		).flatMap((allocation) => allocation.units);
		if (!unit) throw new Error("expected a GPU unit");
		sequence++;
		fixture.clock.advance(100);
		const unverified = sample(unit, { pid: 100, start: "111" });
		unverified.occupants = [
			{
				...(unverified.occupants[0] as Record<string, unknown>),
				pidStart: { status: "unavailable", pid: 100, reason: "not-sampled" },
			},
		];
		await fixture.ledger.facts.recordObservationBatch(healthOf("nvidia-gpu"), [
			unverified,
		]);
		await fixture.ledger.applyObservations();
		expect(incident("gpu-occupancy-conflict:gpu")).toMatchObject({
			state: "open",
			context: { reason: "unknown-occupancy" },
		});
	});

	test("the read model explains capacity, holds and occupants", async () => {
		await defineCpu();
		await defineGpus();
		await lease("local.gpu", "slot", {
			runId: "run-gpu",
			pid: 100,
			processStartTime: "111",
		});
		const [unit] = (
			await fixture.ledger.coordinator.store.allocations("local.gpu")
		).flatMap((allocation) => allocation.units);
		if (!unit) throw new Error("expected a GPU unit");
		const other = unit === "gpu-a" ? "gpu-b" : "gpu-a";
		await recordGpus({
			[unit]: { pid: 100, start: "111" },
			[other]: { pid: 900, start: "999" },
		});
		await recordCpu(0.95);
		await fixture.ledger.coordinator.placeOperatorHold({
			poolId: "local.cpu",
			actor: "owner",
			detail: "maintenance",
		});
		await fixture.ledger.applyObservations();
		const model = fixture.ledger.readModel();
		expect(model.observations.map((item) => item.bindingId).sort()).toEqual([
			"gpu-a",
			"gpu-b",
		]);
		const attribution = Object.fromEntries(
			model.occupants.map((item) => [
				item.bindingId,
				item.occupants[0]?.attribution,
			]),
		);
		expect(attribution).toEqual({ [unit]: "managed", [other]: "external" });
		const cpu = model.effectiveCapacities.find((c) => c.resourceId === "cpu");
		expect(cpu).toMatchObject({
			holdReason: "operator",
			effectiveCapacity: 0n,
			cpuPressure: { busyFraction: 0.95, busyBlocked: true },
			observation: { kind: "linux-cpu", policy: "required" },
		});
		expect(model.holds.find((h) => h.resourceId === "cpu")).toMatchObject({
			state: "open",
			reason: "operator",
			diagnostic: { message: "maintenance" },
		});
	});

	test("releasing the last lease resolves a conflict", async () => {
		await defineGpus();
		const held = await lease("local.gpu", "slot", { runId: "run-gpu" });
		const [unit] = (
			await fixture.ledger.coordinator.store.allocations("local.gpu")
		).flatMap((allocation) => allocation.units);
		if (!unit) throw new Error("expected a GPU unit");
		await recordGpus({ [unit]: { pid: 900, start: "999" } });
		expect(incident("gpu-occupancy-conflict:gpu")?.state).toBe("open");
		await fixture.ledger.coordinator.release(held, "done");
		await fixture.ledger.applyObservations();
		expect(incident("gpu-occupancy-conflict:gpu")?.state).toBe("resolved");
	});
});
