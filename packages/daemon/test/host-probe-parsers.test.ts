import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	GpuOccupancyEvidence,
	PidStartEvidence,
	ProbeCapture,
} from "@mfw/core/host-observation";
import {
	HOST_PROBE_PARSE_LIMITS,
	parseAmdGpuTop,
	parseAmdKfdFallback,
	parseAmdSmi,
	parseLinuxCpuDiscovery,
	parseLinuxCpuPressure,
	parseNvidiaSmi,
	parsePidStartEvidence,
	parseProcMeminfo,
	parseProcStat,
} from "../src/host-probe-parsers.ts";

const fixtureRoot = join(import.meta.dir, "fixtures", "host-probes");

function fixture(path: string): string {
	return readFileSync(join(fixtureRoot, path), "utf8");
}

function capture(path: string): ProbeCapture {
	return { outcome: "ok", stdout: fixture(path) };
}

function failure(path: string): ProbeCapture {
	return JSON.parse(fixture(`failures/${path}`)) as ProbeCapture;
}

function residentBytes(
	evidence: GpuOccupancyEvidence | undefined,
): bigint | null {
	return evidence?.kind === "device-memory"
		? (evidence.residentBytes ?? null)
		: null;
}

const starts = new Map<number, PidStartEvidence>([
	[
		4242,
		{
			status: "verified",
			pid: 4242,
			startTimeTicks: 987654n,
			kernelBootId: "boot-synthetic",
		},
	],
]);

describe("Linux procfs parsers", () => {
	test("discovers logical permits and parses whitespace-tolerant pressure deltas", () => {
		const discovery = parseLinuxCpuDiscovery(
			capture("proc/stat-after-whitespace.txt"),
		);
		expect(discovery.status).toBe("ok");
		if (discovery.status !== "ok") return;
		expect(discovery.value).toEqual({ logicalProcessors: 2 });

		const pressure = parseLinuxCpuPressure(
			capture("proc/stat-before.txt"),
			capture("proc/stat-after-whitespace.txt"),
		);
		expect(pressure.status).toBe("ok");
		if (pressure.status !== "ok") return;
		expect(pressure.value.busyFraction).toBeCloseTo(0.5);
		expect(pressure.value.runnableProcesses).toBe(3);
		expect("availableLogicalProcessors" in pressure.value).toBe(false);
	});

	test("reports only host MemAvailable normalized from procfs KiB to bytes", () => {
		const result = parseProcMeminfo(capture("proc/meminfo.txt"));
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.value).toEqual({
			memTotalBytes: 65_843_092n * 1024n,
			memAvailableBytes: 48_318_382n * 1024n,
			swapTotalBytes: 8_388_608n * 1024n,
			swapFreeBytes: 7_340_032n * 1024n,
			scope: "host",
		});
	});

	test("missing and malformed proc fields fail closed", () => {
		const missing = parseProcMeminfo(capture("proc/meminfo-missing.txt"));
		expect(missing.status).toBe("error");
		expect(missing.value).toBeNull();
		expect(missing.diagnostics[0]?.code).toBe("missing-field");

		const malformedMemory = parseProcMeminfo(
			capture("proc/meminfo-malformed.txt"),
		);
		expect(malformedMemory.status).toBe("error");
		expect(malformedMemory.diagnostics[0]?.code).toBe("invalid-value");

		const malformedCpu = parseProcStat(capture("proc/stat-malformed.txt"));
		expect(malformedCpu.status).toBe("error");
		expect(malformedCpu.value).toBeNull();
	});

	test("PID start evidence detects reuse/race and preserves verified starts", () => {
		const same = parsePidStartEvidence({
			pid: 4242,
			before: capture("proc/pid-4242-start-a.txt"),
			after: capture("proc/pid-4242-start-a.txt"),
			kernelBootId: "boot-synthetic",
		});
		expect(same.status).toBe("ok");
		if (same.status === "ok") {
			expect(same.value).toEqual({
				status: "verified",
				pid: 4242,
				startTimeTicks: 987654n,
				kernelBootId: "boot-synthetic",
			});
		}

		const reused = parsePidStartEvidence({
			pid: 4242,
			before: capture("proc/pid-4242-start-a.txt"),
			after: capture("proc/pid-4242-start-b.txt"),
		});
		expect(reused.status).toBe("degraded");
		if (reused.status === "degraded") expect(reused.value.status).toBe("raced");
		expect(reused.diagnostics[0]?.code).toBe("pid-reused-or-raced");
	});
});

