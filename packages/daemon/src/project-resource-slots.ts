import type { ProjectDbHandle } from "@mfw/db/client";
import { appendEvent, type EventBus, type StoredEvent } from "@mfw/db/eventlog";
import { resourceSlots, resources } from "@mfw/db/schema";
import { and, eq, type SQL } from "drizzle-orm";
import type { Logger } from "./log.ts";

export interface ProjectSlotRef {
	resourceId: string;
	slot: number;
}

export class ProjectSlotConflictError extends Error {
	constructor(readonly slot: ProjectSlotRef) {
		super(`resource ${slot.resourceId} slot ${slot.slot} was taken`);
		this.name = "ProjectSlotConflictError";
	}
}

/**
 * The project-private semaphore, separated from queue policy so automatic and
 * manual task starts commit through the same admission saga. Bare unknown ids
 * deliberately retain the historical fail-open behavior; host-scoped ids are
 * validated elsewhere and never reach this class.
 */
export class ProjectResourceSlots {
	private readonly now: () => number;
	private readonly warnedUnknown = new Set<string>();

	constructor(
		private readonly deps: {
			handle: ProjectDbHandle;
			bus: EventBus;
			log: Logger;
			now?: () => number;
		},
	) {
		this.now = deps.now ?? (() => Date.now());
	}

	async plan(
		requirements: readonly string[],
		taskId?: string,
	): Promise<{ plan: ProjectSlotRef[] } | { blockedBy: string[] }> {
		const required = [...new Set(requirements)];
		if (required.length === 0) return { plan: [] };
		const [defs, held] = await Promise.all([
			this.deps.handle.db.select().from(resources),
			this.deps.handle.db.select().from(resourceSlots),
		]);
		const state = new Map(
			defs.map((definition) => [
				definition.id,
				{
					max: Math.max(1, definition.maxConcurrent),
					used: new Set<number>(),
				},
			]),
		);
		for (const slot of held) state.get(slot.resourceId)?.used.add(slot.slot);

		const plan: ProjectSlotRef[] = [];
		const blockedBy: string[] = [];
		for (const resourceId of required) {
			const entry = state.get(resourceId);
			if (!entry) {
				if (!this.warnedUnknown.has(resourceId)) {
					this.warnedUnknown.add(resourceId);
					this.deps.log.warn(
						{ taskId, resourceId },
						"task requires an unregistered project resource; preserving bare-id fail-open semantics",
					);
				}
				continue;
			}
			let free: number | null = null;
			for (let slot = 0; slot < entry.max; slot++) {
				if (!entry.used.has(slot)) {
					free = slot;
					break;
				}
			}
			if (free === null) blockedBy.push(resourceId);
			else {
				entry.used.add(free);
				plan.push({ resourceId, slot: free });
			}
		}
		return blockedBy.length > 0 ? { blockedBy } : { plan };
	}

	async acquire(runId: string, plan: readonly ProjectSlotRef[]): Promise<void> {
		if (plan.length === 0) return;
		const emitted = await this.deps.handle.withTx(async (tx) => {
			const out: StoredEvent[] = [];
			for (const slot of plan) {
				const won = await tx
					.insert(resourceSlots)
					.values({
						...slot,
						runId,
						lockedAt: new Date(this.now()),
					})
					.onConflictDoNothing()
					.returning({ slot: resourceSlots.slot });
				if (won.length === 0) throw new ProjectSlotConflictError(slot);
				out.push(
					await appendEvent(tx, {
						type: "resource.locked",
						runId,
						payload: slot,
					}),
				);
			}
			return out;
		});
		this.deps.bus.publish(emitted);
	}

	/**
	 * Verify and, when capacity is unambiguously free, repair the immutable
	 * project's slot set for a prepared/live admission. Planning and insertion
	 * share one transaction so recovery can never "verify" against a stale
	 * snapshot and then over-admit.
	 */
	async ensure(
		runId: string,
		requirements: readonly string[],
	): Promise<{ repaired: number; blockedBy: string[] }> {
		const required = [...new Set(requirements)];
		if (required.length === 0) return { repaired: 0, blockedBy: [] };
		const result = await this.deps.handle.withTx(async (tx) => {
			const defs = await tx.select().from(resources);
			const held = await tx.select().from(resourceSlots);
			const state = new Map(
				defs.map((definition) => [
					definition.id,
					{
						max: Math.max(1, definition.maxConcurrent),
						used: new Set<number>(),
					},
				]),
			);
			for (const slot of held) state.get(slot.resourceId)?.used.add(slot.slot);
			const owned = new Set(
				held
					.filter((slot) => slot.runId === runId)
					.map((slot) => slot.resourceId),
			);
			const plan: ProjectSlotRef[] = [];
			const blockedBy: string[] = [];
			for (const resourceId of required) {
				const entry = state.get(resourceId);
				// Preserve the historical fail-open contract for unknown project ids.
				if (!entry || owned.has(resourceId)) continue;
				let free: number | null = null;
				for (let slot = 0; slot < entry.max; slot++) {
					if (!entry.used.has(slot)) {
						free = slot;
						break;
					}
				}
				if (free === null) blockedBy.push(resourceId);
				else {
					entry.used.add(free);
					plan.push({ resourceId, slot: free });
				}
			}
			if (blockedBy.length > 0) return { events: [], blockedBy };

			const events: StoredEvent[] = [];
			for (const slot of plan) {
				const won = await tx
					.insert(resourceSlots)
					.values({ ...slot, runId, lockedAt: new Date(this.now()) })
					.onConflictDoNothing()
					.returning({ slot: resourceSlots.slot });
				if (won.length === 0) throw new ProjectSlotConflictError(slot);
				events.push(
					await appendEvent(tx, {
						type: "resource.locked",
						runId,
						payload: slot,
					}),
				);
			}
			return { events, blockedBy: [] as string[] };
		});
		this.deps.bus.publish(result.events);
		return { repaired: result.events.length, blockedBy: result.blockedBy };
	}

	async release(runId: string, forced = false): Promise<number> {
		return this.free(eq(resourceSlots.runId, runId), forced);
	}

	async forceRelease(resourceId: string, slot?: number): Promise<number> {
		const where =
			slot === undefined
				? eq(resourceSlots.resourceId, resourceId)
				: and(
						eq(resourceSlots.resourceId, resourceId),
						eq(resourceSlots.slot, slot),
					);
		return this.free(where as SQL, true);
	}

	private async free(where: SQL, forced: boolean): Promise<number> {
		const emitted = await this.deps.handle.withTx(async (tx) => {
			const freed = await tx.delete(resourceSlots).where(where).returning();
			const out: StoredEvent[] = [];
			for (const row of freed) {
				await tx
					.update(resources)
					.set({ lastUnlockedAt: new Date(this.now()) })
					.where(eq(resources.id, row.resourceId));
				out.push(
					await appendEvent(tx, {
						type: "resource.released",
						payload: {
							resourceId: row.resourceId,
							slot: row.slot,
							runId: row.runId,
							forced,
						},
					}),
				);
			}
			return out;
		});
		this.deps.bus.publish(emitted);
		return emitted.length;
	}

	async held(runId: string): Promise<ProjectSlotRef[]> {
		const rows = await this.deps.handle.db
			.select()
			.from(resourceSlots)
			.where(eq(resourceSlots.runId, runId));
		return rows.map(({ resourceId, slot }) => ({ resourceId, slot }));
	}
}
