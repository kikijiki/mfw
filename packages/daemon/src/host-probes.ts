import type {
	DiscoveryResult,
	GpuDeviceIdentity,
	GpuDeviceObservation,
	HostObservation,
	HostProbeAdapter,
	HostProbeKind,
	LinuxCpuDiscovery,
	LinuxCpuPressure,
	LinuxMemoryObservation,
	ObservationGeneration,
	PidStartEvidence,
	ProbeBinding,
	ProbeCapture,
	ProbeDiagnostic,
	ProbeResult,
	ProbeSample,
	ProbeToolIdentity,
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
} from "./host-probe-parsers.ts";
import type { HostProbeRuntime } from "./host-probe-runtime.ts";

export const HOST_PROBE_LIMITS = {
	fileBytes: 1024 * 1024,
	commandOutputBytes: 1024 * 1024,
	commandTimeoutMs: 2_000,
	maxKfdEntries: 4096,
	processListRetries: 1,
} as const;

export interface HostProbeEnvironment {
	runtime: HostProbeRuntime;
	processBootId: string;
	kernelBootId: string | null;
	freshnessMs?: number;
	commandTimeoutMs?: number;
	commandOutputBytes?: number;
	sequence?: { next(): bigint };
	/** Minimum monotonic separation before a CPU delta is trustworthy. */
	cpuMinSampleIntervalMs?: number;
}

export type AnyHostProbeAdapter = HostProbeAdapter<unknown, unknown>;

function diagnostic(
	code: ProbeDiagnostic["code"],
	message: string,
	field?: string,
): ProbeDiagnostic {
	const unsupported =
		code === "unsupported-platform" ||
		code === "tool-missing" ||
		code === "tool-version-unsupported";
	return {
		code,
		severity: unsupported ? "warning" : "error",
		admissionEffect: "block",
		message,
		...(field ? { field } : {}),
	};
}

function resultError<T>(
	code: ProbeDiagnostic["code"],
	message: string,
	field?: string,
): Extract<ProbeResult<T>, { status: "error" | "unsupported" }> {
	return {
		status:
			code === "unsupported-platform" ||
			code === "tool-missing" ||
			code === "tool-version-unsupported"
				? "unsupported"
				: "error",
		value: null,
		diagnostics: [diagnostic(code, message, field)],
	};
}

class ObservationEnvelope {
	private sequence = 0n;
	readonly freshnessMs: number;

	constructor(private readonly environment: HostProbeEnvironment) {
		this.freshnessMs = environment.freshnessMs ?? 15_000;
	}

	wrap<T>(
		kind: HostProbeKind,
		tool: ProbeToolIdentity,
		startedAt: number,
		startedMonotonic: number,
		result: ProbeResult<T>,
	): HostObservation<T> {
		const checkedAt = this.environment.runtime.clock.now();
		const generation: ObservationGeneration = {
			processBootId: this.environment.processBootId,
			kernelBootId: this.environment.kernelBootId,
			sequence: this.environment.sequence?.next() ?? ++this.sequence,
		};
		return {
			kind,
			adapterVersion: "mfw-host-probe-1",
			tool,
			generation,
			freshness: {
				state: "fresh",
				checkedAt: new Date(checkedAt).toISOString(),
				expiresAt: new Date(checkedAt + this.freshnessMs).toISOString(),
			},
			observedAt: new Date(startedAt).toISOString(),
			durationMs: Math.max(
				0,
				Math.round(
					this.environment.runtime.clock.monotonicNow() - startedMonotonic,
				),
			),
			result,
		};
	}
}

abstract class BaseProbe {
	protected readonly envelope: ObservationEnvelope;
	protected readonly timeoutMs: number;
	protected readonly outputBytes: number;

