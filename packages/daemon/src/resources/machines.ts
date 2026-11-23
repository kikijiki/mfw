import { randomUUID } from "node:crypto";
import type {
	CallContext,
	HostServices,
} from "../../../plugin-api/src/common.ts";
import type {
	ExternalObject,
	MachinePlugin,
} from "../../../plugin-api/src/machine.ts";
import type { Shape } from "../../../plugin-api/src/resource.ts";
import {
	type MachineEndpoint,
	validateMachineEndpoint,
} from "../../../plugin-api/src/target.ts";
import type { ResourceStore } from "./store.ts";
import {
	type CleanupRecord,
	ResourceError,
	type ResourceLease,
} from "./types.ts";

export interface ProvisionedMachine {
	ownershipToken: string;
	externalId: string;
	endpoint: MachineEndpoint;
}

export interface MachineReconcileReport {
	examined: number;
	closed: number;
	tornDown: number;
	pending: number;
	/** Objects carrying our namespace with no record; reported, never deleted. */
	unrecorded: string[];
}

const CALL_TIMEOUT_MS = 60_000;

/**
 * The core's half of a dynamic lease: the cleanup record commits before
 * `provision`, and only a later inventory closes it. At any kill point there
 * is a record that startup `reconcile` can walk.
 */
export class MachineLifecycle {
	constructor(
		private readonly store: ResourceStore,
		private readonly plugin: MachinePlugin,
		private readonly host: HostServices,
		private readonly ownerListedHosts: readonly string[] = [],
	) {}

	private ctx(operationId: string): CallContext {
		return {
			operationId,
			deadline: this.host.clock.now() + CALL_TIMEOUT_MS,
			signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
			host: this.host,
		};
	}

	private inventory(poolId: string, op: string): Promise<ExternalObject[]> {
		return this.plugin.inventory({ poolId }, this.ctx(`inv-${op}`));
	}

	async provision(input: {
		lease: Pick<ResourceLease, "id" | "fence">;
		poolId: string;
		shape: Shape;
		sshPublicKey: string;
	}): Promise<ProvisionedMachine> {
		const ownershipToken = `mfw.${randomUUID()}`;
		await this.store.openCleanup({
			leaseId: input.lease.id,
			fence: input.lease.fence,
			poolId: input.poolId,
			ownershipToken,
		});
		const result = await this.plugin.provision(
			{
				leaseId: input.lease.id,
				poolId: input.poolId,
				shape: input.shape,
				ownershipToken,
				sshPublicKey: input.sshPublicKey,
			},
			this.ctx(`prov-${ownershipToken}`),
		);
		let externalId: string | null = null;
		if (result.status === "created") externalId = result.externalId;
		else {
			// Refused or failed may still have left an object: only inventory says.
			const inventory = await this.inventory(input.poolId, ownershipToken);
			const found = inventory.filter(
				(o) => o.ownershipToken === ownershipToken,
			);
			if (found.length > 1) {
				throw new ResourceError(
					"provider created two machines for one token",
					"CONFLICT",
				);
			}
			externalId = found[0]?.externalId ?? null;
			if (!externalId) {
				await this.store.closeCleanup(ownershipToken, inventory);
				throw new ResourceError(
					result.status === "ambiguous"
						? "machine create left no object"
						: `machine create ${result.status}: ${result.reason}`,
					"REFUSED",
				);
			}
		}
		await this.store.bindCleanup(ownershipToken, externalId);
		let endpoint: MachineEndpoint;
		try {
			endpoint = await this.plugin.endpoint(
				{ externalId },
				this.ctx(`endpoint-${ownershipToken}`),
			);
			const verdict = validateMachineEndpoint(endpoint, this.ownerListedHosts);
			if (!verdict.ok) {
				throw new ResourceError(
					`machine endpoint refused: ${verdict.reason}`,
					"REFUSED",
					verdict.fix,
				);
			}
		} catch (error) {
			await this.teardown(ownershipToken).catch(() => {});
			throw error;
		}
		return { ownershipToken, externalId, endpoint };
	}

	/** Tears a machine down and closes its record only on inventory proof. */
	async teardown(ownershipToken: string): Promise<boolean> {
		const record = (await this.store.openCleanups()).find(
			(r) => r.ownershipToken === ownershipToken,
		);
		if (!record) return true;
		return this.teardownRecord(record);
	}

	private async teardownRecord(record: CleanupRecord): Promise<boolean> {
		const token = record.ownershipToken;
		const before = await this.inventory(record.poolId, `${token}-pre`);
		const objects = before.filter(
			(o) =>
				o.ownershipToken === token ||
				(record.externalId !== null && o.externalId === record.externalId),
		);
		for (const object of objects) {
			if (object.ownershipToken !== token) {
				await this.store.noteTeardown(token, "bound machine changed owner");
				return false;
			}
			const reply = await this.plugin
				.teardown(
					{ externalId: object.externalId, ownershipToken: token },
					this.ctx(`tear-${token}`),
				)
				.catch((error: unknown) => ({
					status: "failed" as const,
					detail: error instanceof Error ? error.message : String(error),
				}));
			await this.store.noteTeardown(
				token,
				reply.status === "failed" ? (reply.detail ?? "teardown failed") : null,
			);
		}
		const after = await this.inventory(record.poolId, `${token}-post`);
		const remains = after.some(
			(o) =>
				o.ownershipToken === token ||
				(record.externalId !== null && o.externalId === record.externalId),
		);
		if (remains) return false;
		await this.store.closeCleanup(token, after);
		return true;
	}

	/**
	 * Startup and periodic recovery. A record whose lease is still live keeps
	 * its machine; every other open record is torn down. An unreachable
	 * provider leaves every record open.
	 */
	async reconcile(poolId: string): Promise<MachineReconcileReport> {
		const report: MachineReconcileReport = {
			examined: 0,
			closed: 0,
			tornDown: 0,
			pending: 0,
			unrecorded: [],
		};
		const records = await this.store.openCleanups(poolId);
		const live = new Set((await this.store.liveLeases()).map((l) => l.id));
		const inventory = await this.inventory(poolId, `reconcile-${randomUUID()}`);
		const known = new Set(records.map((r) => r.ownershipToken));
		for (const object of inventory) {
			if (object.ownershipToken && !known.has(object.ownershipToken)) {
				report.unrecorded.push(object.externalId);
			}
		}
		for (const record of records) {
			report.examined++;
			const present = inventory.some(
				(o) =>
					o.ownershipToken === record.ownershipToken ||
					(record.externalId !== null && o.externalId === record.externalId),
			);
			if (!present) {
				if (live.has(record.leaseId) && record.externalId === null) {
					// A create may still be in flight for this live lease.
					report.pending++;
					continue;
				}
				await this.store.closeCleanup(record.ownershipToken, inventory);
				report.closed++;
				continue;
			}
			if (live.has(record.leaseId)) {
				report.pending++;
				continue;
			}
			if (await this.teardownRecord(record)) report.tornDown++;
			else report.pending++;
		}
		return report;
	}
}
