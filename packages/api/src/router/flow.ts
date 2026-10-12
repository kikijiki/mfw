import {
	type FlowTaskInput,
	flowAt,
	flowSpans,
	flowTree,
	liveSubset,
	subtreeRefs,
} from "@mfw/daemon/flow";
import type { ProjectServices } from "@mfw/daemon/services";
import { z } from "zod";
import { createTRPCRouter, projectProcedure } from "../trpc.ts";

/** The board index as the flow tree sees it. */
export async function flowTasks(
	svc: Pick<ProjectServices, "tasks">,
): Promise<FlowTaskInput[]> {
	return (await svc.tasks.list()).map((t) => ({
		id: t.id,
		title: t.title,
		status: t.status,
		type: t.type,
		parentId: t.parentId ?? null,
		updatedAt: t.updatedAt,
		createdAt: t.createdAt,
	}));
}

/**
 * FLOW router: the work tree and its timeline. `tree` is the structural
 * snapshot (with the event `seq` it reflects); `spans` is the time axis for a
 * window and a subtree, with point markers.
 */
export const flowRouter = createTRPCRouter({
	tree: projectProcedure
		.input(
			z
				.object({
					include: z
						.object({ ended: z.enum(["folded", "all"]).optional() })
						.optional(),
					/** Ended runs finished before this fold into one group per task. Default: 7 days ago. */
					since: z.date().optional(),
				})
				.default({}),
		)
		.query(async ({ ctx, input }) =>
			flowTree(ctx.svc.handle.db, {
				tasks: await flowTasks(ctx.svc),
				...(input.since ? { since: input.since } : {}),
				...(input.include?.ended ? { ended: input.include.ended } : {}),
			}),
		),

	/**
	 * The tree as it was at `t` (quantised to a second), for the scrub cursor
	 * and the board at t. Same node shape as `tree`; `t` is the instant used.
	 */
	at: projectProcedure
		.input(
			z.object({
				t: z.date(),
				include: z
					.object({ ended: z.enum(["folded", "all"]).optional() })
					.optional(),
			}),
		)
		.query(async ({ ctx, input }) =>
			flowAt(ctx.svc.handle.db, {
				tasks: await flowTasks(ctx.svc),
				t: input.t,
				...(input.include?.ended ? { ended: input.include.ended } : {}),
			}),
		),

	/**
	 * What is running now: live run nodes and their ancestors only (same node
	 * shape as `tree`), so Home draws a run exactly as the Flow lens does
	 * without paying for the whole board.
	 */
	live: projectProcedure.query(async ({ ctx }) => {
		const tree = await flowTree(ctx.svc.handle.db, {
			tasks: await flowTasks(ctx.svc),
		});
		return { nodes: liveSubset(tree.nodes), seq: tree.seq };
	}),

	spans: projectProcedure
		.input(
			z.object({
				from: z.date(),
				to: z.date(),
				/** Explicit subjects (`run:<id>`, `task:<id>`); absent with no `subtree` = the whole project. */
				subjects: z.array(z.string()).max(5000).optional(),
				/** A node and everything under it in the tree. */
				subtree: z.string().optional(),
			}),
		)
		.query(async ({ ctx, input }) => {
			let subjects: string[] | undefined = input.subjects;
			if (input.subtree) {
				const tree = await flowTree(ctx.svc.handle.db, {
					tasks: await flowTasks(ctx.svc),
					ended: "all",
				});
				const under = subtreeRefs(tree.nodes, input.subtree);
				subjects = [...new Set([...under, ...(subjects ?? [])])];
			}
			return flowSpans(ctx.svc.handle.db, {
				from: input.from,
				to: input.to,
				...(subjects ? { subjects } : {}),
			});
		}),
});
