import type { HostProbeKind } from "@mfw/core/host-observation";
import type { HostServices } from "../../../plugin-api/src/common.ts";
import {
	HostObservationService,
	type HostObservationServiceOptions,
} from "../host-observation-service.ts";
import { ProviderHoldStore } from "../provider-holds.ts";
import {
	isConclusiveGpuFact,
	type LocalHostFacts,
	LocalHostResource,
} from "./builtin/local-host.ts";
import { projectPoolId } from "./claims.ts";
import type { ResourceCoordinator } from "./coordinator.ts";
import type { GpuProcessOwner } from "./gpu-diagnostics.ts";
import {
	assertValidDefinition,
	claimOf,
	dimensionNameOf,
	dimensionOf,
	poolIdOf,
	unitOf,
} from "./host-definitions.ts";
import {
	type GpuUnitBinding,
	HostFacts,
	type KindedProbeBinding,
} from "./host-facts.ts";
import type {
	CpuPressureDiagnostic,
	GpuOccupancyDiagnostic,
	HostCapacityHoldReason,
	HostEffectiveCapacity,
	HostHoldDiagnostic,
	HostLease,
	HostResourceBinding,
	HostResourceDefinition,
	HostResourceHold,
	HostResourceIncident,
	HostResourceReadModel,
	LeaseAllocation,
	ObservationAdmissionDiagnostic,
	ProjectIdentity,
	Waiter,
} from "./host-types.ts";
import {
	evaluateRamFormula,
	parseIecBytes,
	parseIntegerQuantity,
	QuantityParseError,
	RAM_OBSERVATION_MAX_AGE_MS,
} from "./quantity.ts";
import type { ResourceStore } from "./store.ts";
import {
	type Blocker,
	type Claim,
	type HoldReason,
	LIVE_LEASE_STATES,
	type PoolIncident,
	type PoolSummary,
	ResourceError,
	type ResourceLease,
	type ResourceWaiter,
} from "./types.ts";

const MIB = 1024n * 1024n;

function encode(value: unknown): string {
	return JSON.stringify(value, (_key, item) =>
		typeof item === "bigint" ? { $bigint: item.toString() } : item,
	);
}

function decode<T>(json: string): T {
	return JSON.parse(json, (_key, item) =>
		item && typeof item === "object" && typeof item.$bigint === "string"
			? BigInt(item.$bigint)
			: item,
	) as T;
}

/** PID-reuse-safe identities of the processes a lease's run launched. */
function processKeys(lease: ResourceLease): string[] {
	const run = lease.run;
	if (!run) return [];
	const keys = (run.processTree ?? []).map(
		(p) => `${p.pid}:${p.processStartTime}`,
	);
	if (run.pid != null && run.processStartTime) {
		keys.push(`${run.pid}:${run.processStartTime}`);
	}
	return keys;
}

/**
 * A deep copy of the read model. `structuredClone` scrambled values here when
 * BigInts sat beside objects shared between capacities, holds and occupants.
 */
function copyModel<T>(value: T): T {
	if (Array.isArray(value)) return value.map(copyModel) as T;
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, copyModel(item)]),
		) as T;
	}
	return value;
}

function cpuPressureOf(
	definition: HostResourceDefinition,
	cpu: LocalHostFacts["cpu"],
): CpuPressureDiagnostic | null {
	if (!cpu) return null;
	const maxBusyFraction = definition.cpuPressure?.maxBusyFraction ?? null;
	const maxRunnableProcesses =
		definition.cpuPressure?.maxRunnableProcesses ?? null;
	return {
		configuredPermits: definition.capacity,
		busyFraction: cpu.busyFraction,
		runnableProcesses: cpu.runnableProcesses,
		maxBusyFraction,
		maxRunnableProcesses,
		busyBlocked: maxBusyFraction !== null && cpu.busyFraction > maxBusyFraction,
		runnableBlocked:
			maxRunnableProcesses !== null &&
			cpu.runnableProcesses > maxRunnableProcesses,
	};
}

/** Reasons read from probes rather than from a hold someone placed. */
const OBSERVED_HOLD: ReadonlySet<string> = new Set([
	"observation-missing",
	"observation-ambiguous",
	"observation-not-current-process",
	"observation-not-current-kernel",
	"observation-stale",
	"observation-failed",
	"observation-inconsistent",
	"cpu-pressure",
	"external-occupancy",
	"unknown-occupancy",
	"headroom-exhausted",
]);

/** The device a GPU hold is about: the first one actually blocking. */
function blockingDevice(
	capacity: HostEffectiveCapacity,
): GpuOccupancyDiagnostic | null {
	return (
		capacity.gpuOccupancy.find((item) => item.blocksExclusiveAdmission) ??
		capacity.gpuOccupancy[0] ??
		null
	);
}

/** When a pool carries several holds, the one the owner must act on first. */
const HOLD_PRIORITY: readonly HoldReason[] = [
	"operator",
	"auth",
	"rate_limit",
	"budget",
	"draining",
	"definition",
	"observation-failed",
	"observation-stale",
	"observation-uncertain",
];

function sameContract(
	a: HostResourceDefinition,
	b: HostResourceDefinition,
): boolean {
	return (
		a.accounting === b.accounting &&
		a.provisioning === b.provisioning &&
		a.capacity === b.capacity &&
		(a.quantityUnit ?? null) === (b.quantityUnit ?? null) &&
		(a.safetyHeadroom ?? null) === (b.safetyHeadroom ?? null) &&
		(a.observationKind ?? null) === (b.observationKind ?? null) &&
		(a.ignoreObservation ?? false) === (b.ignoreObservation ?? false) &&
		(a.cpuPressure?.maxBusyFraction ?? null) ===
			(b.cpuPressure?.maxBusyFraction ?? null) &&
		(a.cpuPressure?.maxRunnableProcesses ?? null) ===
			(b.cpuPressure?.maxRunnableProcesses ?? null)
	);
}

export interface WriteOptions {
	expectedVersion?: bigint | null;
	actor?: string;
	reason?: string;
}

export interface HostLedgerOptions {
	store: ResourceStore;
	coordinator: ResourceCoordinator;
	host: HostServices;
	observations?: HostObservationServiceOptions;
}

/**
 * The owner's host resources over the unified core: each definition is a
 * pool, and draining or disabling one is a pool hold. It keeps the operator
 * surface (versions, drain before disable, detection review) that the API and
 * the Resources page use.
 */
export class HostLedger {
	readonly facts: HostFacts;
	readonly observations: HostObservationService;
	readonly providerHolds: ProviderHoldStore;
	private readonly store: ResourceStore;
	readonly coordinator: ResourceCoordinator;
	private definitions: HostResourceDefinition[] = [];
	private bindings: HostResourceBinding[] = [];
	private summaries: PoolSummary[] = [];
	private incidents: PoolIncident[] = [];
	private gpuOwners = new Map<string, Map<string, GpuProcessOwner>>();
	private unitsByLease = new Map<string, Map<string, string[]>>();
	private auditedHolds = new Map<string, HostCapacityHoldReason>();
	private generation = 0;
	private ledgerId = "";

