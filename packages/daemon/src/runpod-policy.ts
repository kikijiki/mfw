import { RUNPOD_CLOUDS, RUNPOD_CPU_FLAVORS } from "@mfw/core/runpod";
import { z } from "zod";

export { RUNPOD_CLOUDS, RUNPOD_CPU_FLAVORS };

const finitePositive = z.number().finite().positive();
const sshHostPublicKey = z
	.string()
	.trim()
	.regex(
		/^(?:ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) [A-Za-z0-9+/=]+$/,
		"must be one complete pinned OpenSSH public host key",
	);
const uniqueArray = <T extends z.ZodTypeAny>(item: T, minimum = 0) =>
	z
		.array(item)
		.min(minimum)
		.superRefine((values, ctx) => {
			if (
				new Set(values.map((value) => JSON.stringify(value))).size !==
				values.length
			) {
				ctx.addIssue({ code: "custom", message: "entries must be unique" });
			}
		});

const enabledMachinePolicySchema = z
	.object({
		enabled: z.literal(true),
		accountId: z
			.string()
			.trim()
			.regex(/^[a-zA-Z0-9_-]{1,64}$/),
		/** Stable account namespace carried in Pod metadata. Never inferred from a name. */
		ownershipNamespace: z
			.string()
			.trim()
			.regex(/^[a-zA-Z0-9._:-]{8,96}$/),
		/** Authenticated account suffix from RunPod's documented basic-SSH command. */
		sshProxyAccountSuffix: z
			.string()
			.trim()
			.regex(/^[A-Za-z0-9]{4,64}$/)
			.optional(),
		/** Explicit trust anchor for ssh.runpod.io. Discovery/TOFU is forbidden. */
		sshHostPublicKey: sshHostPublicKey.optional(),
		/** Omitted means unrestricted provider choice. An explicit empty list denies all. */
		allowedGpuTypes: uniqueArray(z.string().trim().min(1)).optional(),
		allowedCpuFlavors: uniqueArray(z.enum(RUNPOD_CPU_FLAVORS)).optional(),
		allowedImages: uniqueArray(z.string().trim().min(1)).optional(),
		allowedClouds: uniqueArray(z.enum(RUNPOD_CLOUDS)).optional(),
		maxHourlyPrice: finitePositive,
		/** Legacy optional limits. New accounts rely on cost guardrails instead. */
		maxGpuCount: z.number().int().nonnegative().optional(),
		maxConcurrentPods: z.number().int().positive().optional(),
		maxAggregateHourlyPrice: finitePositive,
		maxRuntimeMinutes: z.number().int().positive(),
		maxRunSpend: finitePositive,
		reconcileIntervalMs: z.number().int().min(1_000).max(3_600_000).optional(),
	})
	.strict();

const disabledMachinePolicySchema = z
	.object({
		enabled: z.literal(false),
		accountId: z
			.string()
			.trim()
			.regex(/^[a-zA-Z0-9_-]{1,64}$/)
			.optional(),
	})
	.strict();

export const RunPodMachinePolicySchema = z.discriminatedUnion("enabled", [
	disabledMachinePolicySchema,
	enabledMachinePolicySchema,
]);
export type RunPodMachinePolicy = z.infer<typeof RunPodMachinePolicySchema>;
export type EnabledRunPodMachinePolicy = z.infer<
	typeof enabledMachinePolicySchema
>;

export const DISABLED_RUNPOD_POLICY: RunPodMachinePolicy = {
	enabled: false,
};

/** Human-facing machine controls. Identity, trust, inventory cadence and scale
 * ceilings are control-plane concerns and are never accepted from the browser. */
export const RunPodMachineSafetySchema = z
	.object({
		enabled: z.boolean(),
		maxHourlyPrice: finitePositive,
		maxAggregateHourlyPrice: finitePositive,
		maxRuntimeMinutes: z.number().int().positive(),
		maxRunSpend: finitePositive,
	})
	.strict();
export type RunPodMachineSafety = z.infer<typeof RunPodMachineSafetySchema>;

