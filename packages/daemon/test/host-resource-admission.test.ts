import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostHoldEventDiagnosticSchema } from "@mfw/core/events";
import type {
	GpuDeviceObservation,
	PidStartEvidence,
	ProbeCapture,
	ProbeResult,
} from "@mfw/core/host-observation";
import { parseAmdSmi, parseNvidiaSmi } from "../src/host-probe-parsers.ts";
import {
	type HostResourceBinding,
	HostResourceCoordinator,
	type HostResourceDefinition,
	type LeaseLivenessInspector,
	type LivenessEvidence,
	type ObservationHealth,
	openHostResourceStore,
	type StoredObservation,
} from "../src/host-resources/index.ts";

const fixtureRoot = join(import.meta.dir, "fixtures", "host-probes");
const homes: string[] = [];

afterEach(async () => {
	for (const path of homes.splice(0)) {
		await rm(path, { recursive: true, force: true });
	}
});

const unavailable: LeaseLivenessInspector = {
	inspect: async (): Promise<LivenessEvidence> => ({
		status: "unavailable",
		checkedAt: 0,
		kernelBootId: "kernel-a",
	}),
};

function fixture(path: string): string {
	return readFileSync(join(fixtureRoot, path), "utf8");
}

function capture(path: string): ProbeCapture {
	return { outcome: "ok", stdout: fixture(path) };
}

function jsonSafe<T>(value: T): T {
	return JSON.parse(
		JSON.stringify(value, (_key, item) =>
			typeof item === "bigint" ? item.toString() : item,
		),
	) as T;
}

function gpuDefinition(
	id: string,
	kind: "amd-gpu" | "nvidia-gpu",
	capacity = 1n,
): HostResourceDefinition {
	return {
		id,
		accounting: "slot",
		provisioning: "static",
		capacity,
		enabled: true,
		draining: false,
		version: 1n,
		observationKind: kind,
	};
}

function declaredDefinition(id: string): HostResourceDefinition {
	return {
		id,
		accounting: "slot",
		provisioning: "static",
		capacity: 1n,
		enabled: true,
		draining: false,
		version: 1n,
	};
}

function binding(
	id: string,
	resourceId: string,
	stableKey = id,
): HostResourceBinding {
	return {
		id,
		resourceId,
		stableKey,
		enabled: true,
		version: 1n,
	};
}

function idleDevice(key: string): GpuDeviceObservation {
	return {
		identity: {
			key,
			vendor: "nvidia",
			pciAddress: "0000:65:00.0",
			uuid: key,
			partition: null,
			displayIndex: null,
		},
		gpuUtilization: 0,
		memoryUsedBytes: 0n,
		memoryTotalBytes: null,
		temperatureCelsius: null,
		powerWatts: null,
		occupancy: {
			state: "idle",
			occupants: [],
			deviceEvidence: [],
			blocksExclusiveAdmission: false,
		},
	};
}

function observedDevice(
	key: string,
	input: {
		pid: number;
		startTimeTicks: bigint;
		residentBytes?: bigint;
		deviceEvidence?: GpuDeviceObservation["occupancy"]["deviceEvidence"];
	},
): GpuDeviceObservation {
	const residentBytes = input.residentBytes ?? 10n;
	return {
		...idleDevice(key),
		memoryUsedBytes: residentBytes,
		occupancy: {
			state: "occupied",
			blocksExclusiveAdmission: true,
			occupants: [
				{
					pid: input.pid,
					attribution: "unknown",
					pidStart: {
						status: "verified",
						pid: input.pid,
						startTimeTicks: input.startTimeTicks,
						kernelBootId: "kernel-a",
					},
					evidence: [
						{
							kind: "device-memory",
							source: "nvidia-smi-processes",
							admission: "blocking",
							residentBytes,
							memoryKind: "framebuffer",
						},
					],
				},
			],
			deviceEvidence: input.deviceEvidence ?? [],
		},
	};
}

