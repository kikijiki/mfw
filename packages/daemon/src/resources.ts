import type { ProjectDbHandle } from "@mfw/db/client";
import { appendEvent, type EventBus } from "@mfw/db/eventlog";
import { resources, runs } from "@mfw/db/schema";
import { asc, eq, inArray } from "drizzle-orm";
import type { HostLedger } from "./resources/host-ledger.ts";

/**
 * Read/admin surface over project semaphores. Each definition is a pool in the
 * resource core, which owns every grant and release; this service owns the
 * definitions and the joined holder/capacity read.
 */

export type ResourceRow = typeof resources.$inferSelect;

export interface ResourceHolder {
	slot: number;
	runId: string;
	taskId: string | null;
	label: string;
	state: string;
	lockedAt: number;
}

export interface ResourceView extends ResourceRow {
	holders: ResourceHolder[];
	/** `maxConcurrent` minus live holders, floored at 0 (a shrunk max can leave more holders than slots). */
	free: number;
}

export interface RegisterResourceInput {
	id: string;
	name?: string;
	type?: "fixed" | "dynamic";
	cost?: "free" | "paid";
	maxConcurrent?: number;
	policy?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
}

export class ResourceService {
	constructor(
		private readonly deps: {
			handle: ProjectDbHandle;
			bus: EventBus;
			projectId: string;
			ledger: Pick<
				HostLedger,
				| "syncProjectPool"
				| "retireProjectPool"
				| "projectHolders"
				| "forceReleaseProjectPool"
			>;
		},
	) {}

	/** Makes the core's pools match the stored definitions (attach and repair). */
	async syncPools(): Promise<void> {
		const defs = await this.deps.handle.db.select().from(resources);
		for (const def of defs) {
			await this.deps.ledger.syncProjectPool(
				this.deps.projectId,
				def.id,
				def.maxConcurrent,
			);
		}
	}

	private async announceReleased(
		resourceId: string,
		freed: readonly { slot: number; runId: string | null }[],
	): Promise<void> {
		if (freed.length === 0) return;
		const emitted = await this.deps.handle.withTx(async (tx) => {
			await tx
				.update(resources)
				.set({ lastUnlockedAt: new Date() })
				.where(eq(resources.id, resourceId));
			const out = [];
			for (const item of freed) {
				out.push(
					await appendEvent(tx, {
						type: "resource.released",
						payload: {
							resourceId,
							slot: item.slot,
							runId: item.runId ?? "",
							forced: true,
						},
					}),
				);
			}
			return out;
		});
		this.deps.bus.publish(emitted);
	}

	async list(): Promise<ResourceView[]> {
		const defs = await this.deps.handle.db
			.select()
			.from(resources)
			.orderBy(asc(resources.id));
		if (defs.length === 0) return [];

		const held: {
			resourceId: string;
			slot: number;
			runId: string;
			lockedAt: Date;
		}[] = [];
		for (const def of defs) {
			for (const holder of await this.deps.ledger.projectHolders(
				this.deps.projectId,
				def.id,
			)) {
				held.push({
					resourceId: def.id,
					slot: holder.slot,
					runId: holder.lease.runId ?? holder.lease.id,
					lockedAt: new Date(
						holder.lease.activatedAt ?? holder.lease.grantedAt,
					),
				});
			}
		}
		const runIds = [...new Set(held.map((h) => h.runId))];
		const runRows =
			runIds.length > 0
				? await this.deps.handle.db
						.select({
							id: runs.id,
							taskId: runs.taskId,
							label: runs.label,
							state: runs.state,
						})
						.from(runs)
						.where(inArray(runs.id, runIds))
				: [];
		const byRun = new Map(runRows.map((r) => [r.id, r]));

		return defs.map((def) => {
			const holders: ResourceHolder[] = held
				.filter((h) => h.resourceId === def.id)
				.map((h) => {
					const run = byRun.get(h.runId);
					return {
						slot: h.slot,
						runId: h.runId,
						taskId: run?.taskId ?? null,
						label: run?.label ?? h.runId,
						state: run?.state ?? "unknown",
						lockedAt: h.lockedAt.getTime(),
					};
				});
			return {
				...def,
				holders,
				free: Math.max(0, def.maxConcurrent - holders.length),
			};
		});
	}

	async get(id: string): Promise<ResourceView | null> {
		return (await this.list()).find((r) => r.id === id) ?? null;
	}

	/** Upsert: re-registering an id updates its definition (how `maxConcurrent` is raised). */
	async register(input: RegisterResourceInput): Promise<ResourceView> {
		const now = new Date();
		const values = {
			id: input.id,
			name: input.name ?? input.id,
			type: input.type ?? ("fixed" as const),
			cost: input.cost ?? ("free" as const),
			maxConcurrent: Math.max(1, Math.floor(input.maxConcurrent ?? 1)),
			policy: input.policy ?? {},
			metadata: input.metadata ?? {},
			createdAt: now,
		};
		await this.deps.handle.withTx((tx) =>
			tx
				.insert(resources)
				.values(values)
				.onConflictDoUpdate({
					target: resources.id,
					set: {
						name: values.name,
						type: values.type,
						cost: values.cost,
						maxConcurrent: values.maxConcurrent,
						policy: values.policy,
						metadata: values.metadata,
					},
				}),
		);
		await this.deps.ledger.syncProjectPool(
			this.deps.projectId,
			values.id,
			values.maxConcurrent,
		);
		return (await this.get(input.id)) as ResourceView;
	}

	/** Remove a definition. Held slots are force-released first, with their events. */
	async unregister(id: string): Promise<{ released: number }> {
		const { released } = await this.forceRelease(id);
		await this.deps.ledger.retireProjectPool(this.deps.projectId, id);
		await this.deps.handle.withTx((tx) =>
			tx.delete(resources).where(eq(resources.id, id)),
		);
		return { released };
	}

	/** Force-release capacity; emits `resource.released { forced: true }` per slot. */
	async forceRelease(
		resourceId: string,
		slot?: number,
	): Promise<{ released: number }> {
		const freed = await this.deps.ledger.forceReleaseProjectPool(
			this.deps.projectId,
			resourceId,
			slot,
		);
		await this.announceReleased(resourceId, freed);
		return { released: freed.length };
	}
}