	constructor(private readonly options: HostLedgerOptions) {
		this.store = options.store;
		this.coordinator = options.coordinator;
		this.coordinator.afterRefresh = () => this.refreshLedgerViews();
		this.providerHolds = new ProviderHoldStore(this.store, () =>
			options.host.clock.now(),
		);
		this.facts = new HostFacts(
			{
				processBootId: this.store.processBootId,
				kernelBootId: this.store.kernelBootId,
			},
			() => options.host.clock.now(),
			this.store,
		);
		this.observations = new HostObservationService(
			this.facts,
			async (meaningfulChange) => {
				await this.applyObservations();
				if (meaningfulChange) this.coordinator.wake();
			},
			options.observations,
		);
	}

	get hostId(): string {
		return this.ledgerId;
	}

	get coordinatorId(): string {
		return this.ledgerId;
	}

	async load(): Promise<void> {
		this.ledgerId = await this.store.ensureHostId();
		await this.facts.load();
		await this.refresh();
		await this.syncPools();
		await this.refresh();
	}

	private async refresh(): Promise<void> {
		const rows = await this.store.readHostConfig();
		this.ledgerId = rows.hostId ?? this.ledgerId;
		this.generation = rows.generation;
		this.definitions = rows.definitions.map((d) =>
			decode<HostResourceDefinition>(d),
		);
		this.bindings = rows.bindings.map((b) => decode<HostResourceBinding>(b));
		await this.coordinator.refresh();
	}

	/** The parts of the read model that change with every lease transition. */
	private async refreshLedgerViews(): Promise<void> {
		this.summaries = await this.store.summaries();
		this.incidents = await this.store.incidents();
		await this.loadGpuOwners();
		this.unitsByLease = await this.store.leaseUnits();
	}

	/** One observation pass: pools first, then the incidents they prove. */
	async applyObservations(): Promise<void> {
		await this.coordinator.observeAll();
		await this.refresh();
		await this.reconcileRamIncidents();
		await this.reconcileConflictIncidents();
		this.incidents = await this.store.incidents();
		await this.auditHoldChanges();
	}

	/** One audit entry each time a resource starts or stops being held. */
	private async auditHoldChanges(): Promise<void> {
		// A resource nobody is waiting on is not being refused to anyone yet.
		const wanted = new Set(
			this.coordinator
				.readModel()
				.waiters.filter((w) => w.state === "waiting")
				.flatMap((w) => w.claims.map((c) => c.poolId)),
		);
		const open = new Map(
			this.holdRows(this.definitions.map((d) => this.capacityOf(d)))
				.filter((row) => wanted.has(poolIdOf(row.resourceId)))
				.map((row) => [row.resourceId, row.reason]),
		);
		for (const [resourceId, reason] of open) {
			if (this.auditedHolds.get(resourceId) === reason) continue;
			await this.store.auditHoldTransition(
				poolIdOf(resourceId),
				"resource.hold.opened",
				{ resourceId, reason },
			);
		}
		for (const [resourceId, reason] of this.auditedHolds) {
			if (open.has(resourceId)) continue;
			await this.store.auditHoldTransition(
				poolIdOf(resourceId),
				"resource.hold.resolved",
				{ resourceId, reason },
			);
		}
		this.auditedHolds = open;
	}

	/**
	 * Opens an incident when live promises exceed what the machine can still
	 * give. Missing or ignored evidence changes nothing: it cannot prove recovery.
	 */
	private async reconcileRamIncidents(): Promise<void> {
		const evidence = this.facts.memoryEvidence();
		if (!evidence) return;
		for (const definition of this.definitions) {
			if (definition.quantityUnit !== "bytes") continue;
			if (definition.ignoreObservation) continue;
			if (definition.safetyHeadroom == null) continue;
			const durablePromises = this.promised(definition.id);
			const formula = evaluateRamFormula({
				configuredQuotaBytes: definition.capacity,
				safetyHeadroomBytes: definition.safetyHeadroom,
				memAvailableBytes: evidence.memAvailableBytes,
				durablePromisesBytes: durablePromises,
				attributableManagedBytes: 0n,
				requestBytes: 0n,
			});
			const low = durablePromises > 0n && formula.observedHeadroomBytes < 0n;
			await this.store.setIncident({
				key: `ram-low-headroom:${definition.id}`,
				kind: "ram-low-headroom",
				poolId: poolIdOf(definition.id),
				context: low
					? {
							configuredQuotaBytes: formula.configuredQuotaBytes,
							safetyHeadroomBytes: formula.safetyHeadroomBytes,
							memAvailableBytes: formula.memAvailableBytes,
							durablePromisesBytes: formula.durablePromisesBytes,
							attributableManagedBytes: formula.attributableManagedBytes,
							outstandingPromiseBytes: formula.outstandingPromiseBytes,
							quotaRemainingBytes: formula.quotaRemainingBytes,
							observedHeadroomBytes: formula.observedHeadroomBytes,
							effectiveCapacityBytes: formula.effectiveCapacityBytes,
							observationSequence: evidence.sequence,
						}
					: null,
			});
		}
	}

	/**
	 * CPU pressure or foreign GPU use over live leases. With no lease left the
	 * condition is over; otherwise only conclusive evidence moves the incident.
	 */
	private async reconcileConflictIncidents(): Promise<void> {
		const facts = this.facts.localFacts();
		for (const definition of this.definitions) {
			const kind = definition.observationKind;
			const isCpu = kind === "linux-cpu";
			if (!isCpu && kind !== "amd-gpu" && kind !== "nvidia-gpu") continue;
			const poolId = poolIdOf(definition.id);
			const incidentKind = isCpu ? "cpu-pressure" : "gpu-occupancy-conflict";
			const target = {
				key: `${incidentKind}:${definition.id}`,
				kind: incidentKind,
				poolId,
			} as const;
			const allocations = await this.store.allocations(poolId);
			if (allocations.length === 0) {
				await this.store.setIncident({ ...target, context: null });
				continue;
			}
			if (definition.ignoreObservation) continue;
			const observation = this.facts.diagnosticFor(kind);
			if (!observation) continue;
			const leaseIds = allocations.map(({ lease }) => lease.id);

			if (isCpu) {
				if (!facts.cpu) continue;
				const cpuPressure = cpuPressureOf(definition, facts.cpu);
				await this.store.setIncident({
					...target,
					context:
						cpuPressure?.busyBlocked || cpuPressure?.runnableBlocked
							? {
									reason: "cpu-pressure",
									observation,
									leaseIds,
									cpuPressure,
								}
							: null,
				});
				continue;
			}

			const leasedUnits = new Set(allocations.flatMap((a) => a.units));
			const explained = this.bindingsOf(definition.id)
				.filter((binding) => leasedUnits.has(unitOf(binding.id)))
				.map((binding) => ({
					unit: unitOf(binding.id),
					explanation: this.facts.explainGpu(binding, this.ownersOf(binding)),
					fact: facts.gpus?.find((gpu) => gpu.unit === unitOf(binding.id)),
				}));
			if (
				explained.length < leasedUnits.size ||
				explained.some(
					(item) =>
						!item.explanation || !item.fact || !isConclusiveGpuFact(item.fact),
				)
			) {
				continue;
			}
			const blocked = explained.filter((item) => item.explanation?.reason);
			await this.store.setIncident({
				...target,
				context:
					blocked.length > 0
						? {
								reason: blocked.some(
									(item) => item.explanation?.reason === "unknown-occupancy",
								)
									? "unknown-occupancy"
									: "external-occupancy",
								observation,
								leaseIds,
								blockedUnits: blocked.map((item) => item.unit),
								gpuOccupancy: blocked.flatMap((item) =>
									item.explanation ? [item.explanation.diagnostic] : [],
								),
							}
						: null,
			});
		}
	}

