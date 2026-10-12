import { summarizeBrain } from "@mfw/daemon/brain-view";
import {
	collectProjectSummary,
	type SummarySource,
} from "@mfw/daemon/project-summary";
import { spendTotals } from "@mfw/db/spend";
import { createTRPCRouter, publicProcedure } from "../trpc.ts";

/**
 * PROJECTS router: machine-wide per-project digests. One call for every
 * attached project (the sidebar must not fan out per project).
 */
export const projectsRouter = createTRPCRouter({
	/** Task counts by status role, live sessions, worktrees, needs-you, brain, today's spend, last activity. */
	summary: publicProcedure.query(async ({ ctx }) =>
		Promise.all(
			ctx.orchestrator.list().map((svc) => {
				const source: SummarySource = {
					name: svc.name,
					tasks: svc.tasks,
					registry: svc.registry,
					workspace: svc.workspace,
					inbox: svc.inbox,
					brainState: async () => {
						const b = summarizeBrain(await svc.brainRuntime.view());
						return { enabled: b.enabled, state: b.state };
					},
					spendSince: async (since) =>
						(await spendTotals(svc.handle.db, { since })).usd,
					lastEventAt: async () => {
						const page = await svc.events.list({ limit: 1 });
						return page.events[0]?.ts ?? null;
					},
				};
				return collectProjectSummary(source);
			}),
		),
	),
});
