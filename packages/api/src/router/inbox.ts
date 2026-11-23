import { budgetedInbox } from "@mfw/daemon/act-budget";
import {
	collectHeadline,
	countLanded,
	type HeadlineSource,
} from "@mfw/daemon/headlines";
import { z } from "zod";
import {
	createTRPCRouter,
	projectProcedure,
	publicProcedure,
} from "../trpc.ts";

/**
 * INBOX router - a thin shell over `InboxService`. The derivation lives in the
 * daemon (inbox.ts) so this layer stays free of business logic and of a
 * direct database dependency; v1's routers reached past the daemon into the
 * store, which is how logic ended up split across layers.
 */
export const inboxRouter = createTRPCRouter({
	/** Every project's attention items in one queue - the cross-project view
	 *  v1 never had. */
	list: publicProcedure.query(({ ctx }) =>
		budgetedInbox(ctx.orchestrator.list()),
	),

	/** One mechanical headline per attached project (`daemon/headlines.ts`). */
	headlines: publicProcedure.query(async ({ ctx }) => {
		const services = ctx.orchestrator.list();
		// A headline degrades rather than throws: without the budget it reads
		// the project's own inbox and shows no held count.
		const budget = await budgetedInbox(services).catch(() => null);
		return Promise.all(
			services.map((svc) => {
				const source: HeadlineSource = {
					name: svc.name,
					inbox: budget
						? {
								list: async () =>
									budget.items.filter((i) => i.project === svc.name),
							}
						: svc.inbox,
					budgets: svc.budgets,
					landedSince: (since) => countLanded(svc.handle, since),
				};
				return collectHeadline(
					source,
					Date.now(),
					budget?.budget?.byProject[svc.name],
				);
			}),
		);
	}),

	dismiss: projectProcedure
		.input(z.object({ itemId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			await ctx.svc.inbox.dismiss(input.itemId);
			return { ok: true };
		}),

	prune: projectProcedure.mutation(async ({ ctx }) => ({
		pruned: await ctx.svc.inbox.prune(),
	})),
});
