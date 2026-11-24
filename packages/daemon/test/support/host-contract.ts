import type { Client } from "@libsql/client";
import { silentLogger } from "../../src/log.ts";
import { builtinPluginHost } from "../../src/resources/builtin/plugin-host.ts";
import { ResourceCoordinator } from "../../src/resources/coordinator.ts";
import { claimOf, unitOf } from "../../src/resources/host-definitions.ts";
import { HostLedger } from "../../src/resources/host-ledger.ts";
import type {
	Held,
	HostHoldDiagnostic,
	HostLease,
	HostResourceBinding,
	HostResourceDefinition,
	ObservationHealth,
	RunRef,
	StoredObservation,
	Waiter,
} from "../../src/resources/host-types.ts";
import {
	openResourceStore,
	type ResourceStore,
} from "../../src/resources/store.ts";
import {
	type Blocker,
	type LeaseEvidenceReport,
	LIVE_LEASE_STATES,
	type ResourceHeld,
} from "../../src/resources/types.ts";

/**
 * The operator-facing host contract the host-resource suites assert, spoken
 * over the real ledger, core and store. It translates shapes only: every grant,
 * hold and transition below is decided by production code.
 */
export type ContractStatus = "live" | "absent" | "unavailable" | "unknown";

export interface ContractEvidence {
	status: ContractStatus;
	checkedAt: number;
	kernelBootId: string | null;
	processBootId?: string | null;
	detail?: string;
}

export interface ContractLiveness {
	inspect(lease?: unknown): Promise<ContractEvidence>;
}

export type ContractTransition =
	| "provisional"
	| "active"
	| "renewed"
	| "releasing"
	| "released"
	| "reclaimed"
	| "force_released";

export interface ContractOptions {
	liveness?: ContractLiveness;
	now?: () => number;
	leaseMs?: number;
	livenessMaxAgeMs?: number;
	clockSkewMs?: number;
	afterTransition?: (transition: ContractTransition, lease: HostLease) => void;
}

interface ContractRequest {
	requestKey: string;
	projectId: string;
	requirements: {
		resourceId: string;
		amount: bigint;
		bindingId?: string | null;
	}[];
	metadata?: Record<string, unknown>;
}

const unknownLiveness: ContractLiveness = {
	inspect: async () => ({
		status: "unavailable",
		checkedAt: Date.now(),
		kernelBootId: null,
	}),
};

const isLive = (state: string) =>
	(LIVE_LEASE_STATES as readonly string[]).includes(state);

function heldReasonOf(
	first: Blocker | undefined,
	diagnostic: HostHoldDiagnostic | undefined,
): Held["reason"] {
	if (first?.code === "fifo") return "fifo";
	if (first?.code === "unknown-pool" || first?.code === "unknown-dimension") {
		return "definition";
	}
	const reason = diagnostic?.reason;
	if (reason === "headroom-exhausted") return "headroom";
	if (
		reason?.startsWith("observation") ||
		reason === "cpu-pressure" ||
		reason === "external-occupancy" ||
		reason === "unknown-occupancy"
	) {
		return "observation";
	}
	if (
		reason === "draining" ||
		reason === "disabled" ||
		reason === "dynamic-unprovisioned"
	) {
		return "definition";
	}
	return "capacity";
}

export class ContractHost {
	ledger!: HostLedger;
	private options: ContractOptions = {};

	constructor(
		readonly core: ResourceStore,
		private readonly clock: () => number,
	) {}

	/** Both the old store and old coordinator are this one object. */
	get store(): this {
		return this;
	}

	get client(): Client {
		return (this.core as unknown as { client: Client }).client;
	}

	get observations() {
		return this.ledger.observations;
	}

	get identity() {
		return {
			hostId: this.ledger.hostId,
			coordinatorId: this.ledger.coordinatorId,
			processBootId: this.core.processBootId,
			kernelBootId: this.core.kernelBootId,
		};
	}

	async configure(options: ContractOptions): Promise<this> {
		this.options = options;
		const now = options.now ?? this.clock;
		const liveness = options.liveness ?? unknownLiveness;
		const host = builtinPluginHost(silentLogger(), now);
		const coordinator = new ResourceCoordinator(this.core, {
			host,
			liveness: {
				inspect: async (lease): Promise<LeaseEvidenceReport> => {
					const seen = await liveness.inspect(lease);
					return {
						status:
							seen.status === "live" || seen.status === "absent"
								? seen.status
								: "unknown",
						checkedAt: seen.checkedAt,
						kernelBootId: seen.kernelBootId,
						...(seen.detail ? { detail: seen.detail } : {}),
					};
				},
			},
			...(options.leaseMs ? { leaseMs: options.leaseMs } : {}),
			...(options.livenessMaxAgeMs
				? { livenessMaxAgeMs: options.livenessMaxAgeMs }
				: {}),
			...(options.clockSkewMs ? { clockSkewMs: options.clockSkewMs } : {}),
		});
		this.ledger = new HostLedger({ store: this.core, coordinator, host });
		await this.ledger.load();
		return this;
	}

