import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createTRPCRouter, projectProcedure } from "../trpc.ts";

/** ADRs: thin shell over AdrService. Rules (immutability, transitions) live there. */
const id = z.string().regex(/^[A-Z][A-Z0-9]{1,9}-ADR-[1-9][0-9]*$/);

export const adrsRouter = createTRPCRouter({
	list: projectProcedure
		.input(
			z.object({
				status: z
					.enum(["proposed", "accepted", "superseded", "rejected"])
					.optional(),
			}),
		)
		.query(({ ctx, input }) => ctx.svc.adrs.list(input.status)),

	get: projectProcedure
		.input(z.object({ id }))
		.query(async ({ ctx, input }) => {
			const adr = await ctx.svc.adrs.get(input.id);
			if (!adr) throw new TRPCError({ code: "NOT_FOUND", message: input.id });
			return adr;
		}),

	create: projectProcedure
		.input(z.object({ title: z.string().min(1), body: z.string().optional() }))
		.mutation(({ ctx, input }) =>
			ctx.svc.adrs.create({ title: input.title, body: input.body }),
		),

	update: projectProcedure
		.input(
			z.object({
				id,
				baseHash: z.string(),
				patch: z.object({
					title: z.string().min(1).optional(),
					body: z.string().optional(),
				}),
			}),
		)
		.mutation(({ ctx, input }) =>
			ctx.svc.adrs.update(input.id, input.patch, input.baseHash),
		),

	setStatus: projectProcedure
		.input(
			z.object({
				id,
				status: z.enum(["accepted", "rejected"]),
				baseHash: z.string().optional(),
			}),
		)
		.mutation(({ ctx, input }) =>
			ctx.svc.adrs.setStatus(input.id, input.status, input.baseHash),
		),

	supersede: projectProcedure
		.input(
			z.object({
				id,
				title: z.string().min(1),
				body: z.string().optional(),
			}),
		)
		.mutation(({ ctx, input }) =>
			ctx.svc.adrs.supersede(input.id, {
				title: input.title,
				body: input.body,
			}),
		),

	remove: projectProcedure
		.input(z.object({ id }))
		.mutation(({ ctx, input }) => ctx.svc.adrs.remove(input.id)),
});