	constructor(protected readonly environment: HostProbeEnvironment) {
		this.envelope = new ObservationEnvelope(environment);
		this.timeoutMs =
			environment.commandTimeoutMs ?? HOST_PROBE_LIMITS.commandTimeoutMs;
		this.outputBytes =
			environment.commandOutputBytes ?? HOST_PROBE_LIMITS.commandOutputBytes;
	}

	protected start(): [number, number] {
		return [
			this.environment.runtime.clock.now(),
			this.environment.runtime.clock.monotonicNow(),
		];
	}

	protected run(
		command: string,
		args: readonly string[],
		signal: AbortSignal,
	): Promise<ProbeCapture> {
		return this.environment.runtime.commands.run(
			{
				command,
				args,
				timeoutMs: this.timeoutMs,
				maxOutputBytes: this.outputBytes,
			},
			signal,
		);
	}
}

export class LinuxCpuProbeAdapter
	extends BaseProbe
	implements HostProbeAdapter<LinuxCpuDiscovery, LinuxCpuPressure>
{
	readonly kind = "linux-cpu" as const;
	private previous: ProbeCapture | null = null;
	private previousAt: number | null = null;
	private readonly tool: ProbeToolIdentity = {
		name: "linux-procfs",
		version: "proc-stat",
	};

	async discover(
		signal: AbortSignal,
	): Promise<DiscoveryResult<LinuxCpuDiscovery>> {
		const [started, monotonic] = this.start();
		const capture = await this.environment.runtime.files.readFile(
			"/proc/stat",
			HOST_PROBE_LIMITS.fileBytes,
			signal,
		);
		return this.envelope.wrap(
			this.kind,
			this.tool,
			started,
			monotonic,
			parseLinuxCpuDiscovery(capture),
		);
	}

	async sample(
		_bindings: readonly ProbeBinding[],
		signal: AbortSignal,
	): Promise<ProbeSample<LinuxCpuPressure>> {
		const [started, monotonic] = this.start();
		const current = await this.environment.runtime.files.readFile(
			"/proc/stat",
			HOST_PROBE_LIMITS.fileBytes,
			signal,
		);
		const previous = this.previous;
		const previousAt = this.previousAt;
		this.previous = current;
		this.previousAt = this.environment.runtime.clock.monotonicNow();
		const interval = previousAt === null ? 0 : this.previousAt - previousAt;
		const minimumInterval = this.environment.cpuMinSampleIntervalMs ?? 100;
		const result =
			previous && previousAt !== null && interval >= minimumInterval
				? parseLinuxCpuPressure(previous, current)
				: resultError<LinuxCpuPressure>(
						"partial-observation",
						`CPU pressure requires a prior sample at least ${minimumInterval}ms old`,
						"proc-stat",
					);
		return this.envelope.wrap(this.kind, this.tool, started, monotonic, result);
	}
}

export class LinuxMemoryProbeAdapter
	extends BaseProbe
	implements HostProbeAdapter<LinuxMemoryObservation, LinuxMemoryObservation>
{
	readonly kind = "linux-memory" as const;
	private readonly tool: ProbeToolIdentity = {
		name: "linux-procfs",
		version: "proc-meminfo",
	};

	private async observe(
		signal: AbortSignal,
	): Promise<HostObservation<LinuxMemoryObservation>> {
		const [started, monotonic] = this.start();
		const capture = await this.environment.runtime.files.readFile(
			"/proc/meminfo",
			HOST_PROBE_LIMITS.fileBytes,
			signal,
		);
		return this.envelope.wrap(
			this.kind,
			this.tool,
			started,
			monotonic,
			parseProcMeminfo(capture),
		);
	}

	discover(
		signal: AbortSignal,
	): Promise<DiscoveryResult<LinuxMemoryObservation>> {
		return this.observe(signal);
	}

	sample(
		_bindings: readonly ProbeBinding[],
		signal: AbortSignal,
	): Promise<ProbeSample<LinuxMemoryObservation>> {
		return this.observe(signal);
	}
}

