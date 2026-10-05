import { z } from "zod";
import { createTRPCRouter, projectProcedure } from "../trpc.ts";

/**
 * Raw audit feed. Read-only: events are appended only by `appendEvent` inside
 * the transaction that changed the state. Never returns `run.output` rows
 * (those live in `events.jsonl` under the run dir, served by `runs.entries`).
 */
export const eventsRouter = createTRPCRouter({
	list: projectProcedure
		.input(
			z.object({
				/** Tail forward: rows newer than this seq, oldest first. */
				sinceSeq: z.number().int().nonnegative().optional(),
				/** Scroll back: rows older than this seq, newest first (default). */
				beforeSeq: z.number().int().positive().optional(),
				limit: z.number().int().positive().max(200).default(100),
				types: z.array(z.string()).optional(),
				taskId: z.string().optional(),
			}),
		)
		.query(({ ctx, input }) => ctx.svc.events.list(input)),

	/** Cheap head, for "is there anything newer than my cursor". */
	latestSeq: projectProcedure.query(async ({ ctx }) => ({
		seq: await ctx.svc.events.latestSeq(),
	})),
});
