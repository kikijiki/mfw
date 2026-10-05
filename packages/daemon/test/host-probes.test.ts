import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProbeCapture } from "@mfw/core/host-observation";
import {
	createProductionHostProbeRuntime,
	type DirectoryCapture,
	type HostProbeRuntime,
	type ProbeCommand,
} from "../src/host-probe-runtime.ts";
import {
	AmdSmiProbeAdapter,
	LinuxCpuProbeAdapter,
	LinuxMemoryProbeAdapter,
	NvidiaSmiProbeAdapter,
} from "../src/host-probes.ts";

const fixtureRoot = join(import.meta.dir, "fixtures", "host-probes");
const fixture = (path: string) => readFileSync(join(fixtureRoot, path), "utf8");

function pidStat(pid: number, start: bigint): string {
	return `${pid} (sanitized process) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 ${start} 20 21 22 23\n`;
}

class FakeRuntime implements HostProbeRuntime {
	nowMs = Date.parse("2026-08-24T00:00:00.000Z");
	monoMs = 0;
	readonly fileReads: string[] = [];
	readonly directoryReads: string[] = [];
	readonly commandsRun: string[] = [];
	readonly filesByPath = new Map<string, ProbeCapture>();
	readonly directories = new Map<string, DirectoryCapture>();
	commandResult: (request: ProbeCommand) => ProbeCapture = () => ({
		outcome: "missing-tool",
	});
	readonly callbacks = new Map<number, () => void>();
	private timerId = 0;

	clock = {
		now: () => this.nowMs,
		monotonicNow: () => this.monoMs,
		random: () => 0.5,
	};

	timer = {
		set: (callback: () => void, _delayMs: number) => {
			const id = ++this.timerId;
			this.callbacks.set(id, callback);
			return id;
		},
		clear: (handle: unknown) => {
			this.callbacks.delete(handle as number);
		},
	};

	files = {
		readFile: async (path: string, _maxBytes: number, _signal: AbortSignal) => {
			this.fileReads.push(path);
			return (
				this.filesByPath.get(path) ?? { outcome: "execution-error" as const }
			);
		},
		readDirectory: async (
			path: string,
			_maxEntries: number,
			_signal: AbortSignal,
		) => {
			this.directoryReads.push(path);
			return (
				this.directories.get(path) ?? { outcome: "execution-error" as const }
			);
		},
	};

	commands = {
		run: async (request: ProbeCommand, _signal: AbortSignal) => {
			this.commandsRun.push([request.command, ...request.args].join(" "));
			return this.commandResult(request);
		},
	};
}

function environment(runtime: FakeRuntime) {
	let sequence = 0n;
	return {
		runtime,
		processBootId: "process-test",
		kernelBootId: "kernel-test",
		freshnessMs: 5_000,
		sequence: { next: () => ++sequence },
	};
}

function configureAmdKfd(runtime: FakeRuntime) {
	const root = "/sys/class/kfd/kfd/proc";
	const topology = "/sys/class/kfd/kfd/topology/nodes";
	runtime.directories.set(root, { outcome: "ok", entries: ["4242"] });
	runtime.directories.set(`${root}/4242`, {
		outcome: "ok",
		entries: ["queues", "vram_44307"],
	});
	runtime.directories.set(`${root}/4242/queues`, {
		outcome: "ok",
		entries: ["0", "1"],
	});
	runtime.filesByPath.set(`${root}/4242/vram_44307`, {
		outcome: "ok",
		stdout: "18504421376\n",
	});
	for (const queue of ["0", "1"])
		runtime.filesByPath.set(`${root}/4242/queues/${queue}/gpuid`, {
			outcome: "ok",
			stdout: "44307\n",
		});
	runtime.directories.set(topology, {
		outcome: "ok",
		entries: ["0", "1"],
	});
	for (const node of ["0", "1"]) {
		runtime.filesByPath.set(`${topology}/${node}/gpu_id`, {
			outcome: "ok",
			stdout: node === "0" ? "0\n" : "44307\n",
		});
		runtime.filesByPath.set(`${topology}/${node}/properties`, {
			outcome: "ok",
			stdout:
				node === "0"
					? "vendor_id 1022\ndomain 0\nlocation_id 0\n"
					: "vendor_id 4098\ndomain 0\nlocation_id 50688\n",
		});
	}
	runtime.filesByPath.set("/proc/4242/stat", {
		outcome: "ok",
		stdout: pidStat(4242, 987654n),
	});
}