function sampleFor(
	bindingId: string,
	kind: "amd-gpu" | "nvidia-gpu",
	sequence: bigint,
	observedAt: number,
	device: GpuDeviceObservation,
	result: StoredObservation["result"] = "ok",
): StoredObservation {
	const safe = jsonSafe(device) as unknown as Record<string, unknown>;
	return {
		bindingId,
		kind,
		sequence,
		result,
		processBootId: "process-a",
		kernelBootId: "kernel-a",
		observedAt,
		durationMs: 1,
		metrics: {
			identity: safe.identity,
			gpuUtilization: safe.gpuUtilization,
			memoryUsedBytes: safe.memoryUsedBytes,
			occupancy: {
				state: device.occupancy.state,
				blocksExclusiveAdmission: device.occupancy.blocksExclusiveAdmission,
				deviceEvidence: jsonSafe(device.occupancy.deviceEvidence),
			},
		},
		occupants: jsonSafe(device.occupancy.occupants),
		warnings: [],
		adapterVersion: "test-1",
	};
}

function health(
	kind: "amd-gpu" | "nvidia-gpu",
	sequence: bigint,
	checkedAt: number,
	result: ObservationHealth["result"] = "ok",
): ObservationHealth {
	return {
		kind,
		result,
		checkedAt,
		processBootId: "process-a",
		kernelBootId: "kernel-a",
		detail: {
			generation: {
				processBootId: "process-a",
				kernelBootId: "kernel-a",
				sequence: sequence.toString(),
			},
			freshness: {
				state: "fresh",
				checkedAt: new Date(checkedAt).toISOString(),
				expiresAt: new Date(checkedAt + 30_000).toISOString(),
			},
		},
	};
}

function cpuHealthAt(
	sequence: bigint,
	checkedAt: number,
	busyFraction: number,
	runnableProcesses: number,
	result: ObservationHealth["result"] = "ok",
): ObservationHealth {
	return {
		kind: "linux-cpu",
		result,
		checkedAt,
		processBootId: "process-a",
		kernelBootId: "kernel-a",
		detail: {
			generation: {
				processBootId: "process-a",
				kernelBootId: "kernel-a",
				sequence: sequence.toString(),
			},
			freshness: {
				state: "fresh",
				checkedAt: new Date(checkedAt).toISOString(),
				expiresAt: new Date(checkedAt + 30_000).toISOString(),
			},
			latest: result === "ok" ? { busyFraction, runnableProcesses } : null,
		},
	};
}

async function createCoordinator(now: { value: number }) {
	const path = await mkdtemp(join(tmpdir(), "mfw-host-admission-"));
	homes.push(path);
	const store = await openHostResourceStore(path, {
		processBootId: "process-a",
		kernelBootId: "kernel-a",
		now: () => now.value,
	});
	return HostResourceCoordinator.create(store, {
		liveness: unavailable,
		now: () => now.value,
	});
}

async function recordDevices(
	coordinator: HostResourceCoordinator,
	kind: "amd-gpu" | "nvidia-gpu",
	sequence: bigint,
	now: number,
	devices: ReadonlyArray<{ bindingId: string; device: GpuDeviceObservation }>,
	result: StoredObservation["result"] = "ok",
) {
	return coordinator.store.recordObservationBatch(
		health(kind, sequence, now, result),
		devices.map(({ bindingId, device }) =>
			sampleFor(bindingId, kind, sequence, now, device, result),
		),
	);
}

async function waiter(
	coordinator: HostResourceCoordinator,
	requestKey: string,
	resourceId: string,
	bindingId?: string,
) {
	return coordinator.putWaiter({
		requestKey,
		projectId: "project-a",
		requirements: [
			{
				resourceId,
				amount: 1n,
				...(bindingId ? { bindingId } : {}),
			},
		],
	});
}

function parsedDevices(
	result: ProbeResult<GpuDeviceObservation[]>,
): GpuDeviceObservation[] {
	if (result.status === "error" || result.status === "unsupported") {
		throw new Error(`fixture parser failed with ${result.status}`);
	}
	if (!result.value) throw new Error("fixture parser returned no value");
	return result.value;
}

