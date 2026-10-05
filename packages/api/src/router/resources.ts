import { z } from "zod";
import { createTRPCRouter, projectProcedure } from "../trpc.ts";

/**
 * Resources router. `forceRelease` goes through
 * `ResourceService` → `Scheduler.forceReleaseSlots`, which is the same
 * transaction every other release uses - so a force-unlock emits
 * `resource.released { forced: true }` per slot instead of quietly deleting
 * rows the audit log still thinks are held.
 */
export const resourcesRouter = createTRPCRouter({
	/** Definitions with their live holders and remaining capacity. */
	list: projectProcedure.query(({ ctx }) => ctx.svc.resources.list()),

	get: projectProcedure
		.input(z.object({ resourceId: z.string() }))
		.query(({ ctx, input }) => ctx.svc.resources.get(input.resourceId)),

	/** Upsert: re-registering an id updates the definition (e.g. raising
	 *  `maxConcurrent`) instead of failing on the primary key. */
	register: projectProcedure
		.input(
			z.object({
				id: z.string().min(1),
				name: z.string().min(1).optional(),
				type: z.enum(["fixed", "dynamic"]).default("fixed"),
				cost: z.enum(["free", "paid"]).default("free"),
				maxConcurrent: z.number().int().positive().default(1),
				policy: z.record(z.string(), z.unknown()).optional(),
				metadata: z.record(z.string(), z.unknown()).optional(),
			}),
		)
		.mutation(({ ctx, input }) => ctx.svc.resources.register(input)),

	unregister: projectProcedure
		.input(z.object({ resourceId: z.string() }))
		.mutation(({ ctx, input }) =>
			ctx.svc.resources.unregister(input.resourceId),
		),

	/** Free one slot, or every slot of a resource when `slot` is omitted. */
	forceRelease: projectProcedure
		.input(
			z.object({
				resourceId: z.string(),
				slot: z.number().int().nonnegative().optional(),
			}),
		)
		.mutation(({ ctx, input }) =>
			ctx.svc.resources.forceRelease(input.resourceId, input.slot),
		),
});
