import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	GpuDeviceIdentity,
	GpuDeviceObservation,
	HostObservation,
	HostProbeAdapter,
	LinuxMemoryObservation,
	ProbeBinding,
} from "@mfw/core/host-observation";
import { boot } from "../src/boot.ts";
import { git } from "../src/git.ts";
import type {
	HostProbeRuntime,
	ProbeClock,
	ProbeTimer,
} from "../src/host-probe-runtime.ts";
import { LinuxCpuProbeAdapter } from "../src/host-probes.ts";
import {
	HostResourceCoordinator,
	openHostResourceStore,
} from "../src/host-resources/index.ts";
import { silentLogger } from "../src/log.ts";

const paths: string[] = [];
afterEach(async () => {
	for (const path of paths.splice(0))
		await rm(path, { recursive: true, force: true });
});

async function temp(prefix: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), prefix));
	paths.push(path);
	return path;
}

async function repo(name: string): Promise<string> {
	const root = await temp(`mfw-host-probe-${name}-`);
	await git(["init", "-q", "-b", "main", "."], root);
	await git(["config", "user.email", "probe@test"], root);
	await git(["config", "user.name", "probe-test"], root);
	await writeFile(
		join(root, "app.ts"),
		`export const name = ${JSON.stringify(name)};\n`,
	);
	await git(["add", "-A"], root);
	await git(["commit", "-qm", "init"], root);
	return root;
}

class ManualTime implements ProbeClock, ProbeTimer {
	nowMs = 1_700_000_000_000;
	monotonicMs = 0;
	private nextId = 0;
	readonly tasks = new Map<number, { callback: () => void; delayMs: number }>();
	readonly scheduledDelays: number[] = [];

	now = () => this.nowMs;
	monotonicNow = () => this.monotonicMs;
	random = () => 0.5;
	set = (callback: () => void, delayMs: number) => {
		const id = ++this.nextId;
		this.tasks.set(id, { callback, delayMs });
		this.scheduledDelays.push(delayMs);
		return id;
	};
	clear = (handle: unknown) => {
		this.tasks.delete(handle as number);
	};

	async fireNext(): Promise<void> {
		const entry = this.tasks.entries().next().value as
			| [number, { callback: () => void; delayMs: number }]
			| undefined;
		if (!entry) throw new Error("no timer scheduled");
		const [id, task] = entry;
		this.tasks.delete(id);
		this.nowMs += task.delayMs;
		this.monotonicMs += task.delayMs;
		task.callback();
		await Bun.sleep(0);
		await Bun.sleep(0);
	}
}

class MemoryAdapter
	implements HostProbeAdapter<LinuxMemoryObservation, LinuxMemoryObservation>
{
	readonly kind = "linux-memory" as const;
	discoveries = 0;
	samples = 0;
	sequence = 0n;
	available = 18_504_421_376n;
	status: "ok" | "unsupported" = "ok";

	constructor(
		private readonly time: ManualTime,
		private readonly processBootId = "probe-process",
	) {}

	private observation(): HostObservation<LinuxMemoryObservation> {
		const checkedAt = new Date(this.time.now()).toISOString();
		const common = {
			kind: this.kind,
			adapterVersion: "test-adapter-1",
			tool: { name: "injected-memory", version: "1" },
			generation: {
				processBootId: this.processBootId,
				kernelBootId: "kernel-test",
				sequence: ++this.sequence,
			},
			freshness: {
				state: "fresh" as const,
				checkedAt,
				expiresAt: new Date(this.time.now() + 3_000).toISOString(),
			},
			observedAt: checkedAt,
			durationMs: 1,
		};
		if (this.status === "unsupported") {
			return {
				...common,
				result: {
					status: "unsupported",
					value: null,
					diagnostics: [
						{
							code: "tool-missing",
							severity: "warning",
							admissionEffect: "block",
							message: "injected unsupported probe",
						},
					],
				},
			};
		}
		return {
			...common,
			result: {
				status: "ok",
				value: {
					memTotalBytes: 64n * 1024n ** 3n,
					memAvailableBytes: this.available,
					swapTotalBytes: 8n * 1024n ** 3n,
					swapFreeBytes: 8n * 1024n ** 3n,
					scope: "host",
				},
				diagnostics: [],
			},
		};
	}

	async discover(_signal: AbortSignal) {
		this.discoveries++;
		return this.observation();
	}

	async sample(_bindings: readonly ProbeBinding[], _signal: AbortSignal) {
		this.samples++;
		return this.observation();
	}
}

