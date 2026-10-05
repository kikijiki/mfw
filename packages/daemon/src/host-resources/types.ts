export type HostAccounting = "slot" | "quantity";
export type HostProvisioning = "static" | "dynamic";
export type HostQuantityUnit = "integer" | "bytes";

export interface CpuPressurePolicy {
	/** Maximum accepted aggregate /proc/stat busy fraction, inclusive 0..1. */
	maxBusyFraction?: number;
	/** Maximum accepted instantaneous runnable process count. */
	maxRunnableProcesses?: number;
}

export interface HostResourceDefinition {
	id: string;
	accounting: HostAccounting;
	provisioning: HostProvisioning;
	capacity: bigint;
	/** Required for quantity resources; absent for identity-bearing slots. */
	quantityUnit?: HostQuantityUnit | null;
	/** Explicit RAM floor. Capacity is never derived from installed memory. */
	safetyHeadroom?: bigint | null;
	enabled: boolean;
	draining: boolean;
	version: bigint;
	observationKind?: string | null;
	ignoreObservation?: boolean;
	/** Required when observationKind is linux-cpu. Permits remain capacity. */
	cpuPressure?: CpuPressurePolicy | null;
	metadata?: Record<string, unknown>;
}

export interface HostResourceBinding {
	id: string;
	resourceId: string;
	stableKey: string;
	enabled: boolean;
	version: bigint;
	metadata?: Record<string, unknown>;
}

export interface HostRequirement {
	resourceId: string;
	amount: bigint;
	bindingId?: string | null;
}

/** A request is immutable once its requestKey has been persisted. */
export interface ImmutableHostRequest {
	requestKey: string;
	projectId: string;
	requirements: readonly HostRequirement[];
	metadata?: Readonly<Record<string, unknown>>;
}

export type WaiterState = "waiting" | "granted" | "cancelled";

export interface Waiter {
	id: string;
	requestKey: string;
	projectId: string;
	sequence: bigint;
	generation: bigint;
	state: WaiterState;
	requirements: HostRequirement[];
	createdAt: number;
}

export type LeaseState =
	| "provisional"
	| "active"
	| "uncertain"
	| "releasing"
	| "released"
	| "reclaimed"
	| "force_released";

export interface RunRef {
	runId: string;
	runDir: string;
	sessionId?: string | null;
	pid?: number | null;
	processStartTime?: string | null;
	kernelBootId?: string | null;
	/** PID-reuse-safe launch tree evidence; names/command lines are forbidden. */
	processTree?: Array<{
		pid: number;
		processStartTime: string;
		kernelBootId?: string | null;
	}>;
}

export interface OwnerProof extends RunRef {
	processBootId: string;
	observedAt: number;
}

export interface LeaseAllocation extends HostRequirement {}

export interface HostLease {
	id: string;
	waiterId: string;
	projectId: string;
	state: LeaseState;
	fence: bigint;
	allocations: LeaseAllocation[];
	run: RunRef | null;
	ownerProcessBootId: string | null;
	grantedAt: number;
	activatedAt: number | null;
	lastRenewedAt: number | null;
	expiresAt: number | null;
	releaseReason: string | null;
}

export interface Grant extends HostLease {
	state: "provisional";
}

export interface ActiveLease extends HostLease {
	state: "active";
}

export interface Held {
	kind: "held";
	waiterId: string;
	generation: bigint;
	reason:
		| "fifo"
		| "capacity"
		| "definition"
		| "generation"
		| "observation"
		| "headroom";
	blockedBy: string[];
	diagnostics: HostHoldDiagnostic[];
}

/**
 * A scheduler wave pins observation/definition identities while each grant
 * transaction re-reads promises, so earlier grants in the wave count and a
 * poll or operator edit cannot mix snapshots.
 */
export interface HostAdmissionSnapshot {
	generation: bigint;
	capturedAt: number;
	processBootId: string;
	kernelBootId: string | null;
	definitions: Record<string, bigint>;
	bindings: Record<string, bigint>;
	health: Record<
		string,
		{ checkedAt: number; sequence: bigint | null; result: ObservationResult }
	>;
	observations: Record<string, bigint>;
}

export type ObservationResult = "ok" | "degraded" | "error" | "unsupported";

export interface StoredObservation {
	bindingId: string;
	kind: string;
	sequence: bigint;
	result: ObservationResult;
	processBootId: string;
	kernelBootId: string | null;
	observedAt: number;
	durationMs: number;
	metrics: Record<string, unknown>;
	occupants: unknown[];
	warnings: string[];
	adapterVersion?: string | null;
}

