import type { ProjectDbHandle } from "@mfw/db/client";
import { resourceSlots, resources, runs } from "@mfw/db/schema";
import { asc, eq, inArray } from "drizzle-orm";
import type { Scheduler } from "./scheduler.ts";

/**
 * Read/admin surface over the `resources` + `resource_slots` semaphore.
 *
 * The scheduler owns every slot mutation (acquisition, and `releaseSlots` /
 * `forceReleaseSlots` as the single release path). This service owns resource
 * definitions and the joined holder/capacity read, so no second release path exists.
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
			scheduler: Pick<Scheduler, "forceReleaseSlots">;
		},
	) {}

	async list(): Promise<ResourceView[]> {
		const defs = await this.deps.handle.db
			.select()
			.from(resources)
			.orderBy(asc(resources.id));
		if (defs.length === 0) return [];

		const held = await this.deps.handle.db
			.select()
			.from(resourceSlots)
			.orderBy(asc(resourceSlots.resourceId), asc(resourceSlots.slot));
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
		return (await this.get(input.id)) as ResourceView;
	}

	/** Remove a definition. Held slots are force-released FIRST: the FK cascade would otherwise drop holds without `resource.released` events. */
	async unregister(id: string): Promise<{ released: number }> {
		const released = await this.deps.scheduler.forceReleaseSlots(id);
		await this.deps.handle.withTx((tx) =>
			tx.delete(resources).where(eq(resources.id, id)),
		);
		return { released };
	}

	/** Force-release capacity; emits `resource.released { forced: true }` per slot via the scheduler. */
	async forceRelease(
		resourceId: string,
		slot?: number,
	): Promise<{ released: number }> {
		return {
			released: await this.deps.scheduler.forceReleaseSlots(resourceId, slot),
		};
	}
}
