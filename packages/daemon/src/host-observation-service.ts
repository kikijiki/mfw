import type {
	GpuDeviceObservation,
	HostObservation,
	HostProbeKind,
	ProbeBinding,
	ProbeDiagnostic,
} from "@mfw/core/host-observation";
import type { ProbeClock, ProbeTimer } from "./host-probe-runtime.ts";
import type { AnyHostProbeAdapter } from "./host-probes.ts";
import type { HostResourceStore } from "./host-resources/store.ts";
import type {
	HostResourceBinding,
	ObservationHealth,
	StoredObservation,
} from "./host-resources/types.ts";
import type { Logger } from "./log.ts";

export interface HostObservationServiceOptions {
	adapters?: readonly AnyHostProbeAdapter[];
	clock?: ProbeClock;
	timer?: ProbeTimer;
	log?: Logger;
	pollIntervalMs?: number;
	maxBackoffMs?: number;
	pollTimeoutMs?: number;
	jitterFraction?: number;
	diagnosticRateLimitMs?: number;
}

const systemClock: ProbeClock = {
	now: () => Date.now(),
	monotonicNow: () => performance.now(),
	random: () => Math.random(),
};

const systemTimer: ProbeTimer = {
	set: (callback, delayMs) => setTimeout(callback, delayMs),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function jsonSafe(value: unknown): unknown {
	if (typeof value === "bigint") return value.toString();
	if (Array.isArray(value)) return value.map(jsonSafe);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, nested]) => [key, jsonSafe(nested)]),
		);
	}
	return value;
}

function diagnosticDetail(diagnostics: readonly ProbeDiagnostic[]): unknown[] {
	return diagnostics.map((item) => ({
		code: item.code,
		severity: item.severity,
		admissionEffect: item.admissionEffect,
		field: item.field ?? null,
		message: item.message,
	}));
}

function isGpuValue(value: unknown): value is GpuDeviceObservation[] {
	return (
		Array.isArray(value) &&
		value.every(
			(item) =>
				item !== null &&
				typeof item === "object" &&
				"identity" in item &&
				"occupancy" in item,
		)
	);
}

function bindingMatchesDevice(
	binding: ProbeBinding,
	device: GpuDeviceObservation,
): boolean {
	const identity = device.identity;
	const key = binding.deviceKey;
	const deviceMatches =
		!key ||
		key === identity.key ||
		key === identity.uuid ||
		key === identity.pciAddress ||
		key === `${identity.pciAddress}/${identity.uuid}`;
	return (
		deviceMatches &&
		(!binding.partitionKey ||
			binding.partitionKey === identity.partition?.id ||
			binding.partitionKey === identity.partition?.uuid)
	);
}

function probeBindings(
	kind: HostProbeKind,
	bindings: readonly HostResourceBinding[],
	definitionKinds: ReadonlyMap<string, string | null | undefined>,
): ProbeBinding[] {
	return bindings
		.filter((binding) => {
			const metadataKind = binding.metadata?.observationKind;
			return (
				metadataKind === kind ||
				definitionKinds.get(binding.resourceId) === kind
			);
		})
		.map((binding) => ({
			id: binding.id,
			deviceKey: binding.stableKey,
			...(typeof binding.metadata?.partitionKey === "string"
				? { partitionKey: binding.metadata.partitionKey }
				: {}),
		}));
}

/**
 * The one process-global polling loop. It owns no capacity, reservation, or
 * admission logic; it only captures coherent facts and persists them.
 */
export class HostObservationService {
	private readonly adapters: readonly AnyHostProbeAdapter[];
	private readonly clock: ProbeClock;
	private readonly timer: ProbeTimer;
	private readonly pollIntervalMs: number;
	private readonly maxBackoffMs: number;
	private readonly pollTimeoutMs: number;
	private readonly jitterFraction: number;
	private readonly diagnosticRateLimitMs: number;
	private readonly discovered = new Set<HostProbeKind>();
	private readonly diagnosticTimes = new Map<string, number>();
	private inFlight: Promise<readonly HostProbeKind[]> | null = null;
	private activeAbort: AbortController | null = null;
	private scheduled: unknown = null;
	private running = false;
	private consecutiveFailures = 0;

	constructor(
		private readonly store: HostResourceStore,
		private readonly onPersisted: (meaningfulChange: boolean) => Promise<void>,
		private readonly options: HostObservationServiceOptions = {},
	) {
		this.adapters = options.adapters ?? [];
		this.clock = options.clock ?? systemClock;
		this.timer = options.timer ?? systemTimer;
		this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
		this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
		this.pollTimeoutMs = options.pollTimeoutMs ?? 8_000;
		this.jitterFraction = options.jitterFraction ?? 0.1;
		this.diagnosticRateLimitMs = options.diagnosticRateLimitMs ?? 60_000;
	}

