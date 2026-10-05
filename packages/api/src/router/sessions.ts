import { z } from "zod";
import {
	createTRPCRouter,
	projectProcedure,
	publicProcedure,
} from "../trpc.ts";

/** Read/start/resolve surface over `SessionService`'s escalation briefs. */
export const sessionsRouter = createTRPCRouter({
	/** Unresolved sessions across all projects (like `clarify.open`), so escalations in other projects are seen. */
	open: publicProcedure.query(async ({ ctx }) => {
		const out = [];
		for (const svc of ctx.orchestrator.list()) {
			for (const s of await svc.sessions.list({ open: true })) {
				out.push({ project: svc.name, ...s });
			}
		}
		out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
		return out;
	}),

	list: projectProcedure
		.input(z.object({ open: z.boolean().optional() }))
		.query(({ ctx, input }) =>
			ctx.svc.sessions.list(
				input.open === undefined ? {} : { open: input.open },
			),
		),

	get: projectProcedure
		.input(z.object({ id: z.string() }))
		.query(({ ctx, input }) => ctx.svc.sessions.get(input.id)),

	/** Start the run (this is when a session begins costing). Idempotent: returns the existing run. Not named `open`, which is the cross-project list. */
	start: projectProcedure
		.input(z.object({ id: z.string() }))
		.mutation(({ ctx, input }) => ctx.svc.sessions.open(input.id)),

	/** Close with a disposition. `dismissed` requires `reason` (also enforced in `SessionService.resolve`). */
	resolve: projectProcedure
		.input(
			z.object({
				id: z.string(),
				resolution: z.enum(["fixed", "retried", "dismissed"]),
				reason: z.string().optional(),
			}),
		)
		.mutation(({ ctx, input }) =>
			ctx.svc.sessions.resolve(input.id, input.resolution, input.reason),
		),
});
