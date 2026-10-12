import { z } from "zod";
import { createTRPCRouter, projectProcedure } from "../trpc.ts";

/**
 * HOLDS router: a person pauses or resumes tasks. The same hold store the
 * brain's `pause`/`resume` write, so the scheduler and the brain see one
 * truth; each call is recorded as one `role: human` decision.
 */
const input = z
	.object({
		taskIds: z.array(z.string().min(1)).max(200).default([]),
		/** Also every descendant of this task. */
		subtree: z.string().min(1).optional(),
		reason: z.string().max(1000).optional(),
	})
	.refine((v) => v.taskIds.length > 0 || v.subtree, {
		message: "name at least one task or a subtree",
	});

export const holdsRouter = createTRPCRouter({
	pause: projectProcedure.input(input).mutation(({ ctx, input: i }) =>
		ctx.svc.brainRuntime.actions.holdAsHuman({
			taskIds: i.taskIds,
			...(i.subtree ? { subtree: i.subtree } : {}),
			...(i.reason ? { reason: i.reason } : {}),
			paused: true,
		}),
	),

	resume: projectProcedure.input(input).mutation(({ ctx, input: i }) =>
		ctx.svc.brainRuntime.actions.holdAsHuman({
			taskIds: i.taskIds,
			...(i.subtree ? { subtree: i.subtree } : {}),
			...(i.reason ? { reason: i.reason } : {}),
			paused: false,
		}),
	),

	/** The tasks a person or the brain has paused, with who and why. */
	list: projectProcedure.query(async ({ ctx }) => {
		const holds = await ctx.svc.brainRuntime.executor.holds();
		return Object.entries(holds).map(([taskId, h]) => ({ taskId, ...h }));
	}),
});
