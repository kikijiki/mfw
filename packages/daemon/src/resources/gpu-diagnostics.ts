import type {
	GpuOccupancyDiagnostic,
	HostGpuEvidenceDiagnostic,
	HostPidStartDiagnostic,
	StoredObservation,
} from "./host-types.ts";

/** The live lease that proved it owns a `pid:startTime` on one GPU unit. */
export interface GpuProcessOwner {
	leaseId: string;
	runId: string | null;
}

export type GpuOccupancyReason = "external-occupancy" | "unknown-occupancy";

function object(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function pidStartDiagnostic(
	value: unknown,
	pid: number,
): HostPidStartDiagnostic {
	const item = object(value);
	if (
		item?.status === "verified" &&
		typeof item.pid === "number" &&
		item.pid === pid &&
		(typeof item.startTimeTicks === "string" ||
			typeof item.startTimeTicks === "bigint") &&
		/^(?:0|[1-9][0-9]*)$/.test(String(item.startTimeTicks))
	) {
		return {
			status: "verified",
			pid,
			startTimeTicks: String(item.startTimeTicks),
			kernelBootId:
				typeof item.kernelBootId === "string" ? item.kernelBootId : null,
		};
	}
	if (
		item?.status === "raced" &&
		typeof item.beforeStartTimeTicks === "string" &&
		typeof item.afterStartTimeTicks === "string"
	) {
		return {
			status: "raced",
			pid,
			beforeStartTimeTicks: item.beforeStartTimeTicks,
			afterStartTimeTicks: item.afterStartTimeTicks,
		};
	}
	const reasons = [
		"permission-denied",
		"process-missing",
		"malformed-stat",
		"not-sampled",
	] as const;
	return {
		status: "unavailable",
		pid,
		reason:
			item?.status === "unavailable" &&
			reasons.includes(item.reason as (typeof reasons)[number])
				? (item.reason as (typeof reasons)[number])
				: "not-sampled",
	};
}

export function gpuEvidenceDiagnostics(
	values: readonly unknown[],
): HostGpuEvidenceDiagnostic[] {
	const result: HostGpuEvidenceDiagnostic[] = [];
	const kfdSources = ["linux-kfd-debugfs", "linux-kfd-sysfs"] as const;
	const blockingSources = [
		"amd-smi-process",
		"amd-smi-device",
		"nvidia-smi-compute-apps",
		"nvidia-smi-processes",
		"nvidia-smi-device",
	] as const;
	for (const value of values.slice(0, 256)) {
		const item = object(value);
		if (!item) continue;
		if (
			item.kind === "hsa-queue" &&
			kfdSources.includes(item.source as (typeof kfdSources)[number]) &&
			item.admission === "diagnostic-only" &&
			typeof item.queueId === "string"
		) {
			result.push({
				kind: "hsa-queue",
				source: item.source as (typeof kfdSources)[number],
				admission: "diagnostic-only",
				queueId: item.queueId.slice(0, 200),
			});
			continue;
		}
		if (
			item.kind === "device-memory" &&
			(kfdSources.includes(item.source as (typeof kfdSources)[number]) ||
				blockingSources.includes(
					item.source as (typeof blockingSources)[number],
				)) &&
			(item.admission === "blocking" || item.admission === "diagnostic-only") &&
			(typeof item.residentBytes === "string" ||
				typeof item.residentBytes === "bigint") &&
			/^(?:0|[1-9][0-9]*)$/.test(String(item.residentBytes))
		) {
			result.push({
				kind: "device-memory",
				source: item.source as Extract<
					HostGpuEvidenceDiagnostic,
					{ kind: "device-memory" }
				>["source"],
				admission: item.admission,
				residentBytes: String(item.residentBytes),
				...(item.memoryKind === "framebuffer" ||
				item.memoryKind === "vram" ||
				item.memoryKind === "gtt"
					? { memoryKind: item.memoryKind }
					: {}),
			} as HostGpuEvidenceDiagnostic);
			continue;
		}
		if (
			item.kind === "compute-context" &&
			blockingSources.includes(
				item.source as (typeof blockingSources)[number],
			) &&
			item.admission === "blocking"
		) {
			result.push({
				kind: "compute-context",
				source: item.source as (typeof blockingSources)[number],
				admission: "blocking",
				...(item.contextKind === "compute" ||
				item.contextKind === "graphics" ||
				item.contextKind === "mps" ||
				item.contextKind === "other"
					? { contextKind: item.contextKind }
					: {}),
				...(typeof item.computeUnitFraction === "number" &&
				Number.isFinite(item.computeUnitFraction) &&
				item.computeUnitFraction >= 0 &&
				item.computeUnitFraction <= 1
					? { computeUnitFraction: item.computeUnitFraction }
					: {}),
			});
		}
	}
	return result;
}

function decimal(value: unknown): bigint | null {
	return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)
		? BigInt(value)
		: null;
}