describe("Linux production probe adapters with injected procfs", () => {
	test("CPU warms up, ignores unreliable iowait regression, and remains pressure-only", async () => {
		const runtime = new FakeRuntime();
		const before = fixture("proc/stat-before.txt");
		const after = fixture("proc/stat-after-whitespace.txt").replace(
			"430  10",
			"430  9",
		);
		runtime.filesByPath.set("/proc/stat", { outcome: "ok", stdout: before });
		const adapter = new LinuxCpuProbeAdapter(environment(runtime));
		const discovery = await adapter.discover(new AbortController().signal);
		expect(discovery.result.status).toBe("ok");
		if (discovery.result.status === "ok")
			expect(discovery.result.value.logicalProcessors).toBe(2);

		const warmup = await adapter.sample([], new AbortController().signal);
		expect(warmup.result.status).toBe("error");
		expect(warmup.result.diagnostics[0]?.code).toBe("partial-observation");

		runtime.monoMs += 250;
		runtime.filesByPath.set("/proc/stat", { outcome: "ok", stdout: after });
		const sample = await adapter.sample([], new AbortController().signal);
		expect(sample.result.status).toBe("ok");
		if (sample.result.status === "ok") {
			expect(sample.result.value.busyFraction).toBeCloseTo(0.5);
			expect(sample.result.value.runnableProcesses).toBe(3);
			expect("capacity" in sample.result.value).toBe(false);
		}

		runtime.monoMs += 250;
		runtime.filesByPath.set("/proc/stat", { outcome: "ok", stdout: before });
		const regressed = await adapter.sample([], new AbortController().signal);
		expect(regressed.result.status).toBe("error");
		expect(regressed.result.diagnostics[0]?.code).toBe("counter-regressed");
	});

	test("memory reads only injected MemAvailable host data with totals and swap", async () => {
		const runtime = new FakeRuntime();
		runtime.filesByPath.set("/proc/meminfo", {
			outcome: "ok",
			stdout: fixture("proc/meminfo.txt"),
		});
		const adapter = new LinuxMemoryProbeAdapter(environment(runtime));
		const sample = await adapter.sample([], new AbortController().signal);
		expect(sample.result.status).toBe("ok");
		if (sample.result.status === "ok") {
			expect(sample.result.value.memAvailableBytes).toBe(48_318_382n * 1024n);
			expect(sample.result.value.memTotalBytes).toBe(65_843_092n * 1024n);
			expect(sample.result.value.swapFreeBytes).toBe(7_340_032n * 1024n);
			expect(sample.result.value.scope).toBe("host");
		}
		expect(runtime.fileReads).toEqual(["/proc/meminfo"]);
	});
});

