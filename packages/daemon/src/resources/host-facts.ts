import type { ProbeBinding } from "@mfw/core/host-observation";
import type { GpuFact, LocalHostFacts } from "./builtin/local-host.ts";
import { explainGpuSample, type GpuProcessOwner } from "./gpu-diagnostics.ts";
import type {
	HostCapacityHoldReason,
	ObservationAdmissionDiagnostic,
	ObservationHealth,
	StoredObservation,
} from "./host-types.ts";
import {
	cpuObservationFromHealth,
	memoryObservationFromHealth,
	observationEnvelopeFromSample,
} from "./observation-policy.ts";
import { RAM_OBSERVATION_MAX_AGE_MS } from "./quantity.ts";
import type { ResourceStore } from "./store.ts";

export type ProbeEvidenceStore = Pick<
	ResourceStore,
	| "readProbeEvidence"
	| "recordProbeBatch"
	| "recordProbeHealth"
	| "recordProbeSample"
>;

/** A binding whose samples are stored, and that has no GPU unit. */
export interface KindedProbeBinding extends ProbeBinding {
	kind: "linux-memory" | "linux-cpu";
}

export interface GpuUnitBinding extends ProbeBinding {
	/** The pool unit this device or partition is. */
	unit: string;
	kind: "amd-gpu" | "nvidia-gpu";
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function bytes(value: unknown): bigint {
	return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)
		? BigInt(value)
		: 0n;
}

function blockingResident(evidence: unknown): bigint {
	if (!Array.isArray(evidence)) return 0n;
	return evidence.reduce<bigint>((total, item) => {
		const e = record(item);
		return e?.kind === "device-memory" && e.admission === "blocking"
			? total + bytes(e.residentBytes)
			: total;
	}, 0n);
}

/**
 * The latest probe results, persisted so an operator can see them after a
 * restart. Admission never trusts an earlier process's samples. It turns them into `local-host` facts through
 * the same freshness and identity policy, so stale or foreign evidence reads
 * as an unavailable probe.
 */
export class HostFacts {
	private readonly health = new Map<string, ObservationHealth>();
	private readonly samples = new Map<string, StoredObservation>();
	private otherBindings: readonly KindedProbeBinding[] = [];

	constructor(
		readonly identity: { processBootId: string; kernelBootId: string | null },
		private readonly now: () => number,
		private readonly evidence: ProbeEvidenceStore,
		private gpuBindings: readonly GpuUnitBinding[] = [],
	) {}

	/** Reloads the persisted evidence; samples of an earlier process fail policy. */
	async load(): Promise<void> {
		const { health, samples } = await this.evidence.readProbeEvidence();
		this.health.clear();
		this.samples.clear();
		for (const row of health) this.health.set(row.kind, row);
		for (const row of samples) this.samples.set(row.bindingId, row);
	}

	setBindings(
		gpu: readonly GpuUnitBinding[],
		others: readonly KindedProbeBinding[] = [],
	): void {
		this.gpuBindings = gpu;
		this.otherBindings = others;
	}

	bindingsFor(kind: string): ProbeBinding[] {
		return [...this.gpuBindings, ...this.otherBindings]
			.filter((binding) => binding.kind === kind)
			.map(({ id, deviceKey, partitionKey }) => ({
				id,
				...(deviceKey ? { deviceKey } : {}),
				...(partitionKey ? { partitionKey } : {}),
			}));
	}

	healthRows(): ObservationHealth[] {
		return [...this.health.values()];
	}

	async recordObservationBatch(
		health: ObservationHealth,
		samples: readonly StoredObservation[],
	): Promise<{ meaningfulChange: boolean }> {
		const result = await this.evidence.recordProbeBatch(health, samples);
		await this.load();
		return result;
	}

	async recordObservationHealth(health: ObservationHealth): Promise<void> {
		await this.evidence.recordProbeHealth(health);
		await this.load();
	}

	async recordObservation(sample: StoredObservation): Promise<void> {
		await this.evidence.recordProbeSample(sample);
		await this.load();
	}

	sampleRows(): StoredObservation[] {
		return [...this.samples.values()];
	}

	/** Who is on a device; null when its latest sample proves nothing. */
	explainGpu(
		binding: { id: string; stableKey: string },
		owners: ReadonlyMap<string, GpuProcessOwner>,
	): ReturnType<typeof explainGpuSample> | null {
		const known = this.gpuBindings.find((item) => item.id === binding.id);
		const coherent = known ? this.coherentGpu(known) : null;
		if (!coherent) return null;
		return explainGpuSample({
			sample: coherent.sample,
			metrics: coherent.envelope.metrics,
			degraded: coherent.envelope.degraded,
			binding,
			owners,
		});
	}

	private coherentGpu(binding: GpuUnitBinding) {
		const sample = this.samples.get(binding.id);
		const health = this.health.get(binding.kind);
		if (!sample || !health) return null;
		// A sample from another generation than its adapter's health is not coherent.
		const sequence = record(record(health.detail)?.generation)?.sequence;
		if (
			health.result === "error" ||
			health.result === "unsupported" ||
			sequence !== sample.sequence.toString() ||
			health.result !== sample.result
		) {
			return null;
		}
		const envelope = observationEnvelopeFromSample({
			sample,
			expectedKind: binding.kind,
			now: this.now(),
			identity: this.identity,
			allowDegradedValue: true,
		});
		return envelope.ok ? { sample, envelope: envelope.value } : null;
	}