describe("host observation-backed admission", () => {
	test("CPU pressure gates configured integer permits without stopping disjoint work", async () => {
		const now = { value: 5_000 };
		const coordinator = await createCoordinator(now);
		await coordinator.putDefinition({
			id: "cpu",
			accounting: "quantity",
			quantityUnit: "integer",
			provisioning: "static",
			capacity: 4n,
			enabled: true,
			draining: false,
			version: 1n,
			observationKind: "linux-cpu",
			cpuPressure: { maxBusyFraction: 0.8, maxRunnableProcesses: 6 },
		});
		await coordinator.putDefinition(declaredDefinition("disjoint"));
		await coordinator.store.recordObservationBatch(
			cpuHealthAt(1n, now.value, 0.9, 2),
			[],
		);
		const cpu = await coordinator.putWaiter({
			requestKey: "cpu/high",
			projectId: "project-a",
			requirements: [{ resourceId: "cpu", amount: 2n }],
		});
		const disjoint = await waiter(coordinator, "cpu/disjoint", "disjoint");
		const snapshot = coordinator.captureAdmissionSnapshot();
		const held = await coordinator.tryGrant(
			cpu.id,
			snapshot.generation,
			snapshot,
		);
		expect(held).toMatchObject({ kind: "held", reason: "observation" });
		if (!("kind" in held)) return;
		expect(held.diagnostics[0]).toMatchObject({
			reason: "cpu-pressure",
			cpuPressure: {
				configuredPermits: 4n,
				busyFraction: 0.9,
				busyBlocked: true,
			},
		});
		expect(
			"kind" in
				(await coordinator.tryGrant(
					disjoint.id,
					snapshot.generation,
					snapshot,
				)),
		).toBe(false);

		now.value += 100;
		await coordinator.store.recordObservationBatch(
			cpuHealthAt(2n, now.value, 0.5, 2),
			[],
		);
		const recoveredGeneration = (await coordinator.store.readModel())
			.generation;
		const grant = await coordinator.tryGrant(cpu.id, recoveredGeneration);
		expect("kind" in grant).toBe(false);
		if (!("kind" in grant)) {
			expect(grant.allocations).toEqual([
				{ resourceId: "cpu", bindingId: null, amount: 2n },
			]);
		}
		const overCapacity = await coordinator.putWaiter({
			requestKey: "cpu/quantity",
			projectId: "project-a",
			requirements: [{ resourceId: "cpu", amount: 3n }],
		});
		expect(
			await coordinator.tryGrant(overCapacity.id, overCapacity.generation),
		).toMatchObject({ kind: "held", reason: "capacity" });
		coordinator.close();
	});

	test("uses one pinned observation snapshot across a wave while promises remain transactional", async () => {
		const now = { value: 10_000 };
		const coordinator = await createCoordinator(now);
		await coordinator.putDefinition(gpuDefinition("wave", "nvidia-gpu", 2n));
		for (const id of ["wave-a", "wave-b"]) {
			await coordinator.putBinding(binding(id, "wave"));
		}
		await recordDevices(coordinator, "nvidia-gpu", 1n, now.value, [
			{ bindingId: "wave-a", device: idleDevice("wave-a") },
			{ bindingId: "wave-b", device: idleDevice("wave-b") },
		]);
		const first = await waiter(coordinator, "wave/first", "wave");
		const second = await waiter(coordinator, "wave/second", "wave");
		const snapshot = coordinator.captureAdmissionSnapshot();

		const firstGrant = await coordinator.tryGrant(
			first.id,
			snapshot.generation,
			snapshot,
		);
		expect("kind" in firstGrant).toBe(false);
		const secondGrant = await coordinator.tryGrant(
			second.id,
			snapshot.generation,
			snapshot,
		);
		expect("kind" in secondGrant).toBe(false);
		if ("kind" in firstGrant || "kind" in secondGrant) return;
		expect(firstGrant.allocations[0]?.bindingId).not.toBe(
			secondGrant.allocations[0]?.bindingId,
		);
		expect((await coordinator.store.liveLeases()).length).toBe(2);

		await coordinator.putDefinition(gpuDefinition("changed", "amd-gpu", 2n));
		for (const id of ["changed-a", "changed-b"]) {
			await coordinator.putBinding(binding(id, "changed"));
		}
		await recordDevices(coordinator, "amd-gpu", 1n, now.value, [
			{ bindingId: "changed-a", device: idleDevice("changed-a") },
			{ bindingId: "changed-b", device: idleDevice("changed-b") },
		]);
		const beforePoll = await waiter(coordinator, "changed/first", "changed");
		const afterPoll = await waiter(coordinator, "changed/second", "changed");
		const pinned = coordinator.captureAdmissionSnapshot();
		expect(
			"kind" in
				(await coordinator.tryGrant(beforePoll.id, pinned.generation, pinned)),
		).toBe(false);
		now.value += 100;
		await recordDevices(coordinator, "amd-gpu", 2n, now.value, [
			{ bindingId: "changed-a", device: idleDevice("changed-a") },
			{ bindingId: "changed-b", device: idleDevice("changed-b") },
		]);
		expect(
			await coordinator.tryGrant(afterPoll.id, pinned.generation, pinned),
		).toMatchObject({ kind: "held", reason: "generation" });
		coordinator.close();
	});

	test("does not credit a PID observed on a different allocation binding", async () => {
		const now = { value: 20_000 };
		const coordinator = await createCoordinator(now);
		await coordinator.putDefinition(gpuDefinition("gpu", "nvidia-gpu", 2n));
		await coordinator.putBinding(binding("gpu-a", "gpu"));
		await coordinator.putBinding(binding("gpu-b", "gpu"));
		await recordDevices(coordinator, "nvidia-gpu", 1n, now.value, [
			{ bindingId: "gpu-a", device: idleDevice("gpu-a") },
			{ bindingId: "gpu-b", device: idleDevice("gpu-b") },
		]);
		const owner = await waiter(coordinator, "owner", "gpu", "gpu-a");
		const grant = await coordinator.tryGrant(owner.id, owner.generation);
		if ("kind" in grant) throw new Error("owner unexpectedly held");
		await coordinator.activate(grant.id, grant.fence, {
			runId: "run-owner",
			runDir: "/runs/owner",
			pid: 4242,
			processStartTime: "987654",
			kernelBootId: "kernel-a",
		});

		now.value += 100;
		await recordDevices(coordinator, "nvidia-gpu", 2n, now.value, [
			{ bindingId: "gpu-a", device: idleDevice("gpu-a") },
			{
				bindingId: "gpu-b",
				device: observedDevice("gpu-b", {
					pid: 4242,
					startTimeTicks: 987654n,
				}),
			},
		]);
		const attacker = await waiter(coordinator, "cross-binding", "gpu", "gpu-b");
		const held = await coordinator.tryGrant(attacker.id, attacker.generation);
		expect(held).toMatchObject({ kind: "held", reason: "observation" });
		if (!("kind" in held)) return;
		expect(held.diagnostics[0]?.gpuOccupancy?.occupants[0]).toMatchObject({
			pid: 4242,
			attribution: "external",
			runId: null,
			leaseId: null,
			pidStart: { status: "verified", startTimeTicks: "987654" },
		});
		const eventDiagnostic = HostHoldEventDiagnosticSchema.parse(
			jsonSafe(held.diagnostics[0]),
		);
		expect(eventDiagnostic.gpuOccupancy?.occupants[0]).toMatchObject({
			attribution: "external",
			pidStart: { status: "verified", startTimeTicks: "987654" },
			evidence: [{ kind: "device-memory", residentBytes: "10" }],
		});
		expect(() => JSON.stringify(eventDiagnostic)).not.toThrow();
		const storedHold = (await coordinator.store.readModel()).holds.find(
			(item) => item.resourceId === "gpu",
		);
		expect(storedHold?.diagnostic.gpuOccupancy?.occupants[0]).toMatchObject({
			pidStart: { status: "verified", startTimeTicks: "987654" },
			evidence: [{ kind: "device-memory", residentBytes: "10" }],
		});
		await coordinator.tryGrant(attacker.id, attacker.generation);
		expect(
			(await coordinator.store.auditEntries()).filter(
				(entry) => entry.action === "resource.hold.opened",
			),
		).toHaveLength(1);
		coordinator.close();
	});

	test("accounts device-memory explanations in aggregate", async () => {
		const now = { value: 30_000 };
		const coordinator = await createCoordinator(now);
		await coordinator.putDefinition(gpuDefinition("gpu", "nvidia-gpu"));
		await coordinator.putBinding(binding("gpu-a", "gpu"));
		await recordDevices(coordinator, "nvidia-gpu", 1n, now.value, [
			{ bindingId: "gpu-a", device: idleDevice("gpu-a") },
		]);
		const owner = await waiter(coordinator, "aggregate-owner", "gpu", "gpu-a");
		const grant = await coordinator.tryGrant(owner.id, owner.generation);
		if ("kind" in grant) throw new Error("owner unexpectedly held");
		await coordinator.activate(grant.id, grant.fence, {
			runId: "run-owner",
			runDir: "/runs/owner",
			pid: 5151,
			processStartTime: "515100",
			kernelBootId: "kernel-a",
		});

		now.value += 100;
		const ten = 10n * 1024n * 1024n * 1024n;
		const evidence = {
			kind: "device-memory" as const,
			source: "nvidia-smi-device" as const,
			admission: "blocking" as const,
			residentBytes: ten,
			memoryKind: "framebuffer" as const,
		};
		await recordDevices(coordinator, "nvidia-gpu", 2n, now.value, [
			{
				bindingId: "gpu-a",
				device: observedDevice("gpu-a", {
					pid: 5151,
					startTimeTicks: 515100n,
					residentBytes: ten,
					deviceEvidence: [evidence, evidence],
				}),
			},
		]);
		const model = await coordinator.store.readModel();
		const incident = model.incidents.find(
			(item) => item.kind === "gpu-occupancy-conflict",
		);
		expect(incident?.state).toBe("open");
		if (incident?.kind === "gpu-occupancy-conflict") {
			expect(typeof incident.context.observation.sequence).toBe("bigint");
			expect(typeof incident.context.gpuOccupancy?.[0]?.memoryUsedBytes).toBe(
				"bigint",
			);
			expect(
				incident.context.gpuOccupancy?.[0]?.deviceEvidence[0],
			).toMatchObject({ residentBytes: ten.toString() });
		}
		expect(model.occupants[0]?.blocksExclusiveAdmission).toBe(true);
		expect(model.occupants[0]?.occupants[0]?.attribution).toBe("managed");
		expect(model.occupants[0]?.deviceEvidence).toHaveLength(2);
		now.value += 100;
		await recordDevices(coordinator, "nvidia-gpu", 3n, now.value, [
			{
				bindingId: "gpu-a",
				device: observedDevice("gpu-a", {
					pid: 5151,
					startTimeTicks: 515100n,
					residentBytes: ten,
					deviceEvidence: [evidence, evidence],
				}),
			},
		]);
		expect(
			(await coordinator.store.auditEntries()).filter(
				(entry) => entry.action === "incident.opened",
			),
		).toHaveLength(1);

		now.value += 100;
		await recordDevices(coordinator, "nvidia-gpu", 4n, now.value, [
			{
				bindingId: "gpu-a",
				device: observedDevice("gpu-a", {
					pid: 5151,
					startTimeTicks: 515100n,
					residentBytes: ten,
					deviceEvidence: [evidence],
				}),
			},
		]);
		const recovered = await coordinator.store.readModel();
		expect(
			recovered.incidents.find((item) => item.kind === "gpu-occupancy-conflict")
				?.state,
		).toBe("resolved");
		expect(recovered.occupants[0]?.blocksExclusiveAdmission).toBe(false);
		expect(
			(await coordinator.store.auditEntries()).filter(
				(entry) => entry.action === "incident.resolved",
			),
		).toHaveLength(1);
		coordinator.close();
	});

	test("persists the real AMD and NVIDIA occupancy fixture contracts", async () => {
		const now = { value: 40_000 };
		const coordinator = await createCoordinator(now);
		const starts = new Map<number, PidStartEvidence>([
			[
				4242,
				{
					status: "verified",
					pid: 4242,
					startTimeTicks: 987654n,
					kernelBootId: "kernel-a",
				},
			],
		]);
		const amd = parsedDevices(
			parseAmdSmi({
				list: capture("amd/list.json"),
				metrics: capture("amd/metrics-low-utilization.json"),
				processes: capture("amd/processes-low-utilization.json"),
				kfd: capture("amd/kfd-two-queues.json"),
				pidStarts: starts,
			}),
		)[0];
		if (!amd) throw new Error("AMD fixture produced no device");
		await coordinator.putDefinition(gpuDefinition("amd", "amd-gpu"));
		await coordinator.putBinding(binding("amd-a", "amd", amd.identity.key));
		await recordDevices(
			coordinator,
			"amd-gpu",
			1n,
			now.value,
			[{ bindingId: "amd-a", device: amd }],
			"degraded",
		);
		const amdWaiter = await waiter(coordinator, "fixture-amd", "amd");
		const amdHeld = await coordinator.tryGrant(
			amdWaiter.id,
			amdWaiter.generation,
		);
		expect(amdHeld).toMatchObject({ kind: "held", reason: "observation" });
		if (!("kind" in amdHeld)) return;
		const amdDiagnostic = amdHeld.diagnostics[0]?.gpuOccupancy;
		expect(amdDiagnostic?.gpuUtilization).toBe(0.01);
		expect(amdDiagnostic?.memoryUsedBytes).toBe(18_504_421_376n);
		expect(
			amdDiagnostic?.occupants[0]?.evidence.filter(
				(item) => item.kind === "hsa-queue",
			),
		).toHaveLength(2);

		const nvidiaStarts = new Map<number, PidStartEvidence>(
			[6161, 6162].map((pid) => [
				pid,
				{
					status: "verified" as const,
					pid,
					startTimeTicks: BigInt(pid * 100),
					kernelBootId: "kernel-a",
				},
			]),
		);
		const nvidia = parsedDevices(
			parseNvidiaSmi({
				listing: capture("nvidia/listing-mig.txt"),
				metrics: capture("nvidia/metrics-zero.csv"),
				processes: { outcome: "ok", stdout: "" },
				contexts: capture("nvidia/contexts-zero.xml"),
				pidStarts: nvidiaStarts,
			}),
		).filter((device) => device.occupancy.occupants.length > 0);
		expect(nvidia).toHaveLength(2);
		await coordinator.putDefinition(gpuDefinition("nvidia", "nvidia-gpu", 2n));
		for (const [index, device] of nvidia.entries()) {
			await coordinator.putBinding(
				binding(`nvidia-${index}`, "nvidia", device.identity.key),
			);
		}
		await recordDevices(
			coordinator,
			"nvidia-gpu",
			1n,
			now.value,
			nvidia.map((device, index) => ({
				bindingId: `nvidia-${index}`,
				device,
			})),
		);
		const request = await waiter(
			coordinator,
			"fixture-nvidia",
			"nvidia",
			"nvidia-0",
		);
		const result = await coordinator.tryGrant(request.id, request.generation);
		expect(result).toMatchObject({ kind: "held", reason: "observation" });
		if (!("kind" in result)) return;
		expect(result.diagnostics[0]?.gpuOccupancy?.gpuUtilization).toBe(0);
		const contextKinds = (
			await coordinator.store.readModel()
		).occupants.flatMap((item) =>
			item.occupants.flatMap((occupant) =>
				occupant.evidence.flatMap((evidence) =>
					evidence.kind === "compute-context" ? [evidence.contextKind] : [],
				),
			),
		);
		expect(contextKinds).toEqual(expect.arrayContaining(["graphics", "mps"]));
		coordinator.close();
	});

	test("transient adapter errors fail closed only for resources bound to that adapter", async () => {
		const now = { value: 50_000 };
		const coordinator = await createCoordinator(now);
		await coordinator.putDefinition(gpuDefinition("nvidia", "nvidia-gpu"));
		await coordinator.putDefinition(gpuDefinition("amd", "amd-gpu"));
		await coordinator.putDefinition(declaredDefinition("project-token"));
		await coordinator.putBinding(binding("nvidia-a", "nvidia"));
		await coordinator.putBinding(binding("amd-a", "amd"));
		await recordDevices(coordinator, "nvidia-gpu", 1n, now.value, [
			{ bindingId: "nvidia-a", device: idleDevice("nvidia-a") },
		]);
		await recordDevices(coordinator, "amd-gpu", 1n, now.value, [
			{ bindingId: "amd-a", device: idleDevice("amd-a") },
		]);
		now.value += 100;
		await recordDevices(
			coordinator,
			"nvidia-gpu",
			2n,
			now.value,
			[{ bindingId: "nvidia-a", device: idleDevice("nvidia-a") }],
			"error",
		);
		const affected = await waiter(coordinator, "error/nvidia", "nvidia");
		const disjointGpu = await waiter(coordinator, "error/amd", "amd");
		const projectOnly = await waiter(
			coordinator,
			"error/project",
			"project-token",
		);
		const snapshot = coordinator.captureAdmissionSnapshot();
		expect(
			await coordinator.tryGrant(affected.id, snapshot.generation, snapshot),
		).toMatchObject({ kind: "held", reason: "observation" });
		expect(
			"kind" in
				(await coordinator.tryGrant(
					disjointGpu.id,
					snapshot.generation,
					snapshot,
				)),
		).toBe(false);
		expect(
			"kind" in
				(await coordinator.tryGrant(
					projectOnly.id,
					snapshot.generation,
					snapshot,
				)),
		).toBe(false);
		coordinator.close();
	});

	test("restart observations fail closed until explicit audited degraded mode", async () => {
		const now = { value: 60_000 };
		const path = await mkdtemp(join(tmpdir(), "mfw-host-admission-restart-"));
		homes.push(path);
		const firstStore = await openHostResourceStore(path, {
			processBootId: "process-a",
			kernelBootId: "kernel-a",
			now: () => now.value,
		});
		let coordinator = await HostResourceCoordinator.create(firstStore, {
			liveness: unavailable,
			now: () => now.value,
		});
		await coordinator.putDefinition(gpuDefinition("gpu", "nvidia-gpu"));
		await coordinator.putBinding(binding("gpu-a", "gpu"));
		await recordDevices(coordinator, "nvidia-gpu", 1n, now.value, [
			{ bindingId: "gpu-a", device: idleDevice("gpu-a") },
		]);
		coordinator.close();

		const restartedStore = await openHostResourceStore(path, {
			processBootId: "process-b",
			kernelBootId: "kernel-a",
			now: () => now.value,
		});
		coordinator = await HostResourceCoordinator.create(restartedStore, {
			liveness: unavailable,
			now: () => now.value,
		});
		const request = await waiter(coordinator, "restart/required", "gpu");
		const required = await coordinator.tryGrant(request.id, request.generation);
		expect(required).toMatchObject({ kind: "held", reason: "observation" });
		if (!("kind" in required)) return;
		expect(required.diagnostics[0]).toMatchObject({
			reason: "observation-not-current-process",
			observation: { processBootId: "process-a", policy: "required" },
		});

		await coordinator.putDefinition({
			...gpuDefinition("gpu", "nvidia-gpu"),
			ignoreObservation: true,
		});
		const generation = coordinator.readModel().generation;
		const ignored = await coordinator.tryGrant(request.id, generation);
		expect("kind" in ignored).toBe(false);
		const model = coordinator.readModel();
		expect(model.effectiveCapacities[0]).toMatchObject({
			resourceId: "gpu",
			observedCapacity: null,
			degraded: true,
		});
		expect(
			(await coordinator.store.auditEntries()).some(
				(entry) =>
					entry.action === "definition.put" &&
					entry.detail.ignoreObservation === true,
			),
		).toBe(true);
		coordinator.close();
	});
});