	private get coordinator() {
		return this.ledger.coordinator;
	}

	private after(transition: ContractTransition, lease: HostLease): void {
		this.options.afterTransition?.(transition, lease);
	}

	private async current(): Promise<void> {
		await this.ledger.refreshObservationsForDetection();
	}

	private async leaseRow(id: string): Promise<HostLease> {
		await this.current();
		const row = this.ledger.readModel().leases.find((l) => l.id === id);
		if (!row) throw new Error(`lease ${id} is missing from the read model`);
		return row;
	}

	readModel() {
		return this.ledger.readModel();
	}

	/** The old store's async read: what another process has committed too. */
	async freshModel() {
		await this.current();
		return this.ledger.readModel();
	}

	subscribe(projectId: string, wake: () => void) {
		return this.ledger.subscribe(projectId, wake);
	}

	putDefinition(definition: HostResourceDefinition) {
		return this.ledger.putDefinition(definition);
	}

	putBinding(binding: HostResourceBinding) {
		return this.ledger.putBinding(binding);
	}

	registerProject(input: Parameters<HostLedger["registerProject"]>[0]) {
		return this.ledger.registerProject(input);
	}

	detachProject(projectId: string) {
		return this.ledger.detachProject(projectId);
	}

	auditEntries(input: { after?: bigint; limit?: number } = {}) {
		return this.ledger.auditEntries(input);
	}

	async applyDetectedResources(
		resources: Parameters<HostLedger["applyDetectedResources"]>[0],
		options: { expectedGeneration: bigint },
	) {
		return this.ledger.applyDetectedResources(resources, options);
	}

	async applyDetectedResource(
		definition: HostResourceDefinition,
		bindings: readonly HostResourceBinding[],
		options: { expectedGeneration: bigint },
	) {
		const result = await this.ledger.applyDetectedResources(
			[{ definition, bindings }],
			options,
		);
		return {
			definitionCreated: result.definitionsCreated === 1,
			bindingsCreated: result.bindingsCreated,
		};
	}

	async recordObservationBatch(
		health: ObservationHealth,
		samples: readonly StoredObservation[],
	) {
		const result = await this.ledger.facts.recordObservationBatch(
			health,
			samples,
		);
		await this.ledger.applyObservations();
		return result;
	}

	async liveLeases(): Promise<HostLease[]> {
		await this.current();
		return this.ledger.readModel().leases.filter((l) => isLive(l.state));
	}

	async lease(id: string): Promise<HostLease | null> {
		await this.current();
		return this.ledger.readModel().leases.find((l) => l.id === id) ?? null;
	}

	async putWaiter(request: ContractRequest): Promise<Waiter> {
		await this.current();
		const definitions = this.ledger.readModel().definitions;
		const claims = request.requirements.map((item) => {
			const definition = definitions.find((d) => d.id === item.resourceId);
			if (!definition) throw new Error(`unknown ${item.resourceId}`);
			return {
				...claimOf(definition, item.amount),
				...(item.bindingId ? { unit: unitOf(item.bindingId) } : {}),
			};
		});
		const waiter = await this.coordinator.putWaiter({
			requestKey: request.requestKey,
			projectId: request.projectId,
			claims,
		});
		await this.current();
		const row = this.ledger.readModel().waiters.find((w) => w.id === waiter.id);
		if (!row) throw new Error("waiter is missing from the read model");
		return row;
	}

	private held(id: string, result: ResourceHeld): Held {
		const waiter = this.coordinator
			.readModel()
			.waiters.find((w) => w.id === id);
		const diagnostics = this.ledger.holdDiagnostics(
			waiter?.claims ?? [],
			result.blockers,
		);
		return {
			kind: "held",
			waiterId: id,
			generation: this.ledger.readModel().generation,
			reason: heldReasonOf(result.blockers[0], diagnostics[0]),
			blockedBy: [
				...new Set(
					result.blockers.map(
						(b) =>
							this.ledger
								.readModel()
								.definitions.find((d) => claimOf(d, 1n).poolId === b.poolId)
								?.id ?? b.poolId,
					),
				),
			],
			diagnostics,
		};
	}