describe("AMD SMI and conservative KFD parsing", () => {
	test("amdgpu_top adds sensors without weakening live KFD context evidence", () => {
		const result = parseAmdGpuTop({
			topology: {
				outcome: "ok",
				stdout: JSON.stringify({
					nodes: [
						{
							gpuId: "44307\n",
							properties: "vendor_id 4098\ndomain 0\nlocation_id 50688\n",
						},
					],
				}),
			},
			kfd: {
				outcome: "ok",
				stdout: JSON.stringify({
					files: [
						{
							path: "/sys/class/kfd/kfd/proc/4242/vram_44307",
							content: "18504421376\n",
						},
						{
							path: "/sys/class/kfd/kfd/proc/4242/queues/0/gpuid",
							content: "44307\n",
						},
					],
				}),
			},
			metrics: {
				outcome: "ok",
				stdout: JSON.stringify({
					devices: [
						{
							Info: { PCI: "0000:c6:00.0", "GPU Type": "APU" },
							gpu_activity: { GFX: { value: 1, unit: "%" } },
							VRAM: {
								"Total GTT Usage": { value: 1024, unit: "MiB" },
								"Total VRAM Usage": { value: 17648, unit: "MiB" },
								"Total GTT": { value: 65536, unit: "MiB" },
								"Total VRAM": { value: 24576, unit: "MiB" },
							},
							Sensors: {
								"Edge Temperature": { value: 47, unit: "C" },
								"GFX Power": { value: 72.5, unit: "W" },
							},
						},
					],
				}),
			},
			pidStarts: starts,
		});
		expect(result.status).toBe("degraded");
		if (result.status !== "degraded") return;
		const device = result.value[0];
		expect(device?.gpuUtilization).toBe(0.01);
		expect(device?.memoryUsedBytes).toBe(18_504_421_376n);
		expect(device?.memoryTotalBytes).toBe(65_536n * 1024n * 1024n);
		expect(device?.temperatureCelsius).toBe(47);
		expect(device?.powerWatts).toBe(72.5);
		expect(device?.occupancy.state).toBe("unknown");
		expect(device?.occupancy.blocksExclusiveAdmission).toBe(false);
		expect(result.diagnostics[0]?.admissionEffect).toBe("block");
	});

	test("KFD-only fallback maps PCI identity and exposes live contexts without claiming idle", () => {
		const result = parseAmdKfdFallback({
			topology: {
				outcome: "ok",
				stdout: JSON.stringify({
					nodes: [
						{
							gpuId: "44307\n",
							properties: "vendor_id 4098\ndomain 0\nlocation_id 50688\n",
						},
					],
				}),
			},
			kfd: {
				outcome: "ok",
				stdout: JSON.stringify({
					files: [
						{
							path: "/sys/class/kfd/kfd/proc/4242/vram_44307",
							content: "18504421376\n",
						},
						{
							path: "/sys/class/kfd/kfd/proc/4242/queues/0/gpuid",
							content: "44307\n",
						},
						{
							path: "/sys/class/kfd/kfd/proc/4242/queues/1/gpuid",
							content: "44307\n",
						},
					],
				}),
			},
			pidStarts: starts,
		});
		expect(result.status).toBe("degraded");
		if (result.status !== "degraded") return;
		const device = result.value[0];
		expect(device?.identity.pciAddress).toBe("0000:c6:00.0");
		expect(device?.identity.uuid).toBe("KFD-PCI-0000:c6:00.0");
		expect(device?.occupancy.state).toBe("unknown");
		expect(device?.occupancy.blocksExclusiveAdmission).toBe(false);
		expect(device?.occupancy.occupants[0]?.pidStart.status).toBe("verified");
		expect(device?.occupancy.occupants[0]?.evidence).toHaveLength(3);
		expect(result.diagnostics[0]).toEqual(
			expect.objectContaining({
				code: "partial-observation",
				admissionEffect: "block",
			}),
		);
	});

	test("the exact low-utilization two-HSA-queue incident remains occupied", () => {
		const result = parseAmdSmi({
			list: capture("amd/list.json"),
			metrics: capture("amd/metrics-low-utilization.json"),
			processes: capture("amd/processes-low-utilization.json"),
			kfd: capture("amd/kfd-two-queues.json"),
			pidStarts: starts,
		});
		expect(result.status).toBe("degraded");
		if (result.status !== "degraded") return;
		const device = result.value[0];
		if (!device) throw new Error("fixture did not produce an AMD device");
		expect(device.gpuUtilization).toBe(0.01);
		expect(device.memoryUsedBytes).toBe(18_504_421_376n);
		expect(device.occupancy.state).toBe("occupied");
		expect(device.occupancy.blocksExclusiveAdmission).toBe(true);
		expect(residentBytes(device.occupancy.deviceEvidence[0])).toBe(
			18_504_421_376n,
		);
		const evidence = device.occupancy.occupants[0]?.evidence ?? [];
		expect(evidence.filter((item) => item.kind === "hsa-queue")).toHaveLength(
			2,
		);
		expect(
			evidence
				.filter((item) => item.kind === "hsa-queue")
				.every((item) => item.admission === "diagnostic-only"),
		).toBe(true);
		const resident = evidence.find((item) => item.kind === "device-memory");
		expect(
			resident?.kind === "device-memory" ? resident.residentBytes : null,
		).toBe(18_504_421_376n);
	});

	test("KFD queues alone produce degraded unknown evidence, never idle or blocking proof", () => {
		const result = parseAmdSmi({
			list: capture("amd/list.json"),
			metrics: {
				outcome: "ok",
				stdout:
					'[{"gpu":0,"usage":{"gfx_activity":0},"vram":{"used":{"value":0,"unit":"B"}}}]',
			},
			processes: { outcome: "ok", stdout: '[{"gpu":0,"process_list":[]}]' },
			kfd: capture("amd/kfd-two-queues.json"),
		});
		expect(result.status).toBe("degraded");
		if (result.status !== "degraded") return;
		expect(result.value[0]?.occupancy.state).toBe("unknown");
		expect(result.value[0]?.occupancy.blocksExclusiveAdmission).toBe(false);
		expect(result.diagnostics[0]?.code).toBe("kfd-evidence-diagnostic-only");
	});

	test("accepts the canonical KFD sysfs proc root and rejects mixed-root manifests", () => {
		const debugManifest = fixture("amd/kfd-two-queues.json");
		const sysfsManifest = debugManifest.replaceAll(
			"/sys/kernel/debug/kfd/proc",
			"/sys/class/kfd/kfd/proc",
		);
		const sysfs = parseAmdSmi({
			list: capture("amd/list.json"),
			metrics: capture("amd/metrics-low-utilization.json"),
			processes: capture("amd/processes-low-utilization.json"),
			kfd: { outcome: "ok", stdout: sysfsManifest },
			pidStarts: starts,
		});
		expect(sysfs.status).toBe("degraded");
		if (sysfs.status === "degraded") {
			const evidence = sysfs.value[0]?.occupancy.occupants[0]?.evidence ?? [];
			expect(evidence).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ source: "linux-kfd-sysfs" }),
				]),
			);
		}

		const mixedManifest = sysfsManifest.replace(
			"/sys/class/kfd/kfd/proc",
			"/sys/kernel/debug/kfd/proc",
		);
		const mixed = parseAmdSmi({
			list: capture("amd/list.json"),
			metrics: capture("amd/metrics-low-utilization.json"),
			processes: capture("amd/processes-low-utilization.json"),
			kfd: { outcome: "ok", stdout: mixedManifest },
			pidStarts: starts,
		});
		expect(mixed.status).toBe("error");
		expect(mixed.diagnostics[0]?.code).toBe("malformed-output");
	});

	test("normalizes AMD logical partitions with stable partition identity", () => {
		const result = parseAmdSmi({
			list: capture("amd/list-partitions.json"),
			metrics: capture("amd/metrics-partitions.json"),
			processes: capture("amd/processes-empty-partitions.json"),
		});
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.value).toHaveLength(2);
		expect(result.value[0]?.identity.partition?.id).toBe("0");
		expect(result.value[1]?.identity.partition?.id).toBe("1");
		expect(result.value[0]?.identity.key).not.toBe(
			result.value[1]?.identity.key,
		);
	});

	test("ambiguous indices and malformed vendor JSON fail closed", () => {
		const ambiguous = parseAmdSmi({
			list: capture("amd/list-ambiguous.json"),
			metrics: capture("amd/metrics-partitions.json"),
			processes: capture("amd/processes-empty-partitions.json"),
		});
		expect(ambiguous.status).toBe("error");
		expect(ambiguous.value).toBeNull();
		expect(ambiguous.diagnostics[0]?.code).toBe("ambiguous-identity");

		const malformed = parseAmdSmi({
			list: capture("amd/malformed.txt"),
			metrics: capture("amd/metrics-low-utilization.json"),
			processes: capture("amd/processes-low-utilization.json"),
		});
		expect(malformed.status).toBe("error");
		expect(malformed.diagnostics[0]?.code).toBe("malformed-output");
	});

	test("KFD permission uncertainty is degraded and cannot become optimistic idle", () => {
		const result = parseAmdSmi({
			list: capture("amd/list.json"),
			metrics: capture("amd/metrics-low-utilization.json"),
			processes: { outcome: "ok", stdout: '[{"gpu":0,"process_list":[]}]' },
			kfd: failure("permission.json"),
		});
		expect(result.status).toBe("degraded");
		expect(result.diagnostics[0]?.code).toBe("permission-denied");
		expect(result.diagnostics[0]?.admissionEffect).toBe("degrade");
		if (result.status === "degraded")
			expect(result.value[0]?.occupancy.state).toBe("occupied");

		const partial = parseAmdSmi({
			list: capture("amd/list.json"),
			metrics: {
				outcome: "ok",
				stdout:
					'[{"gpu":0,"usage":{"gfx_activity":0},"vram":{"used":{"value":0,"unit":"B"}}}]',
			},
			processes: { outcome: "ok", stdout: '[{"gpu":0,"process_list":[]}]' },
			kfd: { outcome: "ok", stdout: "", truncated: true },
		});
		expect(partial.status).toBe("degraded");
		if (partial.status === "degraded") {
			expect(partial.value[0]?.occupancy.state).toBe("unknown");
			expect(partial.value[0]?.occupancy.blocksExclusiveAdmission).toBe(false);
		}
	});
});

