import { createHash } from "node:crypto";
import type { HostProbeKind } from "@mfw/core/host-observation";
import type {
	HostResourceBinding,
	HostResourceDefinition,
	HostResourceReadModel,
} from "./host-resources/types.ts";

export interface HostResourceRecommendation {
	id: string;
	fingerprint: string;
	label: string;
	description: string;
	definition: HostResourceDefinition;
	bindings: HostResourceBinding[];
	definitionState: "new" | "existing" | "conflict";
	missingBindingIds: string[];
	bindingConflictIds: string[];
	canApply: boolean;
}

function detailLatest(model: HostResourceReadModel, kind: string): unknown {
	const health = model.health.find((item) => item.kind === kind);
	if (
		!health ||
		(health.result !== "ok" && health.result !== "degraded") ||
		health.processBootId !== model.processBootId ||
		health.kernelBootId !== model.kernelBootId
	)
		return undefined;
	return health.detail?.latest;
}

function proposalFingerprint(
	definition: HostResourceDefinition,
	bindings: readonly HostResourceBinding[],
): string {
	const serialized = JSON.stringify(
		{
			definition,
			bindings: [...bindings].sort((a, b) => a.id.localeCompare(b.id)),
		},
		(_key, value) => (typeof value === "bigint" ? value.toString() : value),
	);
	return createHash("sha256").update(serialized).digest("hex");
}

function safeBigInt(value: unknown): bigint | null {
	if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value))
		return null;
	try {
		return BigInt(value);
	} catch {
		return null;
	}
}

function definitionState(
	model: HostResourceReadModel,
	definition: HostResourceDefinition,
): HostResourceRecommendation["definitionState"] {
	const existing = model.definitions.find((item) => item.id === definition.id);
	if (!existing) return "new";
	return existing.accounting === definition.accounting &&
		existing.provisioning === definition.provisioning &&
		existing.capacity === definition.capacity &&
		(existing.quantityUnit ?? null) === (definition.quantityUnit ?? null) &&
		(existing.safetyHeadroom ?? null) === (definition.safetyHeadroom ?? null) &&
		(existing.observationKind ?? null) ===
			(definition.observationKind ?? null) &&
		(existing.ignoreObservation ?? false) ===
			(definition.ignoreObservation ?? false) &&
		(existing.cpuPressure?.maxBusyFraction ?? null) ===
			(definition.cpuPressure?.maxBusyFraction ?? null) &&
		(existing.cpuPressure?.maxRunnableProcesses ?? null) ===
			(definition.cpuPressure?.maxRunnableProcesses ?? null)
		? "existing"
		: "conflict";
}

function recommendation(
	model: HostResourceReadModel,
	input: Omit<
		HostResourceRecommendation,
		| "fingerprint"
		| "definitionState"
		| "missingBindingIds"
		| "bindingConflictIds"
		| "canApply"
	>,
): HostResourceRecommendation {
	const state = definitionState(model, input.definition);
	const exactBindingIds = new Set(
		input.bindings
			.filter((binding) =>
				model.bindings.some(
					(existing) =>
						existing.id === binding.id &&
						existing.resourceId === binding.resourceId &&
						existing.stableKey === binding.stableKey,
				),
			)
			.map((binding) => binding.id),
	);
	const bindingConflictIds = input.bindings
		.filter((binding) =>
			model.bindings.some(
				(existing) =>
					(existing.id === binding.id &&
						(existing.resourceId !== binding.resourceId ||
							existing.stableKey !== binding.stableKey)) ||
					(existing.stableKey === binding.stableKey &&
						existing.id !== binding.id),
			),
		)
		.map((binding) => binding.id);
	const conflicts = new Set(bindingConflictIds);
	const missingBindingIds = input.bindings
		.filter(
			(binding) =>
				!exactBindingIds.has(binding.id) && !conflicts.has(binding.id),
		)
		.map((binding) => binding.id);
	return {
		...input,
		fingerprint: proposalFingerprint(input.definition, input.bindings),
		definitionState: state,
		missingBindingIds,
		bindingConflictIds,
		canApply:
			state !== "conflict" &&
			bindingConflictIds.length === 0 &&
			(state === "new" || missingBindingIds.length > 0),
	};
}

