/**
 * Portable host-observation contracts.
 *
 * These are facts produced by probes, not configured capacity, reservations,
 * or admission decisions. Adapters may populate them from captured command or
 * procfs data without importing daemon, database, or scheduler code.
 */

export type HostProbeKind =
	| "linux-cpu"
	| "linux-memory"
	| "amd-gpu"
	| "nvidia-gpu";

export type ProbeResultStatus = "ok" | "degraded" | "error" | "unsupported";

export type ProbeDiagnosticSeverity = "info" | "warning" | "error";

export type ProbeAdmissionEffect = "none" | "degrade" | "block";

export type ProbeDiagnosticCode =
	| "unsupported-platform"
	| "tool-missing"
	| "tool-version-unsupported"
	| "permission-denied"
	| "probe-timeout"
	| "output-truncated"
	| "output-too-large"
	| "too-many-records"
	| "line-too-long"
	| "malformed-output"
	| "missing-field"
	| "invalid-unit"
	| "invalid-value"
	| "counter-regressed"
	| "ambiguous-identity"
	| "duplicate-identity"
	| "device-reset"
	| "partial-observation"
	| "pid-start-unavailable"
	| "pid-reused-or-raced"
	| "kfd-evidence-diagnostic-only"
	| "sample-not-current-process"
	| "kernel-boot-changed"
	| "sample-expired"
	| "execution-failed";

export interface ProbeDiagnostic {
	code: ProbeDiagnosticCode;
	severity: ProbeDiagnosticSeverity;
	/** Whether this condition is safe for an admission consumer to ignore. */
	admissionEffect: ProbeAdmissionEffect;
	message: string;
	/** A bounded, non-sensitive field/record label. Never a command line. */
	field?: string;
}

export type ProbeResult<T> =
	| { status: "ok"; value: T; diagnostics: ProbeDiagnostic[] }
	| { status: "degraded"; value: T; diagnostics: ProbeDiagnostic[] }
	| {
			status: "error" | "unsupported";
			value: null;
			diagnostics: ProbeDiagnostic[];
	  };

export interface ProbeToolIdentity {
	name: string;
	version: string;
}

export interface ObservationGeneration {
	/** Random identity of the daemon process that captured this observation. */
	processBootId: string;
	/** Linux boot_id when available; null is diagnostic and never proof of a reboot. */
	kernelBootId: string | null;
	/** Strictly increasing within one processBootId. */
	sequence: bigint;
}

/** Persistable adapter health without embedding a latest sample or policy. */
export interface ProbeHealth {
	kind: HostProbeKind;
	status: ProbeResultStatus;
	checkedGeneration: ObservationGeneration;
	lastOkGeneration: ObservationGeneration | null;
	diagnostics: ProbeDiagnostic[];
}

export type ObservationFreshness =
	| { state: "fresh"; checkedAt: string; expiresAt: string }
	| {
			state: "stale";
			checkedAt: string;
			reason: "different-process-boot" | "different-kernel-boot" | "expired";
	  };

export interface HostObservation<T> {
	kind: HostProbeKind;
	adapterVersion: string;
	tool: ProbeToolIdentity;
	generation: ObservationGeneration;
	freshness: ObservationFreshness;
	observedAt: string;
	durationMs: number;
	result: ProbeResult<T>;
}

export interface ProbeBinding {
	id: string;
	deviceKey?: string;
	partitionKey?: string;
}

export interface HostProbeAdapter<TDiscovery, TSample> {
	kind: HostProbeKind;
	discover(signal: AbortSignal): Promise<DiscoveryResult<TDiscovery>>;
	sample(
		bindings: readonly ProbeBinding[],
		signal: AbortSignal,
	): Promise<ProbeSample<TSample>>;
}

export type DiscoveryResult<T> = HostObservation<T>;
export type ProbeSample<T> = HostObservation<T>;

/** Integer bytes. bigint prevents silent loss above Number.MAX_SAFE_INTEGER. */
export type ByteCount = bigint;

/** Integer count of configured/discovered logical CPU permits, never a share. */
export type LogicalCpuCount = number;

/** Normalized finite value in the inclusive range 0..1. */
export type UtilizationFraction = number;

export interface LinuxCpuDiscovery {
	logicalProcessors: LogicalCpuCount;
}

export interface LinuxCpuPressure {
	/** Busy fraction from aggregate /proc/stat counter deltas. */
	busyFraction: UtilizationFraction;
	/** Instantaneous runnable process count from procs_running. */
	runnableProcesses: number;
	/** Optional load observations are pressure only, never available CPU permits. */
	loadAverage?: { one: number; five: number; fifteen: number };
}

export interface LinuxMemoryObservation {
	/** Total host RAM reported by /proc/meminfo, normalized from KiB. */
	memTotalBytes: ByteCount;
	/** Host-scoped /proc/meminfo MemAvailable, normalized from KiB to bytes. */
	memAvailableBytes: ByteCount;
	/** Total configured swap and currently free swap, normalized from KiB. */
	swapTotalBytes: ByteCount;
	swapFreeBytes: ByteCount;
	scope: "host";
}

export type GpuVendor = "amd" | "nvidia";

export type GpuPartitionKind =
	| "amd-compute-partition"
	| "nvidia-mig"
	| "sriov-vf";

