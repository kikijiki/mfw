import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type Client,
	createClient,
	type InArgs,
	type Row,
	type Transaction,
} from "@libsql/client";
import {
	HOST_MIGRATIONS,
	HOST_SCHEMA_VERSION,
	REQUIRED_HOST_COLUMNS,
	REQUIRED_HOST_TABLES,
} from "./migrations.ts";
import {
	cpuObservationFromHealth,
	type MemoryObservationPolicyResult,
	memoryObservationFromHealth,
	memoryObservationFromSample,
	observationEnvelopeFromSample,
} from "./policy.ts";
import {
	checkedQuantitySum,
	evaluateRamFormula,
	MAX_HOST_QUANTITY,
	RAM_OBSERVATION_MAX_AGE_MS,
} from "./quantity.ts";
import type {
	ActiveLease,
	GpuOccupancyDiagnostic,
	Grant,
	Held,
	HostAdmissionSnapshot,
	HostAuditEntry,
	HostEffectiveCapacity,
	HostGpuEvidenceDiagnostic,
	HostHoldDiagnostic,
	HostLease,
	HostPidStartDiagnostic,
	HostResourceBinding,
	HostResourceDefinition,
	HostResourceHold,
	HostResourceIncident,
	HostResourceReadModel,
	ImmutableHostRequest,
	ObservationHealth,
	ProjectIdentity,
	RunRef,
	StoredObservation,
	Waiter,
} from "./types.ts";

export class HostStoreError extends Error {
	constructor(
		message: string,
		readonly code:
			| "CORRUPT"
			| "INCOMPATIBLE_SCHEMA"
			| "INVALID_REQUEST"
			| "NOT_FOUND"
			| "STALE_VERSION"
			| "STALE_FENCE"
			| "INVALID_TRANSITION"
			| "BUSY" = "INVALID_REQUEST",
	) {
		super(message);
		this.name = "HostStoreError";
	}
}

export interface HostDefinitionWriteOptions {
	/** Undefined only for trusted boot/test setup; operator writes pass null (create) or the observed version. */
	expectedVersion?: bigint | null;
	actor?: string;
	reason?: string;
}

export interface HostBindingWriteOptions extends HostDefinitionWriteOptions {}

export interface DetectedResourceApplyOptions {
	expectedGeneration: bigint;
	actor?: string;
}

export interface DetectedResourceApplyResult {
	definitionCreated: boolean;
	bindingsCreated: number;
}

export interface DetectedResourcesApplyResult {
	definitionsCreated: number;
	bindingsCreated: number;
}

export interface HostStoreIdentity {
	hostId: string;
	coordinatorId: string;
	kernelBootId: string | null;
	processBootId: string;
	generation: bigint;
}

export interface OpenHostStoreOptions {
	processBootId: string;
	kernelBootId: string | null;
	busyTimeoutMs?: number;
	now?: () => number;
}

const LIVE_LEASE_STATES = [
	"provisional",
	"active",
	"uncertain",
	"releasing",
] as const;

function json(value: unknown): string {
	return JSON.stringify(value ?? {}, (_key, nested) =>
		typeof nested === "bigint" ? nested.toString() : nested,
	);
}

function sameDetectedDefinition(
	current: HostResourceDefinition,
	detected: HostResourceDefinition,
): boolean {
	return (
		current.id === detected.id &&
		current.accounting === detected.accounting &&
		current.provisioning === detected.provisioning &&
		current.capacity === detected.capacity &&
		(current.quantityUnit ?? null) === (detected.quantityUnit ?? null) &&
		(current.safetyHeadroom ?? null) === (detected.safetyHeadroom ?? null) &&
		(current.observationKind ?? null) === (detected.observationKind ?? null) &&
		(current.ignoreObservation ?? false) ===
			(detected.ignoreObservation ?? false) &&
		(current.cpuPressure?.maxBusyFraction ?? null) ===
			(detected.cpuPressure?.maxBusyFraction ?? null) &&
		(current.cpuPressure?.maxRunnableProcesses ?? null) ===
			(detected.cpuPressure?.maxRunnableProcesses ?? null)
	);
}

function parseJson<T>(value: unknown, fallback: T): T {
	if (typeof value !== "string") return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

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

function gpuEvidenceDiagnostics(
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

function bool(value: unknown): boolean {
	return value === 1 || value === 1n || value === true;
}

function big(value: unknown): bigint {
	if (typeof value === "bigint") return value;
	if (typeof value === "number") return BigInt(value);
	if (typeof value === "string") return BigInt(value);
	throw new HostStoreError(
		`expected an integer, got ${String(value)}`,
		"CORRUPT",
	);
}

function num(value: unknown): number {
	const valueBig = big(value);
	if (valueBig > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new HostStoreError(
			"timestamp exceeds JavaScript safe range",
			"CORRUPT",
		);
	}
	return Number(valueBig);
}

function nullableNum(value: unknown): number | null {
	return value == null ? null : num(value);
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, nested) => {
		if (nested === null || typeof nested !== "object" || Array.isArray(nested))
			return nested;
		return Object.fromEntries(
			Object.keys(nested as Record<string, unknown>)
				.sort()
				.map((key) => [key, (nested as Record<string, unknown>)[key]]),
		);
	});
}

function meaningfulHealthJson(value: unknown): string {
	const detail = parseJson<Record<string, unknown>>(value, {});
	const {
		generation: _generation,
		freshness: _freshness,
		...meaningful
	} = detail;
	return canonicalJson(meaningful);
}

function healthGeneration(value: unknown): {
	processBootId: string;
	kernelBootId: string | null;
	sequence: bigint;
} | null {
	const detail = parseJson<Record<string, unknown>>(value, {});
	const generation =
		detail.generation && typeof detail.generation === "object"
			? (detail.generation as Record<string, unknown>)
			: null;
	if (
		typeof generation?.processBootId !== "string" ||
		(generation.kernelBootId !== null &&
			typeof generation.kernelBootId !== "string") ||
		typeof generation.sequence !== "string" ||
		!/^(?:0|[1-9][0-9]*)$/.test(generation.sequence)
	)
		return null;
	return {
		processBootId: generation.processBootId,
		kernelBootId: generation.kernelBootId,
		sequence: BigInt(generation.sequence),
	};
}

function healthSequence(value: unknown): string | null {
	const detail = parseJson<Record<string, unknown>>(value, {});
	const generation = object(detail.generation);
	return typeof generation?.sequence === "string" ? generation.sequence : null;
}

function text(value: unknown): string {
	if (typeof value !== "string") {
		throw new HostStoreError(`expected text, got ${String(value)}`, "CORRUPT");
	}
	return value;
}

function canonicalRequest(request: ImmutableHostRequest): string {
	return canonicalJson({
		projectId: request.projectId,
		requirements: [...request.requirements]
			.map((r) => ({
				resourceId: r.resourceId,
				amount: r.amount.toString(),
				bindingId: r.bindingId ?? null,
			}))
			.sort((a, b) => a.resourceId.localeCompare(b.resourceId)),
		metadata: request.metadata ?? {},
	});
}

function requestHash(request: ImmutableHostRequest): string {
	return createHash("sha256").update(canonicalRequest(request)).digest("hex");
}

async function execute(
	target: Client | Transaction,
	sql: string,
	args: InArgs = [],
) {
	return target.execute({ sql, args });
}

async function one(
	target: Client | Transaction,
	sql: string,
	args: InArgs = [],
): Promise<Row | null> {
	return (await execute(target, sql, args)).rows[0] ?? null;
}

async function retryBusy<T>(
	operation: () => Promise<T>,
	timeoutMs: number,
): Promise<T> {
	const started = performance.now();
	for (;;) {
		try {
			return await operation();
		} catch (error) {
			if (
				!/busy|locked/i.test(
					error instanceof Error ? error.message : String(error),
				)
			)
				throw error;
			if (performance.now() - started >= timeoutMs) throw error;
			await Bun.sleep(5);
		}
	}
}

function definitionFrom(row: Row): HostResourceDefinition {
	return {
		id: text(row.id),
		accounting: text(row.accounting) as HostResourceDefinition["accounting"],
		provisioning: text(
			row.provisioning,
		) as HostResourceDefinition["provisioning"],
		capacity: big(row.capacity),
		quantityUnit:
			typeof row.quantity_unit === "string"
				? (row.quantity_unit as HostResourceDefinition["quantityUnit"])
				: null,
		safetyHeadroom:
			row.safety_headroom == null ? null : big(row.safety_headroom),
		enabled: bool(row.enabled),
		draining: bool(row.draining),
		version: big(row.version),
		observationKind:
			typeof row.observation_kind === "string" ? row.observation_kind : null,
		ignoreObservation: bool(row.ignore_observation),
		cpuPressure:
			typeof row.cpu_pressure_json === "string"
				? parseJson(row.cpu_pressure_json, null)
				: null,
		metadata: parseJson(row.metadata_json, {}),
	};
}

function incidentContext(
	value: unknown,
): Extract<HostResourceIncident, { kind: "ram-low-headroom" }>["context"] {
	const parsed = parseJson<Record<string, unknown>>(value, {});
	const quantity = (key: string) => big(parsed[key]);
	return {
		configuredQuotaBytes: quantity("configuredQuotaBytes"),
		safetyHeadroomBytes: quantity("safetyHeadroomBytes"),
		memAvailableBytes: quantity("memAvailableBytes"),
		durablePromisesBytes: quantity("durablePromisesBytes"),
		attributableManagedBytes: quantity("attributableManagedBytes"),
		outstandingPromiseBytes: quantity("outstandingPromiseBytes"),
		quotaRemainingBytes: quantity("quotaRemainingBytes"),
		observedHeadroomBytes: quantity("observedHeadroomBytes"),
		effectiveCapacityBytes: quantity("effectiveCapacityBytes"),
		observationSequence: quantity("observationSequence"),
	};
}

function incidentFrom(row: Row): HostResourceIncident {
	const kind = text(row.kind) as HostResourceIncident["kind"];
	const rawContext = parseJson<Record<string, unknown>>(row.context_json, {});
	const observationConflictContext = () => {
		const observation = object(rawContext.observation);
		const cpuPressure = object(rawContext.cpuPressure);
		const gpuOccupancy = Array.isArray(rawContext.gpuOccupancy)
			? rawContext.gpuOccupancy.map(gpuOccupancyDiagnosticFrom)
			: undefined;
		return {
			...(rawContext as unknown as Extract<
				HostResourceIncident,
				{ kind: "gpu-occupancy-conflict" | "cpu-pressure" }
			>["context"]),
			observation: observation
				? {
						...(observation as unknown as HostHoldDiagnostic["observation"]),
						sequence:
							typeof observation.sequence === "string"
								? BigInt(observation.sequence)
								: null,
					}
				: null,
			...(cpuPressure
				? {
						cpuPressure: {
							...(cpuPressure as unknown as NonNullable<
								HostHoldDiagnostic["cpuPressure"]
							>),
							configuredPermits: big(cpuPressure.configuredPermits),
						},
					}
				: {}),
			...(gpuOccupancy ? { gpuOccupancy } : {}),
		};
	};
	return {
		key: text(row.incident_key),
		kind,
		resourceId: text(row.resource_id),
		state: text(row.state) as HostResourceIncident["state"],
		openedAt: num(row.opened_at),
		updatedAt: num(row.updated_at),
		resolvedAt: nullableNum(row.resolved_at),
		context:
			kind === "ram-low-headroom"
				? incidentContext(row.context_json)
				: observationConflictContext(),
	} as HostResourceIncident;
}

function gpuOccupancyDiagnosticFrom(value: unknown): GpuOccupancyDiagnostic {
	const parsed = object(value) ?? {};
	const occupants = Array.isArray(parsed.occupants)
		? parsed.occupants.slice(0, 256).map((value) => {
				const occupant = object(value) ?? {};
				const pid =
					typeof occupant.pid === "number" &&
					Number.isSafeInteger(occupant.pid) &&
					occupant.pid > 0
						? occupant.pid
						: 0;
				const attribution: GpuOccupancyDiagnostic["occupants"][number]["attribution"] =
					occupant.attribution === "managed" ||
					occupant.attribution === "external"
						? occupant.attribution
						: "unknown";
				return {
					pid,
					pidStart: pidStartDiagnostic(occupant.pidStart, pid),
					attribution,
					runId: typeof occupant.runId === "string" ? occupant.runId : null,
					leaseId:
						typeof occupant.leaseId === "string" ? occupant.leaseId : null,
					evidence: gpuEvidenceDiagnostics(
						Array.isArray(occupant.evidence) ? occupant.evidence : [],
					),
				};
			})
		: [];
	return {
		bindingId: typeof parsed.bindingId === "string" ? parsed.bindingId : "",
		stableKey: typeof parsed.stableKey === "string" ? parsed.stableKey : "",
		deviceKey: typeof parsed.deviceKey === "string" ? parsed.deviceKey : null,
		state:
			parsed.state === "idle" || parsed.state === "occupied"
				? parsed.state
				: "unknown",
		blocksExclusiveAdmission: parsed.blocksExclusiveAdmission === true,
		gpuUtilization:
			typeof parsed.gpuUtilization === "number" &&
			Number.isFinite(parsed.gpuUtilization)
				? parsed.gpuUtilization
				: null,
		memoryUsedBytes:
			typeof parsed.memoryUsedBytes === "string" &&
			/^(?:0|[1-9][0-9]*)$/.test(parsed.memoryUsedBytes)
				? BigInt(parsed.memoryUsedBytes)
				: null,
		memoryTotalBytes:
			typeof parsed.memoryTotalBytes === "string" &&
			/^(?:0|[1-9][0-9]*)$/.test(parsed.memoryTotalBytes)
				? BigInt(parsed.memoryTotalBytes)
				: null,
		temperatureCelsius:
			typeof parsed.temperatureCelsius === "number" &&
			Number.isFinite(parsed.temperatureCelsius)
				? parsed.temperatureCelsius
				: null,
		powerWatts:
			typeof parsed.powerWatts === "number" &&
			Number.isFinite(parsed.powerWatts) &&
			parsed.powerWatts >= 0
				? parsed.powerWatts
				: null,
		occupants,
		deviceEvidence: gpuEvidenceDiagnostics(
			Array.isArray(parsed.deviceEvidence) ? parsed.deviceEvidence : [],
		),
	};
}

function holdDiagnosticFrom(value: unknown): HostHoldDiagnostic {
	const parsed = parseJson<Record<string, unknown>>(value, {});
	const quantity = (key: string): bigint | null => {
		const item = parsed[key];
		return typeof item === "string" && /^(?:0|[1-9][0-9]*)$/.test(item)
			? BigInt(item)
			: null;
	};
	const observation = object(parsed.observation);
	const ramFormula = object(parsed.ramFormula);
	const cpuPressure = object(parsed.cpuPressure);
	return {
		...(parsed as unknown as HostHoldDiagnostic),
		resourceId: typeof parsed.resourceId === "string" ? parsed.resourceId : "",
		reason: parsed.reason as HostHoldDiagnostic["reason"],
		message: typeof parsed.message === "string" ? parsed.message : "",
		requestedAmount: quantity("requestedAmount") ?? 0n,
		configuredQuota: quantity("configuredQuota"),
		durablePromises: quantity("durablePromises"),
		effectiveCapacity: quantity("effectiveCapacity") ?? 0n,
		observation: observation
			? {
					...(observation as unknown as NonNullable<
						HostHoldDiagnostic["observation"]
					>),
					sequence:
						typeof observation.sequence === "string"
							? BigInt(observation.sequence)
							: null,
				}
			: null,
		ramFormula: ramFormula
			? {
					configuredQuotaBytes: big(ramFormula.configuredQuotaBytes),
					safetyHeadroomBytes: big(ramFormula.safetyHeadroomBytes),
					memAvailableBytes: big(ramFormula.memAvailableBytes),
					durablePromisesBytes: big(ramFormula.durablePromisesBytes),
					attributableManagedBytes: big(ramFormula.attributableManagedBytes),
					outstandingPromiseBytes: big(ramFormula.outstandingPromiseBytes),
					quotaRemainingBytes: big(ramFormula.quotaRemainingBytes),
					observedHeadroomBytes: BigInt(
						String(ramFormula.observedHeadroomBytes ?? 0),
					),
					effectiveCapacityBytes: big(ramFormula.effectiveCapacityBytes),
					...(ramFormula.requestBytes !== undefined
						? { requestBytes: big(ramFormula.requestBytes) }
						: {}),
				}
			: null,
		cpuPressure: cpuPressure
			? {
					...(cpuPressure as unknown as NonNullable<
						HostHoldDiagnostic["cpuPressure"]
					>),
					configuredPermits: big(cpuPressure.configuredPermits),
				}
			: null,
		gpuOccupancy: parsed.gpuOccupancy
			? gpuOccupancyDiagnosticFrom(parsed.gpuOccupancy)
			: null,
	};
}