/** A project can only remove choices or lower numerical ceilings. */
export const RunPodProjectPolicySchema = z
	.object({
		enabled: z.boolean().default(true),
		allowedGpuTypes: z.array(z.string().trim().min(1)).optional(),
		allowedCpuFlavors: z.array(z.enum(RUNPOD_CPU_FLAVORS)).optional(),
		allowedImages: z.array(z.string().trim().min(1)).optional(),
		allowedClouds: z.array(z.enum(RUNPOD_CLOUDS)).optional(),
		maxHourlyPrice: finitePositive.optional(),
		maxGpuCount: z.number().int().nonnegative().optional(),
		maxConcurrentPods: z.number().int().positive().optional(),
		maxRuntimeMinutes: z.number().int().positive().optional(),
		maxRunSpend: finitePositive.optional(),
	})
	.strict();
export type RunPodProjectPolicy = z.infer<typeof RunPodProjectPolicySchema>;

const requestCommon = {
	image: z.string().trim().min(1),
	cloud: z.enum(RUNPOD_CLOUDS),
	/** A task must state the most it is willing to pay; the provider has no price-cap field. */
	maxHourlyPrice: finitePositive,
	maxRuntimeMinutes: z.number().int().positive(),
	maxSpend: finitePositive,
	containerDiskInGb: z.number().int().positive().max(10_000).default(50),
	volumeInGb: z.number().int().nonnegative().max(100_000).default(0),
} as const;

export const RunPodGpuRequestSchema = z
	.object({
		...requestCommon,
		computeType: z.literal("GPU"),
		gpuTypeId: z.string().trim().min(1),
		gpuCount: z.number().int().positive(),
		minVcpuPerGpu: z.number().int().positive().optional(),
		minRamPerGpu: z.number().int().positive().optional(),
		allowedCudaVersions: z.array(z.string().trim().min(1)).max(32).default([]),
	})
	.strict();

export const RunPodCpuRequestSchema = z
	.object({
		...requestCommon,
		computeType: z.literal("CPU"),
		cpuFlavorId: z.enum(RUNPOD_CPU_FLAVORS),
		vcpuCount: z.number().int().positive(),
		memoryInGb: z.number().int().positive(),
	})
	.strict();

export const RunPodPlacementRequestSchema = z.discriminatedUnion(
	"computeType",
	[RunPodGpuRequestSchema, RunPodCpuRequestSchema],
);
export type RunPodPlacementRequest = z.infer<
	typeof RunPodPlacementRequestSchema
>;

export interface EffectiveRunPodPolicy {
	machine: EnabledRunPodMachinePolicy;
	allowedGpuTypes: ReadonlySet<string> | null;
	allowedCpuFlavors: ReadonlySet<string> | null;
	allowedImages: ReadonlySet<string> | null;
	allowedClouds: ReadonlySet<(typeof RUNPOD_CLOUDS)[number]> | null;
	maxHourlyPrice: number;
	maxGpuCount: number | null;
	maxConcurrentPods: number | null;
	maxAggregateHourlyPrice: number;
	maxRuntimeMinutes: number;
	maxRunSpend: number;
}

export class RunPodPolicyError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "RunPodPolicyError";
	}
}

function subset<T>(
	project: readonly T[] | undefined,
	machine: readonly T[] | undefined,
	field: string,
): readonly T[] | null {
	if (project === undefined) return machine ?? null;
	if (machine === undefined) return project;
	const allowed = new Set(machine);
	for (const value of project) {
		if (!allowed.has(value)) {
			throw new RunPodPolicyError(
				"project_policy_widens_machine",
				`project ${field} includes a machine-disallowed value`,
			);
		}
	}
	return project;
}

function lowerCeiling(
	project: number | undefined,
	machine: number,
	field: string,
): number {
	if (project === undefined) return machine;
	if (project > machine) {
		throw new RunPodPolicyError(
			"project_policy_widens_machine",
			`project ${field} exceeds the machine ceiling`,
		);
	}
	return project;
}