export interface GpuPartitionIdentity {
	kind: GpuPartitionKind;
	/** Vendor-reported stable partition identifier within the physical device. */
	id: string;
	/** Vendor UUID when the partition surface provides one. */
	uuid: string | null;
}

export interface GpuDeviceIdentity {
	/** Stable canonical key. Enumeration/display order is deliberately excluded. */
	key: string;
	vendor: GpuVendor;
	/** Canonical lower-case dddd:bb:dd.f. */
	pciAddress: string;
	/**
	 * Vendor-reported physical or logical-device UUID, or a namespaced stable
	 * PCI fallback when the kernel surface does not expose a vendor UUID.
	 */
	uuid: string;
	partition: GpuPartitionIdentity | null;
	/** Diagnostic display order only. It must never be used as identity. */
	displayIndex: number | null;
}

export type PidStartUnavailableReason =
	| "permission-denied"
	| "process-missing"
	| "malformed-stat"
	| "not-sampled";

export type PidStartEvidence =
	| {
			status: "verified";
			pid: number;
			startTimeTicks: bigint;
			kernelBootId: string | null;
	  }
	| {
			status: "unavailable";
			pid: number;
			reason: PidStartUnavailableReason;
	  }
	| {
			status: "raced";
			pid: number;
			beforeStartTimeTicks: bigint;
			afterStartTimeTicks: bigint;
	  };

export type OccupantAttribution = "managed" | "external" | "unknown";

export type GpuOccupancyEvidenceKind =
	| "compute-context"
	| "hsa-queue"
	| "device-memory";

export type GpuOccupancyEvidenceSource =
	| "amd-smi-process"
	| "amd-smi-device"
	| "nvidia-smi-compute-apps"
	| "nvidia-smi-processes"
	| "nvidia-smi-device"
	| "linux-kfd-debugfs"
	| "linux-kfd-sysfs";

export type KfdOccupancyEvidenceSource = Extract<
	GpuOccupancyEvidenceSource,
	"linux-kfd-debugfs" | "linux-kfd-sysfs"
>;

export type GpuContextKind = "compute" | "graphics" | "mps" | "other";

export type GpuOccupancyEvidence =
	| {
			/**
			 * KFD proc evidence is diagnostic-only in this contract. Its
			 * directory walk cannot prove stable device mapping, complete
			 * permissions, and PID/queue race freedom as one atomic observation.
			 */
			kind: "hsa-queue";
			source: KfdOccupancyEvidenceSource;
			admission: "diagnostic-only";
			queueId: string;
	  }
	| {
			/** KFD memory files share the same non-atomic diagnostic boundary. */
			kind: "device-memory";
			source: KfdOccupancyEvidenceSource;
			admission: "diagnostic-only";
			residentBytes: ByteCount;
			memoryKind: "vram";
	  }
	| {
			kind: Exclude<GpuOccupancyEvidenceKind, "hsa-queue">;
			source: Exclude<GpuOccupancyEvidenceSource, KfdOccupancyEvidenceSource>;
			admission: "blocking";
			residentBytes?: ByteCount;
			/** Context kind is evidence, never inferred from utilization. */
			contextKind?: GpuContextKind;
			/** Vendor-reported per-process CU fraction when available. */
			computeUnitFraction?: UtilizationFraction;
			/** Memory domain when a process surface separates VRAM and GTT. */
			memoryKind?: "framebuffer" | "vram" | "gtt";
	  };

interface GpuOccupantBase {
	pid: number;
	evidence: GpuOccupancyEvidence[];
}

export type GpuOccupant =
	| (GpuOccupantBase & {
			attribution: "managed";
			/** Managed attribution is impossible without PID-reuse-safe evidence. */
			pidStart: Extract<PidStartEvidence, { status: "verified" }>;
	  })
	| (GpuOccupantBase & {
			attribution: Exclude<OccupantAttribution, "managed">;
			pidStart: PidStartEvidence;
	  });

export interface GpuOccupancy {
	state: "idle" | "occupied" | "unknown";
	occupants: GpuOccupant[];
	/** Admission-bearing device evidence that cannot be attributed to one PID. */
	deviceEvidence: GpuOccupancyEvidence[];
	/** True only if at least one evidence item is admission-bearing. */
	blocksExclusiveAdmission: boolean;
}

export interface GpuDeviceObservation {
	identity: GpuDeviceIdentity;
	gpuUtilization: UtilizationFraction | null;
	/** Vendor device-level VRAM/framebuffer use. */
	memoryUsedBytes: ByteCount | null;
	/** Vendor-reported addressable GPU memory for display/telemetry only. */
	memoryTotalBytes: ByteCount | null;
	/** Device edge temperature when the vendor exposes a bounded sensor value. */
	temperatureCelsius: number | null;
	/** Instantaneous device power draw when the vendor exposes it. */
	powerWatts: number | null;
	occupancy: GpuOccupancy;
}

/** Bounded subprocess/file capture supplied to a pure parser. */
export type ProbeCapture =
	| {
			outcome: "ok";
			stdout: string;
			stderr?: string;
			exitCode?: 0;
			truncated?: boolean;
	  }
	| {
			outcome:
				| "missing-tool"
				| "unsupported"
				| "permission-denied"
				| "timeout"
				| "execution-error";
			stdout?: string;
			stderr?: string;
			exitCode?: number | null;
			truncated?: boolean;
	  };
