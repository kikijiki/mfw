import { createTRPCRouter, publicProcedure } from "../trpc.ts";

/** Machine-wide OpenRouter account usage; it is not owned by any project. */
export const openrouterAccountRouter = createTRPCRouter({
	get: publicProcedure.query(({ ctx }) =>
		ctx.orchestrator.openrouter.readModel(),
	),
	refresh: publicProcedure.mutation(({ ctx }) =>
		ctx.orchestrator.openrouter.refresh("operator_refresh"),
	),
});