	private ownersOf(binding: HostResourceBinding) {
		return this.gpuOwners.get(unitOf(binding.id)) ?? new Map();
	}

	/** Live GPU leases by unit, so the synchronous read model can attribute. */
	private async loadGpuOwners(): Promise<void> {
		const owners = new Map<string, Map<string, GpuProcessOwner>>();
		for (const definition of this.definitions) {
			if (
				definition.observationKind !== "amd-gpu" &&
				definition.observationKind !== "nvidia-gpu"
			) {
				continue;
			}
			const rows = await this.store.allocations(poolIdOf(definition.id));
			for (const { lease, units } of rows) {
				if (lease.state !== "active" || !lease.run) continue;
				for (const unit of units) {
					const byProcess = owners.get(unit) ?? new Map();
					for (const key of processKeys(lease)) {
						byProcess.set(key, {
							leaseId: lease.id,
							runId: lease.run.runId,
						});
					}
					owners.set(unit, byProcess);
				}
			}
		}
		this.gpuOwners = owners;
	}

	private bindingsOf(resourceId: string): HostResourceBinding[] {
		return this.bindings.filter((b) => b.resourceId === resourceId);
	}

	private pluginFor(definition: HostResourceDefinition) {
		if (!definition.observationKind || definition.ignoreObservation)
			return null;
		const poolId = poolIdOf(definition.id);
		const ledger = async () => {
			const view = this.ledgerView(poolId);
			if (
				definition.observationKind !== "amd-gpu" &&
				definition.observationKind !== "nvidia-gpu"
			) {
				return view;
			}
			return { ...view, managedByUnit: await this.managedByUnit(poolId) };
		};
		// One host-wide reading cannot be attributed to two bindings.
		const ambiguous =
			(definition.observationKind === "linux-memory" ||
				definition.observationKind === "linux-cpu") &&
			this.bindingsOf(definition.id).filter((b) => b.enabled).length > 1;
		const probe = async (): Promise<LocalHostFacts> =>
			ambiguous
				? { cpu: null, memAvailableBytes: null, gpus: null }
				: this.facts.localFacts();
		switch (definition.observationKind) {
			case "linux-cpu":
				return new LocalHostResource({
					config: {
						cpu: {
							permits: Number(definition.capacity),
							...(definition.cpuPressure?.maxBusyFraction === undefined
								? {}
								: { maxBusyFraction: definition.cpuPressure.maxBusyFraction }),
							...(definition.cpuPressure?.maxRunnableProcesses === undefined
								? {}
								: {
										maxRunnableProcesses:
											definition.cpuPressure.maxRunnableProcesses,
									}),
						},
					},
					poolIds: { cpu: poolId },
					probe,
					ledger,
				});
			case "linux-memory":
				return new LocalHostResource({
					config: {
						ram: {
							quotaMib: Number(definition.capacity / MIB),
							safetyHeadroomMib: Number(
								((definition.safetyHeadroom ?? 0n) + MIB - 1n) / MIB,
							),
						},
					},
					poolIds: { ram: poolId },
					probe,
					ledger,
				});
			default:
				return new LocalHostResource({
					config: {
						gpuUnits: this.bindingsOf(definition.id)
							.filter((b) => b.enabled)
							.map((b) => unitOf(b.id)),
					},
					poolIds: { gpu: poolId },
					probe,
					ledger,
				});
		}
	}

	/** Proven processes per GPU unit, so one device never explains another. */
	private async managedByUnit(
		poolId: string,
	): Promise<Map<string, Set<string>>> {
		const out = new Map<string, Set<string>>();
		for (const { lease, units } of await this.store.allocations(poolId)) {
			if (lease.state !== "active" || !lease.run) continue;
			const processes = processKeys(lease);
			for (const unit of units) {
				const set = out.get(unit) ?? new Set<string>();
				for (const key of processes) set.add(key);
				out.set(unit, set);
			}
		}
		return out;
	}

	private ledgerView(poolId: string) {
		const used =
			this.summaries
				.find((p) => p.poolId === poolId)
				?.dimensions.find((d) => d.kind === "quantity")?.used ?? 0;
		const managed = new Set<string>();
		for (const lease of this.coordinator.readModel().leases) {
			if (lease.state !== "active") continue;
			for (const key of processKeys(lease)) managed.add(key);
		}
		return {
			ramPromisedMib: used,
			// No probe attributes resident memory to runs yet: promises stay outstanding.
			ramManagedBytes: 0n,
			managedProcesses: managed,
		};
	}

	/** Makes pools, their holds and their observers match the definitions. */
	private async syncPools(): Promise<void> {
		const gpuBindings: GpuUnitBinding[] = [];
		const probeBindings: KindedProbeBinding[] = [];
		for (const definition of this.definitions) {
			const poolId = poolIdOf(definition.id);
			const bindings = this.bindingsOf(definition.id);
			const plugin = this.pluginFor(definition);
			await this.store.definePool({
				id: poolId,
				title: definition.id,
				dimensions: [dimensionOf(definition, bindings)],
				maxObservationAgeMs: plugin ? RAM_OBSERVATION_MAX_AGE_MS : null,
			});
			this.coordinator.setPoolPlugin(poolId, plugin);
			if (!plugin) await this.store.forgetObservation(poolId);
			await this.syncHold(poolId, "draining", definition.draining);
			await this.syncHold(
				poolId,
				"definition",
				!definition.enabled || definition.provisioning === "dynamic",
			);
			if (
				definition.observationKind === "linux-memory" ||
				definition.observationKind === "linux-cpu"
			) {
				for (const binding of bindings.filter((b) => b.enabled)) {
					probeBindings.push({
						id: binding.id,
						kind: definition.observationKind,
						deviceKey: binding.stableKey,
					});
				}
			}
			if (
				definition.observationKind === "amd-gpu" ||
				definition.observationKind === "nvidia-gpu"
			) {
				for (const binding of bindings.filter((b) => b.enabled)) {
					const partition = binding.metadata?.partitionKey;
					gpuBindings.push({
						id: binding.id,
						unit: unitOf(binding.id),
						kind: definition.observationKind,
						deviceKey: binding.stableKey,
						...(typeof partition === "string"
							? { partitionKey: partition }
							: {}),
					});
				}
			}
		}
		this.facts.setBindings(gpuBindings, probeBindings);
	}