describe("NVIDIA SMI parsing", () => {
	test("maps multiple processes and MIG partitions by UUID, never display order alone", () => {
		const result = parseNvidiaSmi({
			listing: capture("nvidia/listing-mig.txt"),
			metrics: capture("nvidia/metrics.csv"),
			processes: capture("nvidia/processes-multiple.csv"),
		});
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.value).toHaveLength(3);
		const physical = result.value.find(
			(device) =>
				device.identity.uuid === "GPU-00000000-0000-0000-0000-000000000001",
		);
		const mig = result.value.find(
			(device) => device.identity.partition?.kind === "nvidia-mig",
		);
		expect(physical?.occupancy.occupants.map((item) => item.pid)).toEqual([
			5151, 5152,
		]);
		expect(physical?.occupancy.blocksExclusiveAdmission).toBe(true);
		expect(mig?.identity.pciAddress).toBe("0000:65:00.0");
		expect(mig?.occupancy.occupants[0]?.pid).toBe(5153);
		const unattributed = result.value.find(
			(device) =>
				device.identity.uuid === "GPU-00000000-0000-0000-0000-000000000002",
		);
		expect(unattributed?.occupancy.occupants).toEqual([]);
		expect(unattributed?.occupancy.state).toBe("occupied");
		expect(residentBytes(unattributed?.occupancy.deviceEvidence[0])).toBe(
			2048n * 1024n * 1024n,
		);
	});

	test("unknown process UUID and malformed CSV fail closed", () => {
		const ambiguous = parseNvidiaSmi({
			listing: capture("nvidia/listing-mig.txt"),
			metrics: capture("nvidia/metrics.csv"),
			processes: capture("nvidia/processes-ambiguous.csv"),
		});
		expect(ambiguous.status).toBe("error");
		expect(ambiguous.value).toBeNull();
		expect(ambiguous.diagnostics[0]?.code).toBe("ambiguous-identity");

		const malformed = parseNvidiaSmi({
			listing: capture("nvidia/listing-mig.txt"),
			metrics: capture("nvidia/metrics-malformed.csv"),
			processes: { outcome: "ok", stdout: "" },
		});
		expect(malformed.status).toBe("error");
		expect(malformed.diagnostics[0]?.code).toBe("malformed-output");
	});
});