function lowerOptionalCeiling(
	project: number | undefined,
	machine: number | undefined,
	field: string,
): number | null {
	if (project === undefined) return machine ?? null;
	if (machine === undefined) return project;
	return lowerCeiling(project, machine, field);
}

export function effectiveRunPodPolicy(
	machineInput: RunPodMachinePolicy,
	projectInput?: RunPodProjectPolicy,
): EffectiveRunPodPolicy {
	const machine = RunPodMachinePolicySchema.parse(machineInput);
	if (!machine.enabled) {
		throw new RunPodPolicyError("account_disabled", "RunPod is disabled");
	}
	const project = projectInput
		? RunPodProjectPolicySchema.parse(projectInput)
		: undefined;
	if (project?.enabled === false) {
		throw new RunPodPolicyError(
			"project_disabled",
			"RunPod is disabled for this project",
		);
	}
	return {
		machine,
		allowedGpuTypes: (() => {
			const values = subset(
				project?.allowedGpuTypes,
				machine.allowedGpuTypes,
				"allowedGpuTypes",
			);
			return values === null ? null : new Set(values);
		})(),
		allowedCpuFlavors: (() => {
			const values = subset(
				project?.allowedCpuFlavors,
				machine.allowedCpuFlavors,
				"allowedCpuFlavors",
			);
			return values === null ? null : new Set(values);
		})(),
		allowedImages: (() => {
			const values = subset(
				project?.allowedImages,
				machine.allowedImages,
				"allowedImages",
			);
			return values === null ? null : new Set(values);
		})(),
		allowedClouds: (() => {
			const values = subset(
				project?.allowedClouds,
				machine.allowedClouds,
				"allowedClouds",
			);
			return values === null ? null : new Set(values);
		})(),
		maxHourlyPrice: lowerCeiling(
			project?.maxHourlyPrice,
			machine.maxHourlyPrice,
			"maxHourlyPrice",
		),
		maxGpuCount: lowerOptionalCeiling(
			project?.maxGpuCount,
			machine.maxGpuCount,
			"maxGpuCount",
		),
		maxConcurrentPods: lowerOptionalCeiling(
			project?.maxConcurrentPods,
			machine.maxConcurrentPods,
			"maxConcurrentPods",
		),
		// Account burn is intentionally never project-adjustable.
		maxAggregateHourlyPrice: machine.maxAggregateHourlyPrice,
		maxRuntimeMinutes: lowerCeiling(
			project?.maxRuntimeMinutes,
			machine.maxRuntimeMinutes,
			"maxRuntimeMinutes",
		),
		maxRunSpend: lowerCeiling(
			project?.maxRunSpend,
			machine.maxRunSpend,
			"maxRunSpend",
		),
	};
}

export function enforceRunPodRequest(
	requestInput: RunPodPlacementRequest,
	policy: EffectiveRunPodPolicy,
): RunPodPlacementRequest {
	const request = RunPodPlacementRequestSchema.parse(requestInput);
	const deny = (field: string, detail: string): never => {
		throw new RunPodPolicyError(
			"request_exceeds_policy",
			`${field}: ${detail}`,
		);
	};
	if (policy.allowedImages && !policy.allowedImages.has(request.image))
		deny("image", "not allowed");
	if (policy.allowedClouds && !policy.allowedClouds.has(request.cloud))
		deny("cloud", "not allowed");
	if (request.maxHourlyPrice > policy.maxHourlyPrice)
		deny("maxHourlyPrice", "exceeds effective ceiling");
	if (request.maxRuntimeMinutes > policy.maxRuntimeMinutes)
		deny("maxRuntimeMinutes", "exceeds effective ceiling");
	if (request.maxSpend > policy.maxRunSpend)
		deny("maxSpend", "exceeds effective ceiling");
	if (request.computeType === "GPU") {
		if (
			policy.allowedGpuTypes &&
			!policy.allowedGpuTypes.has(request.gpuTypeId)
		)
			deny("gpuTypeId", "not allowed");
		if (policy.maxGpuCount !== null && request.gpuCount > policy.maxGpuCount)
			deny("gpuCount", "exceeds effective ceiling");
	} else {
		if (
			policy.allowedCpuFlavors &&
			!policy.allowedCpuFlavors.has(request.cpuFlavorId)
		)
			deny("cpuFlavorId", "not allowed");
	}
	return request;
}