	private async syncHold(
		poolId: string,
		reason: "draining" | "definition",
		on: boolean,
	): Promise<void> {
		if (on) {
			await this.store.placeHold({ poolId, reason, actor: "core" });
		} else {
			await this.store.clearHold(poolId, reason, "core");
		}
	}

	// Project semaphores: each is a pool of named slots, so a holder has a number.

	async syncProjectPool(
		projectId: string,
		name: string,
		maxConcurrent: number,
	): Promise<void> {
		const poolId = projectPoolId(projectId, name);
		const total = Math.max(1, Math.floor(maxConcurrent));
		await this.store.definePool({
			id: poolId,
			title: name,
			dimensions: [
				{
					kind: "slot",
					name: "slot",
					total,
					units: Array.from({ length: total }, (_, i) => `s${i}`),
				},
			],
		});
		await this.store.clearHold(poolId, "definition", "core");
		await this.refresh();
	}

	/** An unregistered semaphore refuses new work; its pool keeps its history. */
	async retireProjectPool(projectId: string, name: string): Promise<void> {
		await this.store.placeHold({
			poolId: projectPoolId(projectId, name),
			reason: "definition",
			actor: "core",
			detail: "project resource was unregistered",
		});
		await this.refresh();
	}

	async projectHolders(
		projectId: string,
		name: string,
	): Promise<{ slot: number; lease: ResourceLease }[]> {
		const rows = await this.store.allocations(projectPoolId(projectId, name));
		return rows.flatMap(({ lease, units }) =>
			units.map((unit) => ({ slot: Number(unit.slice(1)), lease })),
		);
	}

	/** Project and host resources a live run holds, by their authored names. */
	async resourcesHeldBy(projectId: string, runId: string): Promise<string[]> {
		const { leases, waiters } = this.coordinator.readModel();
		const lease = leases.find(
			(l) =>
				l.runId === runId &&
				l.projectId === projectId &&
				["provisional", "active", "uncertain", "releasing"].includes(l.state),
		);
		const waiter = waiters.find((w) => w.id === lease?.waiterId);
		if (!waiter) return [];
		const titles = new Map(
			(await this.store.summaries()).map((p) => [p.poolId, p.title]),
		);
		return waiter.claims.map((claim) =>
			claim.poolId.startsWith("project.")
				? (titles.get(claim.poolId) ?? claim.poolId)
				: this.resourceIdOf(claim.poolId),
		);
	}

	/** The project semaphores a lease holds, by authored name and slot number. */
	async projectSlotsOf(
		projectId: string,
		leaseId: string,
	): Promise<{ resourceId: string; slot: number }[]> {
		const out: { resourceId: string; slot: number }[] = [];
		const prefix = `${projectPoolId(projectId, "x").slice(0, -1)}`;
		for (const pool of await this.store.summaries()) {
			if (!pool.poolId.startsWith(prefix)) continue;
			for (const { lease, units } of await this.store.allocations(
				pool.poolId,
			)) {
				if (lease.id !== leaseId) continue;
				for (const unit of units) {
					out.push({ resourceId: pool.title, slot: Number(unit.slice(1)) });
				}
			}
		}
		return out;
	}

	/** The owner's force-unlock of one slot, or of every slot when omitted. */
	async forceReleaseProjectPool(
		projectId: string,
		name: string,
		slot?: number,
	): Promise<{ slot: number; runId: string | null }[]> {
		const released: { slot: number; runId: string | null }[] = [];
		for (const holder of await this.projectHolders(projectId, name)) {
			if (slot !== undefined && holder.slot !== slot) continue;
			await this.store.forceReleaseClaim(
				holder.lease.id,
				holder.lease.fence,
				projectPoolId(projectId, name),
				"owner",
				"operator force-unlocked a project resource",
			);
			released.push({ slot: holder.slot, runId: holder.lease.runId });
		}
		await this.refresh();
		if (released.length > 0) this.coordinator.wake();
		return released;
	}

	/** Refuses a requirement this host cannot honour; never admits for free. */
	claimFor(resourceId: string, amount?: number | string): Claim {
		const definition = this.definitions.find((d) => d.id === resourceId);
		const refuse = (why: string): never => {
			throw new ResourceError(
				`host resource '${resourceId}' ${why}`,
				"REFUSED",
			);
		};
		if (!definition) return refuse("is not registered on this host");
		if (!definition.enabled) refuse("is disabled");
		if (definition.draining) refuse("is draining");
		if (definition.provisioning === "dynamic") {
			refuse(
				"is dynamic but no provisioner is installed; dynamic is lifecycle metadata, not free capacity",
			);
		}
		if (definition.accounting === "slot") {
			if (amount !== undefined && amount !== 1) {
				throw new QuantityParseError(
					"slot resources must omit amount or request the numeric value 1",
				);
			}
			return claimOf(definition, 1n);
		}
		if (definition.quantityUnit === "integer") {
			if (amount === undefined) {
				throw new QuantityParseError(
					"integer quantity resources require an explicit amount",
				);
			}
			return claimOf(
				definition,
				parseIntegerQuantity(amount, `amount for '${resourceId}'`),
			);
		}
		if (amount === undefined) {
			throw new QuantityParseError(
				"RAM quantity resources require an explicit IEC byte amount",
			);
		}
		return claimOf(
			definition,
			parseIecBytes(amount, `RAM amount for '${resourceId}'`),
		);
	}

	private promised(id: string): bigint {
		const definition = this.definitions.find((d) => d.id === id);
		if (!definition) return 0n;
		const used =
			this.summaries
				.find((p) => p.poolId === poolIdOf(id))
				?.dimensions.find((d) => d.name === dimensionNameOf(definition))
				?.used ?? 0;
		return definition.quantityUnit === "bytes"
			? BigInt(Math.ceil(used)) * MIB
			: BigInt(Math.ceil(used));
	}