function resourceHoldFrom(row: Row): HostResourceHold {
	return {
		resourceId: text(row.resource_id),
		state: text(row.state) as HostResourceHold["state"],
		reason: text(row.reason) as HostResourceHold["reason"],
		snapshotGeneration: big(row.snapshot_generation),
		openedAt: num(row.opened_at),
		updatedAt: num(row.updated_at),
		resolvedAt: nullableNum(row.resolved_at),
		diagnostic: holdDiagnosticFrom(row.diagnostic_json),
	};
}

function bindingFrom(row: Row): HostResourceBinding {
	return {
		id: text(row.id),
		resourceId: text(row.resource_id),
		stableKey: text(row.stable_key),
		enabled: bool(row.enabled),
		version: big(row.version),
		metadata: parseJson(row.metadata_json, {}),
	};
}

function waiterFrom(row: Row, requirements: Waiter["requirements"]): Waiter {
	return {
		id: text(row.id),
		requestKey: text(row.request_key),
		projectId: text(row.project_id),
		sequence: big(row.sequence),
		generation: big(row.generation),
		state: text(row.state) as Waiter["state"],
		requirements,
		createdAt: num(row.created_at),
	};
}

function leaseFrom(row: Row, allocations: HostLease["allocations"]): HostLease {
	const hasRun = typeof row.run_id === "string";
	return {
		id: text(row.id),
		waiterId: text(row.waiter_id),
		projectId: text(row.project_id),
		state: text(row.state) as HostLease["state"],
		fence: big(row.fence),
		allocations,
		run: hasRun
			? {
					runId: text(row.run_id),
					runDir: text(row.run_dir),
					sessionId: typeof row.session_id === "string" ? row.session_id : null,
					pid: row.pid == null ? null : num(row.pid),
					processStartTime:
						typeof row.process_start_time === "string"
							? row.process_start_time
							: null,
					kernelBootId:
						typeof row.kernel_boot_id === "string" ? row.kernel_boot_id : null,
					processTree: parseJson(row.process_tree_json, []),
				}
			: null,
		ownerProcessBootId:
			typeof row.owner_process_boot_id === "string"
				? row.owner_process_boot_id
				: null,
		grantedAt: num(row.granted_at),
		activatedAt: nullableNum(row.activated_at),
		lastRenewedAt: nullableNum(row.last_renewed_at),
		expiresAt: nullableNum(row.expires_at),
		releaseReason:
			typeof row.release_reason === "string" ? row.release_reason : null,
	};
}

function observationFrom(row: Row): StoredObservation {
	return {
		bindingId: text(row.binding_id),
		kind: text(row.kind),
		sequence: big(row.sequence),
		result: text(row.result) as StoredObservation["result"],
		processBootId: text(row.process_boot_id),
		kernelBootId:
			typeof row.kernel_boot_id === "string" ? row.kernel_boot_id : null,
		observedAt: num(row.observed_at),
		durationMs: num(row.duration_ms),
		metrics: parseJson(row.metrics_json, {}),
		occupants: parseJson(row.occupants_json, []),
		warnings: parseJson(row.warnings_json, []),
		adapterVersion:
			typeof row.adapter_version === "string" ? row.adapter_version : null,
	};
}

export class HostResourceStore {
	private queue: Promise<unknown> = Promise.resolve();
	private closed = false;
	readonly now: () => number;

	constructor(
		readonly client: Client,
		readonly path: string,
		readonly identity: HostStoreIdentity,
		now?: () => number,
		private readonly busyTimeoutMs = 2_000,
	) {
		this.now = now ?? (() => Date.now());
	}

