import { z } from "zod";
import { createTRPCRouter, projectProcedure } from "../trpc.ts";

/**
 * Docs: the project's documentation, one index over board-fed document types
 * and configured documentation directories. Every procedure delegates to
 * `DocsService`, where path containment lives (see `workspace.ts` for why it
 * is not a Zod check). Configuring directory sources is `settings.update`'s
 * `docs` patch; `adopt` here only turns current suggestions into sources.
 */
export const docsRouter = createTRPCRouter({
	/** Board-fed and directory sources with counts. */
	sources: projectProcedure.query(({ ctx }) => ctx.svc.docs.sources()),

	/** The documents of one source (board type name or directory source id). */
	entries: projectProcedure
		.input(z.object({ sourceId: z.string().min(1) }))
		.query(({ ctx, input }) => ctx.svc.docs.entries(input.sourceId)),

	read: projectProcedure
		.input(z.object({ sourceId: z.string().min(1), key: z.string().min(1) }))
		.query(({ ctx, input }) => ctx.svc.docs.read(input.sourceId, input.key)),

	search: projectProcedure
		.input(
			z.object({
				q: z.string().max(200),
				sourceId: z.string().min(1).optional(),
				limit: z.number().int().positive().max(100).optional(),
			}),
		)
		.query(({ ctx, input }) =>
			ctx.svc.docs.search(input.q, {
				sourceId: input.sourceId,
				limit: input.limit,
			}),
		),

	recent: projectProcedure
		.input(z.object({ limit: z.number().int().positive().max(50).optional() }))
		.query(({ ctx, input }) => ctx.svc.docs.recent(input.limit)),

	/** Conventional documentation locations not yet enabled. Never applied silently. */
	suggestions: projectProcedure.query(({ ctx }) => ctx.svc.docs.suggestions()),

	/** Enable suggestions by id; returns the sources that were added. */
	adopt: projectProcedure
		.input(z.object({ ids: z.array(z.string().min(1)).min(1).max(40) }))
		.mutation(({ ctx, input }) => ctx.svc.docs.adopt(input.ids)),

	/** Drop the listing caches so the next read lists the disk again. */
	refresh: projectProcedure.mutation(({ ctx }) => {
		ctx.svc.docs.invalidate();
		return { ok: true as const };
	}),
});