describe("vendor adapters preserve occupancy independently of utilization", () => {
	test("missing amd-smi falls back to live KFD sysfs evidence and stable PCI mapping", async () => {
		const runtime = new FakeRuntime();
		configureAmdKfd(runtime);

		const sample = await new AmdSmiProbeAdapter(environment(runtime)).sample(
			[],
			new AbortController().signal,
		);
		expect(sample.tool).toEqual({
			name: "linux-kfd-sysfs",
			version: "kernel-sysfs",
		});
		expect(sample.result.status).toBe("degraded");
		if (sample.result.status !== "degraded") return;
		const device = sample.result.value[0];
		expect(device?.identity.pciAddress).toBe("0000:c6:00.0");
		expect(device?.occupancy.state).toBe("unknown");
		expect(device?.occupancy.occupants[0]?.evidence).toHaveLength(3);
		expect(
			runtime.fileReads.filter((path) => path === "/proc/4242/stat"),
		).toHaveLength(2);
	});

	test("amdgpu_top supplies live AMD activity and sensors alongside conservative KFD occupancy", async () => {
		const runtime = new FakeRuntime();
		configureAmdKfd(runtime);
		runtime.commandResult = (request) => {
			if (request.command !== "amdgpu_top") return { outcome: "missing-tool" };
			if (request.args.join(" ") === "--version")
				return { outcome: "ok", stdout: "amdgpu_top v0.11.5\n" };
			return {
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
			};
		};

		const sample = await new AmdSmiProbeAdapter(environment(runtime)).sample(
			[],
			new AbortController().signal,
		);
		expect(sample.tool).toEqual({
			name: "amdgpu_top",
			version: "amdgpu_top v0.11.5",
		});
		expect(sample.result.status).toBe("degraded");
		if (sample.result.status !== "degraded") return;
		expect(sample.result.value[0]?.gpuUtilization).toBe(0.01);
		expect(sample.result.value[0]?.memoryUsedBytes).toBe(18_504_421_376n);
		expect(sample.result.value[0]?.memoryTotalBytes).toBe(
			65_536n * 1024n * 1024n,
		);
		expect(sample.result.value[0]?.temperatureCelsius).toBe(47);
		expect(sample.result.value[0]?.occupancy.state).toBe("unknown");
		expect(runtime.commandsRun).toContain("amdgpu_top --json -n 1 -s 250ms");
	});

	test("exact AMD 18,504,421,376-byte two-HSA-queue incident is occupied", async () => {
		const runtime = new FakeRuntime();
		const outputs = new Map<string, string>([
			["version", "AMD SMI 25.3.0 ROCm 6.4.0\n"],
			["list --json", fixture("amd/list.json")],
			[
				"metric --usage --mem-usage --json",
				fixture("amd/metrics-low-utilization.json"),
			],
			["process --json", fixture("amd/processes-low-utilization.json")],
		]);
		runtime.commandResult = (request) => {
			const output = outputs.get(request.args.join(" "));
			return output === undefined
				? { outcome: "execution-error" }
				: { outcome: "ok", stdout: output };
		};
		runtime.filesByPath.set("/proc/4242/stat", {
			outcome: "ok",
			stdout: pidStat(4242, 987654n),
		});
		runtime.directories.set("/sys/kernel/debug/kfd/proc", {
			outcome: "ok",
			entries: ["4242"],
		});
		runtime.directories.set("/sys/kernel/debug/kfd/proc/4242/queues", {
			outcome: "ok",
			entries: ["7001", "7002"],
		});
		runtime.directories.set("/sys/kernel/debug/kfd/proc/4242", {
			outcome: "ok",
			entries: ["queues", "vram_3101"],
		});
		runtime.filesByPath.set("/sys/kernel/debug/kfd/proc/4242/vram_3101", {
			outcome: "ok",
			stdout: "18504421376\n",
		});
		for (const queue of ["7001", "7002"])
			runtime.filesByPath.set(
				`/sys/kernel/debug/kfd/proc/4242/queues/${queue}/gpuid`,
				{ outcome: "ok", stdout: "3101\n" },
			);

		const sample = await new AmdSmiProbeAdapter(environment(runtime)).sample(
			[],
			new AbortController().signal,
		);
		expect(sample.result.status).toBe("degraded");
		if (sample.result.status !== "degraded") return;
		const device = sample.result.value[0];
		expect(device?.gpuUtilization).toBe(0.01);
		expect(device?.memoryUsedBytes).toBe(18_504_421_376n);
		expect(device?.occupancy.state).toBe("occupied");
		expect(
			device?.occupancy.occupants[0]?.evidence.filter(
				(evidence) => evidence.kind === "hsa-queue",
			),
		).toHaveLength(2);
		const resident = device?.occupancy.occupants[0]?.evidence.find(
			(evidence) => evidence.kind === "device-memory",
		);
		expect(
			resident && "residentBytes" in resident ? resident.residentBytes : null,
		).toBe(18_504_421_376n);
		expect(device?.occupancy.occupants[0]?.evidence).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source: "linux-kfd-debugfs",
					kind: "device-memory",
					residentBytes: 18_504_421_376n,
					admission: "diagnostic-only",
				}),
			]),
		);
	});

	test("AMD KFD capture falls back from unavailable debugfs to the canonical sysfs proc root", async () => {
		const runtime = new FakeRuntime();
		const outputs = new Map<string, string>([
			["version", "AMD SMI 25.3.0 ROCm 6.4.0\n"],
			["list --json", fixture("amd/list.json")],
			[
				"metric --usage --mem-usage --json",
				fixture("amd/metrics-low-utilization.json"),
			],
			["process --json", fixture("amd/processes-low-utilization.json")],
		]);
		runtime.commandResult = (request) => {
			const output = outputs.get(request.args.join(" "));
			return output === undefined
				? { outcome: "execution-error" }
				: { outcome: "ok", stdout: output };
		};
		runtime.filesByPath.set("/proc/4242/stat", {
			outcome: "ok",
			stdout: pidStat(4242, 987654n),
		});
		const root = "/sys/class/kfd/kfd/proc";
		runtime.directories.set(root, { outcome: "ok", entries: ["4242"] });
		runtime.directories.set(`${root}/4242`, {
			outcome: "ok",
			entries: ["queues", "vram_3101"],
		});
		runtime.directories.set(`${root}/4242/queues`, {
			outcome: "ok",
			entries: ["7001", "7002"],
		});
		runtime.filesByPath.set(`${root}/4242/vram_3101`, {
			outcome: "ok",
			stdout: "18504421376\n",
		});
		for (const queue of ["7001", "7002"])
			runtime.filesByPath.set(`${root}/4242/queues/${queue}/gpuid`, {
				outcome: "ok",
				stdout: "3101\n",
			});

		const sample = await new AmdSmiProbeAdapter(environment(runtime)).sample(
			[],
			new AbortController().signal,
		);
		expect(runtime.directoryReads.slice(0, 2)).toEqual([
			"/sys/kernel/debug/kfd/proc",
			root,
		]);
		expect(sample.result.status).toBe("degraded");
		if (sample.result.status !== "degraded") return;
		const evidence =
			sample.result.value[0]?.occupancy.occupants[0]?.evidence ?? [];
		expect(evidence).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ source: "linux-kfd-sysfs" }),
			]),
		);
	});

	test("NVIDIA zero-util graphics and MPS contexts remain occupied", async () => {
		const runtime = new FakeRuntime();
		const outputs = new Map<string, string>([
			["--version", "NVIDIA-SMI 550.54.15\n"],
			["-L", fixture("nvidia/listing-mig.txt")],
			[
				"--query-gpu=pci.bus_id,uuid,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits",
				fixture("nvidia/metrics-zero.csv")
					.trim()
					.split("\n")
					.map((line) => `${line}, 24576, 52, 80.5`)
					.join("\n"),
			],
			[
				"--query-compute-apps=gpu_uuid,pid,used_gpu_memory --format=csv,noheader,nounits",
				"",
			],
			["-q -x", fixture("nvidia/contexts-zero.xml")],
		]);
		runtime.commandResult = (request) => {
			const output = outputs.get(request.args.join(" "));
			return output === undefined
				? { outcome: "execution-error" }
				: { outcome: "ok", stdout: output };
		};
		for (const pid of [6161, 6162])
			runtime.filesByPath.set(`/proc/${pid}/stat`, {
				outcome: "ok",
				stdout: pidStat(pid, BigInt(pid * 100)),
			});

		const sample = await new NvidiaSmiProbeAdapter(environment(runtime)).sample(
			[],
			new AbortController().signal,
		);
		expect(sample.result.status).toBe("ok");
		if (sample.result.status !== "ok") return;
		const physical = sample.result.value.filter(
			(device) => device.identity.partition === null,
		);
		expect(physical.every((device) => device.gpuUtilization === 0)).toBe(true);
		expect(physical.every((device) => device.memoryUsedBytes === 0n)).toBe(
			true,
		);
		expect(
			physical.every(
				(device) => device.memoryTotalBytes === 24_576n * 1024n * 1024n,
			),
		).toBe(true);
		expect(physical.every((device) => device.temperatureCelsius === 52)).toBe(
			true,
		);
		expect(physical.every((device) => device.powerWatts === 80.5)).toBe(true);
		expect(
			physical.every((device) => device.occupancy.state === "occupied"),
		).toBe(true);
		expect(
			physical
				.flatMap((device) => device.occupancy.occupants)
				.map((occupant) =>
					occupant.evidence.find(
						(evidence) => evidence.kind === "compute-context",
					),
				),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ contextKind: "graphics" }),
				expect.objectContaining({ contextKind: "mps" }),
			]),
		);
	});

	test("missing tools are typed unsupported and never optimistic idle", async () => {
		const runtime = new FakeRuntime();
		const sample = await new NvidiaSmiProbeAdapter(environment(runtime)).sample(
			[],
			new AbortController().signal,
		);
		expect(sample.result.status).toBe("unsupported");
		expect(sample.result.value).toBeNull();
		expect(sample.result.diagnostics[0]?.code).toBe("tool-missing");
	});

	test("a changing NVIDIA process list exhausts one retry and fails closed", async () => {
		const runtime = new FakeRuntime();
		let processCalls = 0;
		runtime.commandResult = (request) => {
			const args = request.args.join(" ");
			if (args === "--version")
				return { outcome: "ok", stdout: "NVIDIA-SMI 550.54.15\n" };
			if (args === "-L")
				return { outcome: "ok", stdout: fixture("nvidia/listing-mig.txt") };
			if (args.startsWith("--query-gpu="))
				return { outcome: "ok", stdout: fixture("nvidia/metrics-zero.csv") };
			if (args.startsWith("--query-compute-apps=")) {
				processCalls++;
				return {
					outcome: "ok",
					stdout: `GPU-00000000-0000-0000-0000-000000000001, ${7000 + processCalls}, 0\n`,
				};
			}
			if (args === "-q -x")
				return { outcome: "ok", stdout: fixture("nvidia/contexts-zero.xml") };
			return { outcome: "execution-error" };
		};
		const sample = await new NvidiaSmiProbeAdapter(environment(runtime)).sample(
			[],
			new AbortController().signal,
		);
		expect(processCalls).toBe(4);
		expect(sample.result.status).toBe("error");
		expect(sample.result.diagnostics[0]?.code).toBe("partial-observation");
	});
});