export type HostCapacityHoldReason =
	| "disabled"
	| "draining"
	| "dynamic-unprovisioned"
	| "invalid-definition"
	| "quota-exhausted"
	| "observation-missing"
	| "observation-ambiguous"
	| "observation-not-current-process"
	| "observation-not-current-kernel"
	| "observation-stale"
	| "observation-failed"
	| "observation-inconsistent"
	| "cpu-pressure"
	| "external-occupancy"
	| "unknown-occupancy"
	| "headroom-exhausted";

export interface RamPolicyDiagnostic {
	configuredQuotaBytes: bigint;
	safetyHeadroomBytes: bigint;
	memAvailableBytes: bigint;
	durablePromisesBytes: bigint;
	attributableManagedBytes: bigint;
	outstandingPromiseBytes: bigint;
	quotaRemainingBytes: bigint;
	observedHeadroomBytes: bigint;
	effectiveCapacityBytes: bigint;
	requestBytes?: bigint;
}

export interface ObservationAdmissionDiagnostic {
	kind: string;
	bindingId: string | null;
	sequence: bigint | null;
	observedAt: number | null;
	ageMs: number | null;
	expiresAt: number | null;
	maxAgeMs: number;
	processBootId: string | null;
	kernelBootId: string | null;
	/** Samples may be reused only while fresh; promises are re-read per grant. */
	reuse: "serialized-while-fresh";
	policy: "required" | "ignored-explicitly";
}

export interface CpuPressureDiagnostic {
	configuredPermits: bigint;
	busyFraction: number;
	runnableProcesses: number;
	maxBusyFraction: number | null;
	maxRunnableProcesses: number | null;
	busyBlocked: boolean;
	runnableBlocked: boolean;
}

export type HostPidStartDiagnostic =
	| {
			status: "verified";
			pid: number;
			startTimeTicks: string;
			kernelBootId: string | null;
	  }
	| {
			status: "unavailable";
			pid: number;
			reason:
				| "permission-denied"
				| "process-missing"
				| "malformed-stat"
				| "not-sampled";
	  }
	| {
			status: "raced";
			pid: number;
			beforeStartTimeTicks: string;
			afterStartTimeTicks: string;
	  };

export type HostGpuEvidenceDiagnostic =
	| {
			kind: "hsa-queue";
			source: "linux-kfd-debugfs" | "linux-kfd-sysfs";
			admission: "diagnostic-only";
			queueId: string;
	  }
	| {
			kind: "device-memory";
			source:
				| "linux-kfd-debugfs"
				| "linux-kfd-sysfs"
				| "amd-smi-process"
				| "amd-smi-device"
				| "nvidia-smi-compute-apps"
				| "nvidia-smi-processes"
				| "nvidia-smi-device";
			admission: "diagnostic-only" | "blocking";
			residentBytes: string;
			memoryKind?: "framebuffer" | "vram" | "gtt";
	  }
	| {
			kind: "compute-context";
			source:
				| "amd-smi-process"
				| "amd-smi-device"
				| "nvidia-smi-compute-apps"
				| "nvidia-smi-processes"
				| "nvidia-smi-device";
			admission: "blocking";
			contextKind?: "compute" | "graphics" | "mps" | "other";
			computeUnitFraction?: number;
	  };

export interface HostGpuOccupantDiagnostic {
	pid: number;
	pidStart: HostPidStartDiagnostic;
	attribution: "managed" | "external" | "unknown";
	runId: string | null;
	leaseId: string | null;
	evidence: HostGpuEvidenceDiagnostic[];
}

export interface GpuOccupancyDiagnostic {
	bindingId: string;
	stableKey: string;
	deviceKey: string | null;
	state: "idle" | "occupied" | "unknown";
	blocksExclusiveAdmission: boolean;
	gpuUtilization: number | null;
	memoryUsedBytes: bigint | null;
	memoryTotalBytes: bigint | null;
	temperatureCelsius: number | null;
	powerWatts: number | null;
	occupants: HostGpuOccupantDiagnostic[];
	deviceEvidence: HostGpuEvidenceDiagnostic[];
}

export interface HostHoldDiagnostic {
	resourceId: string;
	reason: HostCapacityHoldReason;
	message: string;
	requestedAmount: bigint;
	configuredQuota: bigint | null;
	durablePromises: bigint | null;
	effectiveCapacity: bigint;
	observation: ObservationAdmissionDiagnostic | null;
	ramFormula: RamPolicyDiagnostic | null;
	cpuPressure: CpuPressureDiagnostic | null;
	gpuOccupancy: GpuOccupancyDiagnostic | null;
}

