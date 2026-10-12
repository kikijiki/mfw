import { budgetEntrySchema } from "@mfw/daemon/config";
import { z } from "zod";
import { createTRPCRouter, projectProcedure } from "../trpc.ts";

/**
 * Spend budgets (`daemon/budgets.ts`). `list` returns every effective budget
 * (machine ceilings and project budgets) with its current spend in the open
 * window; `set` writes one entry to the machine config or this project's
 * entry, or removes it with `entry: null`. Raising a limit lifts an exhausted
 * budget on the next evaluation (`budget.restored`, `limit_raised`).
 */
export const budgetsRouter = createTRPCRouter({
	list: projectProcedure.query(({ ctx }) => ctx.svc.budgets.list()),

	get: projectProcedure
		.input(z.object({ id: z.string().min(1) }))
		.query(({ ctx, input }) => ctx.svc.budgets.get(input.id)),

	set: projectProcedure
		.input(
			z.object({
				scope: z.enum(["project", "machine"]),
				kind: z.enum(["agent", "resource", "brain"]),
				key: z.string().min(1).max(80),
				entry: budgetEntrySchema.nullable(),
			}),
		)
		.mutation(({ ctx, input }) =>
			ctx.svc.budgets.set({
				scope: input.scope,
				kind: input.kind,
				key: input.kind === "brain" ? "brain" : input.key,
				entry: input.entry,
			}),
		),
});