	async putDefinition(
		definition: HostResourceDefinition,
		options: WriteOptions = {},
	): Promise<HostResourceDefinition> {
		assertValidDefinition(definition);
		await this.refresh();
		const promised = this.promised(definition.id);
		// Filled in by the change, which is what knows the version it replaced.
		const auditDetail: Record<string, unknown> = {
			resourceId: definition.id,
			reason: options.reason?.trim() || null,
			capacity: definition.capacity.toString(),
			accounting: definition.accounting,
			draining: definition.draining,
			enabled: definition.enabled,
			ignoreObservation: definition.ignoreObservation === true,
		};
		const saved = await this.store.writeHostConfig(
			options.actor?.trim() || "operator",
			"definition.put",
			async (rows, write) => {
				const current =
					rows.definitions
						.map((d) => decode<HostResourceDefinition>(d))
						.find((d) => d.id === definition.id) ?? null;
				if (options.expectedVersion === null && current) {
					throw new ResourceError(
						`host resource '${definition.id}' already exists at version ${current.version}`,
						"CONFLICT",
					);
				}
				if (
					typeof options.expectedVersion === "bigint" &&
					current?.version !== options.expectedVersion
				) {
					throw new ResourceError(
						`stale host resource version ${options.expectedVersion} for '${definition.id}' (actual ${current?.version ?? "missing"})`,
						"CONFLICT",
					);
				}
				if (current) {
					if (definition.capacity < promised) {
						throw new ResourceError(
							`capacity ${definition.capacity} is below ${promised} currently promised`,
							"INVALID_TRANSITION",
						);
					}
					if (
						promised > 0n &&
						(current.accounting !== definition.accounting ||
							(current.quantityUnit ?? null) !==
								(definition.quantityUnit ?? null) ||
							(current.observationKind ?? null) !==
								(definition.observationKind ?? null))
					) {
						throw new ResourceError(
							"accounting or observation binding cannot change while capacity is promised",
							"INVALID_TRANSITION",
						);
					}
					if (current.enabled && !definition.enabled && promised > 0n) {
						throw new ResourceError(
							"drain and release or recover every live promise before disabling this resource",
							"INVALID_TRANSITION",
						);
					}
					if (current.enabled && !definition.enabled && !current.draining) {
						throw new ResourceError(
							"drain the resource before disabling it",
							"INVALID_TRANSITION",
						);
					}
				}
				const next: HostResourceDefinition = {
					...definition,
					version: current
						? current.version + 1n
						: definition.version > 0n
							? definition.version
							: 1n,
				};
				auditDetail.mutation = current ? "updated" : "created";
				auditDetail.actualVersion = current?.version.toString() ?? "absent";
				await write.definition(next.id, Number(next.version), encode(next));
				return next;
			},
			auditDetail,
		);
		await this.refresh();
		await this.syncPools();
		await this.applyObservations();
		this.coordinator.wake();
		return saved;
	}

	async putBinding(
		binding: HostResourceBinding,
		options: WriteOptions = {},
	): Promise<HostResourceBinding> {
		if (
			!binding.id.trim() ||
			!binding.resourceId.trim() ||
			!binding.stableKey.trim()
		) {
			throw new ResourceError(
				"binding id, resource id, and stable key are required",
				"REFUSED",
			);
		}
		await this.refresh();
		const unit = unitOf(binding.id);
		const poolId = poolIdOf(binding.resourceId);
		// A claim on an unnamed slot may be using any binding of its pool.
		const leased = this.coordinator.readModel().leases.some((l) => {
			if (!LIVE_LEASE_STATES.includes(l.state as never)) return false;
			const units = this.unitsByLease.get(l.id)?.get(poolId);
			return (
				units !== undefined && (units.length === 0 || units.includes(unit))
			);
		});
		const auditDetail: Record<string, unknown> = {
			bindingId: binding.id,
			resourceId: binding.resourceId,
			enabled: binding.enabled,
			reason: options.reason?.trim() || null,
		};
		const saved = await this.store.writeHostConfig(
			options.actor?.trim() || "operator",
			"binding.put",
			async (rows, write) => {
				const definitions = rows.definitions.map((d) =>
					decode<HostResourceDefinition>(d),
				);
				const definition = definitions.find((d) => d.id === binding.resourceId);
				if (!definition) {
					throw new ResourceError(
						`unknown host resource '${binding.resourceId}'`,
						"NOT_FOUND",
					);
				}
				const all = rows.bindings.map((b) => decode<HostResourceBinding>(b));
				const current = all.find((b) => b.id === binding.id) ?? null;
				if (options.expectedVersion === null && current) {
					throw new ResourceError(
						`host binding '${binding.id}' already exists at version ${current.version}`,
						"CONFLICT",
					);
				}
				if (
					typeof options.expectedVersion === "bigint" &&
					current?.version !== options.expectedVersion
				) {
					throw new ResourceError(
						`stale host binding version ${options.expectedVersion} for '${binding.id}' (actual ${current?.version ?? "missing"})`,
						"CONFLICT",
					);
				}
				if (current && current.resourceId !== binding.resourceId) {
					throw new ResourceError(
						"a host binding cannot move between resource definitions",
						"INVALID_TRANSITION",
					);
				}
				if (
					current &&
					leased &&
					(current.enabled !== binding.enabled ||
						current.stableKey !== binding.stableKey)
				) {
					throw new ResourceError(
						"release or recover the live promise before changing this binding's identity or availability",
						"INVALID_TRANSITION",
					);
				}
				const isGpu = (d?: HostResourceDefinition) =>
					d?.observationKind === "amd-gpu" ||
					d?.observationKind === "nvidia-gpu";
				if (binding.enabled && isGpu(definition)) {
					const duplicate = all.find(
						(b) =>
							b.id !== binding.id &&
							b.stableKey === binding.stableKey &&
							b.enabled &&
							isGpu(definitions.find((d) => d.id === b.resourceId)),
					);
					if (duplicate) {
						throw new ResourceError(
							`GPU device '${binding.stableKey}' is already enabled by binding '${duplicate.id}'`,
							"INVALID_TRANSITION",
						);
					}
				}
				const next: HostResourceBinding = {
					...binding,
					version: current
						? current.version + 1n
						: binding.version > 0n
							? binding.version
							: 1n,
				};
				auditDetail.mutation = current ? "updated" : "created";
				auditDetail.actualVersion = current?.version.toString() ?? "absent";
				await write.binding(
					next.id,
					next.resourceId,
					next.stableKey,
					Number(next.version),
					encode(next),
				);
				return next;
			},
			auditDetail,
		);
		await this.refresh();
		await this.syncPools();
		await this.refresh();
		return saved;
	}

