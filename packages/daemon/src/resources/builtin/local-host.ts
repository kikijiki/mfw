import type { CallContext } from "../../../../plugin-api/src/common.ts";
import type {
	DimensionObservation,
	Observation,
	PoolProposal,
	ResourcePlugin,
} from "../../../../plugin-api/src/resource.ts";
import { evaluateRamFormula } from "../../host-resources/quantity.ts";

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
	occupants: readonly { pid: number; processStartTime: string | null }[];
	/** Device-level use that no listed process explains. */
	unexplainedDeviceUse: boolean;
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
}

export interface LocalHostOptions {
	config: LocalHostConfig;
	probe(): Promise<LocalHostFacts>;
	ledger(): Promise<LocalHostLedgerView>;
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
	constructor(private readonly options: LocalHostOptions) {}

	async discover(
		_params: Record<string, never>,
		_ctx: CallContext,
	): Promise<PoolProposal[]> {
		const { cpu, ram, gpuUnits } = this.options.config;
		const out: PoolProposal[] = [];
		if (cpu) {
			out.push({
				poolId: CPU_POOL,
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
				poolId: RAM_POOL,
				title: "Local memory",
				providerHardLimit: false,
				dimensions: [
					{ kind: "quantity", name: "mib", unit: "mib", total: ram.quotaMib },
				],
			});
		}
		if (gpuUnits && gpuUnits.length > 0) {
			out.push({
				poolId: GPU_POOL,
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
			(params.poolId === CPU_POOL && cpu) ||
			(params.poolId === RAM_POOL && ram) ||
			(params.poolId === GPU_POOL && gpuUnits?.length);
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

		if (params.poolId === CPU_POOL && cpu) {
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

		if (params.poolId === RAM_POOL && ram) {
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
		const { managedProcesses } = await this.options.ledger();
		const units = gpuUnits ?? [];
		const occupied = units.filter((unit) => {
			const gpu = facts.gpus?.find((item) => item.unit === unit);
			// A configured device the probe did not report is not known to be idle.
			if (!gpu || gpu.state === "unknown" || gpu.unexplainedDeviceUse) {
				return true;
			}
			return gpu.occupants.some(
				(o) =>
					o.processStartTime === null ||
					!managedProcesses.has(`${o.pid}:${o.processStartTime}`),
			);
		});
		return result(occupied.length > 0 ? "degraded" : "ok", [
			{ kind: "slot", name: "slot", total: units.length, occupied },
		]);
	}
}