	/** The expected generation is gone: every grant reads current evidence. */
	async tryGrant(id: string, _generation?: bigint): Promise<HostLease | Held> {
		await this.ledger.applyObservations();
		const model = this.ledger.readModel();
		const waiter = model.waiters.find((w) => w.id === id);
		const indivisible = waiter?.requirements.find(
			(item) =>
				item.amount !== 1n &&
				model.definitions.find((d) => d.id === item.resourceId)?.accounting ===
					"slot",
		);
		if (indivisible) {
			return {
				kind: "held",
				waiterId: id,
				generation: model.generation,
				reason: "definition",
				blockedBy: [indivisible.resourceId],
				diagnostics: [],
			};
		}
		const result = await this.coordinator.tryGrant(id);
		await this.ledger.applyObservations();
		if ("kind" in result) return this.held(id, result);
		const lease = await this.leaseRow(result.id);
		this.after("provisional", lease);
		return lease;
	}

	async activate(id: string, fence: bigint, run: RunRef): Promise<HostLease> {
		await this.coordinator.activate({ id, fence: Number(fence) }, run);
		await this.ledger.applyObservations();
		const lease = await this.leaseRow(id);
		this.after("active", lease);
		return lease;
	}

	async renewOrAdopt(
		id: string,
		fence: bigint,
		owner: RunRef & { processBootId?: string; observedAt?: number },
	): Promise<void> {
		const { processBootId: _boot, observedAt: _at, ...run } = owner;
		await this.coordinator.renewOrAdopt({ id, fence: Number(fence) }, run);
		this.after("renewed", await this.leaseRow(id));
	}

	/** A lease id releases it; a waiter id cancels it, idempotently. */
	async cancelOrRelease(
		id: string,
		fence: bigint,
		reason: string,
	): Promise<void> {
		await this.current();
		const lease = this.ledger.readModel().leases.find((l) => l.id === id);
		if (!lease) {
			await this.coordinator.cancelWaiter(id, reason);
			await this.current();
			return;
		}
		const ref = { id, fence: Number(fence) };
		if (lease.state === "provisional") {
			await this.coordinator.release(ref, reason);
		} else {
			await this.core.markReleasing(id, ref.fence, reason);
			await this.coordinator.refresh();
			this.after("releasing", await this.leaseRow(id));
			await this.coordinator.release(ref, reason);
		}
		await this.current();
	}

	/** A provisional lease launched nothing, so "releasing" voids it directly. */
	async markReleasing(id: string, fence: bigint, reason: string) {
		const lease = await this.leaseRow(id);
		const ref = { id, fence: Number(fence) };
		if (lease.state === "provisional") {
			await this.coordinator.release(ref, reason);
		} else {
			await this.core.markReleasing(id, ref.fence, reason);
		}
		await this.current();
	}

	async finishRelease(id: string, fence: bigint) {
		const lease = await this.leaseRow(id);
		if (lease.state === "releasing") {
			await this.core.finishRelease(id, Number(fence), []);
		}
		await this.current();
	}

	async reconcile(cause: string) {
		const before = new Map(
			(await this.liveLeases()).map((lease) => [lease.id, lease.state]),
		);
		const report = await this.ledger.reconcile(cause);
		await this.current();
		for (const lease of this.ledger.readModel().leases) {
			if (before.has(lease.id) && lease.state === "reclaimed") {
				this.after("reclaimed", lease);
			}
		}
		return report;
	}

	async forceRelease(input: {
		leaseId: string;
		expectedFence: bigint;
		actor: string;
		reason: string;
	}) {
		return this.ledger.forceRelease(input);
	}

	close(): void {
		this.coordinator.close();
	}

	shutdown(): Promise<void> {
		return this.ledger.shutdown();
	}
}

export async function openHostResourceStore(
	home: string,
	options: {
		processBootId?: string;
		kernelBootId?: string | null;
		now?: () => number;
		busyTimeoutMs?: number;
	} = {},
): Promise<ContractHost> {
	const now = options.now ?? Date.now;
	const core = await openResourceStore(home, {
		now,
		kernelBootId: options.kernelBootId ?? null,
		...(options.processBootId ? { processBootId: options.processBootId } : {}),
		...(options.busyTimeoutMs ? { busyTimeoutMs: options.busyTimeoutMs } : {}),
	});
	try {
		return await new ContractHost(core, now).configure({ now });
	} catch (error) {
		core.close();
		throw error;
	}
}

export const HostResourceCoordinator = {
	create: (store: ContractHost, options: ContractOptions) =>
		store.configure(options),
};
export type HostResourceCoordinator = ContractHost;
