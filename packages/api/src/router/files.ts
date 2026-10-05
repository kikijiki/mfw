import { z } from "zod";
import { createTRPCRouter, projectProcedure } from "../trpc.ts";

/**
 * Workspace browser - READ ONLY, over the project root or a run's worktree.
 *
 * Every procedure is a one-line delegation on purpose. Path containment is a
 * security property, not a validation nicety, so it lives in
 * `WorkspaceService` (realpath-based) where it is tested directly and cannot
 * be re-implemented per endpoint. A `z.string()` here would look like it was
 * doing the checking; it is not, and it must not start.
 */
export const filesRouter = createTRPCRouter({
	/** Browsable bases: the repo itself plus every live run worktree. */
	worktrees: projectProcedure.query(({ ctx }) => ctx.svc.workspace.worktrees()),

	listDir: projectProcedure
		.input(
			z.object({ path: z.string().optional(), runId: z.string().optional() }),
		)
		.query(({ ctx, input }) => ctx.svc.workspace.listDir(input)),

	readFile: projectProcedure
		.input(
			z.object({
				path: z.string().min(1),
				runId: z.string().optional(),
				maxBytes: z.number().int().positive().optional(),
			}),
		)
		.query(({ ctx, input }) => ctx.svc.workspace.readFile(input)),

	gitStatus: projectProcedure
		.input(z.object({ runId: z.string().optional() }))
		.query(({ ctx, input }) => ctx.svc.workspace.gitStatus(input)),

	diffFile: projectProcedure
		.input(
			z.object({
				path: z.string().min(1),
				runId: z.string().optional(),
				fromPath: z.string().optional(),
			}),
		)
		.query(({ ctx, input }) => ctx.svc.workspace.diffFile(input)),
});