	get isRunning(): boolean {
		return this.running;
	}

	private logDiagnostics(
		kind: HostProbeKind,
		status: string,
		diagnostics: readonly ProbeDiagnostic[],
	): void {
		if (diagnostics.length === 0 || !this.options.log) return;
		const signature = `${kind}:${status}:${diagnostics
			.map((item) => item.code)
			.sort()
			.join(",")}`;
		const now = this.clock.now();
		const previous = this.diagnosticTimes.get(signature);
		if (
			previous !== undefined &&
			now - previous >= 0 &&
			now - previous < this.diagnosticRateLimitMs
		)
			return;
		this.diagnosticTimes.set(signature, now);
		this.options.log.warn(
			{
				kind,
				status,
				diagnostics: diagnostics.map((item) => item.code),
			},
			"host probe observation is not healthy",
		);
	}

	private async persist(
		observation: HostObservation<unknown>,
		bindings: readonly ProbeBinding[],
	): Promise<boolean> {
		const result = observation.result;
		const checkedAt = Date.parse(observation.freshness.checkedAt);
		const value =
			result.status === "ok" || result.status === "degraded"
				? result.value
				: null;
		const health: ObservationHealth = {
			kind: observation.kind,
			result: result.status,
			checkedAt: Number.isFinite(checkedAt) ? checkedAt : this.clock.now(),
			processBootId: observation.generation.processBootId,
			kernelBootId: observation.generation.kernelBootId,
			detail: jsonSafe({
				adapterVersion: observation.adapterVersion,
				tool: observation.tool,
				generation: {
					...observation.generation,
					sequence: observation.generation.sequence.toString(),
				},
				freshness: observation.freshness,
				diagnostics: diagnosticDetail(result.diagnostics),
				latest: value,
			}) as Record<string, unknown>,
		};
		const warnings = result.diagnostics.map(
			(item) => `${item.code}:${item.message}`,
		);
		const observedAt = Date.parse(observation.observedAt);
		const samples: StoredObservation[] = bindings.map((binding) => {
			let metrics: Record<string, unknown> = {};
			let occupants: unknown[] = [];
			if (value !== null) {
				if (isGpuValue(value)) {
					const device = value.find((candidate) =>
						bindingMatchesDevice(binding, candidate),
					);
					if (device) {
						const safe = jsonSafe(device) as Record<string, unknown>;
						metrics = {
							identity: safe.identity,
							gpuUtilization: safe.gpuUtilization,
							memoryUsedBytes: safe.memoryUsedBytes,
							memoryTotalBytes: safe.memoryTotalBytes,
							temperatureCelsius: safe.temperatureCelsius,
							powerWatts: safe.powerWatts,
							occupancy: {
								state: device.occupancy.state,
								blocksExclusiveAdmission:
									device.occupancy.blocksExclusiveAdmission,
								deviceEvidence: jsonSafe(device.occupancy.deviceEvidence),
							},
						};
						occupants = jsonSafe(device.occupancy.occupants) as unknown[];
					}
				} else {
					metrics = jsonSafe(value) as Record<string, unknown>;
				}
			}
			return {
				bindingId: binding.id,
				kind: observation.kind,
				sequence: observation.generation.sequence,
				result: result.status,
				processBootId: observation.generation.processBootId,
				kernelBootId: observation.generation.kernelBootId,
				observedAt: Number.isFinite(observedAt) ? observedAt : this.clock.now(),
				durationMs: observation.durationMs,
				metrics,
				occupants,
				warnings,
				adapterVersion: observation.adapterVersion,
			};
		});
		const persisted = await this.store.recordObservationBatch(health, samples);
		await this.onPersisted(persisted.meaningfulChange);
		this.logDiagnostics(observation.kind, result.status, result.diagnostics);
		return result.status === "error" || result.status === "unsupported";
	}

	private async pollAdapter(
		adapter: AnyHostProbeAdapter,
		bindings: readonly ProbeBinding[],
		signal: AbortSignal,
	): Promise<boolean> {
		if (!this.discovered.has(adapter.kind)) {
			const discovery = await adapter.discover(signal);
			const succeeded =
				discovery.result.status === "ok" ||
				discovery.result.status === "degraded";
			if (succeeded) this.discovered.add(adapter.kind);
			// Discovery supplies the unconfigured hardware inventory. Once bindings
			// exist, publishing successful discovery as adapter health without the
			// matching binding samples would briefly split one logical generation.
			// Failed discovery is persisted against every binding so policy sees a
			// coherent current-process failure rather than stale prior-process data.
			if (bindings.length === 0 || !succeeded) {
				const failed = await this.persist(discovery, succeeded ? [] : bindings);
				if (failed) return true;
			}
		}
		const sample = await adapter.sample(bindings, signal);
		return this.persist(sample, bindings);
	}