function finite(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Explains one conclusive GPU sample: who is on the device and whether that
 * use is ours. A process without a verified start time is never credited to a
 * run, and device memory is compared in aggregate so one managed process
 * cannot explain two claims.
 */
export function explainGpuSample(input: {
	sample: StoredObservation;
	metrics: Record<string, unknown>;
	/** A partial sample: its absence of occupants proves nothing. */
	degraded: boolean;
	binding: { id: string; stableKey: string };
	owners: ReadonlyMap<string, GpuProcessOwner>;
}): { diagnostic: GpuOccupancyDiagnostic; reason: GpuOccupancyReason | null } {
	const { metrics, binding, owners } = input;
	const occupancy = object(metrics.occupancy);
	const identity = object(metrics.identity);
	const occupants = input.sample.occupants.slice(0, 256).map((value) => {
		const occupant = object(value) ?? {};
		const pid =
			typeof occupant.pid === "number" && Number.isSafeInteger(occupant.pid)
				? occupant.pid
				: 0;
		const pidStart = pidStartDiagnostic(occupant.pidStart, pid);
		const start =
			pidStart.status === "verified" ? pidStart.startTimeTicks : null;
		const owner = start === null ? undefined : owners.get(`${pid}:${start}`);
		return {
			pid,
			pidStart,
			attribution: owner
				? ("managed" as const)
				: start === null
					? ("unknown" as const)
					: ("external" as const),
			runId: owner?.runId ?? null,
			leaseId: owner?.leaseId ?? null,
			evidence: gpuEvidenceDiagnostics(
				Array.isArray(occupant.evidence) ? occupant.evidence : [],
			),
		};
	});
	const deviceEvidence = gpuEvidenceDiagnostics(
		Array.isArray(occupancy?.deviceEvidence) ? occupancy.deviceEvidence : [],
	);
	const blockingBytes = (items: readonly HostGpuEvidenceDiagnostic[]) =>
		items.reduce(
			(total, item) =>
				item.kind === "device-memory" && item.admission === "blocking"
					? total + BigInt(item.residentBytes)
					: total,
			0n,
		);
	const managedBytes = blockingBytes(
		occupants
			.filter((item) => item.attribution === "managed")
			.flatMap((item) => item.evidence),
	);
	const unexplainedDevice =
		deviceEvidence.some(
			(item) => item.admission === "blocking" && item.kind !== "device-memory",
		) || blockingBytes(deviceEvidence) > managedBytes;
	const state = occupancy?.state;
	const reason: GpuOccupancyReason | null =
		input.degraded ||
		state === "unknown" ||
		occupants.some((item) => item.attribution === "unknown")
			? "unknown-occupancy"
			: occupants.some((item) => item.attribution === "external") ||
					unexplainedDevice ||
					(occupancy?.blocksExclusiveAdmission === true &&
						occupants.length === 0)
				? "external-occupancy"
				: null;
	const power = finite(metrics.powerWatts);
	return {
		reason,
		diagnostic: {
			bindingId: binding.id,
			stableKey: binding.stableKey,
			deviceKey: typeof identity?.key === "string" ? identity.key : null,
			state:
				state === "idle" || state === "occupied" || state === "unknown"
					? state
					: "unknown",
			blocksExclusiveAdmission: reason !== null,
			gpuUtilization:
				typeof metrics.gpuUtilization === "number"
					? metrics.gpuUtilization
					: null,
			memoryUsedBytes: decimal(metrics.memoryUsedBytes),
			memoryTotalBytes: decimal(metrics.memoryTotalBytes),
			temperatureCelsius: finite(metrics.temperatureCelsius),
			powerWatts: power !== null && power >= 0 ? power : null,
			occupants,
			deviceEvidence,
		},
	};
}
