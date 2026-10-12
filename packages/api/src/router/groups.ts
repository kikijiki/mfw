import { GroupActionRefusedError, groupView } from "@mfw/daemon/group-view";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createTRPCRouter, projectProcedure } from "../trpc.ts";

/**
 * GROUPS router: attempt groups (`run_groups`) for the compare view.
 * `get` is the group with each attempt's gate facts and whether the server
 * would accept `select_winner` for it now; `selectWinner` is a person's
 * override of the brain, through the same validator and effect.
 */
export const groupsRouter = createTRPCRouter({
	get: projectProcedure
		.input(z.object({ groupId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			const view = await groupView(
				{
					registry: ctx.svc.registry,
					actions: ctx.svc.brainRuntime.actions,
					executor: ctx.svc.brainRuntime.executor,
					db: ctx.svc.handle.db,
				},
				input.groupId,
			);
			if (!view) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: `no attempt group '${input.groupId}'`,
				});
			}
			return view;
		}),

	/**
	 * `Add attempt…`: one more attempt in an open competing group, started by a
	 * person through the brain's own `spawn` validator and launch path.
	 */
	addAttempt: projectProcedure
		.input(
			z.object({
				groupId: z.string().min(1),
				harness: z.string().min(1).optional(),
				model: z.string().min(1).optional(),
				effort: z
					.enum(["none", "low", "medium", "high", "xhigh", "max"])
					.optional(),
				target: z.string().min(1).optional(),
				brief: z.string().max(4000).optional(),
				reason: z.string().max(1000).optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const { project: _project, ...rest } = input;
			const out = await ctx.svc.brainRuntime.actions.addAttemptAsHuman(rest);
			if (!out.ok) {
				throw new GroupActionRefusedError(
					out.rejection.code,
					out.rejection.message,
					out.rejection.fix,
				);
			}
			return {
				ok: true as const,
				groupId: out.groupId,
				runId: out.runId,
				decisionId: out.decisionId,
			};
		}),

	/**
	 * A person chooses the winner. Refused with `PRECONDITION_FAILED` and the
	 * validator's `data.fix` when the attempt is not verified, left its scope,
	 * was reviewed down, or the group is already decided. Recorded as one
	 * `role: human` decision.
	 */
	selectWinner: projectProcedure
		.input(
			z.object({
				groupId: z.string().min(1),
				runId: z.string().min(1),
				reason: z.string().max(1000).optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const out = await ctx.svc.brainRuntime.actions.selectWinnerAsHuman({
				runId: input.runId,
				groupId: input.groupId,
				...(input.reason ? { reason: input.reason } : {}),
			});
			if (!out.ok) {
				throw new GroupActionRefusedError(
					out.rejection.code,
					out.rejection.message,
					out.rejection.fix,
				);
			}
			return {
				ok: true as const,
				groupId: out.groupId,
				runId: input.runId,
				decisionId: out.decisionId,
			};
		}),
});
