import { z } from "zod";
import { createTRPCRouter, projectProcedure } from "../trpc.ts";

/**
 * Triggers router (§9.4): thin shell over `TriggerService`; it only validates
 * input. `arm`/`disarm`/`dryRun`/`retry` reconcile on every call so a stale
 * view never executes an edited definition.
 */
export const triggersRouter = createTRPCRouter({
	/** Every definition in `.mfw/triggers/`, reconciled against its arming record. */
	list: projectProcedure.query(({ ctx }) => ctx.svc.triggers.list()),

	/** Pins the hash the operator reviewed and grants exactly the secret names passed (never more than requested). */
	arm: projectProcedure
		.input(
			z.object({
				defId: z.string().min(1),
				expectedHash: z.string().startsWith("sha256:"),
				secrets: z.array(z.string()).optional(),
			}),
		)
		.mutation(({ ctx, input }) =>
			ctx.svc.triggers.arm(input.defId, {
				by: "operator",
				expectedHash: input.expectedHash,
				secrets: input.secrets,
			}),
		),

	/** Keeps the cursor, so re-arming resumes rather than replaying (§10.2). */
	disarm: projectProcedure
		.input(z.object({ defId: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			await ctx.svc.triggers.disarm(input.defId);
			return { ok: true };
		}),

	/** What would have fired against the last `limit` events; executes nothing (§9.4). */
	dryRun: projectProcedure
		.input(
			z.object({
				defId: z.string().min(1),
				limit: z.number().int().positive().max(500).optional(),
			}),
		)
		.query(({ ctx, input }) =>
			ctx.svc.triggers.dryRun(input.defId, input.limit),
		),

	deliveries: projectProcedure
		.input(
			z.object({
				defId: z.string().min(1),
				limit: z.number().int().positive().max(200).default(50),
			}),
		)
		.query(({ ctx, input }) =>
			ctx.svc.triggers.deliveries(input.defId, input.limit),
		),

	/** Re-runs one recorded delivery, reusing its `delivery_id` so an idempotent action is a no-op (§9.4). */
	retry: projectProcedure
		.input(z.object({ deliveryId: z.string().min(1) }))
		.mutation(({ ctx, input }) => ctx.svc.triggers.retry(input.deliveryId)),
});
