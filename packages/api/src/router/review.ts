import { z } from "zod";
import { createTRPCRouter, projectProcedure } from "../trpc.ts";

/**
 * Review router - one bundle per judgement, and structured inline comments.
 * The derivation lives in the daemon's ReviewService; this stays a thin shell.
 */
export const reviewRouter = createTRPCRouter({
	/** Diff, verification results, acceptance verdict, cost and run meta in one call. */
	bundle: projectProcedure
		.input(z.object({ taskId: z.string() }))
		.query(({ ctx, input }) => ctx.svc.review.bundle(input.taskId)),

	/** Tasks whose branch is already queued or mid-merge; the review queue uses this to stop offering a decision already made. */
	activeMerges: projectProcedure.query(({ ctx }) =>
		ctx.svc.mergeQueue.activeByTask(),
	),

	/** Operator actions on a `parked` merge job. */
	mergeJob: createTRPCRouter({
		/** Re-queue for another attempt (often enough: the conflicting change may have landed). */
		retry: projectProcedure
			.input(z.object({ jobId: z.number().int() }))
			.mutation(async ({ ctx, input }) => {
				await ctx.svc.mergeQueue.retry(input.jobId);
				return { ok: true };
			}),

		/** Give up on the branch outright. */
		abandon: projectProcedure
			.input(z.object({ jobId: z.number().int() }))
			.mutation(async ({ ctx, input }) => {
				await ctx.svc.mergeQueue.abandon(input.jobId);
				return { ok: true };
			}),

		/** Discard the branch and send the task back to `ready`, to be redone from the current tip. */
		sendToReady: projectProcedure
			.input(z.object({ jobId: z.number().int() }))
			.mutation(async ({ ctx, input }) => {
				await ctx.svc.mergeQueue.sendToReady(input.jobId);
				return { ok: true };
			}),
	}),

	comments: createTRPCRouter({
		list: projectProcedure
			.input(z.object({ taskId: z.string() }))
			.query(({ ctx, input }) => ctx.svc.review.listComments(input.taskId)),

		add: projectProcedure
			.input(
				z.object({
					taskId: z.string(),
					file: z.string().min(1),
					line: z.number().int().nonnegative(),
					side: z.enum(["old", "new"]).default("new"),
					body: z.string().min(1),
				}),
			)
			.mutation(({ ctx, input }) => ctx.svc.review.addComment(input)),

		resolve: projectProcedure
			.input(z.object({ id: z.number().int(), resolved: z.boolean() }))
			.mutation(async ({ ctx, input }) => {
				await ctx.svc.review.resolveComment(input.id, input.resolved);
				return { ok: true };
			}),

		remove: projectProcedure
			.input(z.object({ id: z.number().int() }))
			.mutation(async ({ ctx, input }) => {
				await ctx.svc.review.deleteComment(input.id);
				return { ok: true };
			}),
	}),

	/** Preview of the exact text a repair run would be sent. */
	repairBrief: projectProcedure
		.input(z.object({ taskId: z.string(), reason: z.string().min(1) }))
		.query(({ ctx, input }) =>
			ctx.svc.review.repairBrief(input.taskId, input.reason),
		),
});