class RestartingAmdAdapter
	implements
		HostProbeAdapter<readonly GpuDeviceIdentity[], GpuDeviceObservation[]>
{
	readonly kind = "amd-gpu" as const;
	private sequence: bigint;
	private readonly identity: GpuDeviceIdentity = {
		key: "gpu:amd:0000:c6:00.0:KFD-PCI-0000:c6:00.0",
		vendor: "amd",
		pciAddress: "0000:c6:00.0",
		uuid: "KFD-PCI-0000:c6:00.0",
		partition: null,
		displayIndex: null,
	};

	constructor(
		private readonly time: ManualTime,
		private readonly processBootId: string,
		initialSequence: bigint,
	) {
		this.sequence = initialSequence;
	}

	private observation<T>(value: T): HostObservation<T> {
		const checkedAt = new Date(this.time.now()).toISOString();
		return {
			kind: this.kind,
			adapterVersion: "test-amd-kfd-1",
			tool: { name: "linux-kfd-sysfs", version: "kernel-sysfs" },
			generation: {
				processBootId: this.processBootId,
				kernelBootId: "kernel-test",
				sequence: ++this.sequence,
			},
			freshness: {
				state: "fresh",
				checkedAt,
				expiresAt: new Date(this.time.now() + 3_000).toISOString(),
			},
			observedAt: checkedAt,
			durationMs: 1,
			result: {
				status: "degraded",
				value,
				diagnostics: [
					{
						code: "partial-observation",
						severity: "warning",
						admissionEffect: "block",
						message: "injected KFD-only observation",
					},
				],
			},
		};
	}

	async discover() {
		return this.observation([this.identity]);
	}

	async sample() {
		return this.observation([
			{
				identity: this.identity,
				gpuUtilization: null,
				memoryUsedBytes: null,
				memoryTotalBytes: null,
				temperatureCelsius: null,
				powerWatts: null,
				occupancy: {
					state: "unknown" as const,
					occupants: [],
					deviceEvidence: [],
					blocksExclusiveAdmission: false,
				},
			},
		]);
	}
}

const liveness = {
	inspect: async () => ({
		status: "unavailable" as const,
		checkedAt: 1_700_000_000_000,
		kernelBootId: "kernel-test",
	}),
};