describe("typed command failures and parser bounds", () => {
	test("missing and unsupported tools are unsupported, not idle", () => {
		for (const name of ["missing-tool.json", "unsupported.json"] as const) {
			const result = parseNvidiaSmi({
				listing: capture("nvidia/listing-mig.txt"),
				metrics: failure(name),
				processes: { outcome: "ok", stdout: "" },
			});
			expect(result.status).toBe("unsupported");
			expect(result.value).toBeNull();
			expect(result.diagnostics[0]?.admissionEffect).toBe("block");
		}
	});

	test("permission and timeout results are errors with blocking diagnostics", () => {
		for (const name of ["permission.json", "timeout.json"] as const) {
			const result = parseProcMeminfo(failure(name));
			expect(result.status).toBe("error");
			expect(result.value).toBeNull();
			expect(result.diagnostics[0]?.admissionEffect).toBe("block");
		}
	});

	test("oversized and truncated captures are rejected before parsing", () => {
		const oversized = parseProcMeminfo({
			outcome: "ok",
			stdout: "x".repeat(HOST_PROBE_PARSE_LIMITS.maxInputBytes + 1),
		});
		expect(oversized.status).toBe("error");
		expect(oversized.diagnostics[0]?.code).toBe("output-too-large");

		const truncated = parseProcMeminfo({
			outcome: "ok",
			stdout: "MemAvailable: 100 kB\n",
			truncated: true,
		});
		expect(truncated.status).toBe("error");
		expect(truncated.diagnostics[0]?.code).toBe("output-truncated");
	});
});
