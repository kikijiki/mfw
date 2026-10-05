import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
	createTRPCRouter,
	projectProcedure,
	publicProcedure,
} from "../trpc.ts";

/**
 * Clarify router: the read/answer half of the gate `ClarifyService` writes.
 *
 * `open` is cross-project and public, like `inbox.list`, so a question in a
 * project the operator is not viewing is still discoverable.
 */
export const clarifyRouter = createTRPCRouter({
	/** Every unanswered question set, across every project. */
	open: publicProcedure.query(async ({ ctx }) => {
		const out = [];
		for (const svc of ctx.orchestrator.list()) {
			for (const c of await svc.clarify.list({ open: true })) {
				out.push({ project: svc.name, ...c });
			}
		}
		out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
		return out;
	}),

	list: projectProcedure
		.input(z.object({ open: z.boolean().optional() }))
		.query(({ ctx, input }) =>
			ctx.svc.clarify.list(
				input.open === undefined ? {} : { open: input.open },
			),
		),

	/**
	 * The open question set pausing this draft's expansion, if any. Callers
	 * know the task, not the run, so they cannot use `get` (keyed by runId).
	 */
	getForTask: projectProcedure
		.input(z.object({ taskId: z.string() }))
		.query(async ({ ctx, input }) => {
			for (const c of await ctx.svc.clarify.list({ open: true })) {
				const source = await ctx.svc.registry.get(c.runId);
				if (source?.taskId === input.taskId) return { runId: c.runId };
			}
			return null;
		}),

	get: projectProcedure
		.input(z.object({ runId: z.string() }))
		.query(async ({ ctx, input }) => {
			const clarification = await ctx.svc.clarify.get(input.runId);
			if (!clarification) return null;
			const source = await ctx.svc.registry.get(input.runId);
			const task = source?.taskId
				? await ctx.svc.tasks.get(source.taskId)
				: null;
			return {
				...clarification,
				/** Set only when the questions belong to a Draft; enables the archive escape. */
				draftTaskId: task?.status === "draft" ? task.id : null,
			};
		}),

	/**
	 * Answer some or all of a set. With `continuePlanning`, the answers feed a
	 * fresh plan run against the original goal. The result is a union because
	 * persisting answers can succeed while starting the continuation fails
	 * (recoverable, not a request failure).
	 */
	answer: projectProcedure
		.input(
			z.object({
				runId: z.string(),
				answers: z.array(
					z.object({
						index: z.number().int().nonnegative(),
						answer: z.string(),
					}),
				),
				continuePlanning: z.boolean().default(false),
			}),
		)
		.mutation(({ ctx, input }) =>
			ctx.svc.clarify.answer(input.runId, input.answers, {
				continuePlanning: input.continuePlanning,
			}),
		),

	/**
	 * Abandon a Draft paused on these questions. The task moves first (claim
	 * compare-and-swap), then the clarification resolves, so maintenance never
	 * sees a window in which it could start expansion.
	 */
	archiveDraft: projectProcedure
		.input(z.object({ runId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const clarification = await ctx.svc.clarify.get(input.runId);
			if (!clarification) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: `unknown clarification ${input.runId}`,
				});
			}
			const source = await ctx.svc.registry.get(input.runId);
			if (!source?.taskId) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "these questions do not belong to a draft task",
				});
			}
			const before = await ctx.svc.tasks.get(source.taskId);
			if (!before) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: `draft task ${source.taskId} no longer exists`,
				});
			}
			if (clarification.resolvedAt && before.status !== "archived") {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "these questions are already closed",
				});
			}
			if (before.status !== "draft" && before.status !== "archived") {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: `${source.taskId} is already ${before.status}`,
				});
			}

			let archived = before;
			if (before.status === "draft") {
				const moved = await ctx.svc.tasks.release(
					source.taskId,
					null,
					"archived",
					"human",
					"archived while awaiting clarification answers",
				);
				if (!moved) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message: `${source.taskId} started expanding; stop that run before archiving`,
					});
				}
				archived = moved;
			}

			// Older daemons could raise overlapping sets for one Draft; close every
			// open set for the task to avoid ghost Inbox items.
			let closed = clarification;
			for (const open of await ctx.svc.clarify.list({ open: true })) {
				const openSource = await ctx.svc.registry.get(open.runId);
				if (openSource?.taskId !== source.taskId) continue;
				const dismissed = await ctx.svc.clarify.dismiss(open.runId);
				if (open.runId === input.runId && dismissed) closed = dismissed;
			}
			return { task: archived, clarification: closed };
		}),

	/** Close a set without answering it. */
	dismiss: projectProcedure
		.input(z.object({ runId: z.string() }))
		.mutation(({ ctx, input }) => ctx.svc.clarify.dismiss(input.runId)),
});