function versionFrom(capture: ProbeCapture, name: string): ProbeToolIdentity {
	if (capture.outcome !== "ok") return { name, version: "unavailable" };
	const first = capture.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
	return {
		name,
		version: first?.replace(/[^\x20-\x7e]/g, "").slice(0, 200) || "unknown",
	};
}

function captureFailure<T>(
	capture: ProbeCapture,
	field: string,
): Extract<ProbeResult<T>, { status: "error" | "unsupported" }> {
	if (capture.truncated)
		return resultError("output-truncated", "Probe output was truncated", field);
	switch (capture.outcome) {
		case "missing-tool":
			return resultError(
				"tool-missing",
				"Required probe tool is missing",
				field,
			);
		case "unsupported":
			return resultError(
				"tool-version-unsupported",
				"Probe surface is unsupported",
				field,
			);
		case "permission-denied":
			return resultError("permission-denied", "Probe permission denied", field);
		case "timeout":
			return resultError("probe-timeout", "Probe command timed out", field);
		case "execution-error":
			return resultError("execution-failed", "Probe command failed", field);
		case "ok":
			return resultError("malformed-output", "Unexpected empty result", field);
	}
}

function uniquePidsFromJson(capture: ProbeCapture): number[] {
	if (capture.outcome !== "ok" || capture.truncated) return [];
	try {
		const root = JSON.parse(capture.stdout) as unknown;
		const pids = new Set<number>();
		let visited = 0;
		const walk = (value: unknown): void => {
			if (++visited > HOST_PROBE_PARSE_LIMITS.maxRecords * 16) return;
			if (Array.isArray(value)) {
				for (const item of value) walk(item);
				return;
			}
			if (!value || typeof value !== "object") return;
			for (const [key, nested] of Object.entries(value)) {
				if (
					(key === "pid" || key === "PID") &&
					Number.isSafeInteger(Number(nested))
				) {
					const pid = Number(nested);
					if (pid > 0) pids.add(pid);
				} else walk(nested);
			}
		};
		walk(root);
		return [...pids].slice(0, HOST_PROBE_PARSE_LIMITS.maxRecords);
	} catch {
		return [];
	}
}

function uniqueNvidiaPids(...captures: ProbeCapture[]): number[] {
	const pids = new Set<number>();
	for (const capture of captures) {
		if (capture.outcome !== "ok" || capture.truncated) continue;
		for (const match of capture.stdout.matchAll(
			/(?:^|,|<pid>)\s*(\d+)\s*(?:,|<\/pid>)/gm,
		)) {
			const pid = Number(match[1]);
			if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
			if (pids.size >= HOST_PROBE_PARSE_LIMITS.maxRecords) break;
		}
	}
	return [...pids];
}

async function pidStarts(
	environment: HostProbeEnvironment,
	pids: readonly number[],
	signal: AbortSignal,
): Promise<Map<number, PidStartEvidence>> {
	const result = new Map<number, PidStartEvidence>();
	for (const pid of pids.slice(0, HOST_PROBE_PARSE_LIMITS.maxRecords)) {
		const path = `/proc/${pid}/stat`;
		const before = await environment.runtime.files.readFile(
			path,
			64 * 1024,
			signal,
		);
		const after = await environment.runtime.files.readFile(
			path,
			64 * 1024,
			signal,
		);
		const parsed = parsePidStartEvidence({
			pid,
			before,
			after,
			kernelBootId: environment.kernelBootId,
		});
		if (parsed.status === "ok" || parsed.status === "degraded")
			result.set(pid, parsed.value);
	}
	return result;
}