	private async poll(): Promise<readonly HostProbeKind[]> {
		if (this.adapters.length === 0) return [];
		const model = await this.store.readModel();
		const definitionKinds = new Map(
			model.definitions.map((definition) => [
				definition.id,
				definition.observationKind,
			]),
		);
		const controller = new AbortController();
		this.activeAbort = controller;
		const timeout = this.timer.set(
			() => controller.abort("host probe poll deadline"),
			this.pollTimeoutMs,
		);
		try {
			const outcomes = await Promise.all(
				this.adapters.map(async (adapter) => {
					const bindings = probeBindings(
						adapter.kind,
						model.bindings,
						definitionKinds,
					);
					try {
						return await this.pollAdapter(adapter, bindings, controller.signal);
					} catch (error) {
						const checkedAt = this.clock.now();
						const health: ObservationHealth = {
							kind: adapter.kind,
							result: "error",
							checkedAt,
							processBootId: this.store.identity.processBootId,
							kernelBootId: this.store.identity.kernelBootId,
							detail: {
								diagnostics: [
									{
										code: controller.signal.aborted
											? "probe-timeout"
											: "execution-failed",
										message:
											error instanceof Error
												? error.message.slice(0, 500)
												: "probe threw a non-error value",
									},
								],
							},
						};
						// An exception escaped before the adapter could create an
						// ObservationGeneration, so this is health-only evidence rather
						// than a sample batch. The next successful generated batch remains
						// free to recover it.
						await this.store.recordObservationHealth(health);
						await this.onPersisted(true);
						this.options.log?.warn(
							{ err: error, kind: adapter.kind },
							"host probe adapter failed without escaping the poll loop",
						);
						return true;
					}
				}),
			);
			this.consecutiveFailures = outcomes.some(Boolean)
				? Math.min(this.consecutiveFailures + 1, 20)
				: 0;
		} finally {
			this.timer.clear(timeout);
			if (this.activeAbort === controller) this.activeAbort = null;
		}
		return this.adapters.map((adapter) => adapter.kind);
	}

	/** Manual refreshes and timer refreshes coalesce with the in-flight poll. */
	refresh(): Promise<readonly HostProbeKind[]>;
	refresh(run: () => Promise<void>): Promise<readonly HostProbeKind[]>;
	refresh(
		run: () => Promise<readonly HostProbeKind[]>,
	): Promise<readonly HostProbeKind[]>;
	refresh(run?: () => Promise<unknown>): Promise<readonly HostProbeKind[]> {
		if (this.inFlight) return this.inFlight;
		const execute = run
			? async () => {
					const result = await run();
					return Array.isArray(result)
						? (result as readonly HostProbeKind[])
						: [];
				}
			: () => this.poll();
		this.inFlight = execute().finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	private nextDelay(): number {
		const exponential = Math.min(
			this.maxBackoffMs,
			this.pollIntervalMs * 2 ** this.consecutiveFailures,
		);
		const jitter =
			exponential * this.jitterFraction * (this.clock.random() * 2 - 1);
		return Math.max(1, Math.round(exponential + jitter));
	}

	private schedule(): void {
		if (!this.running || this.scheduled !== null) return;
		this.scheduled = this.timer.set(() => {
			this.scheduled = null;
			void this.refresh()
				.catch((error) => {
					this.options.log?.warn(
						{ err: error },
						"host observation poll failed",
					);
				})
				.finally(() => this.schedule());
		}, this.nextDelay());
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			await this.refresh();
		} finally {
			this.schedule();
		}
	}

	async stop(): Promise<void> {
		this.running = false;
		if (this.scheduled !== null) {
			this.timer.clear(this.scheduled);
			this.scheduled = null;
		}
		this.activeAbort?.abort("host observation service stopping");
		await this.inFlight?.catch(() => {});
	}

	async recordSample(sample: StoredObservation): Promise<void> {
		await this.store.recordObservation(sample);
		await this.onPersisted(true);
	}

	async recordHealth(health: ObservationHealth): Promise<void> {
		await this.store.recordObservationHealth(health);
		await this.onPersisted(true);
	}
}