	/**
	 * Applies reviewed detection results in one write. The generation is checked
	 * inside the write lock, so a proposal reviewed against old state is refused.
	 */
	async applyDetectedResources(
		resources: readonly {
			definition: HostResourceDefinition;
			bindings: readonly HostResourceBinding[];
		}[],
		options: { expectedGeneration: bigint; actor?: string },
	): Promise<{ definitionsCreated: number; bindingsCreated: number }> {
		if (resources.length === 0) {
			throw new ResourceError(
				"at least one detected resource is required",
				"REFUSED",
			);
		}
		if (
			new Set(resources.map((r) => r.definition.id)).size !== resources.length
		) {
			throw new ResourceError(
				"detected resource ids must be unique",
				"REFUSED",
			);
		}
		for (const { definition, bindings } of resources) {
			assertValidDefinition(definition);
			for (const binding of bindings) {
				if (
					!binding.id.trim() ||
					!binding.stableKey.trim() ||
					binding.resourceId !== definition.id
				) {
					throw new ResourceError(
						"detected bindings must have an id, stable key, and matching resource id",
						"REFUSED",
					);
				}
			}
		}
		const result = await this.store.writeHostConfig(
			options.actor?.trim() || "local-operator",
			"definition.detected",
			async (rows, write) => {
				if (BigInt(rows.generation) !== options.expectedGeneration) {
					throw new ResourceError(
						"Host state changed after detection; review a fresh proposal",
						"CONFLICT",
					);
				}
				const definitions = rows.definitions.map((d) =>
					decode<HostResourceDefinition>(d),
				);
				const existing = rows.bindings.map((b) =>
					decode<HostResourceBinding>(b),
				);
				let definitionsCreated = 0;
				let bindingsCreated = 0;
				for (const { definition, bindings } of resources) {
					const current = definitions.find((d) => d.id === definition.id);
					if (current && !sameContract(current, definition)) {
						throw new ResourceError(
							"An existing definition uses this name with a different accounting contract",
							"INVALID_TRANSITION",
						);
					}
					const ids = new Set<string>();
					const keys = new Set<string>();
					const missing: HostResourceBinding[] = [];
					for (const binding of bindings) {
						if (ids.has(binding.id) || keys.has(binding.stableKey)) {
							throw new ResourceError(
								"Detected hardware contains duplicate binding identities",
								"INVALID_TRANSITION",
							);
						}
						ids.add(binding.id);
						keys.add(binding.stableKey);
						const byId = existing.find((b) => b.id === binding.id);
						const byKey = existing.find(
							(b) => b.stableKey === binding.stableKey,
						);
						if (
							(byId &&
								(byId.resourceId !== binding.resourceId ||
									byId.stableKey !== binding.stableKey)) ||
							(byKey && byKey.id !== binding.id)
						) {
							throw new ResourceError(
								"Detected hardware identity conflicts with an existing binding",
								"INVALID_TRANSITION",
							);
						}
						if (!byId) missing.push(binding);
					}
					if (current && missing.length === 0) {
						throw new ResourceError(
							"Detected resource is already configured",
							"INVALID_TRANSITION",
						);
					}
					if (!current) {
						const version = definition.version > 0n ? definition.version : 1n;
						await write.definition(
							definition.id,
							Number(version),
							encode({ ...definition, version }),
						);
						definitionsCreated++;
					}
					for (const binding of missing) {
						const version = binding.version > 0n ? binding.version : 1n;
						await write.binding(
							binding.id,
							binding.resourceId,
							binding.stableKey,
							Number(version),
							encode({ ...binding, version }),
						);
						bindingsCreated++;
					}
				}
				return { definitionsCreated, bindingsCreated };
			},
		);
		await this.refresh();
		await this.syncPools();
		await this.applyObservations();
		this.coordinator.wake();
		return result;
	}

	/** A stored claim in the definition's own unit; project pools have none. */
	private hostAmount(poolId: string, stored?: number | null): bigint {
		const definition = this.definitions.find((d) => poolIdOf(d.id) === poolId);
		// Slots are stored as whole units, quantities as millionths.
		if (definition?.accounting === "slot") return BigInt(stored ?? 1);
		const amount = BigInt(Math.ceil((stored ?? 0) / 1_000_000) || 1);
		return definition?.quantityUnit === "bytes" ? amount * MIB : amount;
	}

	private isHostPool(poolId: string): boolean {
		return this.definitions.some((d) => poolIdOf(d.id) === poolId);
	}

	async setDefinitionDrain(input: {
		resourceId: string;
		expectedVersion: bigint;
		draining: boolean;
		actor: string;
		reason?: string;
	}): Promise<HostResourceDefinition> {
		const definition = this.requireDefinition(input.resourceId);
		return this.putDefinition(
			{ ...definition, draining: input.draining },
			{
				expectedVersion: input.expectedVersion,
				actor: input.actor,
				reason:
					input.reason ??
					(input.draining ? "operator enabled drain" : "operator ended drain"),
			},
		);
	}

	async setDefinitionEnabled(input: {
		resourceId: string;
		expectedVersion: bigint;
		enabled: boolean;
		actor: string;
		reason: string;
	}): Promise<HostResourceDefinition> {
		const definition = this.requireDefinition(input.resourceId);
		return this.putDefinition(
			{ ...definition, enabled: input.enabled },
			{
				expectedVersion: input.expectedVersion,
				actor: input.actor,
				reason: input.reason,
			},
		);
	}

	private requireDefinition(id: string): HostResourceDefinition {
		const definition = this.definitions.find((d) => d.id === id);
		if (!definition) {
			throw new ResourceError(`unknown host resource '${id}'`, "NOT_FOUND");
		}
		return definition;
	}

	async refreshObservations(): Promise<HostResourceReadModel> {
		await this.observations.refresh();
		await this.applyObservations();
		return this.readModel();
	}

	async refreshObservationsForDetection(): Promise<{
		model: HostResourceReadModel;
		probedKinds: readonly HostProbeKind[];
	}> {
		const probedKinds = await this.observations.refresh();
		await this.refresh();
		return { model: this.readModel(), probedKinds };
	}

	/** The audit trail as the API pages it: bigint cursors and fences. */
	async auditEntries(input: { after?: bigint; limit?: number } = {}) {
		const entries = await this.store.auditEntries({
			...(input.after === undefined ? {} : { after: Number(input.after) }),
			...(input.limit === undefined ? {} : { limit: input.limit }),
		});
		return entries.map(({ detail, seq, ...entry }) => {
			const { fence, ...rest } = detail;
			return {
				...entry,
				seq: BigInt(seq),
				eventKey: `audit:${seq}`,
				projectId: typeof rest.projectId === "string" ? rest.projectId : null,
				waiterId: typeof rest.waiterId === "string" ? rest.waiterId : null,
				fence: typeof fence === "number" ? BigInt(fence) : null,
				detail: rest,
			};
		});
	}

	async registerProject(input: {
		identity: ProjectIdentity;
		root: string;
		displayName: string;
		metadata?: Record<string, unknown>;
	}): Promise<void> {
		await this.store.registerProject({
			id: input.identity.id,
			createdAt: input.identity.createdAt,
			root: input.root,
			displayName: input.displayName,
			...(input.metadata ? { metadata: input.metadata } : {}),
		});
	}

	/** Detaching keeps the project's leases: its runs may still be live. */
	async detachProject(projectId: string): Promise<void> {
		await this.store.detachProject(projectId);
	}

