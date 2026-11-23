import type { CallContext } from "../../../../plugin-api/src/common.ts";
import type {
	DimensionObservation,
	Observation,
	PoolProposal,
	ResourcePlugin,
} from "../../../../plugin-api/src/resource.ts";
import { evaluateRamFormula } from "../quantity.ts";

const MIB = 1024n * 1024n;

/**
 * What the owner confirmed. Capacity is never derived from installed memory
 * or a device count at observation time: a pool exists because it is listed.
 */
export interface LocalHostConfig {
	cpu?: {
		permits: number;
		maxBusyFraction?: number;
		maxRunnableProcesses?: number;
	};
	ram?: { quotaMib: number; safetyHeadroomMib: number };
	/** Stable unit names, one per exclusive GPU or partition. */
	gpuUnits?: readonly string[];
}

export interface GpuFact {
	unit: string;
	state: "idle" | "occupied" | "unknown";
	/** A null start time cannot be matched to a run, so it never reads as ours. */
	occupants: readonly {
		pid: number;
		processStartTime: string | null;
		/** Admission-bearing device memory this process explains. */
		blockingResidentBytes: bigint;
	}[];
	/** Admission-bearing device memory reported without a process. */
	blockingDeviceBytes: bigint;
	/** Admission-bearing device evidence that memory cannot explain. */
	blockingDeviceContext: boolean;
	/** The probe's own verdict that the device is in exclusive use. */
	blocksExclusive: boolean;
	/** A partial sample: its absence of occupants proves nothing. */
	degraded: boolean;
}

/** What the probes report; a null section is an unavailable probe. */
export interface LocalHostFacts {
	cpu: { busyFraction: number; runnableProcesses: number } | null;
	memAvailableBytes: bigint | null;
	gpus: readonly GpuFact[] | null;
}

/** The core's own promises, needed to tell our load from everyone else's. */
export interface LocalHostLedgerView {
	ramPromisedMib: number;
	/** Resident bytes proven to belong to live leases. */
	ramManagedBytes: bigint;
	/** `pid:startTime` of processes proven to belong to live leases. */
	managedProcesses: ReadonlySet<string>;
	/**
	 * The same evidence per GPU unit. When present it is authoritative: a run
	 * leased on one device never explains a process seen on another.
	 */
	managedByUnit?: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface LocalHostOptions {
	config: LocalHostConfig;
	/** Pool ids, when the owner named these resources differently. */
	poolIds?: { cpu?: string; ram?: string; gpu?: string };
	probe(): Promise<LocalHostFacts>;
	ledger(): Promise<LocalHostLedgerView>;
}

/** Whether this sample can prove anything about who is using the device. */
export function isConclusiveGpuFact(gpu: GpuFact): boolean {
	return !gpu.degraded && gpu.state !== "unknown";
}

/** Whether a conclusive sample shows use that `owned` processes do not explain. */
export function hasUnexplainedGpuUse(
	gpu: GpuFact,
	owned: ReadonlySet<string>,
): boolean {
	const isManaged = (o: GpuFact["occupants"][number]) =>
		o.processStartTime !== null && owned.has(`${o.pid}:${o.processStartTime}`);
	if (!gpu.occupants.every(isManaged)) return true;
	if (gpu.blockingDeviceContext) return true;
	// Compared in aggregate, so one managed process cannot explain two claims.
	const explained = gpu.occupants.reduce(
		(total, o) => total + o.blockingResidentBytes,
		0n,
	);
	if (gpu.blockingDeviceBytes > explained) return true;
	return gpu.blocksExclusive && gpu.occupants.length === 0;
}

const CPU_POOL = "local.cpu";
const RAM_POOL = "local.ram";
const GPU_POOL = "local.gpu";

/**
 * `local-host`: this machine's CPU permits, RAM and GPU slots. It describes
 * and observes; the core holds the leases. An unavailable probe reports the
 * pool `down`, which holds it, so unknown is never free capacity.
 */
export class LocalHostResource implements ResourcePlugin {
	private readonly cpuPool: string;
	private readonly ramPool: string;
	private readonly gpuPool: string;

	constructor(private readonly options: LocalHostOptions) {
		this.cpuPool = options.poolIds?.cpu ?? CPU_POOL;
		this.ramPool = options.poolIds?.ram ?? RAM_POOL;
		this.gpuPool = options.poolIds?.gpu ?? GPU_POOL;
	}