export interface HostEffectiveCapacity {
	resourceId: string;
	accounting: HostAccounting;
	quantityUnit: HostQuantityUnit | null;
	/** Reservations gate launch only; no cgroup/kernel limit is claimed. */
	enforcement: {
		mode: "admission-control";
		kernelEnforced: false;
	};
	configuredQuota: bigint;
	durablePromises: bigint;
	/** Observation-constrained capacity before durable promises are applied. */
	observedCapacity: bigint | null;
	effectiveCapacity: bigint;
	holdReason: HostCapacityHoldReason | null;
	observation: ObservationAdmissionDiagnostic | null;
	ramFormula: RamPolicyDiagnostic | null;
	cpuPressure: CpuPressureDiagnostic | null;
	gpuOccupancy: GpuOccupancyDiagnostic[];
	degraded: boolean;
}

export interface RamResourceIncident {
	key: string;
	kind: "ram-low-headroom";
	resourceId: string;
	state: "open" | "resolved";
	openedAt: number;
	updatedAt: number;
	resolvedAt: number | null;
	context: RamPolicyDiagnostic & {
		observationSequence: bigint;
	};
}

export interface ObservationConflictIncident {
	key: string;
	kind: "gpu-occupancy-conflict" | "cpu-pressure";
	resourceId: string;
	state: "open" | "resolved";
	openedAt: number;
	updatedAt: number;
	resolvedAt: number | null;
	context: {
		reason: HostCapacityHoldReason;
		observation: ObservationAdmissionDiagnostic;
		leaseIds: string[];
		cpuPressure?: CpuPressureDiagnostic;
		gpuOccupancy?: GpuOccupancyDiagnostic[];
	};
}

export type HostResourceIncident =
	| RamResourceIncident
	| ObservationConflictIncident;

export interface HostResourceHold {
	resourceId: string;
	state: "open" | "resolved";
	reason: HostCapacityHoldReason;
	snapshotGeneration: bigint;
	openedAt: number;
	updatedAt: number;
	resolvedAt: number | null;
	diagnostic: HostHoldDiagnostic;
}

export interface ObservationHealth {
	kind: string;
	result: ObservationResult;
	checkedAt: number;
	processBootId: string;
	kernelBootId: string | null;
	detail?: Record<string, unknown>;
}

export interface HostAuditEntry {
	seq: bigint;
	at: number;
	eventKey: string;
	action: string;
	actor: string;
	projectId: string | null;
	waiterId: string | null;
	leaseId: string | null;
	fence: bigint | null;
	detail: Record<string, unknown>;
}

export interface HostResourceReadModel {
	hostId: string;
	coordinatorId: string;
	kernelBootId: string | null;
	processBootId: string;
	generation: bigint;
	definitions: HostResourceDefinition[];
	bindings: HostResourceBinding[];
	waiters: Waiter[];
	leases: HostLease[];
	observations: StoredObservation[];
	health: ObservationHealth[];
	effectiveCapacities: HostEffectiveCapacity[];
	incidents: HostResourceIncident[];
	holds: HostResourceHold[];
	occupants: Array<GpuOccupancyDiagnostic & { resourceId: string }>;
}

export type LivenessStatus = "live" | "absent" | "unavailable" | "unknown";

export interface LivenessEvidence {
	status: LivenessStatus;
	checkedAt: number;
	kernelBootId: string | null;
	processBootId?: string | null;
	detail?: string;
}

export interface LeaseLivenessInspector {
	inspect(lease: HostLease): Promise<LivenessEvidence>;
}

export type ReconcileCause =
	| "startup"
	| "manual"
	| "project_attached"
	| "project_detached"
	| "observation";

export interface ReconcileReport {
	cause: ReconcileCause;
	examined: number;
	adopted: number;
	reclaimed: number;
	uncertain: number;
	released: number;
	unchanged: number;
}

export type Unsubscribe = () => void;

/** The only host-resource capability injected into a project. */
export interface HostResourceCoordinatorPort {
	readModel(): HostResourceReadModel;
	captureAdmissionSnapshot(): HostAdmissionSnapshot;
	putWaiter(request: ImmutableHostRequest): Promise<Waiter>;
	tryGrant(
		waiterId: string,
		expectedGeneration: bigint,
		snapshot?: HostAdmissionSnapshot,
	): Promise<Grant | Held>;
	activate(grantId: string, fence: bigint, run: RunRef): Promise<ActiveLease>;
	renewOrAdopt(
		leaseId: string,
		fence: bigint,
		owner: OwnerProof,
	): Promise<void>;
	cancelOrRelease(id: string, fence: bigint, reason: string): Promise<void>;
	reconcile(cause: ReconcileCause): Promise<ReconcileReport>;
	subscribe(projectId: string, wake: () => void): Unsubscribe;
}

export interface ProjectIdentity {
	id: string;
	createdAt: number;
}