	projects() {
		return this.store.projects();
	}

	async reconcile(cause: string) {
		const report = await this.coordinator.reconcile();
		await this.refresh();
		return { cause, ...report };
	}

	async forceRelease(input: {
		leaseId: string;
		expectedFence: bigint;
		actor: string;
		reason: string;
	}): Promise<boolean> {
		const done = await this.coordinator.forceRelease({
			...input,
			expectedFence: Number(input.expectedFence),
		});
		await this.refresh();
		return done;
	}

	subscribe(projectId: string, wake: () => void): () => void {
		return this.coordinator.subscribe(projectId, wake);
	}

	private toWaiter(waiter: ResourceWaiter): Waiter {
		return {
			id: waiter.id,
			requestKey: waiter.requestKey,
			projectId: waiter.projectId,
			sequence: BigInt(waiter.sequence),
			generation: BigInt(waiter.sequence),
			state: waiter.state,
			requirements: waiter.claims
				.filter((c) => this.isHostPool(c.poolId))
				.map((c) => ({
					resourceId: this.resourceIdOf(c.poolId),
					amount: this.hostAmount(c.poolId, c.amount),
				})),
			createdAt: 0,
		};
	}

	private toLease(
		lease: ResourceLease,
		waiters: readonly ResourceWaiter[],
	): HostLease {
		const waiter = waiters.find((w) => w.id === lease.waiterId);
		return {
			id: lease.id,
			waiterId: lease.waiterId,
			projectId: lease.projectId,
			state: lease.state,
			fence: BigInt(lease.fence),
			allocations: (waiter?.claims ?? [])
				.filter((c) => this.isHostPool(c.poolId))
				.flatMap((c): LeaseAllocation[] => {
					const resourceId = this.resourceIdOf(c.poolId);
					const units = this.unitsByLease.get(lease.id)?.get(c.poolId) ?? [];
					const bound = units.flatMap((unit) => {
						const binding = this.bindings.find(
							(b) => b.resourceId === resourceId && unitOf(b.id) === unit,
						);
						return binding ? [binding.id] : [];
					});
					return bound.length > 0
						? bound.map((bindingId) => ({
								resourceId,
								bindingId,
								amount: 1n,
							}))
						: [
								{
									resourceId,
									bindingId: null,
									amount: this.hostAmount(c.poolId, c.amount),
								},
							];
				}),
			run: lease.run ? { runDir: "", ...lease.run } : null,
			ownerProcessBootId: lease.ownerBootId,
			grantedAt: lease.grantedAt,
			activatedAt: lease.activatedAt,
			lastRenewedAt: lease.lastRenewedAt,
			expiresAt: lease.expiresAt,
			releaseReason: lease.releaseReason,
		};
	}

	private resourceIdOf(poolId: string): string {
		return (
			this.definitions.find((d) => poolIdOf(d.id) === poolId)?.id ?? poolId
		);
	}

	private capacityOf(
		definition: HostResourceDefinition,
	): HostEffectiveCapacity {
		const summary = this.summaries.find(
			(p) => p.poolId === poolIdOf(definition.id),
		);
		const dimension = summary?.dimensions.find(
			(d) => d.name === dimensionNameOf(definition),
		);
		const scale = definition.quantityUnit === "bytes" ? MIB : 1n;
		const durablePromises = BigInt(Math.ceil(dimension?.used ?? 0)) * scale;
		const observed =
			dimension?.capacity == null
				? definition.capacity
				: BigInt(Math.floor(dimension.capacity)) * scale;
		const free = observed > durablePromises ? observed - durablePromises : 0n;
		const holds = summary?.holds.map((h) => h.reason) ?? [];
		const kind = definition.observationKind ?? null;
		const ignored = definition.ignoreObservation === true;
		const facts = this.facts.localFacts();
		const diagnostic = kind ? this.facts.diagnosticFor(kind) : null;
		const observation: ObservationAdmissionDiagnostic | null =
			kind && ignored
				? {
						kind,
						bindingId: null,
						sequence: null,
						observedAt: null,
						ageMs: null,
						expiresAt: null,
						maxAgeMs: RAM_OBSERVATION_MAX_AGE_MS,
						processBootId: null,
						kernelBootId: null,
						reuse: "serialized-while-fresh",
						...diagnostic,
						policy: "ignored-explicitly",
					}
				: diagnostic;
		const memory = this.facts.memoryEvidence();
		const ramFormula =
			definition.quantityUnit === "bytes" &&
			!ignored &&
			memory &&
			definition.safetyHeadroom != null
				? evaluateRamFormula({
						configuredQuotaBytes: definition.capacity,
						safetyHeadroomBytes: definition.safetyHeadroom,
						memAvailableBytes: memory.memAvailableBytes,
						durablePromisesBytes: durablePromises,
						attributableManagedBytes: 0n,
						requestBytes: 0n,
					})
				: null;
		const cpuPressure =
			kind === "linux-cpu" && !ignored
				? cpuPressureOf(definition, facts.cpu)
				: null;
		const explanations =
			kind === "amd-gpu" || kind === "nvidia-gpu"
				? this.bindingsOf(definition.id)
						.filter((binding) => binding.enabled)
						.flatMap((binding) => {
							const item = this.facts.explainGpu(
								binding,
								this.ownersOf(binding),
							);
							return item ? [item] : [];
						})
				: [];
		const gpuOccupancy: GpuOccupancyDiagnostic[] = explanations.map(
			(item) => item.diagnostic,
		);
		const poolId = poolIdOf(definition.id);
		const leasedUnits = new Set(
			this.coordinator
				.readModel()
				.leases.filter((lease) =>
					LIVE_LEASE_STATES.includes(lease.state as never),
				)
				.flatMap((lease) => this.unitsByLease.get(lease.id)?.get(poolId) ?? []),
		);
		const unitFree = explanations.some(
			(item) =>
				!item.reason && !leasedUnits.has(unitOf(item.diagnostic.bindingId)),
		);
		const gpuReason =
			unitFree || ignored
				? null
				: explanations.some((item) => item.reason === "unknown-occupancy")
					? ("unknown-occupancy" as const)
					: explanations.some((item) => item.reason === "external-occupancy")
						? ("external-occupancy" as const)
						: null;
		const denial =
			!kind || ignored
				? null
				: (kind === "linux-memory" || kind === "linux-cpu") &&
						this.bindingsOf(definition.id).filter((b) => b.enabled).length > 1
					? ("observation-ambiguous" as const)
					: this.facts.denialFor(kind);
		const pinned = HOLD_PRIORITY.find(
			(reason) =>
				(reason === "operator" ||
					reason === "auth" ||
					reason === "rate_limit" ||
					reason === "budget") &&
				holds.includes(reason),
		);
		const holdReason: HostEffectiveCapacity["holdReason"] = !definition.enabled
			? "disabled"
			: definition.draining
				? "draining"
				: definition.provisioning === "dynamic"
					? "dynamic-unprovisioned"
					: pinned
						? (pinned as HostCapacityHoldReason)
						: denial
							? denial
							: holds.includes("observation-failed")
								? "observation-failed"
								: holds.includes("observation-stale")
									? "observation-stale"
									: cpuPressure?.busyBlocked || cpuPressure?.runnableBlocked
										? "cpu-pressure"
										: gpuReason
											? gpuReason
											: free === 0n &&
													(ramFormula?.quotaRemainingBytes ?? 0n) > 0n
												? "headroom-exhausted"
												: free === 0n
													? "quota-exhausted"
													: null;
		return {
			resourceId: definition.id,
			accounting: definition.accounting,
			quantityUnit: definition.quantityUnit ?? null,
			enforcement: { mode: "admission-control", kernelEnforced: false },
			configuredQuota: definition.capacity,
			durablePromises,
			observedCapacity:
				kind && !ignored
					? kind === "amd-gpu" || kind === "nvidia-gpu"
						? BigInt(explanations.filter((item) => !item.reason).length)
						: observed
					: null,
			effectiveCapacity: holdReason && free > 0n ? 0n : free,
			holdReason,
			observation,
			ramFormula: ramFormula
				? {
						configuredQuotaBytes: ramFormula.configuredQuotaBytes,
						safetyHeadroomBytes: ramFormula.safetyHeadroomBytes,
						memAvailableBytes: ramFormula.memAvailableBytes,
						durablePromisesBytes: ramFormula.durablePromisesBytes,
						attributableManagedBytes: ramFormula.attributableManagedBytes,
						outstandingPromiseBytes: ramFormula.outstandingPromiseBytes,
						quotaRemainingBytes: ramFormula.quotaRemainingBytes,
						observedHeadroomBytes: ramFormula.observedHeadroomBytes,
						effectiveCapacityBytes: ramFormula.effectiveCapacityBytes,
					}
				: null,
			cpuPressure,
			gpuOccupancy,
			degraded: ignored || holds.some((h) => h.startsWith("observation")),
		};
	}

