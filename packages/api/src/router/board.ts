import { loadBoardSchema } from "@mfw/daemon/board-schema";
import { createTRPCRouter, projectProcedure } from "../trpc.ts";

/**
 * BOARD router: what the project's own `board.yaml` says, for the UI to draw
 * its columns and hierarchy from instead of hardcoding the canonical eight.
 */
export const boardRouter = createTRPCRouter({
	/** Statuses (declared order, role, writable), task types, hierarchy, layout. */
	schema: projectProcedure.query(({ ctx }) =>
		loadBoardSchema(ctx.svc.boardDir),
	),
});