	private withWrite<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
		if (this.closed) return Promise.reject(new Error("host store is closed"));
		const next = this.queue.then(
			() => this.writeNow(fn),
			() => this.writeNow(fn),
		);
		this.queue = next.catch(() => {});
		return next;
	}

	private async writeNow<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
		const started = performance.now();
		for (;;) {
			let tx: Transaction | null = null;
			try {
				tx = await this.client.transaction("write"); // BEGIN IMMEDIATE
				const result = await fn(tx);
				await tx.commit();
				return result;
			} catch (error) {
				const busy = /busy|locked/i.test(
					error instanceof Error ? error.message : String(error),
				);
				if (tx && !tx.closed) await tx.rollback().catch(() => {});
				if (!busy) throw error;
				if (performance.now() - started >= this.busyTimeoutMs) {
					throw new HostStoreError(
						`host store lock unavailable: ${error instanceof Error ? error.message : String(error)}`,
						"BUSY",
					);
				}
				// A long native busy wait blocks Bun's event loop and the lock holder; retry short waits.
				await new Promise((resolve) => setTimeout(resolve, 5));
			} finally {
				tx?.close();
			}
		}
	}

	private async generation(target: Client | Transaction): Promise<bigint> {
		const row = await one(
			target,
			"SELECT generation FROM host_meta WHERE singleton=1",
		);
		if (!row) throw new HostStoreError("host metadata is missing", "CORRUPT");
		return big(row.generation);
	}

	private async bumpGeneration(tx: Transaction): Promise<bigint> {
		const now = this.now();
		const row = await one(
			tx,
			"UPDATE host_meta SET generation=generation+1, updated_at=? WHERE singleton=1 RETURNING generation",
			[now],
		);
		if (!row) throw new HostStoreError("host metadata is missing", "CORRUPT");
		const generation = big(row.generation);
		this.identity.generation = generation;
		return generation;
	}

	private async audit(
		tx: Transaction,
		entry: Omit<HostAuditEntry, "seq" | "at"> & { at?: number },
	): Promise<void> {
		await execute(
			tx,
			`INSERT INTO audit(event_key,at_ms,action,actor,project_id,waiter_id,lease_id,fence,detail_json)
			 VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING`,
			[
				entry.eventKey,
				entry.at ?? this.now(),
				entry.action,
				entry.actor,
				entry.projectId,
				entry.waiterId,
				entry.leaseId,
				entry.fence,
				json(entry.detail),
			],
		);
	}

	async registerProject(input: {
		identity: ProjectIdentity;
		root: string;
		displayName: string;
		metadata?: Record<string, unknown>;
	}): Promise<void> {
		await this.withWrite(async (tx) => {
			const now = this.now();
			await execute(
				tx,
				`INSERT INTO projects(id,root,display_name,attached,last_attached_at,last_process_boot_id,metadata_json)
				 VALUES(?,?,?,1,?,?,?)
				 ON CONFLICT(id) DO UPDATE SET root=excluded.root, display_name=excluded.display_name,
				 attached=1,last_attached_at=excluded.last_attached_at,
				 last_process_boot_id=excluded.last_process_boot_id,metadata_json=excluded.metadata_json`,
				[
					input.identity.id,
					input.root,
					input.displayName,
					now,
					this.identity.processBootId,
					json(input.metadata),
				],
			);
			await this.bumpGeneration(tx);
			await this.audit(tx, {
				eventKey: `project:${input.identity.id}:attached:${this.identity.processBootId}`,
				action: "project.attached",
				actor: "orchestrator",
				projectId: input.identity.id,
				waiterId: null,
				leaseId: null,
				fence: null,
				detail: { root: input.root, displayName: input.displayName },
			});
		});
	}

	async detachProject(projectId: string): Promise<void> {
		await this.withWrite(async (tx) => {
			const now = this.now();
			const result = await execute(
				tx,
				"UPDATE projects SET attached=0,last_detached_at=? WHERE id=?",
				[now, projectId],
			);
			if (result.rowsAffected === 0) return;
			await this.bumpGeneration(tx);
			await this.audit(tx, {
				eventKey: `project:${projectId}:detached:${this.identity.processBootId}:${randomUUID()}`,
				action: "project.detached",
				actor: "orchestrator",
				projectId,
				waiterId: null,
				leaseId: null,
				fence: null,
				detail: {},
			});
		});
	}

	/** Create a reviewed detected definition and its missing bindings in one write transaction; the generation fence and identity conflicts are rechecked inside BEGIN IMMEDIATE. */
	async applyDetectedResources(
		resources: readonly {
			definition: HostResourceDefinition;
			bindings: readonly HostResourceBinding[];
		}[],
		options: DetectedResourceApplyOptions,
	): Promise<DetectedResourcesApplyResult> {
		if (resources.length === 0) {
			throw new HostStoreError("at least one detected resource is required");
		}
		if (
			new Set(resources.map(({ definition }) => definition.id)).size !==
			resources.length
		) {
			throw new HostStoreError("detected resource ids must be unique");
		}
		for (const { definition, bindings } of resources) {
			if (
				!definition.id.trim() ||
				definition.capacity <= 0n ||
				definition.capacity > MAX_HOST_QUANTITY
			) {
				throw new HostStoreError(
					"detected resource id and positive capacity are required",
				);
			}
			for (const binding of bindings) {
				if (
					!binding.id.trim() ||
					!binding.stableKey.trim() ||
					binding.resourceId !== definition.id
				) {
					throw new HostStoreError(
						"detected bindings must have an id, stable key, and matching resource id",
					);
				}
			}
		}

		return this.withWrite(async (tx) => {
			const generation = await this.generation(tx);
			if (generation !== options.expectedGeneration) {
				throw new HostStoreError(
					"Host state changed after detection; review a fresh proposal",
					"STALE_VERSION",
				);
			}

			let definitionsCreated = 0;
			let bindingsCreated = 0;
			for (const { definition, bindings } of resources) {
				const currentDefinitionRow = await one(
					tx,
					"SELECT * FROM resource_definitions WHERE id=?",
					[definition.id],
				);
				const currentDefinition = currentDefinitionRow
					? definitionFrom(currentDefinitionRow)
					: null;
				if (
					currentDefinition &&
					!sameDetectedDefinition(currentDefinition, definition)
				) {
					throw new HostStoreError(
						"An existing definition uses this name with a different accounting contract",
						"INVALID_TRANSITION",
					);
				}

				const existingBindings = (
					await execute(tx, "SELECT * FROM resource_bindings ORDER BY id")
				).rows.map(bindingFrom);
				const candidateIds = new Set<string>();
				const candidateStableKeys = new Set<string>();
				const missingBindings: HostResourceBinding[] = [];
				for (const binding of bindings) {
					if (
						candidateIds.has(binding.id) ||
						candidateStableKeys.has(binding.stableKey)
					) {
						throw new HostStoreError(
							"Detected hardware contains duplicate binding identities",
							"INVALID_TRANSITION",
						);
					}
					candidateIds.add(binding.id);
					candidateStableKeys.add(binding.stableKey);

					const byId = existingBindings.find((item) => item.id === binding.id);
					const byStableKey = existingBindings.find(
						(item) => item.stableKey === binding.stableKey,
					);
					if (
						(byId &&
							(byId.resourceId !== binding.resourceId ||
								byId.stableKey !== binding.stableKey)) ||
						(byStableKey && byStableKey.id !== binding.id)
					) {
						throw new HostStoreError(
							"Detected hardware identity conflicts with an existing binding",
							"INVALID_TRANSITION",
						);
					}
					if (!byId) missingBindings.push(binding);
				}

				const definitionCreated = currentDefinition === null;
				if (!definitionCreated && missingBindings.length === 0) {
					throw new HostStoreError(
						"Detected resource is already configured",
						"INVALID_TRANSITION",
					);
				}

				const now = this.now();
				const actor = options.actor?.trim() || "local-operator";
				if (definitionCreated) {
					definitionsCreated += 1;
					await execute(
						tx,
						`INSERT INTO resource_definitions
					 (id,accounting,provisioning,capacity,quantity_unit,safety_headroom,enabled,draining,version,observation_kind,ignore_observation,cpu_pressure_json,metadata_json,created_at,updated_at)
					 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
						[
							definition.id,
							definition.accounting,
							definition.provisioning,
							definition.capacity,
							definition.quantityUnit ?? null,
							definition.safetyHeadroom ?? null,
							definition.enabled,
							definition.draining,
							definition.version > 0n ? definition.version : 1n,
							definition.observationKind ?? null,
							definition.ignoreObservation ?? false,
							definition.cpuPressure ? json(definition.cpuPressure) : null,
							json(definition.metadata),
							now,
							now,
						],
					);
					await this.audit(tx, {
						eventKey: `definition:${definition.id}:detected:${randomUUID()}`,
						action: "definition.put",
						actor,
						projectId: null,
						waiterId: null,
						leaseId: null,
						fence: null,
						detail: {
							mutation: "created",
							expectedVersion: "absent",
							actualVersion: "absent",
							reason: "operator accepted detected host resource",
							accounting: definition.accounting,
							capacity: definition.capacity.toString(),
							quantityUnit: definition.quantityUnit ?? null,
							safetyHeadroom: definition.safetyHeadroom?.toString() ?? null,
							observationKind: definition.observationKind ?? null,
							ignoreObservation: definition.ignoreObservation === true,
							cpuPressure: definition.cpuPressure ?? null,
						},
					});
				}

				for (const binding of missingBindings) {
					await execute(
						tx,
						`INSERT INTO resource_bindings
					 (id,resource_id,stable_key,enabled,version,metadata_json,created_at,updated_at)
					 VALUES(?,?,?,?,?,?,?,?)`,
						[
							binding.id,
							binding.resourceId,
							binding.stableKey,
							binding.enabled,
							binding.version > 0n ? binding.version : 1n,
							json(binding.metadata),
							now,
							now,
						],
					);
					await this.audit(tx, {
						eventKey: `binding:${binding.id}:detected:${randomUUID()}`,
						action: "binding.put",
						actor,
						projectId: null,
						waiterId: null,
						leaseId: null,
						fence: null,
						detail: {
							mutation: "created",
							expectedVersion: "absent",
							actualVersion: "absent",
							reason: "operator accepted detected hardware binding",
							resourceId: binding.resourceId,
							stableKey: binding.stableKey,
						},
					});
				}
				bindingsCreated += missingBindings.length;
			}

			await this.reconcileRamIncidents(tx);
			await this.reconcileObservationIncidents(tx);
			await this.bumpGeneration(tx);
			return { definitionsCreated, bindingsCreated };
		});
	}

	async applyDetectedResource(
		definition: HostResourceDefinition,
		bindings: readonly HostResourceBinding[],
		options: DetectedResourceApplyOptions,
	): Promise<DetectedResourceApplyResult> {
		const result = await this.applyDetectedResources(
			[{ definition, bindings }],
			options,
		);
		return {
			definitionCreated: result.definitionsCreated === 1,
			bindingsCreated: result.bindingsCreated,
		};
	}

	async putDefinition(
		definition: HostResourceDefinition,
		options: HostDefinitionWriteOptions = {},
	): Promise<HostResourceDefinition> {
		if (
			!definition.id.trim() ||
			definition.capacity <= 0n ||
			definition.capacity > MAX_HOST_QUANTITY
		) {
			throw new HostStoreError(
				"resource id and positive capacity are required",
			);
		}
		if (
			definition.accounting === "slot" &&
			(definition.quantityUnit != null || definition.safetyHeadroom != null)
		) {
			throw new HostStoreError(
				"slot resources cannot declare a quantity unit or safety headroom",
			);
		}
		if (
			definition.accounting === "quantity" &&
			definition.quantityUnit !== "integer" &&
			definition.quantityUnit !== "bytes"
		) {
			throw new HostStoreError(
				"quantity resources require an explicit integer or bytes base unit",
			);
		}
		if (definition.quantityUnit === "bytes") {
			if (definition.observationKind !== "linux-memory") {
				throw new HostStoreError(
					"byte quantity resources require the linux-memory observation binding",
				);
			}
			if (
				definition.safetyHeadroom == null ||
				definition.safetyHeadroom < 0n ||
				definition.safetyHeadroom > MAX_HOST_QUANTITY
			) {
				throw new HostStoreError(
					"RAM resources require an explicit non-negative safety headroom in bytes",
				);
			}
		} else if (definition.safetyHeadroom != null) {
			throw new HostStoreError(
				"safety headroom is valid only for byte quantity resources",
			);
		}
		const cpuPolicy = definition.cpuPressure ?? null;
		if (definition.observationKind === "linux-cpu") {
			if (
				definition.accounting !== "quantity" ||
				definition.quantityUnit !== "integer" ||
				!cpuPolicy ||
				(cpuPolicy.maxBusyFraction === undefined &&
					cpuPolicy.maxRunnableProcesses === undefined)
			) {
				throw new HostStoreError(
					"linux-cpu resources require integer quantity accounting and an explicit pressure threshold",
				);
			}
			if (
				(cpuPolicy.maxBusyFraction !== undefined &&
					(!Number.isFinite(cpuPolicy.maxBusyFraction) ||
						cpuPolicy.maxBusyFraction < 0 ||
						cpuPolicy.maxBusyFraction > 1)) ||
				(cpuPolicy.maxRunnableProcesses !== undefined &&
					(!Number.isSafeInteger(cpuPolicy.maxRunnableProcesses) ||
						cpuPolicy.maxRunnableProcesses < 0))
			) {
				throw new HostStoreError("linux-cpu pressure thresholds are invalid");
			}
		} else if (cpuPolicy) {
			throw new HostStoreError(
				"CPU pressure policy is valid only for linux-cpu resources",
			);
		}
		if (
			definition.observationKind != null &&
			!["linux-memory", "linux-cpu", "amd-gpu", "nvidia-gpu"].includes(
				definition.observationKind,
			)
		) {
			throw new HostStoreError(
				`unsupported observation kind '${definition.observationKind}'`,
			);
		}
		if (
			(definition.observationKind === "amd-gpu" ||
				definition.observationKind === "nvidia-gpu") &&
			definition.accounting !== "slot"
		) {
			throw new HostStoreError(
				"GPU observations require exclusive slot accounting",
			);
		}
		if (definition.ignoreObservation && definition.observationKind == null) {
			throw new HostStoreError(
				"ignoreObservation requires an explicit observation binding",
			);
		}
		return this.withWrite(async (tx) => {
			const now = this.now();
			const currentRow = await one(
				tx,
				"SELECT * FROM resource_definitions WHERE id=?",
				[definition.id],
			);
			const current = currentRow ? definitionFrom(currentRow) : null;
			if (options.expectedVersion === null && current) {
				throw new HostStoreError(
					`host resource '${definition.id}' already exists at version ${current.version.toString()}`,
					"STALE_VERSION",
				);
			}
			if (
				typeof options.expectedVersion === "bigint" &&
				(!current || current.version !== options.expectedVersion)
			) {
				throw new HostStoreError(
					`stale host resource version ${options.expectedVersion.toString()} for '${definition.id}' (actual ${current?.version.toString() ?? "missing"})`,
					"STALE_VERSION",
				);
			}
			if (current) {
				const promised =
					(await this.promisedByResource(tx, [definition.id])).get(
						definition.id,
					) ?? 0n;
				if (definition.capacity < promised) {
					throw new HostStoreError(
						`capacity ${definition.capacity.toString()} is below ${promised.toString()} currently promised`,
						"INVALID_TRANSITION",
					);
				}
				if (
					promised > 0n &&
					(current.accounting !== definition.accounting ||
						current.quantityUnit !== (definition.quantityUnit ?? null) ||
						current.observationKind !== (definition.observationKind ?? null))
				) {
					throw new HostStoreError(
						"accounting or observation binding cannot change while capacity is promised",
						"INVALID_TRANSITION",
					);
				}
				if (current.enabled && !definition.enabled && promised > 0n) {
					throw new HostStoreError(
						"drain and release or recover every live promise before disabling this resource",
						"INVALID_TRANSITION",
					);
				}
				if (current.enabled && !definition.enabled && !current.draining) {
					throw new HostStoreError(
						"drain the resource before disabling it",
						"INVALID_TRANSITION",
					);
				}
			}
			await execute(
				tx,
				`INSERT INTO resource_definitions
					 (id,accounting,provisioning,capacity,quantity_unit,safety_headroom,enabled,draining,version,observation_kind,ignore_observation,cpu_pressure_json,metadata_json,created_at,updated_at)
					 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
				 ON CONFLICT(id) DO UPDATE SET accounting=excluded.accounting,
				 provisioning=excluded.provisioning,capacity=excluded.capacity,
				 quantity_unit=excluded.quantity_unit,safety_headroom=excluded.safety_headroom,
				 enabled=excluded.enabled,draining=excluded.draining,
				 version=resource_definitions.version+1,observation_kind=excluded.observation_kind,
					 ignore_observation=excluded.ignore_observation,cpu_pressure_json=excluded.cpu_pressure_json,
					 metadata_json=excluded.metadata_json,
				 updated_at=excluded.updated_at`,
				[
					definition.id,
					definition.accounting,
					definition.provisioning,
					definition.capacity,
					definition.quantityUnit ?? null,
					definition.safetyHeadroom ?? null,
					definition.enabled,
					definition.draining,
					definition.version > 0n ? definition.version : 1n,
					definition.observationKind ?? null,
					definition.ignoreObservation ?? false,
					cpuPolicy ? json(cpuPolicy) : null,
					json(definition.metadata),
					now,
					now,
				],
			);
			await this.reconcileRamIncidents(tx);
			await this.reconcileObservationIncidents(tx);
			await this.bumpGeneration(tx);
			await this.audit(tx, {
				eventKey: `definition:${definition.id}:${current?.version.toString() ?? "new"}:${randomUUID()}`,
				action: "definition.put",
				actor: options.actor?.trim() || "operator",
				projectId: null,
				waiterId: null,
				leaseId: null,
				fence: null,
				detail: {
					mutation: current ? "updated" : "created",
					expectedVersion:
						options.expectedVersion === undefined
							? null
							: (options.expectedVersion?.toString() ?? "absent"),
					actualVersion: current?.version.toString() ?? "absent",
					reason: options.reason?.trim() || null,
					accounting: definition.accounting,
					capacity: definition.capacity.toString(),
					quantityUnit: definition.quantityUnit ?? null,
					safetyHeadroom: definition.safetyHeadroom?.toString() ?? null,
					observationKind: definition.observationKind ?? null,
					ignoreObservation: definition.ignoreObservation === true,
					cpuPressure: cpuPolicy,
				},
			});
			const row = await one(
				tx,
				"SELECT * FROM resource_definitions WHERE id=?",
				[definition.id],
			);
			return definitionFrom(row as Row);
		});
	}

	async putBinding(
		binding: HostResourceBinding,
		options: HostBindingWriteOptions = {},
	): Promise<HostResourceBinding> {
		if (
			!binding.id.trim() ||
			!binding.resourceId.trim() ||
			!binding.stableKey.trim()
		) {
			throw new HostStoreError(
				"binding id, resource id, and stable key are required",
			);
		}
		return this.withWrite(async (tx) => {
			const now = this.now();
			const definitionRow = await one(
				tx,
				"SELECT * FROM resource_definitions WHERE id=?",
				[binding.resourceId],
			);
			if (!definitionRow) {
				throw new HostStoreError(
					`unknown host resource '${binding.resourceId}'`,
					"NOT_FOUND",
				);
			}
			const definition = definitionFrom(definitionRow);
			const currentRow = await one(
				tx,
				"SELECT * FROM resource_bindings WHERE id=?",
				[binding.id],
			);
			const current = currentRow ? bindingFrom(currentRow) : null;
			if (options.expectedVersion === null && current) {
				throw new HostStoreError(
					`host binding '${binding.id}' already exists at version ${current.version.toString()}`,
					"STALE_VERSION",
				);
			}
			if (
				typeof options.expectedVersion === "bigint" &&
				(!current || current.version !== options.expectedVersion)
			) {
				throw new HostStoreError(
					`stale host binding version ${options.expectedVersion.toString()} for '${binding.id}' (actual ${current?.version.toString() ?? "missing"})`,
					"STALE_VERSION",
				);
			}
			if (current && current.resourceId !== binding.resourceId) {
				throw new HostStoreError(
					"a host binding cannot move between resource definitions",
					"INVALID_TRANSITION",
				);
			}
			if (
				current &&
				(current.enabled !== binding.enabled ||
					current.stableKey !== binding.stableKey)
			) {
				const live = await one(
					tx,
					`SELECT 1 FROM lease_allocations a JOIN leases l ON l.id=a.lease_id
					 WHERE a.binding_id=? AND l.state IN ('provisional','active','uncertain','releasing') LIMIT 1`,
					[binding.id],
				);
				if (live) {
					throw new HostStoreError(
						"release or recover the live promise before changing this binding's identity or availability",
						"INVALID_TRANSITION",
					);
				}
			}
			if (
				binding.enabled &&
				(definition.observationKind === "amd-gpu" ||
					definition.observationKind === "nvidia-gpu")
			) {
				const duplicate = await one(
					tx,
					`SELECT b.id FROM resource_bindings b
					 JOIN resource_definitions d ON d.id=b.resource_id
					 WHERE b.id<>? AND b.stable_key=? AND b.enabled=1
					 AND d.observation_kind IN ('amd-gpu','nvidia-gpu') LIMIT 1`,
					[binding.id, binding.stableKey],
				);
				if (duplicate) {
					throw new HostStoreError(
						`GPU device '${binding.stableKey}' is already enabled by binding '${text(duplicate.id)}'`,
						"INVALID_TRANSITION",
					);
				}
			}
			await execute(
				tx,
				`INSERT INTO resource_bindings
				 (id,resource_id,stable_key,enabled,version,metadata_json,created_at,updated_at)
				 VALUES(?,?,?,?,?,?,?,?)
				 ON CONFLICT(id) DO UPDATE SET resource_id=excluded.resource_id,
				 stable_key=excluded.stable_key,enabled=excluded.enabled,
				 version=resource_bindings.version+1,metadata_json=excluded.metadata_json,
				 updated_at=excluded.updated_at`,
				[
					binding.id,
					binding.resourceId,
					binding.stableKey,
					binding.enabled,
					binding.version > 0n ? binding.version : 1n,
					json(binding.metadata),
					now,
					now,
				],
			);
			await this.bumpGeneration(tx);
			await this.audit(tx, {
				eventKey: `binding:${binding.id}:${current?.version.toString() ?? "new"}:${randomUUID()}`,
				action: "binding.put",
				actor: options.actor?.trim() || "operator",
				projectId: null,
				waiterId: null,
				leaseId: null,
				fence: null,
				detail: {
					mutation: current ? "updated" : "created",
					expectedVersion:
						options.expectedVersion === undefined
							? null
							: (options.expectedVersion?.toString() ?? "absent"),
					actualVersion: current?.version.toString() ?? "absent",
					reason: options.reason?.trim() || null,
					resourceId: binding.resourceId,
					stableKey: binding.stableKey,
				},
			});
			const row = await one(tx, "SELECT * FROM resource_bindings WHERE id=?", [
				binding.id,
			]);
			return bindingFrom(row as Row);
		});
	}

	async putWaiter(request: ImmutableHostRequest): Promise<Waiter> {
		if (!request.requestKey.trim() || !request.projectId.trim()) {
			throw new HostStoreError("requestKey and projectId are required");
		}
		if (request.requirements.length === 0) {
			throw new HostStoreError("a host waiter needs at least one requirement");
		}
		const ids = new Set<string>();
		for (const requirement of request.requirements) {
			if (
				!requirement.resourceId.trim() ||
				requirement.amount <= 0n ||
				requirement.amount > MAX_HOST_QUANTITY
			) {
				throw new HostStoreError(
					"host requirements need an id and positive integer amount",
				);
			}
			if (ids.has(requirement.resourceId)) {
				throw new HostStoreError(
					`duplicate host requirement '${requirement.resourceId}'`,
				);
			}
			ids.add(requirement.resourceId);
		}
		const hash = requestHash(request);
		return this.withWrite(async (tx) => {
			const existing = await one(
				tx,
				"SELECT * FROM waiters WHERE request_key=?",
				[request.requestKey],
			);
			if (existing) {
				if (text(existing.request_hash) !== hash) {
					throw new HostStoreError(
						`requestKey '${request.requestKey}' already names a different immutable request`,
					);
				}
				return this.waiterByRow(tx, existing);
			}
			const placeholders = [...ids].map(() => "?").join(",");
			const defs = await execute(
				tx,
				`SELECT id FROM resource_definitions WHERE id IN (${placeholders})`,
				[...ids],
			);
			if (defs.rows.length !== ids.size) {
				throw new HostStoreError("unknown host resource requirement");
			}
			for (const requirement of request.requirements) {
				if (!requirement.bindingId) continue;
				const binding = await one(
					tx,
					"SELECT resource_id,enabled FROM resource_bindings WHERE id=?",
					[requirement.bindingId],
				);
				if (
					!binding ||
					text(binding.resource_id) !== requirement.resourceId ||
					!bool(binding.enabled)
				) {
					throw new HostStoreError(
						`binding '${requirement.bindingId}' is unavailable for '${requirement.resourceId}'`,
					);
				}
			}
			const sequenceRow = await one(
				tx,
				"SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM waiters",
			);
			const sequence = big(sequenceRow?.sequence);
			const generation = await this.bumpGeneration(tx);
			const id = randomUUID();
			const now = this.now();
			await execute(
				tx,
				`INSERT INTO waiters(id,request_key,request_hash,project_id,sequence,generation,state,metadata_json,created_at,updated_at)
				 VALUES(?,?,?,?,?,?,'waiting',?,?,?)`,
				[
					id,
					request.requestKey,
					hash,
					request.projectId,
					sequence,
					generation,
					json(request.metadata),
					now,
					now,
				],
			);
			for (const requirement of request.requirements) {
				await execute(
					tx,
					"INSERT INTO waiter_requirements(waiter_id,resource_id,binding_id,amount) VALUES(?,?,?,?)",
					[
						id,
						requirement.resourceId,
						requirement.bindingId ?? null,
						requirement.amount,
					],
				);
			}
			await this.audit(tx, {
				eventKey: `waiter:${id}:created`,
				action: "waiter.created",
				actor: "coordinator",
				projectId: request.projectId,
				waiterId: id,
				leaseId: null,
				fence: null,
				detail: {
					requestKey: request.requestKey,
					sequence: sequence.toString(),
				},
			});
			return {
				id,
				requestKey: request.requestKey,
				projectId: request.projectId,
				sequence,
				generation,
				state: "waiting",
				requirements: request.requirements.map((r) => ({ ...r })),
				createdAt: now,
			};
		});
	}

	private async waiterByRow(
		target: Client | Transaction,
		row: Row,
	): Promise<Waiter> {
		const requirements = (
			await execute(
				target,
				"SELECT resource_id,binding_id,amount FROM waiter_requirements WHERE waiter_id=? ORDER BY resource_id",
				[text(row.id)],
			)
		).rows.map((r) => ({
			resourceId: text(r.resource_id),
			bindingId: typeof r.binding_id === "string" ? r.binding_id : null,
			amount: big(r.amount),
		}));
		return waiterFrom(row, requirements);
	}

	private async promisedByResource(
		target: Client | Transaction,
		resourceIds: readonly string[],
	): Promise<Map<string, bigint>> {
		if (resourceIds.length === 0) return new Map();
		const placeholders = resourceIds.map(() => "?").join(",");
		const rows = await execute(
			target,
			`SELECT a.resource_id,a.amount FROM lease_allocations a
			 JOIN leases l ON l.id=a.lease_id
			 WHERE l.state IN ('provisional','active','uncertain','releasing')
			 AND a.resource_id IN (${placeholders}) ORDER BY a.resource_id,a.lease_id`,
			[...resourceIds],
		);
		const used = new Map<string, bigint>();
		for (const row of rows.rows) {
			const resourceId = text(row.resource_id);
			try {
				used.set(
					resourceId,
					checkedQuantitySum(
						used.get(resourceId) ?? 0n,
						big(row.amount),
						`durable promises for '${resourceId}'`,
					),
				);
			} catch (error) {
				throw new HostStoreError(
					error instanceof Error ? error.message : "quantity promise overflow",
					"CORRUPT",
				);
			}
		}
		return used;
	}

	private missingObservation(
		kind: string,
		reason: "observation-missing" | "observation-ambiguous",
		message: string,
		ignoreObservation = false,
	): MemoryObservationPolicyResult {
		const diagnostic = {
			kind,
			bindingId: null,
			sequence: null,
			observedAt: null,
			ageMs: null,
			expiresAt: null,
			maxAgeMs: RAM_OBSERVATION_MAX_AGE_MS,
			processBootId: null,
			kernelBootId: null,
			reuse: "serialized-while-fresh" as const,
			policy: ignoreObservation
				? ("ignored-explicitly" as const)
				: ("required" as const),
		};
		if (ignoreObservation) {
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
		return {
			ok: false,
			reason,
			message,
			diagnostic,
		};
	}

	private async memoryObservation(
		target: Client | Transaction,
		definition: HostResourceDefinition,
	): Promise<MemoryObservationPolicyResult> {
		const now = this.now();
		const identity = {
			processBootId: this.identity.processBootId,
			kernelBootId: this.identity.kernelBootId,
		};
		const healthRow = await one(
			target,
			"SELECT * FROM observation_health WHERE kind='linux-memory'",
		);
		if (healthRow) {
			return memoryObservationFromHealth({
				health: {
					kind: text(healthRow.kind),
					result: text(healthRow.result) as ObservationHealth["result"],
					checkedAt: num(healthRow.checked_at),
					processBootId: text(healthRow.process_boot_id),
					kernelBootId:
						typeof healthRow.kernel_boot_id === "string"
							? healthRow.kernel_boot_id
							: null,
					detail: parseJson(healthRow.detail_json, {}),
				},
				now,
				identity,
				ignoreObservation: definition.ignoreObservation,
			});
		}

		const sampleRows = (
			await execute(
				target,
				`SELECT o.* FROM observations o
				 JOIN resource_bindings b ON b.id=o.binding_id
				 WHERE b.resource_id=? AND b.enabled=1 AND o.kind='linux-memory'
				 ORDER BY o.binding_id`,
				[definition.id],
			)
		).rows;
		if (sampleRows.length === 0) {
			return this.missingObservation(
				"linux-memory",
				"observation-missing",
				"no linux-memory observation is available",
				definition.ignoreObservation,
			);
		}
		if (sampleRows.length !== 1) {
			return this.missingObservation(
				"linux-memory",
				"observation-ambiguous",
				"multiple linux-memory binding samples are available",
				definition.ignoreObservation,
			);
		}
		return memoryObservationFromSample({
			sample: observationFrom(sampleRows[0] as Row),
			now,
			identity,
			ignoreObservation: definition.ignoreObservation,
		});
	}

	private observationHealthFrom(row: Row): ObservationHealth {
		return {
			kind: text(row.kind),
			result: text(row.result) as ObservationHealth["result"],
			checkedAt: num(row.checked_at),
			processBootId: text(row.process_boot_id),
			kernelBootId:
				typeof row.kernel_boot_id === "string" ? row.kernel_boot_id : null,
			detail: parseJson(row.detail_json, {}),
		};
	}

	private missingDiagnostic(
		kind: string,
		ignoreObservation: boolean,
		bindingId: string | null = null,
	) {
		return {
			kind,
			bindingId,
			sequence: null,
			observedAt: null,
			ageMs: null,
			expiresAt: null,
			maxAgeMs: RAM_OBSERVATION_MAX_AGE_MS,
			processBootId: null,
			kernelBootId: null,
			reuse: "serialized-while-fresh" as const,
			policy: ignoreObservation
				? ("ignored-explicitly" as const)
				: ("required" as const),
		};
	}

	private async cpuObservation(
		target: Client | Transaction,
		definition: HostResourceDefinition,
	) {
		const row = await one(
			target,
			"SELECT * FROM observation_health WHERE kind='linux-cpu'",
		);
		if (!row) {
			const diagnostic = this.missingDiagnostic(
				"linux-cpu",
				definition.ignoreObservation === true,
			);
			return definition.ignoreObservation
				? ({
						ok: true,
						value: {
							metrics: {},
							diagnostic,
							ignored: true,
							degraded: true,
							pressure: null,
							blocked: false,
						},
					} as const)
				: ({
						ok: false,
						reason: "observation-missing",
						message: "no linux-cpu observation is available",
						diagnostic,
					} as const);
		}
		return cpuObservationFromHealth({
			health: this.observationHealthFrom(row),
			now: this.now(),
			identity: {
				processBootId: this.identity.processBootId,
				kernelBootId: this.identity.kernelBootId,
			},
			configuredPermits: definition.capacity,
			policy: definition.cpuPressure ?? {},
			ignoreObservation: definition.ignoreObservation,
		});
	}

	private async liveAllocationRows(
		target: Client | Transaction,
		resourceId: string,
	): Promise<Row[]> {
		return (
			await execute(
				target,
				`SELECT l.*,a.binding_id FROM leases l
				 JOIN lease_allocations a ON a.lease_id=l.id
				 WHERE a.resource_id=?
				 AND l.state IN ('provisional','active','uncertain','releasing')
				 ORDER BY l.id`,
				[resourceId],
			)
		).rows;
	}

	private attributedGpuOccupants(
		raw: readonly unknown[],
		leases: readonly Row[],
		bindingId: string,
	): GpuOccupancyDiagnostic["occupants"] {
		return raw.slice(0, 256).map((value) => {
			const occupant = object(value) ?? {};
			const pid =
				typeof occupant.pid === "number" && Number.isSafeInteger(occupant.pid)
					? occupant.pid
					: 0;
			const normalizedPidStart = pidStartDiagnostic(occupant.pidStart, pid);
			const pidStart = object(normalizedPidStart);
			const startTicks =
				pidStart?.status === "verified" &&
				(typeof pidStart.startTimeTicks === "string" ||
					typeof pidStart.startTimeTicks === "bigint")
					? String(pidStart.startTimeTicks)
					: null;
			const kernelBootId =
				typeof pidStart?.kernelBootId === "string"
					? pidStart.kernelBootId
					: null;
			const owner =
				startTicks === null
					? null
					: (leases.find((lease) => {
							if (lease.binding_id !== bindingId) return false;
							if (text(lease.state) !== "active") return false;
							if (
								kernelBootId !== null &&
								typeof lease.kernel_boot_id === "string" &&
								lease.kernel_boot_id !== kernelBootId
							)
								return false;
							if (
								lease.pid != null &&
								num(lease.pid) === pid &&
								lease.process_start_time === startTicks
							)
								return true;
							return parseJson<RunRef["processTree"]>(
								lease.process_tree_json,
								[],
							)?.some(
								(entry) =>
									entry.pid === pid &&
									entry.processStartTime === startTicks &&
									(entry.kernelBootId == null ||
										kernelBootId == null ||
										entry.kernelBootId === kernelBootId),
							);
						}) ?? null);
			const attribution = owner
				? ("managed" as const)
				: startTicks === null
					? ("unknown" as const)
					: ("external" as const);
			return {
				pid,
				pidStart: normalizedPidStart,
				attribution,
				runId: owner && typeof owner.run_id === "string" ? owner.run_id : null,
				leaseId: owner ? text(owner.id) : null,
				evidence: gpuEvidenceDiagnostics(
					Array.isArray(occupant.evidence) ? occupant.evidence : [],
				),
			};
		});
	}

	private async gpuBindingObservation(
		target: Client | Transaction,
		definition: HostResourceDefinition,
		binding: HostResourceBinding,
		leases: readonly Row[],
	): Promise<
		| {
				ok: true;
				ignored: boolean;
				available: boolean;
				reason: "external-occupancy" | "unknown-occupancy" | null;
				observation: HostHoldDiagnostic["observation"];
				diagnostic: GpuOccupancyDiagnostic;
		  }
		| {
				ok: false;
				reason: HostHoldDiagnostic["reason"];
				message: string;
				observation: HostHoldDiagnostic["observation"];
				diagnostic: GpuOccupancyDiagnostic | null;
		  }
	> {
		const kind = definition.observationKind as "amd-gpu" | "nvidia-gpu";
		const row = await one(
			target,
			"SELECT * FROM observations WHERE binding_id=?",
			[binding.id],
		);
		if (!row) {
			const observation = this.missingDiagnostic(
				kind,
				definition.ignoreObservation === true,
				binding.id,
			);
			if (definition.ignoreObservation) {
				return {
					ok: true,
					ignored: true,
					available: true,
					reason: null,
					observation,
					diagnostic: {
						bindingId: binding.id,
						stableKey: binding.stableKey,
						deviceKey: null,
						state: "unknown",
						blocksExclusiveAdmission: false,
						gpuUtilization: null,
						memoryUsedBytes: null,
						memoryTotalBytes: null,
						temperatureCelsius: null,
						powerWatts: null,
						occupants: [],
						deviceEvidence: [],
					},
				};
			}
			return {
				ok: false,
				reason: "observation-missing",
				message: `no ${kind} sample exists for binding '${binding.id}'`,
				observation,
				diagnostic: null,
			};
		}
		const sample = observationFrom(row);
		if (!definition.ignoreObservation) {
			const healthRow = await one(
				target,
				"SELECT * FROM observation_health WHERE kind=?",
				[kind],
			);
			const sequenceText = healthRow
				? healthSequence(healthRow.detail_json)
				: null;
			if (!healthRow) {
				return {
					ok: false,
					reason: "observation-missing",
					message: `no coherent ${kind} health envelope is available`,
					observation: this.missingDiagnostic(kind, false, binding.id),
					diagnostic: null,
				};
			}
			const healthResult = text(healthRow.result);
			if (healthResult === "error" || healthResult === "unsupported") {
				return {
					ok: false,
					reason: "observation-failed",
					message: `${kind} observation result is ${healthResult}`,
					observation: this.missingDiagnostic(kind, false, binding.id),
					diagnostic: null,
				};
			}
			if (
				sequenceText === null ||
				BigInt(sequenceText) !== sample.sequence ||
				healthResult !== sample.result ||
				text(healthRow.process_boot_id) !== sample.processBootId ||
				(healthRow.kernel_boot_id ?? null) !== sample.kernelBootId
			) {
				return {
					ok: false,
					reason: "observation-inconsistent",
					message: `${kind} binding sample disagrees with adapter health generation`,
					observation: this.missingDiagnostic(kind, false, binding.id),
					diagnostic: null,
				};
			}
		}
		const envelope = observationEnvelopeFromSample({
			sample,
			expectedKind: kind,
			now: this.now(),
			identity: {
				processBootId: this.identity.processBootId,
				kernelBootId: this.identity.kernelBootId,
			},
			ignoreObservation: definition.ignoreObservation,
			allowDegradedValue: true,
		});
		if (!envelope.ok) {
			return {
				ok: false,
				reason: envelope.reason,
				message: envelope.message,
				observation: envelope.diagnostic,
				diagnostic: null,
			};
		}
		const metrics = envelope.value.metrics;
		const occupancy = object(metrics.occupancy);
		const identity = object(metrics.identity);
		const occupants = this.attributedGpuOccupants(
			sample.occupants,
			leases,
			binding.id,
		);
		const deviceEvidence = gpuEvidenceDiagnostics(
			Array.isArray(occupancy?.deviceEvidence) ? occupancy.deviceEvidence : [],
		);
		const state =
			occupancy?.state === "idle" ||
			occupancy?.state === "occupied" ||
			occupancy?.state === "unknown"
				? occupancy.state
				: "unknown";
		const memoryUsed =
			typeof metrics.memoryUsedBytes === "string" &&
			/^(?:0|[1-9][0-9]*)$/.test(metrics.memoryUsedBytes)
				? BigInt(metrics.memoryUsedBytes)
				: metrics.memoryUsedBytes === null
					? null
					: null;
		const memoryTotal =
			typeof metrics.memoryTotalBytes === "string" &&
			/^(?:0|[1-9][0-9]*)$/.test(metrics.memoryTotalBytes)
				? BigInt(metrics.memoryTotalBytes)
				: null;
		const external = occupants.some((item) => item.attribution === "external");
		const unknown = occupants.some((item) => item.attribution === "unknown");
		const managedResident = occupants
			.filter((item) => item.attribution === "managed")
			.flatMap((item) => item.evidence)
			.reduce((total, evidence) => {
				const item = object(evidence);
				if (item?.admission !== "blocking") return total;
				const resident = item?.residentBytes;
				return typeof resident === "string" &&
					/^(?:0|[1-9][0-9]*)$/.test(resident)
					? total + BigInt(resident)
					: total;
			}, 0n);
		// Compare device resident evidence with managed resident evidence once, in
		// aggregate, so one managed 10 GiB process cannot explain two device claims.
		const blockingDeviceResident = deviceEvidence.reduce(
			(total, evidence) =>
				evidence.kind === "device-memory" && evidence.admission === "blocking"
					? total + BigInt(evidence.residentBytes)
					: total,
			0n,
		);
		const unexplainedDeviceEvidence =
			deviceEvidence.some(
				(evidence) =>
					evidence.admission === "blocking" &&
					evidence.kind !== "device-memory",
			) || blockingDeviceResident > managedResident;
		const rawBlocks = occupancy?.blocksExclusiveAdmission === true;
		const reason = unknown
			? ("unknown-occupancy" as const)
			: external ||
					unexplainedDeviceEvidence ||
					(rawBlocks && occupants.length === 0)
				? ("external-occupancy" as const)
				: null;
		const diagnostic: GpuOccupancyDiagnostic = {
			bindingId: binding.id,
			stableKey: binding.stableKey,
			deviceKey: typeof identity?.key === "string" ? identity.key : null,
			state,
			blocksExclusiveAdmission: reason !== null,
			gpuUtilization:
				typeof metrics.gpuUtilization === "number"
					? metrics.gpuUtilization
					: null,
			memoryUsedBytes: memoryUsed,
			memoryTotalBytes: memoryTotal,
			temperatureCelsius:
				typeof metrics.temperatureCelsius === "number" &&
				Number.isFinite(metrics.temperatureCelsius)
					? metrics.temperatureCelsius
					: null,
			powerWatts:
				typeof metrics.powerWatts === "number" &&
				Number.isFinite(metrics.powerWatts) &&
				metrics.powerWatts >= 0
					? metrics.powerWatts
					: null,
			occupants,
			deviceEvidence,
		};
		if (envelope.value.ignored) {
			return {
				ok: true,
				ignored: true,
				available: true,
				reason: null,
				observation: envelope.value.diagnostic,
				diagnostic,
			};
		}
		if (reason) {
			return {
				ok: true,
				ignored: false,
				available: false,
				reason,
				observation: envelope.value.diagnostic,
				diagnostic,
			};
		}
		if (envelope.value.degraded || state === "unknown") {
			return {
				ok: false,
				reason:
					state === "unknown" ? "unknown-occupancy" : "observation-failed",
				message: `${kind} binding '${binding.id}' is partial or ambiguous`,
				observation: envelope.value.diagnostic,
				diagnostic,
			};
		}
		return {
			ok: true,
			ignored: false,
			available: true,
			reason: null,
			observation: envelope.value.diagnostic,
			diagnostic,
		};
	}

	private holdDiagnostic(input: {
		definition: HostResourceDefinition;
		requestedAmount: bigint;
		durablePromises: bigint;
		reason: HostHoldDiagnostic["reason"];
		message: string;
		effectiveCapacity?: bigint;
		observation?: HostHoldDiagnostic["observation"];
		ramFormula?: HostHoldDiagnostic["ramFormula"];
		cpuPressure?: HostHoldDiagnostic["cpuPressure"];
		gpuOccupancy?: HostHoldDiagnostic["gpuOccupancy"];
	}): HostHoldDiagnostic {
		return {
			resourceId: input.definition.id,
			reason: input.reason,
			message: input.message,
			requestedAmount: input.requestedAmount,
			configuredQuota: input.definition.capacity,
			durablePromises: input.durablePromises,
			effectiveCapacity: input.effectiveCapacity ?? 0n,
			observation: input.observation ?? null,
			ramFormula: input.ramFormula ?? null,
			cpuPressure: input.cpuPressure ?? null,
			gpuOccupancy: input.gpuOccupancy ?? null,
		};
	}

	private async effectiveCapacities(
		target: Client | Transaction,
		definitions: readonly HostResourceDefinition[],
	): Promise<HostEffectiveCapacity[]> {
		const promised = await this.promisedByResource(
			target,
			definitions.map((item) => item.id),
		);
		const capacities: HostEffectiveCapacity[] = [];
		for (const definition of definitions) {
			const durablePromises = promised.get(definition.id) ?? 0n;
			const base = {
				resourceId: definition.id,
				accounting: definition.accounting,
				quantityUnit: definition.quantityUnit ?? null,
				enforcement: {
					mode: "admission-control" as const,
					kernelEnforced: false as const,
				},
				configuredQuota: definition.capacity,
				durablePromises,
				observedCapacity: null,
				cpuPressure: null,
				gpuOccupancy: [] as GpuOccupancyDiagnostic[],
				degraded: false,
			};
			const definitionHold = !definition.enabled
				? ("disabled" as const)
				: definition.draining
					? ("draining" as const)
					: definition.provisioning === "dynamic"
						? ("dynamic-unprovisioned" as const)
						: definition.accounting === "quantity" &&
								definition.quantityUnit == null
							? ("invalid-definition" as const)
							: null;
			if (definitionHold) {
				capacities.push({
					...base,
					effectiveCapacity: 0n,
					holdReason: definitionHold,
					observation: null,
					ramFormula: null,
				});
				continue;
			}
			if (durablePromises > definition.capacity) {
				capacities.push({
					...base,
					effectiveCapacity: 0n,
					holdReason: "invalid-definition",
					observation: null,
					ramFormula: null,
				});
				continue;
			}
			const quotaRemaining = definition.capacity - durablePromises;
			if (definition.observationKind === "linux-cpu") {
				const observed = await this.cpuObservation(target, definition);
				if (!observed.ok) {
					capacities.push({
						...base,
						effectiveCapacity: 0n,
						holdReason: observed.reason,
						observation: observed.diagnostic,
						ramFormula: null,
						degraded: true,
					});
					continue;
				}
				capacities.push({
					...base,
					observedCapacity: observed.value.ignored
						? null
						: observed.value.blocked
							? 0n
							: definition.capacity,
					effectiveCapacity: observed.value.blocked ? 0n : quotaRemaining,
					holdReason: observed.value.blocked
						? "cpu-pressure"
						: quotaRemaining === 0n
							? "quota-exhausted"
							: null,
					observation: observed.value.diagnostic,
					ramFormula: null,
					cpuPressure: observed.value.pressure,
					degraded: observed.value.ignored,
				});
				continue;
			}
			if (
				definition.observationKind === "amd-gpu" ||
				definition.observationKind === "nvidia-gpu"
			) {
				const bindings = (
					await execute(
						target,
						"SELECT * FROM resource_bindings WHERE resource_id=? AND enabled=1 ORDER BY id",
						[definition.id],
					)
				).rows.map(bindingFrom);
				const leases = await this.liveAllocationRows(target, definition.id);
				const usedBindings = new Set(
					leases
						.map((row) =>
							typeof row.binding_id === "string" ? row.binding_id : null,
						)
						.filter((id): id is string => id !== null),
				);
				const results = await Promise.all(
					bindings.map((binding) =>
						this.gpuBindingObservation(target, definition, binding, leases),
					),
				);
				const diagnostics = results
					.map((result) => result.diagnostic)
					.filter((item): item is GpuOccupancyDiagnostic => item !== null);
				const observedFree = results.filter(
					(result) => result.ok && result.available,
				).length;
				const effectiveFree = results.filter(
					(result, index) =>
						result.ok &&
						result.available &&
						!usedBindings.has(bindings[index]?.id ?? ""),
				).length;
				const failed = results.find((result) => !result.ok);
				const occupied = results.find(
					(result) => result.ok && !result.available,
				);
				const ignored = results.some((result) => result.ok && result.ignored);
				const effectiveFreeQuantity = BigInt(failed ? 0 : effectiveFree);
				const effective =
					quotaRemaining < effectiveFreeQuantity
						? quotaRemaining
						: effectiveFreeQuantity;
				const observedFreeQuantity = BigInt(observedFree);
				capacities.push({
					...base,
					observedCapacity: ignored
						? null
						: definition.capacity < observedFreeQuantity
							? definition.capacity
							: observedFreeQuantity,
					effectiveCapacity: effective,
					holdReason:
						effective > 0n
							? null
							: failed
								? failed.reason
								: (occupied?.reason ??
									(quotaRemaining === 0n
										? "quota-exhausted"
										: "observation-missing")),
					observation: failed?.observation ?? occupied?.observation ?? null,
					ramFormula: null,
					gpuOccupancy: diagnostics,
					degraded: ignored || failed !== undefined,
				});
				continue;
			}
			if (
				definition.accounting !== "quantity" ||
				definition.quantityUnit !== "bytes"
			) {
				capacities.push({
					...base,
					// Declared-only: quota drives admission but is not observed capacity.
					observedCapacity: null,
					effectiveCapacity: quotaRemaining,
					holdReason: quotaRemaining === 0n ? "quota-exhausted" : null,
					observation: null,
					ramFormula: null,
				});
				continue;
			}
			const observed = await this.memoryObservation(target, definition);
			if (!observed.ok) {
				capacities.push({
					...base,
					effectiveCapacity: 0n,
					holdReason: observed.reason,
					observation: observed.diagnostic,
					ramFormula: null,
					degraded: true,
				});
				continue;
			}
			if (observed.value.ignored) {
				capacities.push({
					...base,
					effectiveCapacity: quotaRemaining,
					holdReason: quotaRemaining === 0n ? "quota-exhausted" : null,
					observation: observed.value.diagnostic,
					ramFormula: null,
					degraded: true,
				});
				continue;
			}
			try {
				const formula = evaluateRamFormula({
					configuredQuotaBytes: definition.capacity,
					safetyHeadroomBytes: definition.safetyHeadroom as bigint,
					memAvailableBytes: observed.value.memAvailableBytes,
					durablePromisesBytes: durablePromises,
					attributableManagedBytes: observed.value.attributableManagedBytes,
					requestBytes: 0n,
				});
				capacities.push({
					...base,
					observedCapacity:
						formula.effectiveCapacityBytes + durablePromises >
						definition.capacity
							? definition.capacity
							: formula.effectiveCapacityBytes + durablePromises,
					effectiveCapacity: formula.effectiveCapacityBytes,
					holdReason:
						formula.effectiveCapacityBytes === 0n
							? formula.quotaRemainingBytes === 0n
								? "quota-exhausted"
								: "headroom-exhausted"
							: null,
					observation: observed.value.diagnostic,
					ramFormula: formula,
				});
			} catch {
				capacities.push({
					...base,
					effectiveCapacity: 0n,
					holdReason: "observation-inconsistent",
					observation: observed.value.diagnostic,
					ramFormula: null,
					degraded: true,
				});
			}
		}
		return capacities;
	}

	private async snapshotMatches(
		target: Client | Transaction,
		snapshot: HostAdmissionSnapshot,
		definitions: readonly HostResourceDefinition[],
	): Promise<boolean> {
		if (
			snapshot.processBootId !== this.identity.processBootId ||
			snapshot.kernelBootId !== this.identity.kernelBootId
		)
			return false;
		for (const definition of definitions) {
			if (snapshot.definitions[definition.id] !== definition.version)
				return false;
			const kind = definition.observationKind;
			if (!kind) continue;
			const healthRow = await one(
				target,
				"SELECT * FROM observation_health WHERE kind=?",
				[kind],
			);
			const pinnedHealth = snapshot.health[kind];
			if (!healthRow) {
				if (pinnedHealth) return false;
			} else {
				const sequenceText = healthSequence(healthRow.detail_json);
				const sequence = sequenceText === null ? null : BigInt(sequenceText);
				if (
					!pinnedHealth ||
					pinnedHealth.checkedAt !== num(healthRow.checked_at) ||
					pinnedHealth.sequence !== sequence ||
					pinnedHealth.result !== text(healthRow.result)
				)
					return false;
			}
			const bindingRows = (
				await execute(
					target,
					"SELECT * FROM resource_bindings WHERE resource_id=? ORDER BY id",
					[definition.id],
				)
			).rows;
			for (const bindingRow of bindingRows) {
				const binding = bindingFrom(bindingRow);
				if (snapshot.bindings[binding.id] !== binding.version) return false;
				const observationRow = await one(
					target,
					"SELECT sequence FROM observations WHERE binding_id=?",
					[binding.id],
				);
				const current = observationRow
					? big(observationRow.sequence)
					: undefined;
				if (snapshot.observations[binding.id] !== current) return false;
			}
		}
		return true;
	}

	private async recordResourceHolds(
		tx: Transaction,
		diagnostics: readonly HostHoldDiagnostic[],
		generation: bigint,
	): Promise<void> {
		for (const diagnostic of diagnostics) {
			const safe = JSON.parse(json(diagnostic)) as Record<string, unknown>;
			const safeObservation = object(safe.observation);
			const fingerprint = createHash("sha256")
				.update(
					canonicalJson({
						...safe,
						observation:
							diagnostic.observation && safeObservation
								? {
										...safeObservation,
										ageMs: null,
									}
								: null,
					}),
				)
				.digest("hex");
			const current = await one(
				tx,
				"SELECT * FROM host_resource_holds WHERE resource_id=?",
				[diagnostic.resourceId],
			);
			const unchanged =
				current &&
				text(current.state) === "open" &&
				text(current.fingerprint) === fingerprint;
			const now = this.now();
			await execute(
				tx,
				`INSERT INTO host_resource_holds
				 (resource_id,state,reason,fingerprint,snapshot_generation,opened_at,updated_at,resolved_at,diagnostic_json)
				 VALUES(?,'open',?,?,?,?,?,NULL,?)
				 ON CONFLICT(resource_id) DO UPDATE SET state='open',reason=excluded.reason,
				 fingerprint=excluded.fingerprint,snapshot_generation=excluded.snapshot_generation,
				 opened_at=CASE WHEN host_resource_holds.state='resolved' THEN excluded.opened_at ELSE host_resource_holds.opened_at END,
				 updated_at=excluded.updated_at,resolved_at=NULL,diagnostic_json=excluded.diagnostic_json`,
				[
					diagnostic.resourceId,
					diagnostic.reason,
					fingerprint,
					generation,
					now,
					now,
					json(diagnostic),
				],
			);
			if (!unchanged) {
				await this.audit(tx, {
					eventKey: `resource-hold:${diagnostic.resourceId}:open:${fingerprint}`,
					action: "resource.hold.opened",
					actor: "host-policy",
					projectId: null,
					waiterId: null,
					leaseId: null,
					fence: null,
					detail: safe,
				});
			}
		}
	}

	private async resolveResourceHolds(
		tx: Transaction,
		resourceIds: readonly string[],
	): Promise<void> {
		for (const resourceId of resourceIds) {
			const current = await one(
				tx,
				"SELECT * FROM host_resource_holds WHERE resource_id=? AND state='open'",
				[resourceId],
			);
			if (!current) continue;
			const now = this.now();
			await execute(
				tx,
				"UPDATE host_resource_holds SET state='resolved',updated_at=?,resolved_at=? WHERE resource_id=?",
				[now, now, resourceId],
			);
			await this.audit(tx, {
				eventKey: `resource-hold:${resourceId}:resolved:${text(current.fingerprint)}`,
				action: "resource.hold.resolved",
				actor: "host-policy",
				projectId: null,
				waiterId: null,
				leaseId: null,
				fence: null,
				detail: { previousReason: text(current.reason) },
			});
		}
	}

	async tryGrant(
		waiterId: string,
		_expectedGeneration: bigint,
		snapshot?: HostAdmissionSnapshot,
	): Promise<Grant | Held> {
		return this.withWrite(async (tx) => {
			const row = await one(tx, "SELECT * FROM waiters WHERE id=?", [waiterId]);
			if (!row)
				throw new HostStoreError(`unknown waiter '${waiterId}'`, "NOT_FOUND");
			const waiter = await this.waiterByRow(tx, row);
			if (waiter.state === "granted") {
				const lease = await this.leaseByWaiter(tx, waiter.id);
				if (lease?.state !== "provisional") {
					throw new HostStoreError(
						"granted waiter has no provisional lease",
						"CORRUPT",
					);
				}
				return lease as Grant;
			}
			if (waiter.state !== "waiting") {
				throw new HostStoreError(
					`waiter is ${waiter.state}`,
					"INVALID_TRANSITION",
				);
			}
			const generation = await this.generation(tx);
			if (
				(snapshot && _expectedGeneration !== snapshot.generation) ||
				(!snapshot && _expectedGeneration !== generation)
			) {
				return {
					kind: "held",
					waiterId,
					generation,
					reason: "generation",
					blockedBy: [],
					diagnostics: [],
				};
			}
			const resourceIds = waiter.requirements.map((r) => r.resourceId);
			const placeholders = resourceIds.map(() => "?").join(",");

			const older = await execute(
				tx,
				`SELECT DISTINCT wr.resource_id
				 FROM waiters w JOIN waiter_requirements wr ON wr.waiter_id=w.id
				 WHERE w.state='waiting' AND w.sequence < ? AND wr.resource_id IN (${placeholders})
				 ORDER BY wr.resource_id`,
				[waiter.sequence, ...resourceIds],
			);
			if (older.rows.length > 0) {
				return {
					kind: "held",
					waiterId,
					generation,
					reason: "fifo",
					blockedBy: older.rows.map((r) => text(r.resource_id)),
					diagnostics: [],
				};
			}

			const defs = (
				await execute(
					tx,
					`SELECT * FROM resource_definitions WHERE id IN (${placeholders})`,
					resourceIds,
				)
			).rows.map(definitionFrom);
			const byId = new Map(defs.map((d) => [d.id, d]));
			if (snapshot && !(await this.snapshotMatches(tx, snapshot, defs))) {
				return {
					kind: "held",
					waiterId,
					generation,
					reason: "generation",
					blockedBy: [],
					diagnostics: [],
				};
			}
			const requestedBindingIds = waiter.requirements
				.map((r) => r.bindingId)
				.filter((id): id is string => id != null);
			const bindingById = new Map<string, HostResourceBinding>();
			if (requestedBindingIds.length > 0) {
				const bindingPlaceholders = requestedBindingIds
					.map(() => "?")
					.join(",");
				for (const binding of (
					await execute(
						tx,
						`SELECT * FROM resource_bindings WHERE id IN (${bindingPlaceholders})`,
						requestedBindingIds,
					)
				).rows.map(bindingFrom)) {
					bindingById.set(binding.id, binding);
				}
			}
			const definitionBlocked = waiter.requirements
				.filter((r) => {
					const def = byId.get(r.resourceId);
					const binding = r.bindingId ? bindingById.get(r.bindingId) : null;
					return (
						!def?.enabled ||
						def.draining ||
						def.provisioning === "dynamic" ||
						(def.accounting === "slot" && r.amount !== 1n) ||
						(def.accounting === "quantity" && def.quantityUnit == null) ||
						(r.bindingId != null &&
							(!binding?.enabled || binding.resourceId !== r.resourceId))
					);
				})
				.map((r) => r.resourceId);
			if (definitionBlocked.length > 0) {
				const blockedDiagnostics = definitionBlocked.map((resourceId) => {
					const definition = byId.get(resourceId);
					const requested =
						waiter.requirements.find((item) => item.resourceId === resourceId)
							?.amount ?? 0n;
					return {
						resourceId,
						reason: "invalid-definition" as const,
						message: `host resource '${resourceId}' cannot satisfy this accounting request`,
						requestedAmount: requested,
						configuredQuota: definition?.capacity ?? null,
						durablePromises: null,
						effectiveCapacity: 0n,
						observation: null,
						ramFormula: null,
						cpuPressure: null,
						gpuOccupancy: null,
					};
				});
				await this.recordResourceHolds(tx, blockedDiagnostics, generation);
				return {
					kind: "held",
					waiterId,
					generation,
					reason: "definition",
					blockedBy: definitionBlocked,
					diagnostics: blockedDiagnostics,
				};
			}

			const used = await this.promisedByResource(tx, resourceIds);
			const usedBindings = new Set<string>();
			if (requestedBindingIds.length > 0) {
				const bindingPlaceholders = requestedBindingIds
					.map(() => "?")
					.join(",");
				const rows = await execute(
					tx,
					`SELECT DISTINCT a.binding_id FROM lease_allocations a
					 JOIN leases l ON l.id=a.lease_id
					 WHERE l.state IN ('provisional','active','uncertain','releasing')
					 AND a.binding_id IN (${bindingPlaceholders})`,
					requestedBindingIds,
				);
				for (const row of rows.rows) {
					if (typeof row.binding_id === "string")
						usedBindings.add(row.binding_id);
				}
			}
			const diagnostics: HostHoldDiagnostic[] = [];
			const selectedBindings = new Map<string, string>();
			let heldReason: Held["reason"] = "capacity";
			for (const requirement of waiter.requirements) {
				const definition = byId.get(
					requirement.resourceId,
				) as HostResourceDefinition;
				const promised = used.get(requirement.resourceId) ?? 0n;
				let promisedWithRequest: bigint;
				try {
					promisedWithRequest = checkedQuantitySum(
						promised,
						requirement.amount,
						`grant for '${requirement.resourceId}'`,
					);
				} catch (error) {
					diagnostics.push(
						this.holdDiagnostic({
							definition,
							requestedAmount: requirement.amount,
							durablePromises: promised,
							reason: "quota-exhausted",
							message:
								error instanceof Error ? error.message : "quantity overflow",
						}),
					);
					continue;
				}
				if (
					promisedWithRequest > definition.capacity ||
					(requirement.bindingId != null &&
						usedBindings.has(requirement.bindingId))
				) {
					diagnostics.push(
						this.holdDiagnostic({
							definition,
							requestedAmount: requirement.amount,
							durablePromises: promised,
							reason: "quota-exhausted",
							message: `configured quota for '${requirement.resourceId}' cannot cover the request`,
							effectiveCapacity:
								definition.capacity > promised
									? definition.capacity - promised
									: 0n,
						}),
					);
					continue;
				}
				if (definition.observationKind === "linux-cpu") {
					const observed = await this.cpuObservation(tx, definition);
					if (!observed.ok) {
						heldReason = "observation";
						diagnostics.push(
							this.holdDiagnostic({
								definition,
								requestedAmount: requirement.amount,
								durablePromises: promised,
								reason: observed.reason,
								message: observed.message,
								observation: observed.diagnostic,
							}),
						);
						continue;
					}
					if (observed.value.blocked) {
						heldReason = "observation";
						diagnostics.push(
							this.holdDiagnostic({
								definition,
								requestedAmount: requirement.amount,
								durablePromises: promised,
								reason: "cpu-pressure",
								message:
									"CPU pressure exceeds the configured admission threshold",
								observation: observed.value.diagnostic,
								cpuPressure: observed.value.pressure,
							}),
						);
					}
					continue;
				}
				if (
					definition.observationKind === "amd-gpu" ||
					definition.observationKind === "nvidia-gpu"
				) {
					const bindings = (
						await execute(
							tx,
							`SELECT * FROM resource_bindings WHERE resource_id=? AND enabled=1
							 ${requirement.bindingId ? "AND id=?" : ""} ORDER BY id`,
							requirement.bindingId
								? [definition.id, requirement.bindingId]
								: [definition.id],
						)
					).rows.map(bindingFrom);
					const leases = await this.liveAllocationRows(tx, definition.id);
					if (leases.some((lease) => lease.binding_id == null)) {
						heldReason = "observation";
						diagnostics.push(
							this.holdDiagnostic({
								definition,
								requestedAmount: requirement.amount,
								durablePromises: promised,
								reason: "observation-ambiguous",
								message:
									"a live GPU promise predates stable binding allocation",
							}),
						);
						continue;
					}
					const leasedBindings = new Set(
						leases
							.map((lease) =>
								typeof lease.binding_id === "string" ? lease.binding_id : null,
							)
							.filter((id): id is string => id !== null),
					);
					const results = await Promise.all(
						bindings.map(async (binding) => ({
							binding,
							policy: await this.gpuBindingObservation(
								tx,
								definition,
								binding,
								leases,
							),
						})),
					);
					const available = results.find(
						(item) =>
							item.policy.ok &&
							item.policy.available &&
							!leasedBindings.has(item.binding.id),
					);
					if (available) {
						selectedBindings.set(definition.id, available.binding.id);
						continue;
					}
					const failed = results.find((item) => !item.policy.ok);
					const occupied = results.find(
						(item) => item.policy.ok && !item.policy.available,
					);
					const policy = failed?.policy ?? occupied?.policy;
					const reason = policy?.reason ?? "observation-missing";
					heldReason = "observation";
					diagnostics.push(
						this.holdDiagnostic({
							definition,
							requestedAmount: requirement.amount,
							durablePromises: promised,
							reason,
							message:
								policy && !policy.ok
									? policy.message
									: `no observed-idle GPU binding is available for '${definition.id}'`,
							observation: policy?.observation ?? undefined,
							gpuOccupancy: policy?.diagnostic ?? undefined,
						}),
					);
					continue;
				}
				if (
					definition.accounting !== "quantity" ||
					definition.quantityUnit !== "bytes"
				) {
					continue;
				}
				const observed = await this.memoryObservation(tx, definition);
				if (!observed.ok) {
					heldReason = "observation";
					diagnostics.push(
						this.holdDiagnostic({
							definition,
							requestedAmount: requirement.amount,
							durablePromises: promised,
							reason: observed.reason,
							message: observed.message,
							observation: observed.diagnostic,
						}),
					);
					continue;
				}
				if (observed.value.ignored) continue;
				try {
					const formula = evaluateRamFormula({
						configuredQuotaBytes: definition.capacity,
						safetyHeadroomBytes: definition.safetyHeadroom as bigint,
						memAvailableBytes: observed.value.memAvailableBytes,
						durablePromisesBytes: promised,
						attributableManagedBytes: observed.value.attributableManagedBytes,
						requestBytes: requirement.amount,
					});
					if (!formula.allowed) {
						heldReason =
							formula.blockedBy === "headroom" ? "headroom" : heldReason;
						diagnostics.push(
							this.holdDiagnostic({
								definition,
								requestedAmount: requirement.amount,
								durablePromises: promised,
								reason:
									formula.blockedBy === "headroom"
										? "headroom-exhausted"
										: "quota-exhausted",
								message: `RAM request is blocked by ${formula.blockedBy}`,
								effectiveCapacity: formula.effectiveCapacityBytes,
								observation: observed.value.diagnostic,
								ramFormula: formula,
							}),
						);
					}
				} catch (error) {
					heldReason = "observation";
					diagnostics.push(
						this.holdDiagnostic({
							definition,
							requestedAmount: requirement.amount,
							durablePromises: promised,
							reason: "observation-inconsistent",
							message:
								error instanceof Error
									? error.message
									: "RAM policy arithmetic failed",
							observation: observed.value.diagnostic,
						}),
					);
				}
			}
			if (diagnostics.length > 0) {
				await this.recordResourceHolds(tx, diagnostics, generation);
				return {
					kind: "held",
					waiterId,
					generation,
					reason: heldReason,
					blockedBy: diagnostics.map((item) => item.resourceId),
					diagnostics,
				};
			}
			await this.resolveResourceHolds(tx, resourceIds);

			const fenceRow = await one(
				tx,
				"UPDATE host_meta SET next_fence=next_fence+1 WHERE singleton=1 RETURNING next_fence-1 AS fence",
			);
			const fence = big(fenceRow?.fence);
			const leaseId = randomUUID();
			const now = this.now();
			await execute(
				tx,
				`INSERT INTO leases(id,waiter_id,project_id,state,fence,granted_at,updated_at)
				 VALUES(?,?,?,'provisional',?,?,?)`,
				[leaseId, waiter.id, waiter.projectId, fence, now, now],
			);
			for (const requirement of waiter.requirements) {
				await execute(
					tx,
					"INSERT INTO lease_allocations(lease_id,resource_id,binding_id,amount) VALUES(?,?,?,?)",
					[
						leaseId,
						requirement.resourceId,
						selectedBindings.get(requirement.resourceId) ??
							requirement.bindingId ??
							null,
						requirement.amount,
					],
				);
			}
			const nextGeneration = await this.bumpGeneration(tx);
			await execute(
				tx,
				"UPDATE waiters SET state='granted',generation=?,updated_at=? WHERE id=?",
				[nextGeneration, now, waiter.id],
			);
			await this.audit(tx, {
				eventKey: `lease:${leaseId}:${fence}:provisional`,
				action: "lease.provisional",
				actor: "coordinator",
				projectId: waiter.projectId,
				waiterId: waiter.id,
				leaseId,
				fence,
				detail: { resources: resourceIds },
			});
			return {
				id: leaseId,
				waiterId: waiter.id,
				projectId: waiter.projectId,
				state: "provisional",
				fence,
				allocations: waiter.requirements.map((r) => ({
					...r,
					bindingId: selectedBindings.get(r.resourceId) ?? r.bindingId ?? null,
				})),
				run: null,
				ownerProcessBootId: null,
				grantedAt: now,
				activatedAt: null,
				lastRenewedAt: null,
				expiresAt: null,
				releaseReason: null,
			};
		});
	}

	private async allocations(target: Client | Transaction, leaseId: string) {
		return (
			await execute(
				target,
				"SELECT resource_id,binding_id,amount FROM lease_allocations WHERE lease_id=? ORDER BY resource_id",
				[leaseId],
			)
		).rows.map((r) => ({
			resourceId: text(r.resource_id),
			bindingId: typeof r.binding_id === "string" ? r.binding_id : null,
			amount: big(r.amount),
		}));
	}

	private async leaseByWaiter(
		target: Client | Transaction,
		waiterId: string,
	): Promise<HostLease | null> {
		const row = await one(target, "SELECT * FROM leases WHERE waiter_id=?", [
			waiterId,
		]);
		return row
			? leaseFrom(row, await this.allocations(target, text(row.id)))
			: null;
	}

	async lease(id: string): Promise<HostLease | null> {
		const row = await one(this.client, "SELECT * FROM leases WHERE id=?", [id]);
		return row ? leaseFrom(row, await this.allocations(this.client, id)) : null;
	}

	private assertFence(row: Row, fence: bigint): void {
		if (big(row.fence) !== fence) {
			throw new HostStoreError(
				`stale fence ${fence.toString()} for lease ${text(row.id)}`,
				"STALE_FENCE",
			);
		}
	}

	async activate(
		id: string,
		fence: bigint,
		run: RunRef,
		leaseMs: number,
	): Promise<ActiveLease> {
		if (!run.runId || !run.runDir)
			throw new HostStoreError("run id and run directory are required");
		return this.withWrite(async (tx) => {
			const row = await one(tx, "SELECT * FROM leases WHERE id=?", [id]);
			if (!row) throw new HostStoreError(`unknown lease '${id}'`, "NOT_FOUND");
			this.assertFence(row, fence);
			if (text(row.state) === "active") {
				if (row.run_id !== run.runId)
					throw new HostStoreError(
						"lease belongs to another run",
						"INVALID_TRANSITION",
					);
				return leaseFrom(row, await this.allocations(tx, id)) as ActiveLease;
			}
			if (text(row.state) !== "provisional") {
				throw new HostStoreError(
					`cannot activate a ${text(row.state)} lease`,
					"INVALID_TRANSITION",
				);
			}
			const now = this.now();
			await execute(
				tx,
				`UPDATE leases SET state='active',run_id=?,run_dir=?,session_id=?,pid=?,process_start_time=?,
					 kernel_boot_id=?,process_tree_json=?,owner_process_boot_id=?,activated_at=?,last_renewed_at=?,expires_at=?,updated_at=?
				 WHERE id=? AND fence=?`,
				[
					run.runId,
					run.runDir,
					run.sessionId ?? null,
					run.pid ?? null,
					run.processStartTime ?? null,
					run.kernelBootId ?? this.identity.kernelBootId,
					json(run.processTree ?? []),
					this.identity.processBootId,
					now,
					now,
					now + leaseMs,
					now,
					id,
					fence,
				],
			);
			await this.bumpGeneration(tx);
			await this.audit(tx, {
				eventKey: `lease:${id}:${fence}:active`,
				action: "lease.activated",
				actor: "coordinator",
				projectId: text(row.project_id),
				waiterId: text(row.waiter_id),
				leaseId: id,
				fence,
				detail: { runId: run.runId, sessionId: run.sessionId ?? null },
			});
			return (await this.leaseInTx(tx, id)) as ActiveLease;
		});
	}

	private async leaseInTx(tx: Transaction, id: string): Promise<HostLease> {
		const row = await one(tx, "SELECT * FROM leases WHERE id=?", [id]);
		if (!row) throw new HostStoreError(`unknown lease '${id}'`, "NOT_FOUND");
		return leaseFrom(row, await this.allocations(tx, id));
	}

	async renewOrAdopt(
		id: string,
		fence: bigint,
		owner: RunRef & { processBootId: string; observedAt: number },
		leaseMs: number,
	): Promise<void> {
		await this.withWrite(async (tx) => {
			const row = await one(tx, "SELECT * FROM leases WHERE id=?", [id]);
			if (!row) throw new HostStoreError(`unknown lease '${id}'`, "NOT_FOUND");
			this.assertFence(row, fence);
			const state = text(row.state);
			if (state !== "active" && state !== "uncertain") {
				throw new HostStoreError(
					`cannot renew a ${state} lease`,
					"INVALID_TRANSITION",
				);
			}
			if (row.run_id !== owner.runId || row.run_dir !== owner.runDir) {
				throw new HostStoreError(
					"owner proof does not match the persisted run",
					"INVALID_TRANSITION",
				);
			}
			if (
				row.pid != null &&
				owner.pid != null &&
				(num(row.pid) !== owner.pid ||
					row.process_start_time !== (owner.processStartTime ?? null))
			) {
				throw new HostStoreError(
					"owner proof does not match pid identity",
					"INVALID_TRANSITION",
				);
			}
			if (
				row.owner_process_boot_id === owner.processBootId &&
				row.last_renewed_at != null &&
				num(row.last_renewed_at) === owner.observedAt &&
				state === "active"
			) {
				return;
			}
			const now = this.now();
			await execute(
				tx,
				`UPDATE leases SET state='active',process_tree_json=?,owner_process_boot_id=?,last_renewed_at=?,expires_at=?,updated_at=?
					 WHERE id=? AND fence=?`,
				[
					json(owner.processTree ?? parseJson(row.process_tree_json, [])),
					owner.processBootId,
					owner.observedAt,
					now + leaseMs,
					now,
					id,
					fence,
				],
			);
			await this.bumpGeneration(tx);
			await this.audit(tx, {
				eventKey: `lease:${id}:${fence}:${state === "uncertain" ? "adopt" : "renew"}:${owner.processBootId}:${owner.observedAt}`,
				action: state === "uncertain" ? "lease.adopted" : "lease.renewed",
				actor: "owner",
				projectId: text(row.project_id),
				waiterId: text(row.waiter_id),
				leaseId: id,
				fence,
				detail: { observedAt: owner.observedAt },
			});
		});
	}

	async cancelWaiter(
		id: string,
		fence: bigint,
		reason: string,
	): Promise<"cancelled" | "already_cancelled" | "not_waiter"> {
		return this.withWrite(async (tx) => {
			const waiter = await one(tx, "SELECT * FROM waiters WHERE id=?", [id]);
			if (!waiter) return "not_waiter";
			if (fence !== big(waiter.generation)) {
				throw new HostStoreError("stale waiter generation", "STALE_FENCE");
			}
			const state = text(waiter.state);
			if (state === "cancelled") return "already_cancelled";
			if (state !== "waiting") {
				throw new HostStoreError(
					`cannot cancel a ${state} waiter by waiter id`,
					"INVALID_TRANSITION",
				);
			}
			const now = this.now();
			await execute(
				tx,
				"UPDATE waiters SET state='cancelled',updated_at=? WHERE id=?",
				[now, id],
			);
			await this.bumpGeneration(tx);
			await this.audit(tx, {
				eventKey: `waiter:${id}:cancelled`,
				action: "waiter.cancelled",
				actor: "coordinator",
				projectId: text(waiter.project_id),
				waiterId: id,
				leaseId: null,
				fence: null,
				detail: { reason },
			});
			return "cancelled";
		});
	}

	async markReleasing(
		id: string,
		fence: bigint,
		reason: string,
	): Promise<HostLease> {
		if (!reason.trim()) throw new HostStoreError("release reason is required");
		return this.withWrite(async (tx) => {
			const row = await one(tx, "SELECT * FROM leases WHERE id=?", [id]);
			if (!row) throw new HostStoreError(`unknown lease '${id}'`, "NOT_FOUND");
			this.assertFence(row, fence);
			const state = text(row.state);
			if (["released", "reclaimed", "force_released"].includes(state)) {
				return leaseFrom(row, await this.allocations(tx, id));
			}
			if (state !== "releasing") {
				const now = this.now();
				await execute(
					tx,
					"UPDATE leases SET state='releasing',release_reason=?,updated_at=? WHERE id=? AND fence=?",
					[reason, now, id, fence],
				);
				await this.bumpGeneration(tx);
				await this.audit(tx, {
					eventKey: `lease:${id}:${fence}:releasing`,
					action: "lease.releasing",
					actor: "owner",
					projectId: text(row.project_id),
					waiterId: text(row.waiter_id),
					leaseId: id,
					fence,
					detail: { reason },
				});
			}
			return this.leaseInTx(tx, id);
		});
	}

	async finishRelease(
		id: string,
		fence: bigint,
		actor = "owner",
	): Promise<boolean> {
		return this.terminalTransition(
			id,
			fence,
			"released",
			actor,
			"release completed",
		);
	}

	async recoveryTransition(
		id: string,
		fence: bigint,
		to: "active" | "uncertain" | "released" | "reclaimed",
		actor: string,
		reason: string,
	): Promise<boolean> {
		if (to === "released" || to === "reclaimed") {
			return this.terminalTransition(id, fence, to, actor, reason);
		}
		return this.withWrite(async (tx) => {
			const row = await one(tx, "SELECT * FROM leases WHERE id=?", [id]);
			if (!row) return false;
			this.assertFence(row, fence);
			const from = text(row.state);
			if (from === to) {
				if (
					to !== "active" ||
					row.owner_process_boot_id === this.identity.processBootId
				) {
					return false;
				}
				const now = this.now();
				await execute(
					tx,
					"UPDATE leases SET owner_process_boot_id=?,updated_at=? WHERE id=? AND fence=?",
					[this.identity.processBootId, now, id, fence],
				);
				await this.bumpGeneration(tx);
				await this.audit(tx, {
					eventKey: `lease:${id}:${fence}:active:${this.identity.processBootId}`,
					action: "lease.adopted",
					actor,
					projectId: text(row.project_id),
					waiterId: text(row.waiter_id),
					leaseId: id,
					fence,
					detail: { from, reason },
				});
				return true;
			}
			if (
				!LIVE_LEASE_STATES.includes(from as (typeof LIVE_LEASE_STATES)[number])
			)
				return false;
			const now = this.now();
			await execute(
				tx,
				"UPDATE leases SET state=?,owner_process_boot_id=?,updated_at=? WHERE id=? AND fence=?",
				[
					to,
					to === "active"
						? this.identity.processBootId
						: (row.owner_process_boot_id ?? null),
					now,
					id,
					fence,
				],
			);
			await this.bumpGeneration(tx);
			await this.audit(tx, {
				eventKey: `lease:${id}:${fence}:${to}:${this.identity.processBootId}`,
				action: `lease.${to}`,
				actor,
				projectId: text(row.project_id),
				waiterId: text(row.waiter_id),
				leaseId: id,
				fence,
				detail: { from, reason },
			});
			return true;
		});
	}

	async forceRelease(
		id: string,
		fence: bigint,
		actor: string,
		reason: string,
		detail: Record<string, unknown>,
	): Promise<boolean> {
		if (!actor.trim() || !reason.trim()) {
			throw new HostStoreError("force release requires actor and reason");
		}
		return this.terminalTransition(id, fence, "force_released", actor, reason, {
			...detail,
			expectedFence: fence.toString(),
			actualFence: fence.toString(),
		});
	}

	private async terminalTransition(
		id: string,
		fence: bigint,
		to: "released" | "reclaimed" | "force_released",
		actor: string,
		reason: string,
		detail: Record<string, unknown> = {},
	): Promise<boolean> {
		return this.withWrite(async (tx) => {
			const row = await one(tx, "SELECT * FROM leases WHERE id=?", [id]);
			if (!row) throw new HostStoreError(`unknown lease '${id}'`, "NOT_FOUND");
			this.assertFence(row, fence);
			const from = text(row.state);
			if (from === to) return false;
			if (["released", "reclaimed", "force_released"].includes(from)) {
				throw new HostStoreError(
					`lease is already ${from}`,
					"INVALID_TRANSITION",
				);
			}
			const now = this.now();
			await execute(
				tx,
				"UPDATE leases SET state=?,release_reason=?,released_at=?,updated_at=? WHERE id=? AND fence=?",
				[to, reason, now, now, id, fence],
			);
			await this.reconcileRamIncidents(tx);
			await this.reconcileObservationIncidents(tx);
			await this.bumpGeneration(tx);
			await this.audit(tx, {
				eventKey: `lease:${id}:${fence}:${to}`,
				action: `lease.${to}`,
				actor,
				projectId: text(row.project_id),
				waiterId: text(row.waiter_id),
				leaseId: id,
				fence,
				detail: { from, reason, ...detail },
			});
			return true;
		});
	}

	async liveLeases(): Promise<HostLease[]> {
		const rows = (
			await execute(
				this.client,
				"SELECT * FROM leases WHERE state IN ('provisional','active','uncertain','releasing') ORDER BY granted_at,id",
			)
		).rows;
		return Promise.all(
			rows.map(async (row) =>
				leaseFrom(row, await this.allocations(this.client, text(row.id))),
			),
		);
	}

	private async reconcileRamIncidents(tx: Transaction): Promise<void> {
		const definitions = (
			await execute(
				tx,
				"SELECT * FROM resource_definitions WHERE accounting='quantity' AND quantity_unit='bytes' ORDER BY id",
			)
		).rows.map(definitionFrom);
		const promised = await this.promisedByResource(
			tx,
			definitions.map((item) => item.id),
		);
		for (const definition of definitions) {
			const current = await one(
				tx,
				"SELECT * FROM host_incidents WHERE incident_key=?",
				[`ram-low-headroom:${definition.id}`],
			);
			const observed = await this.memoryObservation(tx, definition);
			if (!observed.ok) continue; // uncertainty cannot prove recovery
			if (observed.value.ignored) continue; // degraded policy is not recovery evidence
			const durablePromises = promised.get(definition.id) ?? 0n;
			let low = false;
			let context: HostResourceIncident["context"] | null = null;
			try {
				const formula = evaluateRamFormula({
					configuredQuotaBytes: definition.capacity,
					safetyHeadroomBytes: definition.safetyHeadroom as bigint,
					memAvailableBytes: observed.value.memAvailableBytes,
					durablePromisesBytes: durablePromises,
					attributableManagedBytes: observed.value.attributableManagedBytes,
					requestBytes: 0n,
				});
				low = durablePromises > 0n && formula.observedHeadroomBytes < 0n;
				context = {
					configuredQuotaBytes: formula.configuredQuotaBytes,
					safetyHeadroomBytes: formula.safetyHeadroomBytes,
					memAvailableBytes: formula.memAvailableBytes,
					durablePromisesBytes: formula.durablePromisesBytes,
					attributableManagedBytes: formula.attributableManagedBytes,
					outstandingPromiseBytes: formula.outstandingPromiseBytes,
					quotaRemainingBytes: formula.quotaRemainingBytes,
					observedHeadroomBytes: formula.observedHeadroomBytes,
					effectiveCapacityBytes: formula.effectiveCapacityBytes,
					observationSequence: observed.value.diagnostic.sequence as bigint,
				};
			} catch {
				continue;
			}
			const now = this.now();
			const key = `ram-low-headroom:${definition.id}`;
			if (low && context) {
				const wasOpen = current && text(current.state) === "open";
				await execute(
					tx,
					`INSERT INTO host_incidents(incident_key,kind,resource_id,state,opened_at,updated_at,resolved_at,context_json)
					 VALUES(?,'ram-low-headroom',?,'open',?,?,NULL,?)
					 ON CONFLICT(incident_key) DO UPDATE SET state='open',
					 opened_at=CASE WHEN host_incidents.state='resolved' THEN excluded.opened_at ELSE host_incidents.opened_at END,
					 updated_at=excluded.updated_at,resolved_at=NULL,context_json=excluded.context_json`,
					[key, definition.id, now, now, json(context)],
				);
				if (!wasOpen) {
					await this.audit(tx, {
						eventKey: `incident:${key}:open:${now}`,
						action: "incident.opened",
						actor: "host-policy",
						projectId: null,
						waiterId: null,
						leaseId: null,
						fence: null,
						detail: { ...context },
					});
				}
			} else if (current && text(current.state) === "open") {
				await execute(
					tx,
					"UPDATE host_incidents SET state='resolved',updated_at=?,resolved_at=? WHERE incident_key=?",
					[now, now, key],
				);
				await this.audit(tx, {
					eventKey: `incident:${key}:resolved:${now}`,
					action: "incident.resolved",
					actor: "host-policy",
					projectId: null,
					waiterId: null,
					leaseId: null,
					fence: null,
					detail: { reason: "RAM headroom recovered" },
				});
			}
		}
	}

	private async setObservationIncident(
		tx: Transaction,
		input: {
			key: string;
			kind: "gpu-occupancy-conflict" | "cpu-pressure";
			resourceId: string;
			context: Record<string, unknown> | null;
		},
	): Promise<void> {
		const current = await one(
			tx,
			"SELECT * FROM host_incidents WHERE incident_key=?",
			[input.key],
		);
		const now = this.now();
		if (input.context) {
			const wasOpen = current && text(current.state) === "open";
			const contextJson = json(input.context);
			await execute(
				tx,
				`INSERT INTO host_incidents(incident_key,kind,resource_id,state,opened_at,updated_at,resolved_at,context_json)
				 VALUES(?,?,?,'open',?,?,NULL,?)
				 ON CONFLICT(incident_key) DO UPDATE SET state='open',
				 opened_at=CASE WHEN host_incidents.state='resolved' THEN excluded.opened_at ELSE host_incidents.opened_at END,
				 updated_at=excluded.updated_at,resolved_at=NULL,context_json=excluded.context_json`,
				[input.key, input.kind, input.resourceId, now, now, contextJson],
			);
			if (!wasOpen) {
				await this.audit(tx, {
					eventKey: `incident:${input.key}:open:${now}`,
					action: "incident.opened",
					actor: "host-policy",
					projectId: null,
					waiterId: null,
					leaseId: null,
					fence: null,
					detail: input.context,
				});
			}
			return;
		}
		if (!current || text(current.state) !== "open") return;
		await execute(
			tx,
			"UPDATE host_incidents SET state='resolved',updated_at=?,resolved_at=? WHERE incident_key=?",
			[now, now, input.key],
		);
		await this.audit(tx, {
			eventKey: `incident:${input.key}:resolved:${now}`,
			action: "incident.resolved",
			actor: "host-policy",
			projectId: null,
			waiterId: null,
			leaseId: null,
			fence: null,
			detail: { reason: "observed conflict recovered" },
		});
	}

	private async reconcileObservationIncidents(tx: Transaction): Promise<void> {
		const definitions = (
			await execute(
				tx,
				"SELECT * FROM resource_definitions WHERE observation_kind IN ('linux-cpu','amd-gpu','nvidia-gpu') ORDER BY id",
			)
		).rows.map(definitionFrom);
		for (const definition of definitions) {
			const leases = await this.liveAllocationRows(tx, definition.id);
			const leaseIds = leases.map((row) => text(row.id));
			if (definition.observationKind === "linux-cpu") {
				const key = `cpu-pressure:${definition.id}`;
				if (leaseIds.length === 0) {
					await this.setObservationIncident(tx, {
						key,
						kind: "cpu-pressure",
						resourceId: definition.id,
						context: null,
					});
					continue;
				}
				const observed = await this.cpuObservation(tx, definition);
				if (!observed.ok || observed.value.ignored) continue;
				await this.setObservationIncident(tx, {
					key,
					kind: "cpu-pressure",
					resourceId: definition.id,
					context:
						observed.value.blocked && observed.value.pressure
							? {
									reason: "cpu-pressure",
									observation: observed.value.diagnostic,
									leaseIds,
									cpuPressure: observed.value.pressure,
								}
							: null,
				});
				continue;
			}

			const key = `gpu-occupancy-conflict:${definition.id}`;
			if (leaseIds.length === 0) {
				await this.setObservationIncident(tx, {
					key,
					kind: "gpu-occupancy-conflict",
					resourceId: definition.id,
					context: null,
				});
				continue;
			}
			if (definition.ignoreObservation) continue;
			const bindingIds = new Set(
				leases
					.map((row) =>
						typeof row.binding_id === "string" ? row.binding_id : null,
					)
					.filter((id): id is string => id !== null),
			);
			const bindings = (
				await execute(
					tx,
					"SELECT * FROM resource_bindings WHERE resource_id=? AND enabled=1 ORDER BY id",
					[definition.id],
				)
			).rows.map(bindingFrom);
			const evaluated = await Promise.all(
				bindings
					.filter((binding) => bindingIds.has(binding.id))
					.map((binding) =>
						this.gpuBindingObservation(tx, definition, binding, leases),
					),
			);
			if (evaluated.some((result) => !result.ok)) continue;
			const conflicts = evaluated.filter(
				(result) => result.ok && !result.available,
			);
			const first = conflicts[0];
			await this.setObservationIncident(tx, {
				key,
				kind: "gpu-occupancy-conflict",
				resourceId: definition.id,
				context:
					first?.ok && first.reason
						? {
								reason: first.reason,
								observation: first.observation,
								leaseIds,
								gpuOccupancy: conflicts
									.map((result) => result.diagnostic)
									.filter(
										(item): item is GpuOccupancyDiagnostic => item !== null,
									),
							}
						: null,
			});
		}
	}

	async recordObservation(sample: StoredObservation): Promise<void> {
		await this.withWrite(async (tx) => {
			const current = await one(
				tx,
				"SELECT sequence,process_boot_id FROM observations WHERE binding_id=?",
				[sample.bindingId],
			);
			if (
				current &&
				text(current.process_boot_id) === sample.processBootId &&
				big(current.sequence) >= sample.sequence
			)
				return;
			await execute(
				tx,
				`INSERT INTO observations(binding_id,kind,sequence,result,observed_at,duration_ms,process_boot_id,kernel_boot_id,adapter_version,metrics_json,occupants_json,warnings_json)
				 VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
				 ON CONFLICT(binding_id) DO UPDATE SET kind=excluded.kind,sequence=excluded.sequence,
				 result=excluded.result,observed_at=excluded.observed_at,duration_ms=excluded.duration_ms,
				 process_boot_id=excluded.process_boot_id,kernel_boot_id=excluded.kernel_boot_id,
				 adapter_version=excluded.adapter_version,metrics_json=excluded.metrics_json,
				 occupants_json=excluded.occupants_json,warnings_json=excluded.warnings_json`,
				[
					sample.bindingId,
					sample.kind,
					sample.sequence,
					sample.result,
					sample.observedAt,
					sample.durationMs,
					sample.processBootId,
					sample.kernelBootId,
					sample.adapterVersion ?? null,
					json(sample.metrics),
					json(sample.occupants),
					json(sample.warnings),
				],
			);
			await this.reconcileRamIncidents(tx);
			await this.reconcileObservationIncidents(tx);
			await this.bumpGeneration(tx);
			await this.audit(tx, {
				eventKey: `observation:${sample.bindingId}:${sample.processBootId}:${sample.sequence}`,
				action: "observation.recorded",
				actor: "observation-service",
				projectId: null,
				waiterId: null,
				leaseId: null,
				fence: null,
				detail: { result: sample.result, kind: sample.kind },
			});
		});
	}

	async recordObservationHealth(health: ObservationHealth): Promise<void> {
		await this.withWrite(async (tx) => {
			await execute(
				tx,
				`INSERT INTO observation_health(kind,result,checked_at,process_boot_id,kernel_boot_id,detail_json)
				 VALUES(?,?,?,?,?,?) ON CONFLICT(kind) DO UPDATE SET result=excluded.result,
				 checked_at=excluded.checked_at,process_boot_id=excluded.process_boot_id,
				 kernel_boot_id=excluded.kernel_boot_id,detail_json=excluded.detail_json`,
				[
					health.kind,
					health.result,
					health.checkedAt,
					health.processBootId,
					health.kernelBootId,
					json(health.detail),
				],
			);
			await this.reconcileRamIncidents(tx);
			await this.reconcileObservationIncidents(tx);
			await this.bumpGeneration(tx);
			await this.audit(tx, {
				eventKey: `observation-health:${health.kind}:${health.checkedAt}:${randomUUID()}`,
				action: "observation.health",
				actor: "observation-service",
				projectId: null,
				waiterId: null,
				leaseId: null,
				fence: null,
				detail: { result: health.result },
			});
		});
	}

	/** Persist one adapter's health and binding samples in one transaction, so readers never see a mix of snapshots. */
	async recordObservationBatch(
		health: ObservationHealth,
		samples: readonly StoredObservation[],
	): Promise<{ meaningfulChange: boolean }> {
		return this.withWrite(async (tx) => {
			let meaningfulChange = false;
			const detailJson = json(health.detail);
			const generation = healthGeneration(detailJson);
			if (
				!generation ||
				generation.processBootId !== health.processBootId ||
				generation.kernelBootId !== health.kernelBootId
			) {
				throw new HostStoreError(
					"observation batch health has an invalid generation envelope",
					"INVALID_REQUEST",
				);
			}
			const previousHealth = await one(
				tx,
				"SELECT * FROM observation_health WHERE kind=?",
				[health.kind],
			);
			const healthExact =
				previousHealth !== null &&
				text(previousHealth.result) === health.result &&
				num(previousHealth.checked_at) === health.checkedAt &&
				text(previousHealth.process_boot_id) === health.processBootId &&
				(previousHealth.kernel_boot_id ?? null) === health.kernelBootId &&
				canonicalJson(parseJson(previousHealth.detail_json, {})) ===
					canonicalJson(health.detail ?? {});
			if (previousHealth) {
				const previousGeneration = healthGeneration(previousHealth.detail_json);
				if (
					previousGeneration?.processBootId === generation.processBootId &&
					previousGeneration.sequence > generation.sequence
				)
					return { meaningfulChange: false };
			}

			const prepared: Array<{
				sample: StoredObservation;
				current: Row | null;
				metricsJson: string;
				occupantsJson: string;
				warningsJson: string;
				exact: boolean;
			}> = [];
			const seenBindings = new Set<string>();
			for (const sample of samples) {
				if (
					sample.kind !== health.kind ||
					sample.sequence !== generation.sequence ||
					sample.result !== health.result ||
					sample.processBootId !== generation.processBootId ||
					sample.kernelBootId !== generation.kernelBootId ||
					seenBindings.has(sample.bindingId)
				) {
					throw new HostStoreError(
						"observation batch contains a duplicate binding or mixed generation",
						"INVALID_REQUEST",
					);
				}
				seenBindings.add(sample.bindingId);
				const current = await one(
					tx,
					"SELECT * FROM observations WHERE binding_id=?",
					[sample.bindingId],
				);
				const metricsJson = json(sample.metrics);
				const occupantsJson = json(sample.occupants);
				const warningsJson = json(sample.warnings);
				const exact =
					current !== null &&
					big(current.sequence) === sample.sequence &&
					text(current.kind) === sample.kind &&
					text(current.result) === sample.result &&
					num(current.observed_at) === sample.observedAt &&
					num(current.duration_ms) === sample.durationMs &&
					text(current.process_boot_id) === sample.processBootId &&
					(current.kernel_boot_id ?? null) === sample.kernelBootId &&
					(current.adapter_version ?? null) ===
						(sample.adapterVersion ?? null) &&
					canonicalJson(parseJson(current.metrics_json, {})) ===
						canonicalJson(sample.metrics) &&
					canonicalJson(parseJson(current.occupants_json, [])) ===
						canonicalJson(sample.occupants) &&
					canonicalJson(parseJson(current.warnings_json, [])) ===
						canonicalJson(sample.warnings);
				if (
					current &&
					text(current.process_boot_id) === sample.processBootId &&
					big(current.sequence) > sample.sequence
				)
					return { meaningfulChange: false };
				if (
					current &&
					text(current.process_boot_id) === sample.processBootId &&
					big(current.sequence) === sample.sequence &&
					!exact
				) {
					throw new HostStoreError(
						`observation sequence conflict for binding '${sample.bindingId}'`,
						"INVALID_REQUEST",
					);
				}
				prepared.push({
					sample,
					current,
					metricsJson,
					occupantsJson,
					warningsJson,
					exact,
				});
			}
			if (
				previousHealth &&
				num(previousHealth.checked_at) === health.checkedAt &&
				healthSequence(previousHealth.detail_json) ===
					generation.sequence.toString() &&
				text(previousHealth.process_boot_id) === generation.processBootId &&
				!healthExact
			) {
				throw new HostStoreError(
					`observation health timestamp conflict for kind '${health.kind}'`,
					"INVALID_REQUEST",
				);
			}
			if (healthExact && prepared.every((item) => item.exact)) {
				return { meaningfulChange: false };
			}

			meaningfulChange =
				!previousHealth ||
				(previousHealth !== null &&
					this.now() - num(previousHealth.checked_at) >
						RAM_OBSERVATION_MAX_AGE_MS) ||
				text(previousHealth.result) !== health.result ||
				text(previousHealth.process_boot_id) !== health.processBootId ||
				(previousHealth.kernel_boot_id ?? null) !== health.kernelBootId ||
				meaningfulHealthJson(previousHealth.detail_json) !==
					meaningfulHealthJson(detailJson);
			await execute(
				tx,
				`INSERT INTO observation_health(kind,result,checked_at,process_boot_id,kernel_boot_id,detail_json)
				 VALUES(?,?,?,?,?,?) ON CONFLICT(kind) DO UPDATE SET result=excluded.result,
				 checked_at=excluded.checked_at,process_boot_id=excluded.process_boot_id,
				 kernel_boot_id=excluded.kernel_boot_id,detail_json=excluded.detail_json`,
				[
					health.kind,
					health.result,
					health.checkedAt,
					health.processBootId,
					health.kernelBootId,
					detailJson,
				],
			);

			for (const item of prepared) {
				if (item.exact) continue;
				const { sample, current, metricsJson, occupantsJson, warningsJson } =
					item;
				meaningfulChange ||=
					!current ||
					text(current.kind) !== sample.kind ||
					text(current.result) !== sample.result ||
					text(current.process_boot_id) !== sample.processBootId ||
					(current.kernel_boot_id ?? null) !== sample.kernelBootId ||
					(current.adapter_version ?? null) !==
						(sample.adapterVersion ?? null) ||
					text(current.metrics_json) !== metricsJson ||
					text(current.occupants_json) !== occupantsJson ||
					text(current.warnings_json) !== warningsJson;
				await execute(
					tx,
					`INSERT INTO observations(binding_id,kind,sequence,result,observed_at,duration_ms,process_boot_id,kernel_boot_id,adapter_version,metrics_json,occupants_json,warnings_json)
					 VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
					 ON CONFLICT(binding_id) DO UPDATE SET kind=excluded.kind,sequence=excluded.sequence,
					 result=excluded.result,observed_at=excluded.observed_at,duration_ms=excluded.duration_ms,
					 process_boot_id=excluded.process_boot_id,kernel_boot_id=excluded.kernel_boot_id,
					 adapter_version=excluded.adapter_version,metrics_json=excluded.metrics_json,
					 occupants_json=excluded.occupants_json,warnings_json=excluded.warnings_json`,
					[
						sample.bindingId,
						sample.kind,
						sample.sequence,
						sample.result,
						sample.observedAt,
						sample.durationMs,
						sample.processBootId,
						sample.kernelBootId,
						sample.adapterVersion ?? null,
						metricsJson,
						occupantsJson,
						warningsJson,
					],
				);
			}
			await this.reconcileRamIncidents(tx);
			await this.reconcileObservationIncidents(tx);
			await this.bumpGeneration(tx);
			const batchHash = createHash("sha256")
				.update(
					canonicalJson({
						health,
						samples: [...samples]
							.sort((a, b) => a.bindingId.localeCompare(b.bindingId))
							.map((sample) => ({
								...sample,
								sequence: sample.sequence.toString(),
							})),
					}),
				)
				.digest("hex");
			if (meaningfulChange) {
				await this.audit(tx, {
					eventKey: `observation-batch:${batchHash}`,
					action: "observation.batch",
					actor: "observation-service",
					projectId: null,
					waiterId: null,
					leaseId: null,
					fence: null,
					detail: {
						kind: health.kind,
						result: health.result,
						samples: samples.length,
					},
				});
			}
			return { meaningfulChange };
		});
	}

	async auditEntries(
		input: { after?: bigint; limit?: number } = {},
	): Promise<HostAuditEntry[]> {
		const limit = Math.max(1, Math.min(input.limit ?? 200, 1_000));
		const result =
			input.after === undefined
				? await execute(
						this.client,
						"SELECT * FROM audit ORDER BY seq DESC LIMIT ?",
						[limit],
					)
				: await execute(
						this.client,
						"SELECT * FROM audit WHERE seq>? ORDER BY seq LIMIT ?",
						[input.after, limit],
					);
		const rows =
			input.after === undefined ? result.rows.reverse() : result.rows;
		return rows.map((row) => ({
			seq: big(row.seq),
			at: num(row.at_ms),
			eventKey: text(row.event_key),
			action: text(row.action),
			actor: text(row.actor),
			projectId: typeof row.project_id === "string" ? row.project_id : null,
			waiterId: typeof row.waiter_id === "string" ? row.waiter_id : null,
			leaseId: typeof row.lease_id === "string" ? row.lease_id : null,
			fence: row.fence == null ? null : big(row.fence),
			detail: parseJson(row.detail_json, {}),
		}));
	}

	async readModel(): Promise<HostResourceReadModel> {
		const tx = await this.client.transaction("read");
		try {
			const model = await this.readModelFrom(tx);
			await tx.commit();
			return model;
		} catch (error) {
			if (!tx.closed) await tx.rollback().catch(() => {});
			throw error;
		} finally {
			tx.close();
		}
	}

	private async readModelFrom(
		target: Client | Transaction,
	): Promise<HostResourceReadModel> {
		const [
			meta,
			defRows,
			bindingRows,
			waiterRows,
			leaseRows,
			observationRows,
			healthRows,
			incidentRows,
			holdRows,
		] = await Promise.all([
			one(target, "SELECT * FROM host_meta WHERE singleton=1"),
			execute(target, "SELECT * FROM resource_definitions ORDER BY id"),
			execute(
				target,
				"SELECT * FROM resource_bindings ORDER BY resource_id,id",
			),
			execute(target, "SELECT * FROM waiters ORDER BY sequence"),
			execute(target, "SELECT * FROM leases ORDER BY granted_at,id"),
			execute(target, "SELECT * FROM observations ORDER BY binding_id"),
			execute(target, "SELECT * FROM observation_health ORDER BY kind"),
			execute(target, "SELECT * FROM host_incidents ORDER BY incident_key"),
			execute(target, "SELECT * FROM host_resource_holds ORDER BY resource_id"),
		]);
		if (!meta) throw new HostStoreError("host metadata is missing", "CORRUPT");
		const definitions = defRows.rows.map(definitionFrom);
		const effectiveCapacities = await this.effectiveCapacities(
			target,
			definitions,
		);
		return {
			hostId: text(meta.host_id),
			coordinatorId: text(meta.coordinator_id),
			kernelBootId:
				typeof meta.kernel_boot_id === "string" ? meta.kernel_boot_id : null,
			processBootId: text(meta.process_boot_id),
			generation: big(meta.generation),
			definitions,
			bindings: bindingRows.rows.map(bindingFrom),
			waiters: await Promise.all(
				waiterRows.rows.map((row) => this.waiterByRow(target, row)),
			),
			leases: await Promise.all(
				leaseRows.rows.map(async (row) =>
					leaseFrom(row, await this.allocations(target, text(row.id))),
				),
			),
			observations: observationRows.rows.map(observationFrom),
			health: healthRows.rows.map((row) => ({
				kind: text(row.kind),
				result: text(row.result) as ObservationHealth["result"],
				checkedAt: num(row.checked_at),
				processBootId: text(row.process_boot_id),
				kernelBootId:
					typeof row.kernel_boot_id === "string" ? row.kernel_boot_id : null,
				detail: parseJson(row.detail_json, {}),
			})),
			effectiveCapacities,
			incidents: incidentRows.rows.map(incidentFrom),
			holds: holdRows.rows.map(resourceHoldFrom),
			occupants: effectiveCapacities.flatMap((capacity) =>
				capacity.gpuOccupancy.map((occupancy) => {
					// Clone: shared nested arrays get aliased/corrupted when the read model is cloned on some Bun releases.
					const independent = structuredClone(occupancy);
					return { ...independent, resourceId: capacity.resourceId };
				}),
			),
		};
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.client.close();
	}
}

export async function openHostResourceStore(
	mfwHome: string,
	options: OpenHostStoreOptions,
): Promise<HostResourceStore> {
	const path = join(mfwHome, "host", "host.db");
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const timeout = options.busyTimeoutMs ?? 2_000;
	const sqliteBusySliceMs = Math.max(1, Math.min(25, timeout));
	const client = createClient({
		url: `file:${path}`,
		intMode: "bigint",
		timeout: sqliteBusySliceMs,
	});
	try {
		await retryBusy(
			() =>
				client.executeMultiple(
					`PRAGMA journal_mode=WAL;
			 PRAGMA synchronous=FULL;
			 PRAGMA foreign_keys=ON;
			 PRAGMA busy_timeout=${sqliteBusySliceMs};`,
				),
			timeout,
		);
		const integrity = await one(client, "PRAGMA integrity_check");
		if (integrity?.[0] !== "ok") {
			throw new HostStoreError(
				"host store failed SQLite integrity_check",
				"CORRUPT",
			);
		}
		const versionRow = await one(client, "PRAGMA user_version");
		let version = Number(
			big(versionRow?.user_version ?? versionRow?.[0] ?? 0n),
		);
		if (version > HOST_SCHEMA_VERSION) {
			throw new HostStoreError(
				`host store schema ${version} is newer than supported ${HOST_SCHEMA_VERSION}; downgrade is refused`,
				"INCOMPATIBLE_SCHEMA",
			);
		}
		for (const migration of HOST_MIGRATIONS) {
			if (migration.version <= version) continue;
			const tx = await client.transaction("write");
			try {
				await tx.executeMultiple(migration.sql);
				await execute(
					tx,
					"INSERT INTO host_schema_migrations(version,applied_at) VALUES(?,?)",
					[migration.version, (options.now ?? Date.now)()],
				);
				await tx.executeMultiple(`PRAGMA user_version=${migration.version};`);
				await tx.commit();
				version = migration.version;
			} catch (error) {
				if (!tx.closed) await tx.rollback().catch(() => {});
				throw error;
			} finally {
				tx.close();
			}
		}
		if (version !== HOST_SCHEMA_VERSION) {
			throw new HostStoreError(
				`host schema migration stopped at ${version}`,
				"INCOMPATIBLE_SCHEMA",
			);
		}
		const tables = new Set(
			(
				await execute(
					client,
					"SELECT name FROM sqlite_master WHERE type='table'",
				)
			).rows.map((row) => text(row.name)),
		);
		for (const required of REQUIRED_HOST_TABLES) {
			if (!tables.has(required)) {
				throw new HostStoreError(
					`host store is missing required table '${required}'`,
					"CORRUPT",
				);
			}
		}
		for (const [table, requiredColumns] of Object.entries(
			REQUIRED_HOST_COLUMNS,
		)) {
			const actual = new Set(
				(await execute(client, `PRAGMA table_info(${table})`)).rows.map((row) =>
					text(row.name),
				),
			);
			for (const column of requiredColumns) {
				if (!actual.has(column)) {
					throw new HostStoreError(
						`host store table '${table}' is missing required column '${column}'`,
						"CORRUPT",
					);
				}
			}
		}
		const migrationRow = await one(
			client,
			"SELECT MAX(version) AS version FROM host_schema_migrations",
		);
		if (Number(big(migrationRow?.version ?? 0n)) !== HOST_SCHEMA_VERSION) {
			throw new HostStoreError(
				"host schema migration journal disagrees with user_version",
				"CORRUPT",
			);
		}

		const now = (options.now ?? Date.now)();
		const meta = await retryBusy(async () => {
			let current = await one(
				client,
				"SELECT * FROM host_meta WHERE singleton=1",
			);
			if (!current) {
				const hostId = randomUUID();
				await execute(
					client,
					`INSERT INTO host_meta(singleton,host_id,coordinator_id,kernel_boot_id,process_boot_id,generation,next_fence,created_at,updated_at)
				 VALUES(1,?,?,?,?,0,1,?,?)`,
					[
						hostId,
						randomUUID(),
						options.kernelBootId,
						options.processBootId,
						now,
						now,
					],
				);
				current = await one(
					client,
					"SELECT * FROM host_meta WHERE singleton=1",
				);
			} else {
				await execute(
					client,
					"UPDATE host_meta SET kernel_boot_id=?,process_boot_id=?,updated_at=? WHERE singleton=1",
					[options.kernelBootId, options.processBootId, now],
				);
				current = await one(
					client,
					"SELECT * FROM host_meta WHERE singleton=1",
				);
			}
			return current;
		}, timeout);
		if (!meta)
			throw new HostStoreError("could not initialize host identity", "CORRUPT");
		return new HostResourceStore(
			client,
			path,
			{
				hostId: text(meta.host_id),
				coordinatorId: text(meta.coordinator_id),
				kernelBootId:
					typeof meta.kernel_boot_id === "string" ? meta.kernel_boot_id : null,
				processBootId: text(meta.process_boot_id),
				generation: big(meta.generation),
			},
			options.now,
			timeout,
		);
	} catch (error) {
		client.close();
		if (error instanceof HostStoreError) throw error;
		throw new HostStoreError(
			`cannot open host store ${path}: ${error instanceof Error ? error.message : String(error)}`,
			/busy|locked/i.test(String(error)) ? "BUSY" : "CORRUPT",
		);
	}
}