export interface LiveCostFact {
	id: string;
	hourlyPrice: number | null;
}

export function enforceRunPodAccountCaps(
	live: readonly LiveCostFact[],
	request: RunPodPlacementRequest,
	policy: EffectiveRunPodPolicy,
): void {
	if (
		policy.maxConcurrentPods !== null &&
		live.length >= policy.maxConcurrentPods
	) {
		throw new RunPodPolicyError(
			"concurrency_cap",
			"RunPod concurrent Pod ceiling reached",
		);
	}
	let burn = 0;
	for (const pod of live) {
		if (pod.hourlyPrice === null || !Number.isFinite(pod.hourlyPrice)) {
			throw new RunPodPolicyError(
				"unknown_live_burn",
				`live Pod ${pod.id} has no trustworthy hourly price`,
			);
		}
		burn += pod.hourlyPrice;
	}
	// The provider cannot accept a price ceiling, so reserve the request's own
	// maximum rather than an optimistic catalogue price.
	if (burn + request.maxHourlyPrice > policy.maxAggregateHourlyPrice) {
		throw new RunPodPolicyError(
			"aggregate_burn_cap",
			"RunPod aggregate hourly burn ceiling would be exceeded",
		);
	}
}

export interface ObservedRunPodShape {
	computeType: "GPU" | "CPU" | null;
	offeringId: string | null;
	gpuCount: number | null;
	image: string | null;
	cloud: (typeof RUNPOD_CLOUDS)[number] | null;
	hourlyPrice: number | null;
	vcpuCount: number | null;
	memoryInGb: number | null;
}

export function runPodShapeViolations(
	request: RunPodPlacementRequest,
	observed: ObservedRunPodShape,
): string[] {
	const violations: string[] = [];
	if (observed.computeType && observed.computeType !== request.computeType)
		violations.push("wrong_compute_type");
	if (observed.offeringId) {
		const wanted =
			request.computeType === "GPU" ? request.gpuTypeId : request.cpuFlavorId;
		if (observed.offeringId !== wanted) violations.push("wrong_offering");
	}
	if (request.computeType === "GPU") {
		if (observed.gpuCount !== null && observed.gpuCount !== request.gpuCount)
			violations.push("wrong_gpu_count");
	} else if (observed.gpuCount !== null && observed.gpuCount !== 0) {
		violations.push("cpu_has_gpu");
	}
	if (request.computeType === "CPU") {
		if (observed.vcpuCount !== null && observed.vcpuCount !== request.vcpuCount)
			violations.push("wrong_vcpu_count");
		if (
			observed.memoryInGb !== null &&
			observed.memoryInGb < request.memoryInGb
		)
			violations.push("insufficient_memory");
	}
	if (observed.image && observed.image !== request.image)
		violations.push("wrong_image");
	if (observed.cloud && observed.cloud !== request.cloud)
		violations.push("wrong_cloud");
	if (
		observed.hourlyPrice !== null &&
		observed.hourlyPrice > request.maxHourlyPrice
	)
		violations.push("price_exceeds_request");
	return violations;
}

export function isRunPodShapeVerified(
	request: RunPodPlacementRequest,
	observed: ObservedRunPodShape,
): boolean {
	return (
		runPodShapeViolations(request, observed).length === 0 &&
		observed.computeType === request.computeType &&
		observed.offeringId !== null &&
		observed.gpuCount !== null &&
		observed.image !== null &&
		observed.cloud !== null &&
		observed.hourlyPrice !== null &&
		(request.computeType !== "CPU" ||
			(observed.vcpuCount !== null && observed.memoryInGb !== null))
	);
}