	private gpuFact(binding: GpuUnitBinding): GpuFact | null {
		const coherent = this.coherentGpu(binding);
		if (!coherent) return null;
		const { sample, envelope } = coherent;
		const occupancy = record(envelope.metrics.occupancy);
		const device = Array.isArray(occupancy?.deviceEvidence)
			? occupancy.deviceEvidence
			: [];
		const state = occupancy?.state;
		return {
			unit: binding.unit,
			state:
				state === "idle" || state === "occupied" || state === "unknown"
					? state
					: "unknown",
			occupants: sample.occupants.slice(0, 256).map((raw) => {
				const occupant = record(raw) ?? {};
				const start = record(occupant.pidStart);
				return {
					pid: typeof occupant.pid === "number" ? occupant.pid : 0,
					processStartTime:
						start?.status === "verified" &&
						typeof start.startTimeTicks === "string"
							? start.startTimeTicks
							: null,
					blockingResidentBytes: blockingResident(occupant.evidence),
				};
			}),
			blockingDeviceBytes: blockingResident(device),
			blockingDeviceContext: device.some((item) => {
				const e = record(item);
				return e?.admission === "blocking" && e.kind !== "device-memory";
			}),
			blocksExclusive: occupancy?.blocksExclusiveAdmission === true,
			degraded: envelope.degraded,
		};
	}

	/** How a probe's latest health reads, for an incident's explanation. */
	diagnosticFor(kind: string): ObservationAdmissionDiagnostic | null {
		const health = this.health.get(kind);
		if (!health) return null;
		const detail = record(health.detail);
		const sequence = record(detail?.generation)?.sequence;
		const expires = record(detail?.freshness)?.expiresAt;
		const expiresAt = typeof expires === "string" ? Date.parse(expires) : NaN;
		return {
			kind,
			bindingId: null,
			sequence:
				typeof sequence === "string" && /^(?:0|[1-9][0-9]*)$/.test(sequence)
					? BigInt(sequence)
					: null,
			observedAt: health.checkedAt,
			ageMs: Math.max(0, this.now() - health.checkedAt),
			expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
			maxAgeMs: RAM_OBSERVATION_MAX_AGE_MS,
			processBootId: health.processBootId,
			kernelBootId: health.kernelBootId,
			reuse: "serialized-while-fresh",
			policy: "required",
		};
	}

	/** Why this kind's evidence cannot be used now; null when it can. */
	denialFor(kind: string): HostCapacityHoldReason | null {
		const health = this.health.get(kind);
		if (!health) return "observation-missing";
		const identity = this.identity;
		const now = this.now();
		if (kind === "linux-memory") {
			const memory = memoryObservationFromHealth({ health, now, identity });
			return memory.ok ? null : memory.reason;
		}
		if (kind === "linux-cpu") {
			const cpu = cpuObservationFromHealth({
				health,
				now,
				identity,
				configuredPermits: 1n,
				policy: {},
			});
			return cpu.ok ? null : cpu.reason;
		}
		if (health.processBootId !== identity.processBootId) {
			return "observation-not-current-process";
		}
		if (health.kernelBootId !== identity.kernelBootId) {
			return "observation-not-current-kernel";
		}
		return health.result === "error" || health.result === "unsupported"
			? "observation-failed"
			: null;
	}

	/** Current memory evidence with its sequence; null when it proves nothing. */
	memoryEvidence(): { memAvailableBytes: bigint; sequence: bigint } | null {
		const health = this.health.get("linux-memory");
		if (!health) return null;
		const memory = memoryObservationFromHealth({
			health,
			now: this.now(),
			identity: this.identity,
		});
		if (!memory.ok || memory.value.diagnostic.sequence === null) return null;
		return {
			memAvailableBytes: memory.value.memAvailableBytes,
			sequence: memory.value.diagnostic.sequence,
		};
	}

	/** Facts for `local-host`. Anything unproven is null or a missing device. */
	localFacts(): LocalHostFacts {
		const now = this.now();
		const cpuHealth = this.health.get("linux-cpu");
		const cpu = cpuHealth
			? cpuObservationFromHealth({
					health: cpuHealth,
					now,
					identity: this.identity,
					configuredPermits: 1n,
					policy: {},
				})
			: null;
		const memoryHealth = this.health.get("linux-memory");
		const memory = memoryHealth
			? memoryObservationFromHealth({
					health: memoryHealth,
					now,
					identity: this.identity,
				})
			: null;
		const gpus = this.gpuBindings.flatMap((binding) => {
			const fact = this.gpuFact(binding);
			return fact ? [fact] : [];
		});
		return {
			cpu:
				cpu?.ok && cpu.value.pressure
					? {
							busyFraction: cpu.value.pressure.busyFraction,
							runnableProcesses: cpu.value.pressure.runnableProcesses,
						}
					: null,
			memAvailableBytes: memory?.ok ? memory.value.memAvailableBytes : null,
			gpus,
		};
	}
}