function filterDevices(
	result: ProbeResult<GpuDeviceObservation[]>,
	bindings: readonly ProbeBinding[],
): ProbeResult<GpuDeviceObservation[]> {
	if (
		(result.status !== "ok" && result.status !== "degraded") ||
		bindings.length === 0
	)
		return result;
	const selected = new Map<string, GpuDeviceObservation>();
	for (const binding of bindings) {
		const key = binding.deviceKey;
		const device = result.value.find((candidate) => {
			const identity = candidate.identity;
			const deviceMatches =
				!key ||
				key === identity.key ||
				key === identity.uuid ||
				key === identity.pciAddress ||
				key === `${identity.pciAddress}/${identity.uuid}`;
			const partitionMatches =
				!binding.partitionKey ||
				binding.partitionKey === identity.partition?.id ||
				binding.partitionKey === identity.partition?.uuid;
			return deviceMatches && partitionMatches;
		});
		if (!device)
			return resultError(
				"ambiguous-identity",
				`Configured binding '${binding.id}' has no stable device match`,
				"binding",
			);
		selected.set(device.identity.key, device);
	}
	return { ...result, value: [...selected.values()] };
}

abstract class VendorGpuProbe extends BaseProbe {
	protected tool: ProbeToolIdentity;
	protected versionCapture: ProbeCapture | null = null;

	constructor(
		environment: HostProbeEnvironment,
		protected readonly command: string,
	) {
		super(environment);
		this.tool = { name: command, version: "unknown" };
	}

	protected async ensureVersion(
		args: readonly string[],
		signal: AbortSignal,
	): Promise<Extract<
		ProbeResult<null>,
		{ status: "error" | "unsupported" }
	> | null> {
		if (!this.versionCapture) {
			this.versionCapture = await this.run(this.command, args, signal);
			this.tool = versionFrom(this.versionCapture, this.command);
		}
		return this.versionCapture.outcome === "ok" &&
			!this.versionCapture.truncated
			? null
			: captureFailure(this.versionCapture, `${this.command}-version`);
	}
}

interface AmdCaptureSet {
	list: ProbeCapture;
	metrics: ProbeCapture;
	processes: ProbeCapture;
	kfd?: ProbeCapture;
	pidStarts?: Map<number, PidStartEvidence>;
}

const DEFAULT_KFD_PROC_ROOTS = [
	"/sys/kernel/debug/kfd/proc",
	"/sys/class/kfd/kfd/proc",
] as const;

async function captureKfd(
	environment: HostProbeEnvironment,
	signal: AbortSignal,
	roots: readonly string[],
): Promise<ProbeCapture> {
	// Kernels expose the same KFD process evidence through either debugfs or
	// the class-device symlink. Prefer debugfs for compatibility, but do not
	// discard readable queue/VRAM evidence merely because debugfs is not
	// mounted or is root-only (the common unprivileged-host configuration).
	let selected:
		| {
				root: string;
				processes: { entries: string[]; truncated?: boolean };
		  }
		| undefined;
	let sawPermissionDenied = false;
	for (const root of roots) {
		const processes = await environment.runtime.files.readDirectory(
			root,
			HOST_PROBE_LIMITS.maxKfdEntries,
			signal,
		);
		if (processes.outcome === "ok") {
			selected = { root, processes };
			break;
		}
		sawPermissionDenied ||= processes.outcome === "permission-denied";
	}
	if (!selected) {
		return {
			outcome: sawPermissionDenied ? "permission-denied" : "execution-error",
		};
	}
	const { root, processes } = selected;
	if (processes.truncated)
		return { outcome: "ok", stdout: "", truncated: true };
	const files: { path: string; content: string }[] = [];
	for (const pid of processes.entries.filter((entry) => /^\d+$/.test(entry))) {
		const processRoot = `${root}/${pid}`;
		const processEntries = await environment.runtime.files.readDirectory(
			processRoot,
			HOST_PROBE_LIMITS.maxKfdEntries - files.length,
			signal,
		);
		if (processEntries.outcome !== "ok")
			return { outcome: processEntries.outcome };
		if (processEntries.truncated)
			return { outcome: "ok", stdout: "", truncated: true };
		for (const entry of processEntries.entries.filter((name) =>
			/^vram_\d+$/.test(name),
		)) {
			if (files.length >= HOST_PROBE_LIMITS.maxKfdEntries)
				return { outcome: "ok", stdout: "", truncated: true };
			const path = `${processRoot}/${entry}`;
			const content = await environment.runtime.files.readFile(
				path,
				128,
				signal,
			);
			if (content.outcome !== "ok" || content.truncated) return content;
			files.push({ path, content: content.stdout });
		}
		const queueRoot = `${root}/${pid}/queues`;
		const queues = await environment.runtime.files.readDirectory(
			queueRoot,
			HOST_PROBE_LIMITS.maxKfdEntries - files.length,
			signal,
		);
		if (queues.outcome !== "ok") return { outcome: queues.outcome };
		if (queues.truncated) return { outcome: "ok", stdout: "", truncated: true };
		for (const queue of queues.entries) {
			if (files.length >= HOST_PROBE_LIMITS.maxKfdEntries)
				return { outcome: "ok", stdout: "", truncated: true };
			const path = `${queueRoot}/${queue}/gpuid`;
			const content = await environment.runtime.files.readFile(
				path,
				128,
				signal,
			);
			if (content.outcome !== "ok" || content.truncated) return content;
			files.push({ path, content: content.stdout });
		}
	}
	return { outcome: "ok", stdout: JSON.stringify({ files }) };
}