describe("process-global host observation lifecycle", () => {
	test("service keeps CPU pressure in warm-up until a bounded later sample", async () => {
		const home = await temp("mfw-host-cpu-warmup-");
		const time = new ManualTime();
		let reads = 0;
		const before =
			"cpu 100 20 30 400 10 5 5 0\ncpu0 50 10 15 200 5 2 3 0\ncpu1 50 10 15 200 5 3 2 0\nprocs_running 2\n";
		const after =
			"cpu 120 20 40 430 9 5 5 0\ncpu0 60 10 20 215 4 2 3 0\ncpu1 60 10 20 215 5 3 2 0\nprocs_running 3\n";
		const runtime: HostProbeRuntime = {
			clock: time,
			timer: time,
			commands: {
				run: async () => ({ outcome: "missing-tool" }),
			},
			files: {
				readFile: async () => ({
					outcome: "ok",
					stdout: reads++ < 2 ? before : after,
				}),
				readDirectory: async () => ({ outcome: "execution-error" }),
			},
		};
		let sequence = 0n;
		const adapter = new LinuxCpuProbeAdapter({
			runtime,
			processBootId: "process-a",
			kernelBootId: "kernel-test",
			cpuMinSampleIntervalMs: 100,
			sequence: { next: () => ++sequence },
		});
		const store = await openHostResourceStore(home, {
			processBootId: "process-a",
			kernelBootId: "kernel-test",
			now: time.now,
		});
		const coordinator = await HostResourceCoordinator.create(store, {
			liveness,
			now: time.now,
			observations: {
				adapters: [adapter],
				clock: time,
				timer: time,
				pollIntervalMs: 1_000,
				jitterFraction: 0,
			},
		});
		await coordinator.observations.start();
		expect(coordinator.readModel().health[0]?.result).toBe("error");
		expect(
			(
				coordinator.readModel().health[0]?.detail?.diagnostics as Array<{
					code: string;
				}>
			)[0]?.code,
		).toBe("partial-observation");
		await time.fireNext();
		const recovered = coordinator.readModel().health[0];
		expect(recovered?.result).toBe("ok");
		expect(recovered?.detail?.latest).toMatchObject({
			busyFraction: 0.5,
			runnableProcesses: 3,
		});
		await coordinator.shutdown();
	});

	test("persists coherent samples, wakes only on semantic change, and retains stale restart evidence", async () => {
		const home = await temp("mfw-host-observation-store-");
		const time = new ManualTime();
		const adapter = new MemoryAdapter(time, "process-a");
		let store = await openHostResourceStore(home, {
			processBootId: "process-a",
			kernelBootId: "kernel-test",
			now: time.now,
		});
		let coordinator = await HostResourceCoordinator.create(store, {
			liveness,
			now: time.now,
			observations: {
				adapters: [adapter],
				clock: time,
				timer: time,
				pollIntervalMs: 1_000,
				jitterFraction: 0,
			},
		});
		await coordinator.putDefinition({
			id: "ram",
			accounting: "quantity",
			quantityUnit: "bytes",
			safetyHeadroom: 0n,
			provisioning: "static",
			capacity: 64n * 1024n ** 3n,
			enabled: true,
			draining: false,
			version: 1n,
			observationKind: "linux-memory",
		});
		await coordinator.putBinding({
			id: "host-ram",
			resourceId: "ram",
			stableKey: "host",
			enabled: true,
			version: 1n,
		});
		let wakes = 0;
		coordinator.subscribe("project-a", () => wakes++);
		await coordinator.observations.start();
		await Bun.sleep(0);
		const firstWakes = wakes;
		const first = coordinator.readModel();
		expect(first.health[0]?.detail?.latest).toMatchObject({
			memAvailableBytes: "18504421376",
			scope: "host",
		});
		expect(first.observations[0]?.metrics).toMatchObject({
			memAvailableBytes: "18504421376",
		});

		await time.fireNext();
		expect(wakes).toBe(firstWakes);
		adapter.available -= 1n;
		await time.fireNext();
		expect(wakes).toBe(firstWakes + 1);
		await coordinator.shutdown();
		expect(time.tasks.size).toBe(0);

		store = await openHostResourceStore(home, {
			processBootId: "process-b",
			kernelBootId: "kernel-test",
			now: time.now,
		});
		coordinator = await HostResourceCoordinator.create(store, {
			liveness,
			now: time.now,
		});
		const restarted = coordinator.readModel();
		expect(restarted.observations[0]?.processBootId).toBe("process-a");
		expect(restarted.observations[0]?.processBootId).not.toBe(
			restarted.processBootId,
		);
		await coordinator.shutdown();
	});

	test("a restarted AMD poller replaces a higher prior-process sequence and refresh stays coherent", async () => {
		const home = await temp("mfw-host-amd-restart-");
		const time = new ManualTime();
		let store = await openHostResourceStore(home, {
			processBootId: "process-a",
			kernelBootId: "kernel-test",
			now: time.now,
		});
		let coordinator = await HostResourceCoordinator.create(store, {
			liveness,
			now: time.now,
			observations: {
				adapters: [new RestartingAmdAdapter(time, "process-a", 498n)],
				clock: time,
				timer: time,
				pollIntervalMs: 1_000,
				jitterFraction: 0,
			},
		});
		await coordinator.putDefinition({
			id: "gpu-amd",
			accounting: "slot",
			provisioning: "static",
			capacity: 1n,
			enabled: true,
			draining: false,
			version: 1n,
			observationKind: "amd-gpu",
		});
		await coordinator.putBinding({
			id: "gpu-amd-0",
			resourceId: "gpu-amd",
			stableKey: "gpu:amd:0000:c6:00.0:KFD-PCI-0000:c6:00.0",
			enabled: true,
			version: 1n,
		});
		await coordinator.observations.start();
		expect(coordinator.readModel().observations[0]).toMatchObject({
			processBootId: "process-a",
			sequence: 500n,
		});
		await coordinator.shutdown();

		time.nowMs += 1_000;
		store = await openHostResourceStore(home, {
			processBootId: "process-b",
			kernelBootId: "kernel-test",
			now: time.now,
		});
		coordinator = await HostResourceCoordinator.create(store, {
			liveness,
			now: time.now,
			observations: {
				adapters: [new RestartingAmdAdapter(time, "process-b", 0n)],
				clock: time,
				timer: time,
				pollIntervalMs: 1_000,
				jitterFraction: 0,
			},
		});
		await coordinator.observations.start();
		await coordinator.observations.refresh();
		const recovered = coordinator.readModel();
		expect(recovered.health[0]).toMatchObject({ processBootId: "process-b" });
		expect(recovered.health[0]?.detail?.generation).toMatchObject({
			sequence: "3",
		});
		expect(recovered.observations[0]).toMatchObject({
			processBootId: "process-b",
			sequence: 3n,
		});
		expect(recovered.effectiveCapacities[0]?.holdReason).toBe(
			"unknown-occupancy",
		);
		const batches = (await coordinator.store.auditEntries()).filter(
			(entry) => entry.action === "observation.batch",
		);
		expect(batches).toHaveLength(2);
		expect(batches.map((entry) => entry.detail.samples)).toEqual([1, 1]);
		await coordinator.shutdown();
	});

	test("unsupported observations back off and shutdown cancels the only timer", async () => {
		const home = await temp("mfw-host-observation-backoff-");
		const time = new ManualTime();
		const adapter = new MemoryAdapter(time, "process-a");
		adapter.status = "unsupported";
		const store = await openHostResourceStore(home, {
			processBootId: "process-a",
			kernelBootId: "kernel-test",
			now: time.now,
		});
		const coordinator = await HostResourceCoordinator.create(store, {
			liveness,
			now: time.now,
			observations: {
				adapters: [adapter],
				clock: time,
				timer: time,
				pollIntervalMs: 100,
				maxBackoffMs: 1_000,
				jitterFraction: 0,
			},
		});
		await coordinator.observations.start();
		expect(time.scheduledDelays.at(-1)).toBe(200);
		expect(time.tasks.size).toBe(1);
		await coordinator.shutdown();
		expect(time.tasks.size).toBe(0);
	});

	test("shutdown aborts and joins an in-flight adapter before closing the store", async () => {
		const home = await temp("mfw-host-observation-abort-");
		const time = new ManualTime();
		let aborted = false;
		const adapter: HostProbeAdapter<never, never> = {
			kind: "nvidia-gpu",
			discover: (signal) =>
				new Promise((_, reject) => {
					signal.addEventListener(
						"abort",
						() => {
							aborted = true;
							reject(new Error("injected probe aborted"));
						},
						{ once: true },
					);
				}),
			sample: async () => {
				throw new Error("sample must not run");
			},
		};
		const store = await openHostResourceStore(home, {
			processBootId: "process-a",
			kernelBootId: "kernel-test",
			now: time.now,
		});
		const coordinator = await HostResourceCoordinator.create(store, {
			liveness,
			now: time.now,
			observations: {
				adapters: [adapter],
				clock: time,
				timer: time,
				pollTimeoutMs: 1_000,
			},
		});
		const starting = coordinator.observations.start();
		await Bun.sleep(0);
		await coordinator.shutdown();
		await starting;
		expect(aborted).toBe(true);
		expect(time.tasks.size).toBe(0);
	});

	test("one boot-owned poller survives multiple project attach and detach", async () => {
		const home = await temp("mfw-host-observation-boot-");
		const time = new ManualTime();
		const adapter = new MemoryAdapter(time);
		const orchestrator = await boot({
			projects: [],
			mfwHome: home,
			autostart: true,
			log: silentLogger(),
			hostProbes: {
				adapters: [adapter],
				clock: time,
				timer: time,
				pollIntervalMs: 1_000,
				jitterFraction: 0,
			},
		});
		expect(adapter.discoveries).toBe(1);
		expect(adapter.samples).toBe(1);
		expect(time.tasks.size).toBe(1);

		const firstRoot = await repo("first");
		const secondRoot = await repo("second");
		await orchestrator.attach({
			name: "first",
			root: firstRoot,
			schedulerAutostart: false,
		});
		await orchestrator.attach({
			name: "second",
			root: secondRoot,
			schedulerAutostart: false,
		});
		expect(adapter.discoveries).toBe(1);
		expect(adapter.samples).toBe(1);
		await orchestrator.detach("first");
		await orchestrator.detach("second");
		expect(time.tasks.size).toBe(1);

		await time.fireNext();
		expect(adapter.discoveries).toBe(1);
		expect(adapter.samples).toBe(2);
		expect(time.tasks.size).toBe(1);
		await orchestrator.shutdown();
		expect(time.tasks.size).toBe(0);
	});
});