describe("production command capture bounds", () => {
	test("missing commands, output overflow, and timeouts return bounded captures", async () => {
		const runtime = createProductionHostProbeRuntime();
		const signal = new AbortController().signal;
		const missing = await runtime.commands.run(
			{
				command: `mfw-definitely-missing-${process.pid}`,
				args: [],
				timeoutMs: 100,
				maxOutputBytes: 64,
			},
			signal,
		);
		expect(missing.outcome).toBe("missing-tool");

		const oversized = await runtime.commands.run(
			{
				command: "bun",
				args: ["-e", 'process.stdout.write("x".repeat(4096))'],
				timeoutMs: 1_000,
				maxOutputBytes: 64,
			},
			signal,
		);
		expect(oversized.truncated).toBe(true);
		expect(
			new TextEncoder().encode(oversized.stdout ?? "").byteLength,
		).toBeLessThanOrEqual(64);

		const combined = await runtime.commands.run(
			{
				command: "bun",
				args: [
					"-e",
					'process.stdout.write("o".repeat(80)); process.stderr.write("e".repeat(80))',
				],
				timeoutMs: 1_000,
				maxOutputBytes: 96,
			},
			signal,
		);
		expect(combined.truncated).toBe(true);
		expect(
			new TextEncoder().encode(
				`${combined.stdout ?? ""}${combined.stderr ?? ""}`,
			).byteLength,
		).toBeLessThanOrEqual(96);

		const started = performance.now();
		const timeout = await runtime.commands.run(
			{
				command: "bun",
				args: ["-e", "await new Promise(() => {})"],
				timeoutMs: 30,
				maxOutputBytes: 64,
			},
			signal,
		);
		expect(timeout.outcome).toBe("timeout");
		expect(performance.now() - started).toBeLessThan(2_000);
	});
});