async function captureKfdTopology(
	environment: HostProbeEnvironment,
	signal: AbortSignal,
	root = "/sys/class/kfd/kfd/topology/nodes",
): Promise<ProbeCapture> {
	const directory = await environment.runtime.files.readDirectory(
		root,
		HOST_PROBE_LIMITS.maxKfdEntries,
		signal,
	);
	if (directory.outcome !== "ok") return { outcome: directory.outcome };
	if (directory.truncated)
		return { outcome: "ok", stdout: "", truncated: true };
	const nodes: { gpuId: string; properties: string }[] = [];
	for (const entry of directory.entries.filter((name) => /^\d+$/.test(name))) {
		const [gpuId, properties] = await Promise.all([
			environment.runtime.files.readFile(
				`${root}/${entry}/gpu_id`,
				128,
				signal,
			),
			environment.runtime.files.readFile(
				`${root}/${entry}/properties`,
				64 * 1024,
				signal,
			),
		]);
		if (gpuId.outcome !== "ok" || gpuId.truncated) return gpuId;
		if (properties.outcome !== "ok" || properties.truncated) return properties;
		nodes.push({ gpuId: gpuId.stdout, properties: properties.stdout });
	}
	return { outcome: "ok", stdout: JSON.stringify({ nodes }) };
}

