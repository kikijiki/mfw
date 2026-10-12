import { existsSync } from "node:fs";
import { join } from "node:path";
import { type FlowNode, flowTree, subNode } from "@mfw/daemon/flow";
import { parseSubRef, runSubagentsOf } from "@mfw/daemon/run-subagents";
import { STORY_KINDS, taskStory } from "@mfw/daemon/story";
import { decisions } from "@mfw/db/schema";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createTRPCRouter, projectProcedure } from "../trpc.ts";
import { flowTasks } from "./flow.ts";

/**
 * NODE router: the inspector's view of one node of the work tree, addressed
 * by `ref` (`task:<id>`, later `run:<id>`, `group:<id>`, ...). v0 serves task
 * Stories only; the fold lives in the daemon (story.ts).
 */
export const nodeRouter = createTRPCRouter({
	/**
	 * One node of the work tree with its detail: the task record (`task:<id>`),
	 * the run row (`run:<id>`) or the decision row (`decision:<n>`).
	 */
	get: projectProcedure
		.input(z.object({ ref: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			const svc = ctx.svc;
			const notFound = () =>
				new TRPCError({
					code: "NOT_FOUND",
					message: `no node '${input.ref}'`,
				});
			const subParts = parseSubRef(input.ref);
			if (subParts) {
				// A subagent: its row, its parent as the breadcrumb, no tree walk.
				const rows = await runSubagentsOf(svc.handle.db, subParts.runId);
				const row = rows.find((r) => r.toolUseId === subParts.toolUseId);
				if (!row) throw notFound();
				const node = subNode(row, {
					parentExists:
						row.parentToolUseId !== null &&
						rows.some((r) => r.toolUseId === row.parentToolUseId),
				});
				if (!node) throw notFound();
				return { ...node, detail: row };
			}
			const m = /^(task|run|decision):(.+)$/.exec(input.ref);
			if (!m) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `node.get serves task:, run:, sub: and decision: refs; got '${input.ref}'`,
				});
			}
			const [, kind, id] = m as unknown as [string, string, string];
			if (kind === "decision") {
				const [row] = await svc.handle.db
					.select()
					.from(decisions)
					.where(eq(decisions.id, Number(id)));
				if (!row) throw notFound();
				const node: FlowNode = {
					ref: input.ref,
					parent: row.subjectRunId
						? `run:${row.subjectRunId}`
						: row.taskId
							? `task:${row.taskId}`
							: null,
					kind: "decision",
					title: `${row.role}: ${row.action ?? row.status}`,
					needsMe: null,
					lastAt: row.finishedAt ?? row.ts,
				};
				return { ...node, detail: row };
			}
			const tree = await flowTree(svc.handle.db, {
				tasks: await flowTasks(svc),
				ended: "all",
			});
			const node = tree.nodes.find((n) => n.ref === input.ref);
			if (!node) throw notFound();
			if (kind === "task") {
				const task = await svc.tasks.get(id);
				if (!task) throw notFound();
				return { ...node, detail: task };
			}
			const run = await svc.registry.get(id);
			if (!run) throw notFound();
			return { ...node, detail: run };
		}),

	/** A task's chronological Story, newest page first, paged backwards by cursor. */
	story: projectProcedure
		.input(
			z.object({
				ref: z.string().min(1),
				before: z.string().optional(),
				limit: z.number().int().min(1).max(100).default(50),
				filter: z
					.object({ kinds: z.array(z.enum(STORY_KINDS)).optional() })
					.optional(),
			}),
		)
		.query(async ({ ctx, input }) => {
			const m = /^task:(.+)$/.exec(input.ref);
			if (!m) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `node.story serves task refs (task:<id>); got '${input.ref}'`,
				});
			}
			const svc = ctx.svc;
			return taskStory(svc.handle.db, {
				taskId: m[1] as string,
				limit: input.limit,
				...(input.before ? { before: input.before } : {}),
				...(input.filter?.kinds ? { kinds: input.filter.kinds } : {}),
				transcriptAvailable: (runId) =>
					existsSync(join(svc.registry.runDir(runId), "events.jsonl")),
			});
		}),
});
