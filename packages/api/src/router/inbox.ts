import { mergeInboxes } from "@mfw/daemon/inbox";
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
	list: publicProcedure.query(async ({ ctx }) => {
		const lists = await Promise.all(
			ctx.orchestrator.list().map((svc) => svc.inbox.list()),
		);
		return mergeInboxes(lists);
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
