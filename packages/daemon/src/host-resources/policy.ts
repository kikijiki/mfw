import {
	checkedQuantitySum,
	MAX_HOST_QUANTITY,
	RAM_OBSERVATION_FUTURE_SKEW_MS,
	RAM_OBSERVATION_MAX_AGE_MS,
} from "./quantity.ts";
import type {
	CpuPressureDiagnostic,
	CpuPressurePolicy,
	HostCapacityHoldReason,
	ObservationAdmissionDiagnostic,
	ObservationHealth,
	StoredObservation,
} from "./types.ts";

export interface CurrentHostIdentity {
	processBootId: string;
	kernelBootId: string | null;
}

export interface ParsedMemoryObservation {
	memAvailableBytes: bigint;
	attributableManagedBytes: bigint;
	diagnostic: ObservationAdmissionDiagnostic;
	ignored: boolean;
}

export type MemoryObservationPolicyResult =
	| { ok: true; value: ParsedMemoryObservation }
	| {
			ok: false;
			reason: HostCapacityHoldReason;
			message: string;
			diagnostic: ObservationAdmissionDiagnostic;
	  };

function decimalBigint(value: unknown, field: string): bigint {
	let parsed: bigint;
	if (typeof value === "bigint") parsed = value;
	else if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) {
		parsed = BigInt(value);
	} else {
		throw new Error(`${field} is not an unsigned integer`);
	}
	if (parsed > MAX_HOST_QUANTITY) {
		throw new Error(`${field} exceeds the supported 64-bit quantity range`);
	}
	return parsed;
}