function uniqueKfdPids(capture: ProbeCapture): number[] {
	if (capture.outcome !== "ok" || capture.truncated) return [];
	const pids = new Set<number>();
	for (const match of capture.stdout.matchAll(/\/proc\/(\d+)\//g)) {
		const pid = Number(match[1]);
		if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
		if (pids.size >= HOST_PROBE_PARSE_LIMITS.maxRecords) break;
	}
	return [...pids];
}

export class AmdSmiProbeAdapter
	extends VendorGpuProbe
	implements
		HostProbeAdapter<readonly GpuDeviceIdentity[], GpuDeviceObservation[]>
{
	readonly kind = "amd-gpu" as const;

	constructor(
		environment: HostProbeEnvironment,
		command = "amd-smi",
		private readonly kfdProcRoots: readonly string[] = DEFAULT_KFD_PROC_ROOTS,
		private readonly kfdTopologyRoot = "/sys/class/kfd/kfd/topology/nodes",
		private readonly amdgpuTopCommand = "amdgpu_top",
	) {
		super(environment, command);
	}

	private async capture(
		signal: AbortSignal,
	): Promise<ProbeResult<GpuDeviceObservation[]>> {
		const unavailable = await this.ensureVersion(["version"], signal);
		if (unavailable) {
			const [topology, kfd, amdgpuTopVersion, amdgpuTopMetrics] =
				await Promise.all([
					captureKfdTopology(this.environment, signal, this.kfdTopologyRoot),
					captureKfd(this.environment, signal, this.kfdProcRoots),
					this.run(this.amdgpuTopCommand, ["--version"], signal),
					this.run(
						this.amdgpuTopCommand,
						["--json", "-n", "1", "-s", "250ms"],
						signal,
					),
				]);
			if (topology.outcome !== "ok" || kfd.outcome !== "ok") return unavailable;
			const starts = await pidStarts(
				this.environment,
				uniqueKfdPids(kfd),
				signal,
			);
			if (
				amdgpuTopVersion.outcome === "ok" &&
				!amdgpuTopVersion.truncated &&
				amdgpuTopMetrics.outcome === "ok" &&
				!amdgpuTopMetrics.truncated
			) {
				this.tool = versionFrom(amdgpuTopVersion, this.amdgpuTopCommand);
				return parseAmdGpuTop({
					topology,
					kfd,
					pidStarts: starts,
					metrics: amdgpuTopMetrics,
				});
			}
			this.tool = { name: "linux-kfd-sysfs", version: "kernel-sysfs" };
			return parseAmdKfdFallback({ topology, kfd, pidStarts: starts });
		}
		for (
			let attempt = 0;
			attempt <= HOST_PROBE_LIMITS.processListRetries;
			attempt++
		) {
			const [list, metrics, firstProcesses] = await Promise.all([
				this.run(this.command, ["list", "--json"], signal),
				this.run(
					this.command,
					["metric", "--usage", "--mem-usage", "--json"],
					signal,
				),
				this.run(this.command, ["process", "--json"], signal),
			]);
			const [lastList, processes] = await Promise.all([
				this.run(this.command, ["list", "--json"], signal),
				this.run(this.command, ["process", "--json"], signal),
			]);
			const stable =
				list.outcome !== "ok" ||
				lastList.outcome !== "ok" ||
				firstProcesses.outcome !== "ok" ||
				processes.outcome !== "ok" ||
				(list.stdout === lastList.stdout &&
					firstProcesses.stdout === processes.stdout);
			if (!stable) {
				if (attempt < HOST_PROBE_LIMITS.processListRetries) continue;
				return resultError(
					"partial-observation",
					"AMD device or process list changed during bounded capture",
					"amd-smi",
				);
			}
			const starts = await pidStarts(
				this.environment,
				uniquePidsFromJson(processes),
				signal,
			);
			const kfd = await captureKfd(this.environment, signal, this.kfdProcRoots);
			const captures: AmdCaptureSet = {
				list,
				metrics,
				processes,
				kfd,
				pidStarts: starts,
			};
			return parseAmdSmi(captures);
		}
		return resultError(
			"execution-failed",
			"AMD capture retry exhausted",
			"amd-smi",
		);
	}

	async discover(
		signal: AbortSignal,
	): Promise<DiscoveryResult<readonly GpuDeviceIdentity[]>> {
		const [started, monotonic] = this.start();
		const sample = await this.capture(signal);
		const result: ProbeResult<readonly GpuDeviceIdentity[]> =
			sample.status === "ok" || sample.status === "degraded"
				? { ...sample, value: sample.value.map((device) => device.identity) }
				: sample;
		return this.envelope.wrap(this.kind, this.tool, started, monotonic, result);
	}

	async sample(
		bindings: readonly ProbeBinding[],
		signal: AbortSignal,
	): Promise<ProbeSample<GpuDeviceObservation[]>> {
		const [started, monotonic] = this.start();
		const result = filterDevices(await this.capture(signal), bindings);
		return this.envelope.wrap(this.kind, this.tool, started, monotonic, result);
	}
}

export class NvidiaSmiProbeAdapter
	extends VendorGpuProbe
	implements
		HostProbeAdapter<readonly GpuDeviceIdentity[], GpuDeviceObservation[]>
{
	readonly kind = "nvidia-gpu" as const;

	constructor(environment: HostProbeEnvironment, command = "nvidia-smi") {
		super(environment, command);
	}

	private async capture(
		signal: AbortSignal,
	): Promise<ProbeResult<GpuDeviceObservation[]>> {
		const unavailable = await this.ensureVersion(["--version"], signal);
		if (unavailable) return unavailable;
		for (
			let attempt = 0;
			attempt <= HOST_PROBE_LIMITS.processListRetries;
			attempt++
		) {
			const [listing, metrics, firstProcesses, contexts] = await Promise.all([
				this.run(this.command, ["-L"], signal),
				this.run(
					this.command,
					[
						"--query-gpu=pci.bus_id,uuid,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
						"--format=csv,noheader,nounits",
					],
					signal,
				),
				this.run(
					this.command,
					[
						"--query-compute-apps=gpu_uuid,pid,used_gpu_memory",
						"--format=csv,noheader,nounits",
					],
					signal,
				),
				this.run(this.command, ["-q", "-x"], signal),
			]);
			const [lastListing, processes] = await Promise.all([
				this.run(this.command, ["-L"], signal),
				this.run(
					this.command,
					[
						"--query-compute-apps=gpu_uuid,pid,used_gpu_memory",
						"--format=csv,noheader,nounits",
					],
					signal,
				),
			]);
			const stable =
				listing.outcome !== "ok" ||
				lastListing.outcome !== "ok" ||
				firstProcesses.outcome !== "ok" ||
				processes.outcome !== "ok" ||
				(listing.stdout === lastListing.stdout &&
					firstProcesses.stdout === processes.stdout);
			if (!stable) {
				if (attempt < HOST_PROBE_LIMITS.processListRetries) continue;
				return resultError(
					"partial-observation",
					"NVIDIA device or process list changed during bounded capture",
					"nvidia-smi",
				);
			}
			const starts = await pidStarts(
				this.environment,
				uniqueNvidiaPids(processes, contexts),
				signal,
			);
			return parseNvidiaSmi({
				listing,
				metrics,
				processes,
				contexts,
				pidStarts: starts,
			});
		}
		return resultError(
			"execution-failed",
			"NVIDIA capture retry exhausted",
			"nvidia-smi",
		);
	}

	async discover(
		signal: AbortSignal,
	): Promise<DiscoveryResult<readonly GpuDeviceIdentity[]>> {
		const [started, monotonic] = this.start();
		const sample = await this.capture(signal);
		const result: ProbeResult<readonly GpuDeviceIdentity[]> =
			sample.status === "ok" || sample.status === "degraded"
				? { ...sample, value: sample.value.map((device) => device.identity) }
				: sample;
		return this.envelope.wrap(this.kind, this.tool, started, monotonic, result);
	}

	async sample(
		bindings: readonly ProbeBinding[],
		signal: AbortSignal,
	): Promise<ProbeSample<GpuDeviceObservation[]>> {
		const [started, monotonic] = this.start();
		const result = filterDevices(await this.capture(signal), bindings);
		return this.envelope.wrap(this.kind, this.tool, started, monotonic, result);
	}
}

export function createDefaultHostProbeAdapters(
	environment: HostProbeEnvironment,
): AnyHostProbeAdapter[] {
	let sequence = 0n;
	const sharedEnvironment: HostProbeEnvironment = {
		...environment,
		sequence: environment.sequence ?? { next: () => ++sequence },
	};
	return [
		new LinuxCpuProbeAdapter(sharedEnvironment),
		new LinuxMemoryProbeAdapter(sharedEnvironment),
		new NvidiaSmiProbeAdapter(sharedEnvironment),
		new AmdSmiProbeAdapter(sharedEnvironment),
	];
}
