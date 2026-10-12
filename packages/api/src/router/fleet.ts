import { gatherFleet } from "@mfw/daemon/fleet";
import { createTRPCRouter, publicProcedure } from "../trpc.ts";

/**
 * Fleet: where agents run and what they cost (`daemon/fleet.ts`). One
 * machine-wide read over hosts, harness accounts and resources: capacity,
 * occupants as run chips, budgets and ledger spend, holds with their reset
 * time, and health. No project input: the page is process-global.
 */
export const fleetRouter = createTRPCRouter({
	summary: publicProcedure.query(({ ctx }) => gatherFleet(ctx.orchestrator)),
});