function object(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function observationDiagnostic(input: {
	kind: string;
	bindingId?: string | null;
	sequence?: bigint | null;
	observedAt?: number | null;
	expiresAt?: number | null;
	now: number;
	processBootId?: string | null;
	kernelBootId?: string | null;
	ignoreObservation?: boolean;
}): ObservationAdmissionDiagnostic {
	return {
		kind: input.kind,
		bindingId: input.bindingId ?? null,
		sequence: input.sequence ?? null,
		observedAt: input.observedAt ?? null,
		ageMs:
			input.observedAt === undefined || input.observedAt === null
				? null
				: input.now - input.observedAt,
		expiresAt: input.expiresAt ?? null,
		maxAgeMs: RAM_OBSERVATION_MAX_AGE_MS,
		processBootId: input.processBootId ?? null,
		kernelBootId: input.kernelBootId ?? null,
		reuse: "serialized-while-fresh",
		policy: input.ignoreObservation ? "ignored-explicitly" : "required",
	};
}

export interface ParsedObservationEnvelope {
	metrics: Record<string, unknown>;
	diagnostic: ObservationAdmissionDiagnostic;
	ignored: boolean;
	degraded: boolean;
}

export type ObservationEnvelopePolicyResult =
	| { ok: true; value: ParsedObservationEnvelope }
	| {
			ok: false;
			reason: HostCapacityHoldReason;
			message: string;
			diagnostic: ObservationAdmissionDiagnostic;
	  };

function validateEnvelope(input: {
	kind: string;
	result: ObservationHealth["result"];
	metrics: Record<string, unknown> | null;
	diagnostic: ObservationAdmissionDiagnostic;
	identity: CurrentHostIdentity;
	ignoreObservation: boolean;
	allowDegradedValue?: boolean;
}): ObservationEnvelopePolicyResult {
	if (input.ignoreObservation) {
		return {
			ok: true,
			value: {
				metrics: {},
				diagnostic: input.diagnostic,
				ignored: true,
				degraded: true,
			},
		};
	}
	if (
		input.result !== "ok" &&
		!(input.allowDegradedValue && input.result === "degraded")
	) {
		return {
			ok: false,
			reason: "observation-failed",
			message: `${input.kind} observation result is ${input.result}`,
			diagnostic: input.diagnostic,
		};
	}
	if (input.diagnostic.sequence === null) {
		return {
			ok: false,
			reason: "observation-inconsistent",
			message: `${input.kind} observation has no valid monotonic sequence`,
			diagnostic: input.diagnostic,
		};
	}
	if (input.diagnostic.processBootId !== input.identity.processBootId) {
		return {
			ok: false,
			reason: "observation-not-current-process",
			message: `${input.kind} observation is not from the current daemon process`,
			diagnostic: input.diagnostic,
		};
	}
	if (
		input.identity.kernelBootId !== null &&
		input.diagnostic.kernelBootId !== input.identity.kernelBootId
	) {
		return {
			ok: false,
			reason: "observation-not-current-kernel",
			message: `${input.kind} observation is not from the current kernel boot`,
			diagnostic: input.diagnostic,
		};
	}
	if (
		input.diagnostic.ageMs === null ||
		input.diagnostic.ageMs < -RAM_OBSERVATION_FUTURE_SKEW_MS ||
		input.diagnostic.ageMs > RAM_OBSERVATION_MAX_AGE_MS ||
		(input.diagnostic.expiresAt !== null &&
			input.diagnostic.observedAt !== null &&
			input.diagnostic.expiresAt <
				input.diagnostic.observedAt + input.diagnostic.ageMs)
	) {
		return {
			ok: false,
			reason: "observation-stale",
			message: `${input.kind} observation is outside the ${RAM_OBSERVATION_MAX_AGE_MS}ms admission window`,
			diagnostic: input.diagnostic,
		};
	}
	if (!input.metrics) {
		return {
			ok: false,
			reason: "observation-inconsistent",
			message: `${input.kind} observation has no latest value`,
			diagnostic: input.diagnostic,
		};
	}
	return {
		ok: true,
		value: {
			metrics: input.metrics,
			diagnostic: input.diagnostic,
			ignored: false,
			degraded: input.result === "degraded",
		},
	};
}

function generationSequence(detail: Record<string, unknown>): bigint | null {
	const generation = object(detail.generation);
	try {
		return generation?.sequence === undefined
			? null
			: decimalBigint(generation.sequence, "generation.sequence");
	} catch {
		return null;
	}
}

export function observationEnvelopeFromHealth(input: {
	health: ObservationHealth;
	expectedKind: string;
	now: number;
	identity: CurrentHostIdentity;
	ignoreObservation?: boolean;
	allowDegradedValue?: boolean;
}): ObservationEnvelopePolicyResult {
	const detail = input.health.detail ?? {};
	const generation = object(detail.generation);
	const freshness = object(detail.freshness);
	const expiresAt =
		typeof freshness?.expiresAt === "string"
			? Date.parse(freshness.expiresAt)
			: Number.NaN;
	const checkedAt =
		typeof freshness?.checkedAt === "string"
			? Date.parse(freshness.checkedAt)
			: Number.NaN;
	const diagnostic = observationDiagnostic({
		kind: input.health.kind,
		sequence: generationSequence(detail),
		observedAt: input.health.checkedAt,
		expiresAt:
			freshness?.state === "fresh" && Number.isFinite(expiresAt)
				? expiresAt
				: input.health.checkedAt - 1,
		now: input.now,
		processBootId: input.health.processBootId,
		kernelBootId: input.health.kernelBootId,
		ignoreObservation: input.ignoreObservation,
	});
	if (input.health.kind !== input.expectedKind) {
		return {
			ok: false,
			reason: "observation-inconsistent",
			message: `expected ${input.expectedKind} health, got '${input.health.kind}'`,
			diagnostic,
		};
	}
	if (
		input.ignoreObservation !== true &&
		(generation?.processBootId !== input.health.processBootId ||
			(generation.kernelBootId ?? null) !== input.health.kernelBootId ||
			freshness?.state !== "fresh" ||
			!Number.isFinite(checkedAt) ||
			checkedAt !== input.health.checkedAt)
	) {
		return {
			ok: false,
			reason: "observation-inconsistent",
			message: `${input.expectedKind} health envelope disagrees with its generation or freshness detail`,
			diagnostic,
		};
	}
	return validateEnvelope({
		kind: input.expectedKind,
		result: input.health.result,
		metrics: object(detail.latest),
		diagnostic,
		identity: input.identity,
		ignoreObservation: input.ignoreObservation === true,
		allowDegradedValue: input.allowDegradedValue,
	});
}

export function observationEnvelopeFromSample(input: {
	sample: StoredObservation;
	expectedKind: string;
	now: number;
	identity: CurrentHostIdentity;
	ignoreObservation?: boolean;
	allowDegradedValue?: boolean;
}): ObservationEnvelopePolicyResult {
	const diagnostic = observationDiagnostic({
		kind: input.sample.kind,
		bindingId: input.sample.bindingId,
		sequence: input.sample.sequence,
		observedAt: input.sample.observedAt,
		expiresAt: input.sample.observedAt + RAM_OBSERVATION_MAX_AGE_MS,
		now: input.now,
		processBootId: input.sample.processBootId,
		kernelBootId: input.sample.kernelBootId,
		ignoreObservation: input.ignoreObservation,
	});
	if (input.sample.kind !== input.expectedKind) {
		return {
			ok: false,
			reason: "observation-inconsistent",
			message: `expected ${input.expectedKind} sample, got '${input.sample.kind}'`,
			diagnostic,
		};
	}
	return validateEnvelope({
		kind: input.expectedKind,
		result: input.sample.result,
		metrics: input.sample.metrics,
		diagnostic,
		identity: input.identity,
		ignoreObservation: input.ignoreObservation === true,
		allowDegradedValue: input.allowDegradedValue,
	});
}

export type CpuObservationPolicyResult =
	| {
			ok: true;
			value: ParsedObservationEnvelope & {
				pressure: CpuPressureDiagnostic | null;
				blocked: boolean;
			};
	  }
	| Exclude<ObservationEnvelopePolicyResult, { ok: true }>;

export function cpuObservationFromHealth(input: {
	health: ObservationHealth;
	now: number;
	identity: CurrentHostIdentity;
	configuredPermits: bigint;
	policy: CpuPressurePolicy;
	ignoreObservation?: boolean;
}): CpuObservationPolicyResult {
	const envelope = observationEnvelopeFromHealth({
		health: input.health,
		expectedKind: "linux-cpu",
		now: input.now,
		identity: input.identity,
		ignoreObservation: input.ignoreObservation,
	});
	if (!envelope.ok) return envelope;
	if (envelope.value.ignored) {
		return {
			ok: true,
			value: { ...envelope.value, pressure: null, blocked: false },
		};
	}
	const busy = envelope.value.metrics.busyFraction;
	const runnable = envelope.value.metrics.runnableProcesses;
	if (
		typeof busy !== "number" ||
		!Number.isFinite(busy) ||
		busy < 0 ||
		busy > 1 ||
		typeof runnable !== "number" ||
		!Number.isSafeInteger(runnable) ||
		runnable < 0
	) {
		return {
			ok: false,
			reason: "observation-inconsistent",
			message: "linux-cpu pressure fields are invalid",
			diagnostic: envelope.value.diagnostic,
		};
	}
	const maxBusy = input.policy.maxBusyFraction ?? null;
	const maxRunnable = input.policy.maxRunnableProcesses ?? null;
	const pressure: CpuPressureDiagnostic = {
		configuredPermits: input.configuredPermits,
		busyFraction: busy,
		runnableProcesses: runnable,
		maxBusyFraction: maxBusy,
		maxRunnableProcesses: maxRunnable,
		busyBlocked: maxBusy !== null && busy > maxBusy,
		runnableBlocked: maxRunnable !== null && runnable > maxRunnable,
	};
	return {
		ok: true,
		value: {
			...envelope.value,
			pressure,
			blocked: pressure.busyBlocked || pressure.runnableBlocked,
		},
	};
}

function attribution(metrics: Record<string, unknown>): bigint {
	const managed = object(metrics.managedAttribution);
	if (managed?.state !== "verified") return 0n;
	if (!Array.isArray(managed.residents)) {
		throw new Error("verified managed attribution has no resident evidence");
	}
	let total = 0n;
	for (const [index, value] of managed.residents.entries()) {
		const resident = object(value);
		if (
			!resident ||
			typeof resident.leaseId !== "string" ||
			resident.leaseId.length === 0 ||
			typeof resident.runId !== "string" ||
			resident.runId.length === 0 ||
			typeof resident.pid !== "number" ||
			!Number.isSafeInteger(resident.pid) ||
			resident.pid <= 0 ||
			typeof resident.processStartTime !== "string" ||
			resident.processStartTime.length === 0
		) {
			throw new Error(
				`managedAttribution.residents[${index}] lacks PID-reuse-safe ownership evidence`,
			);
		}
		total = checkedQuantitySum(
			total,
			decimalBigint(
				resident.residentBytes,
				`managedAttribution.residents[${index}].residentBytes`,
			),
			"managed resident attribution",
		);
	}
	return total;
}

function validateValue(metrics: Record<string, unknown>): {
	memAvailableBytes: bigint;
	attributableManagedBytes: bigint;
} {
	if (metrics.scope !== "host") {
		throw new Error("linux-memory observation scope must be 'host'");
	}
	const available = decimalBigint(
		metrics.memAvailableBytes,
		"memAvailableBytes",
	);
	if (metrics.memTotalBytes !== undefined) {
		const total = decimalBigint(metrics.memTotalBytes, "memTotalBytes");
		if (available > total) {
			throw new Error("memAvailableBytes exceeds memTotalBytes");
		}
	}
	for (const field of ["swapTotalBytes", "swapFreeBytes"] as const) {
		if (metrics[field] !== undefined) decimalBigint(metrics[field], field);
	}
	if (
		metrics.swapTotalBytes !== undefined &&
		metrics.swapFreeBytes !== undefined &&
		decimalBigint(metrics.swapFreeBytes, "swapFreeBytes") >
			decimalBigint(metrics.swapTotalBytes, "swapTotalBytes")
	) {
		throw new Error("swapFreeBytes exceeds swapTotalBytes");
	}
	return {
		memAvailableBytes: available,
		attributableManagedBytes: attribution(metrics),
	};
}

function applyEnvelope(input: {
	result: ObservationHealth["result"];
	metrics: Record<string, unknown> | null;
	diagnostic: ObservationAdmissionDiagnostic;
	identity: CurrentHostIdentity;
	ignoreObservation: boolean;
}): MemoryObservationPolicyResult {
	const { diagnostic } = input;
	if (input.ignoreObservation) {
		return {
			ok: true,
			value: {
				memAvailableBytes: 0n,
				attributableManagedBytes: 0n,
				diagnostic,
				ignored: true,
			},
		};
	}
	if (input.result !== "ok") {
		return {
			ok: false,
			reason: "observation-failed",
			message: `linux-memory observation result is ${input.result}`,
			diagnostic,
		};
	}
	if (diagnostic.sequence === null) {
		return {
			ok: false,
			reason: "observation-inconsistent",
			message: "linux-memory observation has no valid monotonic sequence",
			diagnostic,
		};
	}
	if (diagnostic.processBootId !== input.identity.processBootId) {
		return {
			ok: false,
			reason: "observation-not-current-process",
			message:
				"linux-memory observation is not from the current daemon process",
			diagnostic,
		};
	}
	if (
		input.identity.kernelBootId !== null &&
		diagnostic.kernelBootId !== input.identity.kernelBootId
	) {
		return {
			ok: false,
			reason: "observation-not-current-kernel",
			message: "linux-memory observation is not from the current kernel boot",
			diagnostic,
		};
	}
	if (
		diagnostic.ageMs === null ||
		diagnostic.ageMs < -RAM_OBSERVATION_FUTURE_SKEW_MS ||
		diagnostic.ageMs > RAM_OBSERVATION_MAX_AGE_MS ||
		(diagnostic.expiresAt !== null &&
			diagnostic.observedAt !== null &&
			diagnostic.expiresAt < diagnostic.observedAt + diagnostic.ageMs)
	) {
		return {
			ok: false,
			reason: "observation-stale",
			message: `linux-memory observation is outside the ${RAM_OBSERVATION_MAX_AGE_MS}ms admission window`,
			diagnostic,
		};
	}
	if (!input.metrics) {
		return {
			ok: false,
			reason: "observation-inconsistent",
			message: "linux-memory observation has no latest value",
			diagnostic,
		};
	}
	try {
		return {
			ok: true,
			value: { ...validateValue(input.metrics), diagnostic, ignored: false },
		};
	} catch (error) {
		return {
			ok: false,
			reason: "observation-inconsistent",
			message:
				error instanceof Error
					? error.message
					: "linux-memory observation is internally inconsistent",
			diagnostic,
		};
	}
}

/** Parse the exact JSON-safe MFW-92 `health.detail.latest` contract. */
export function memoryObservationFromHealth(input: {
	health: ObservationHealth;
	now: number;
	identity: CurrentHostIdentity;
	ignoreObservation?: boolean;
}): MemoryObservationPolicyResult {
	if (input.health.kind !== "linux-memory") {
		return {
			ok: false,
			reason: "observation-inconsistent",
			message: `expected linux-memory health, got '${input.health.kind}'`,
			diagnostic: observationDiagnostic({
				kind: input.health.kind,
				observedAt: input.health.checkedAt,
				now: input.now,
				processBootId: input.health.processBootId,
				kernelBootId: input.health.kernelBootId,
				ignoreObservation: input.ignoreObservation,
			}),
		};
	}
	const detail = input.health.detail ?? {};
	const generation = object(detail.generation);
	const freshness = object(detail.freshness);
	const expiresAt =
		typeof freshness?.expiresAt === "string"
			? Date.parse(freshness.expiresAt)
			: Number.NaN;
	const freshnessCheckedAt =
		typeof freshness?.checkedAt === "string"
			? Date.parse(freshness.checkedAt)
			: Number.NaN;
	let sequence: bigint | null = null;
	try {
		if (generation?.sequence !== undefined) {
			sequence = decimalBigint(generation.sequence, "generation.sequence");
		}
	} catch {
		sequence = null;
	}
	const diagnostic = observationDiagnostic({
		kind: input.health.kind,
		sequence,
		observedAt: input.health.checkedAt,
		expiresAt:
			freshness?.state === "fresh" && Number.isFinite(expiresAt)
				? expiresAt
				: input.health.checkedAt - 1,
		now: input.now,
		processBootId: input.health.processBootId,
		kernelBootId: input.health.kernelBootId,
		ignoreObservation: input.ignoreObservation,
	});
	if (
		input.ignoreObservation !== true &&
		(generation?.processBootId !== input.health.processBootId ||
			(generation.kernelBootId ?? null) !== input.health.kernelBootId ||
			(freshness?.state === "fresh" &&
				(!Number.isFinite(freshnessCheckedAt) ||
					freshnessCheckedAt !== input.health.checkedAt)))
	) {
		return {
			ok: false,
			reason: "observation-inconsistent",
			message:
				"linux-memory health envelope disagrees with its generation or freshness detail",
			diagnostic,
		};
	}
	return applyEnvelope({
		result: input.health.result,
		metrics: object(detail.latest),
		diagnostic,
		identity: input.identity,
		ignoreObservation: input.ignoreObservation === true,
	});
}

/** Compatibility and configured-binding path for an injected stored sample. */
export function memoryObservationFromSample(input: {
	sample: StoredObservation;
	now: number;
	identity: CurrentHostIdentity;
	ignoreObservation?: boolean;
}): MemoryObservationPolicyResult {
	if (input.sample.kind !== "linux-memory") {
		return {
			ok: false,
			reason: "observation-inconsistent",
			message: `expected linux-memory sample, got '${input.sample.kind}'`,
			diagnostic: observationDiagnostic({
				kind: input.sample.kind,
				bindingId: input.sample.bindingId,
				observedAt: input.sample.observedAt,
				now: input.now,
				processBootId: input.sample.processBootId,
				kernelBootId: input.sample.kernelBootId,
				ignoreObservation: input.ignoreObservation,
			}),
		};
	}
	const diagnostic = observationDiagnostic({
		kind: input.sample.kind,
		bindingId: input.sample.bindingId,
		sequence: input.sample.sequence,
		observedAt: input.sample.observedAt,
		expiresAt: input.sample.observedAt + RAM_OBSERVATION_MAX_AGE_MS,
		now: input.now,
		processBootId: input.sample.processBootId,
		kernelBootId: input.sample.kernelBootId,
		ignoreObservation: input.ignoreObservation,
	});
	return applyEnvelope({
		result: input.sample.result,
		metrics: input.sample.metrics,
		diagnostic,
		identity: input.identity,
		ignoreObservation: input.ignoreObservation === true,
	});
}