function gpuRecommendations(
	model: HostResourceReadModel,
	kind: "amd-gpu" | "nvidia-gpu",
): HostResourceRecommendation | null {
	const latest = detailLatest(model, kind);
	if (!Array.isArray(latest) || latest.length === 0) return null;
	const vendor = kind === "amd-gpu" ? "amd" : "nvidia";
	const observedDevices = latest
		.flatMap((item) => {
			if (!item || typeof item !== "object") return [];
			const record = item as Record<string, unknown>;
			// Health snapshots contain the probe's `latest` identities directly.
			// Accept the older nested device-observation shape as well so persisted
			// snapshots from an earlier daemon remain reviewable after an upgrade.
			const value =
				record.identity && typeof record.identity === "object"
					? (record.identity as Record<string, unknown>)
					: record;
			if (
				typeof value.key !== "string" ||
				typeof value.pciAddress !== "string" ||
				value.vendor !== vendor
			)
				return [];
			const partition =
				value.partition && typeof value.partition === "object"
					? (value.partition as Record<string, unknown>)
					: null;
			const partitionKey =
				typeof partition?.uuid === "string" && partition.uuid.trim()
					? partition.uuid
					: typeof partition?.id === "string" && partition.id.trim()
						? partition.id
						: null;
			if (partition && !partitionKey) return [];
			return [
				{
					key: value.key,
					pciAddress: value.pciAddress,
					partitioned: partition !== null,
					partitionKey,
				},
			];
		})
		.sort(
			(a, b) =>
				a.pciAddress.localeCompare(b.pciAddress) ||
				a.key.localeCompare(b.key) ||
				(a.partitionKey ?? "").localeCompare(b.partitionKey ?? ""),
		);
	const devicesByKey = new Map<string, (typeof observedDevices)[number]>();
	for (const device of observedDevices) {
		const previous = devicesByKey.get(device.key);
		if (
			previous &&
			(previous.pciAddress !== device.pciAddress ||
				previous.partitionKey !== device.partitionKey)
		)
			return null;
		devicesByKey.set(device.key, device);
	}
	const uniqueDevices = [...devicesByKey.values()];
	const partitionedAddresses = new Set(
		uniqueDevices
			.filter((device) => device.partitioned)
			.map((device) => device.pciAddress),
	);
	const devices = uniqueDevices.filter(
		(device) =>
			device.partitioned || !partitionedAddresses.has(device.pciAddress),
	);
	if (devices.length === 0) return null;
	const resourceId = `gpu-${vendor}`;
	const bindings = devices.map((device) => {
		const identityHash = createHash("sha256")
			.update(device.key)
			.digest("hex")
			.slice(0, 12);
		return {
			id: `${resourceId}-${device.pciAddress.replace(/[^a-zA-Z0-9]+/g, "-")}-${identityHash}`,
			resourceId,
			stableKey: device.key,
			enabled: true,
			version: 1n,
			metadata: {
				pciAddress: device.pciAddress,
				...(device.partitionKey ? { partitionKey: device.partitionKey } : {}),
			},
		};
	});
	if (new Set(bindings.map((binding) => binding.id)).size !== bindings.length)
		return null;
	return recommendation(model, {
		id: resourceId,
		label: `${vendor === "amd" ? "AMD" : "NVIDIA"} GPU`,
		description: `${devices.length} physical or partitioned device${devices.length === 1 ? "" : "s"}, reserved as exclusive host slots and gated by live context occupancy.`,
		definition: {
			id: resourceId,
			accounting: "slot",
			provisioning: "static",
			capacity: BigInt(devices.length),
			enabled: true,
			draining: false,
			version: 1n,
			observationKind: kind,
			ignoreObservation: false,
		},
		bindings,
	});
}

/**
 * Build a reviewable, deterministic proposal from the current host's own
 * probes. Nothing is written here; applying remains an explicit operator act.
 */
export function detectHostResourceRecommendations(
	model: HostResourceReadModel,
	logicalProcessors: number,
	eligibleKinds?: ReadonlySet<HostProbeKind>,
): HostResourceRecommendation[] {
	const result: HostResourceRecommendation[] = [];
	if (
		(!eligibleKinds || eligibleKinds.has("linux-cpu")) &&
		Number.isInteger(logicalProcessors) &&
		logicalProcessors > 0
	) {
		result.push(
			recommendation(model, {
				id: "cpu",
				label: "CPU",
				description: `${logicalProcessors} logical processors, with new work held above 90% aggregate busy pressure.`,
				definition: {
					id: "cpu",
					accounting: "quantity",
					provisioning: "static",
					capacity: BigInt(logicalProcessors),
					quantityUnit: "integer",
					enabled: true,
					draining: false,
					version: 1n,
					observationKind: "linux-cpu",
					ignoreObservation: false,
					cpuPressure: {
						maxBusyFraction: 0.9,
						maxRunnableProcesses: logicalProcessors * 2,
					},
				},
				bindings: [],
			}),
		);
	}
	const memory =
		eligibleKinds?.has("linux-memory") === false
			? undefined
			: detailLatest(model, "linux-memory");
	const total =
		memory && typeof memory === "object"
			? safeBigInt((memory as Record<string, unknown>).memTotalBytes)
			: null;
	if (total && total > 0n) {
		const fourGiB = 4n * 1024n ** 3n;
		const headroom = [total / 10n, fourGiB, total / 4n].sort((a, b) =>
			a < b ? -1 : a > b ? 1 : 0,
		)[1] as bigint;
		result.push(
			recommendation(model, {
				id: "ram",
				label: "RAM",
				description: `${(Number(total) / 1024 ** 3).toFixed(1)} GiB installed with ${(Number(headroom) / 1024 ** 3).toFixed(1)} GiB reserved as safety headroom.`,
				definition: {
					id: "ram",
					accounting: "quantity",
					provisioning: "static",
					capacity: total,
					quantityUnit: "bytes",
					safetyHeadroom: headroom,
					enabled: true,
					draining: false,
					version: 1n,
					observationKind: "linux-memory",
					ignoreObservation: false,
				},
				bindings: [],
			}),
		);
	}
	for (const kind of ["amd-gpu", "nvidia-gpu"] as const) {
		if (eligibleKinds?.has(kind) === false) continue;
		const gpu = gpuRecommendations(model, kind);
		if (gpu) result.push(gpu);
	}
	return result;
}