	/**
	 * Why a claim set is held, per host resource, in the terms of its own
	 * definition. Project semaphores have no host diagnostic.
	 */
	holdDiagnostics(
		claims: readonly Claim[],
		blockers: readonly Blocker[],
	): HostHoldDiagnostic[] {
		const model = this.definitions.map((d) => this.capacityOf(d));
		return [...new Set(blockers.map((b) => b.poolId))].flatMap((poolId) => {
			const definition = this.definitions.find(
				(d) => poolIdOf(d.id) === poolId,
			);
			const capacity = model.find((c) => c.resourceId === definition?.id);
			if (!definition || !capacity) return [];
			const claim = claims.find((c) => c.poolId === poolId);
			const requestedAmount = this.hostAmount(poolId, claim?.amount);
			const formula = capacity.ramFormula;
			const reason: HostCapacityHoldReason =
				capacity.holdReason && capacity.holdReason !== "quota-exhausted"
					? capacity.holdReason
					: formula && formula.quotaRemainingBytes >= requestedAmount
						? "headroom-exhausted"
						: "quota-exhausted";
			return [
				{
					resourceId: definition.id,
					reason,
					message: `host resource '${definition.id}' is held: ${reason}`,
					requestedAmount,
					configuredQuota: capacity.configuredQuota,
					durablePromises: capacity.durablePromises,
					effectiveCapacity: formula
						? formula.effectiveCapacityBytes
						: capacity.effectiveCapacity,
					observation: capacity.observation,
					ramFormula: formula,
					cpuPressure: capacity.cpuPressure,
					gpuOccupancy: blockingDevice(capacity),
				},
			];
		});
	}

	/** One row per held resource, naming the hold the owner must act on first. */
	private holdRows(capacities: readonly HostEffectiveCapacity[]) {
		return this.definitions.flatMap((definition): HostResourceHold[] => {
			const summary = this.summaries.find(
				(p) => p.poolId === poolIdOf(definition.id),
			);
			const capacity = capacities.find((c) => c.resourceId === definition.id);
			if (!capacity) return [];
			const hold = HOLD_PRIORITY.flatMap(
				(reason) => summary?.holds.filter((h) => h.reason === reason) ?? [],
			)[0];
			const observed = OBSERVED_HOLD.has(capacity.holdReason ?? "")
				? capacity.holdReason
				: null;
			if (!hold && !observed) return [];
			const reason: HostCapacityHoldReason = observed
				? observed
				: hold?.reason === "definition"
					? definition.enabled
						? "dynamic-unprovisioned"
						: "disabled"
					: hold?.reason === "observation-uncertain"
						? "observation-inconsistent"
						: (hold?.reason as HostCapacityHoldReason);
			const at = hold?.openedAt ?? this.options.host.clock.now();
			return [
				{
					resourceId: definition.id,
					state: "open",
					reason,
					snapshotGeneration: BigInt(this.generation),
					openedAt: at,
					updatedAt: at,
					resolvedAt: null,
					diagnostic: {
						resourceId: definition.id,
						reason,
						message: hold?.detail || reason,
						requestedAmount: 0n,
						configuredQuota: capacity.configuredQuota,
						durablePromises: capacity.durablePromises,
						effectiveCapacity: capacity.effectiveCapacity,
						observation: capacity.observation,
						ramFormula: capacity.ramFormula,
						cpuPressure: capacity.cpuPressure,
						gpuOccupancy: blockingDevice(capacity),
					},
				},
			];
		});
	}

	readModel(): HostResourceReadModel {
		const ledger = this.coordinator.readModel();
		const effectiveCapacities = this.definitions.map((d) => this.capacityOf(d));
		return copyModel({
			hostId: this.ledgerId,
			coordinatorId: this.ledgerId,
			kernelBootId: ledger.kernelBootId,
			processBootId: ledger.processBootId,
			generation: BigInt(this.generation),
			definitions: this.definitions,
			bindings: this.bindings,
			waiters: ledger.waiters.map((w) => this.toWaiter(w)),
			leases: ledger.leases.map((l) => this.toLease(l, ledger.waiters)),
			observations: this.facts.sampleRows(),
			health: this.facts.healthRows(),
			effectiveCapacities,
			incidents: this.incidents.map(
				({ poolId, ...incident }) =>
					({
						...incident,
						resourceId: this.resourceIdOf(poolId),
					}) as HostResourceIncident,
			),
			holds: this.holdRows(effectiveCapacities),
			occupants: effectiveCapacities.flatMap((capacity) =>
				capacity.gpuOccupancy.map((item) => ({
					...item,
					resourceId: capacity.resourceId,
				})),
			),
		});
	}

	async shutdown(): Promise<void> {
		await this.observations.stop();
		this.coordinator.close();
	}
}
