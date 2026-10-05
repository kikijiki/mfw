import { describe, expect, test } from "bun:test";
import type {
	DiscoveryResult,
	GpuDeviceIdentity,
	GpuOccupancyEvidence,
	HostObservation,
	LinuxCpuPressure,
	LinuxMemoryObservation,
	PidStartEvidence,
	ProbeDiagnostic,
} from "../src/host-observation.ts";

describe("portable host observation contract", () => {
	test("generation and freshness require current process and kernel evidence", () => {
		const observation: HostObservation<LinuxCpuPressure> = {
			kind: "linux-cpu",
			adapterVersion: "1",
			tool: { name: "procfs", version: "linux-6.8.0" },
			generation: {
				processBootId: "process-boot-synthetic",
				kernelBootId: "kernel-boot-synthetic",
				sequence: 9n,
			},
			freshness: {
				state: "fresh",
				checkedAt: "2026-08-24T00:00:01.000Z",
				expiresAt: "2026-08-24T00:00:06.000Z",
			},
			observedAt: "2026-08-24T00:00:00.000Z",
			durationMs: 2,
			result: {
				status: "ok",
				value: { busyFraction: 0.25, runnableProcesses: 3 },
				diagnostics: [],
			},
		};
		expect(observation.generation.sequence).toBe(9n);
		expect(observation.freshness.state).toBe("fresh");
	});

	test("unsupported discovery is typed and cannot contain optimistic data", () => {
		const diagnostic: ProbeDiagnostic = {
			code: "tool-missing",
			severity: "warning",
			admissionEffect: "block",
			message: "required tool unavailable",
		};
		const discovery = {
			kind: "nvidia-gpu",
			adapterVersion: "1",
			tool: { name: "nvidia-smi", version: "unavailable" },
			generation: { processBootId: "p", kernelBootId: "k", sequence: 1n },
			freshness: {
				state: "stale",
				checkedAt: "2026-08-24T00:00:00.000Z",
				reason: "different-process-boot",
			},
			observedAt: "2026-08-24T00:00:00.000Z",
			durationMs: 0,
			result: { status: "unsupported", value: null, diagnostics: [diagnostic] },
		} satisfies DiscoveryResult<readonly GpuDeviceIdentity[]>;
		expect(discovery.result.value).toBeNull();
		expect(discovery.result.diagnostics[0]?.admissionEffect).toBe("block");
	});

	test("CPU pressure and RAM availability cannot masquerade as configured capacity", () => {
		const cpu: LinuxCpuPressure = { busyFraction: 0.5, runnableProcesses: 2 };
		const memory: LinuxMemoryObservation = {
			memTotalBytes: 64n * 1024n ** 3n,
			memAvailableBytes: 18_504_421_376n,
			swapTotalBytes: 8n * 1024n ** 3n,
			swapFreeBytes: 7n * 1024n ** 3n,
			scope: "host",
		};
		expect(Object.keys(cpu).sort()).toEqual([
			"busyFraction",
			"runnableProcesses",
		]);
		expect(Object.keys(memory).sort()).toEqual([
			"memAvailableBytes",
			"memTotalBytes",
			"scope",
			"swapFreeBytes",
			"swapTotalBytes",
		]);
		expect("capacity" in cpu).toBe(false);
		expect("reservations" in memory).toBe(false);
	});

	test("partition identity is subordinate to stable PCI and vendor UUID identity", () => {
		const physical: GpuDeviceIdentity = {
			key: "gpu:nvidia:0000:65:00.0:GPU-synthetic",
			vendor: "nvidia",
			pciAddress: "0000:65:00.0",
			uuid: "GPU-synthetic",
			partition: null,
			displayIndex: 0,
		};
		const partition: GpuDeviceIdentity = {
			...physical,
			key: `${physical.key}:nvidia-mig:0:MIG-synthetic`,
			uuid: "MIG-synthetic",
			partition: { kind: "nvidia-mig", id: "0", uuid: "MIG-synthetic" },
		};
		expect(partition.key).not.toBe(physical.key);
		expect(partition.pciAddress).toBe(physical.pciAddress);
	});

	test("PID start evidence distinguishes verified identity from reuse races", () => {
		const verified: PidStartEvidence = {
			status: "verified",
			pid: 4242,
			startTimeTicks: 987654n,
			kernelBootId: "boot-synthetic",
		};
		const raced: PidStartEvidence = {
			status: "raced",
			pid: 4242,
			beforeStartTimeTicks: 987654n,
			afterStartTimeTicks: 999999n,
		};
		expect(verified.status).toBe("verified");
		expect(raced.status).toBe("raced");
	});

	test("KFD evidence is structurally unable to become admission-bearing", () => {
		const evidence = {
			kind: "hsa-queue",
			source: "linux-kfd-debugfs",
			admission: "diagnostic-only",
			queueId: "7001",
		} satisfies GpuOccupancyEvidence;
		expect(evidence.admission).toBe("diagnostic-only");
	});
});