	async discover(
		_params: Record<string, never>,
		_ctx: CallContext,
	): Promise<PoolProposal[]> {
		const { cpu, ram, gpuUnits } = this.options.config;
		const out: PoolProposal[] = [];
		if (cpu) {
			out.push({
				poolId: this.cpuPool,
				title: "Local CPU",
				providerHardLimit: false,
				dimensions: [
					{
						kind: "quantity",
						name: "permits",
						unit: "permit",
						total: cpu.permits,
					},
				],
			});
		}
		if (ram) {
			out.push({
				poolId: this.ramPool,
				title: "Local memory",
				providerHardLimit: false,
				dimensions: [
					{ kind: "quantity", name: "mib", unit: "mib", total: ram.quotaMib },
				],
			});
		}
		if (gpuUnits && gpuUnits.length > 0) {
			out.push({
				poolId: this.gpuPool,
				title: "Local GPUs",
				providerHardLimit: false,
				dimensions: [
					{
						kind: "slot",
						name: "slot",
						total: gpuUnits.length,
						units: [...gpuUnits],
					},
				],
			});
		}
		return out;
	}

	async observe(
		params: { poolId: string },
		ctx: CallContext,
	): Promise<Observation> {
		const { cpu, ram, gpuUnits } = this.options.config;
		const known =
			(params.poolId === this.cpuPool && cpu) ||
			(params.poolId === this.ramPool && ram) ||
			(params.poolId === this.gpuPool && gpuUnits?.length);
		if (!known) throw new Error(`unknown pool ${params.poolId}`);
		const facts = await this.options.probe();
		const observedAt = ctx.host.clock.now();
		const result = (
			health: Observation["health"],
			dimensions: DimensionObservation[],
			detail?: string,
		): Observation => ({
			poolId: params.poolId,
			observedAt,
			health,
			dimensions,
			...(detail ? { detail } : {}),
		});

		if (params.poolId === this.cpuPool && cpu) {
			if (!facts.cpu) return result("down", [], "CPU probe is unavailable");
			const blocked =
				(cpu.maxBusyFraction !== undefined &&
					facts.cpu.busyFraction > cpu.maxBusyFraction) ||
				(cpu.maxRunnableProcesses !== undefined &&
					facts.cpu.runnableProcesses > cpu.maxRunnableProcesses);
			return result(blocked ? "degraded" : "ok", [
				{
					kind: "quantity",
					name: "permits",
					total: blocked ? 0 : cpu.permits,
					used: null,
				},
			]);
		}

		if (params.poolId === this.ramPool && ram) {
			if (facts.memAvailableBytes === null) {
				return result("down", [], "memory probe is unavailable");
			}
			const view = await this.options.ledger();
			const formula = evaluateRamFormula({
				configuredQuotaBytes: BigInt(ram.quotaMib) * MIB,
				safetyHeadroomBytes: BigInt(ram.safetyHeadroomMib) * MIB,
				memAvailableBytes: facts.memAvailableBytes,
				durablePromisesBytes: BigInt(Math.ceil(view.ramPromisedMib)) * MIB,
				attributableManagedBytes: view.ramManagedBytes,
				requestBytes: 0n,
			});
			// The core subtracts its live allocations from this total, so it
			// carries them; rounding down never overstates what is free.
			const free = Number(formula.effectiveCapacityBytes / MIB);
			const total = Math.min(ram.quotaMib, view.ramPromisedMib + free);
			return result(free === 0 ? "degraded" : "ok", [
				{
					kind: "quantity",
					name: "mib",
					total,
					used: view.ramPromisedMib,
				},
			]);
		}

		if (!facts.gpus) return result("down", [], "GPU probe is unavailable");
		const { managedProcesses, managedByUnit } = await this.options.ledger();
		const units = gpuUnits ?? [];
		const occupied = units.filter((unit) => {
			const gpu = facts.gpus?.find((item) => item.unit === unit);
			// A configured device the probe did not report is not known to be idle.
			if (!gpu || !isConclusiveGpuFact(gpu)) return true;
			const owned = managedByUnit
				? (managedByUnit.get(unit) ?? new Set<string>())
				: managedProcesses;
			return hasUnexplainedGpuUse(gpu, owned);
		});
		return result(occupied.length > 0 ? "degraded" : "ok", [
			{ kind: "slot", name: "slot", total: units.length, occupied },
		]);
	}
}
