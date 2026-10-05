import { parseAgentEvents } from "@mfw/daemon/agents/events";
import { z } from "zod";
import {
	createTRPCRouter,
	projectProcedure,
	publicProcedure,
} from "../trpc.ts";

/** Runs router. The transcript is parsed server-side into typed AgentEvents. */
export const runsRouter = createTRPCRouter({
	/** Cross-project "what is running right now". */
	active: publicProcedure.query(async ({ ctx }) => {
		const out = [];
		for (const svc of ctx.orchestrator.list()) {
			const rows = (
				await svc.registry.list({
					states: ["starting", "running", "ended", "finalizing", "merging"],
				})
			).filter((row) => row.kind !== "brain");
			out.push(
				...(await Promise.all(
					rows.map(async (r) => ({
						project: svc.name,
						runId: r.id,
						kind: r.kind,
						state: r.state,
						label: r.label,
						model: r.model,
						providerId: r.providerId,
						reasoningEffort: r.reasoningEffort,
						taskId: r.taskId,
						taskTitle: r.taskId
							? ((await svc.tasks.get(r.taskId))?.title ?? null)
							: null,
						attempt: r.attempt,
						capabilities: r.capabilities,
						steerable:
							r.state === "running" &&
							r.capabilities.verified &&
							r.capabilities.steer,
						startedAt: r.startedAt.getTime(),
					})),
				)),
			);
		}
		out.sort((a, b) => b.startedAt - a.startedAt);
		return out;
	}),

	list: projectProcedure
		.input(
			z.object({
				taskId: z.string().optional(),
				limit: z.number().int().positive().max(200).default(50),
				/** Brain decisions are implementation diagnostics, not agent sessions. */
				includeInternal: z.boolean().default(false),
			}),
		)
		.query(async ({ ctx, input }) => {
			const rows = (
				await ctx.svc.registry.list({ taskId: input.taskId })
			).filter((row) => input.includeInternal || row.kind !== "brain");
			const sorted = rows
				.sort((a, b) => {
					const activity =
						Number(isActive(b.state)) - Number(isActive(a.state));
					return activity || b.startedAt.getTime() - a.startedAt.getTime();
				})
				.slice(0, input.limit);
			return Promise.all(
				sorted.map(async (row) => ({
					...row,
					taskTitle: row.taskId
						? ((await ctx.svc.tasks.get(row.taskId))?.title ?? null)
						: null,
				})),
			);
		}),

	get: projectProcedure
		.input(z.object({ runId: z.string() }))
		.query(async ({ ctx, input }) => {
			const row = await ctx.svc.registry.get(input.runId);
			return row
				? {
						...row,
						taskTitle: row.taskId
							? ((await ctx.svc.tasks.get(row.taskId))?.title ?? null)
							: null,
					}
				: null;
		}),

	/** Parsed transcript entries. Offset-addressed so the client appends. */
	entries: projectProcedure
		.input(
			z.object({
				runId: z.string(),
				offset: z.number().int().nonnegative().default(0),
			}),
		)
		.query(async ({ ctx, input }) => {
			const { chunk, size, complete } = await ctx.svc.registry.readOutput(
				input.runId,
				"events.jsonl",
				input.offset,
			);
			return { entries: parseAgentEvents(chunk), offset: size, complete };
		}),

	/** The finalization journal: what the run did and where it stopped. */
	steps: projectProcedure
		.input(z.object({ runId: z.string() }))
		.query(({ ctx, input }) => ctx.svc.registry.steps(input.runId)),

	stop: projectProcedure
		.input(z.object({ runId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			await ctx.svc.engine.stop(input.runId);
			ctx.svc.supervisor.wake(); // finalize promptly, never inline
			return { ok: true };
		}),

	/** Rejects with PRECONDITION_FAILED unless the run's driver verified it drains the steer channel. */
	steer: projectProcedure
		.input(z.object({ runId: z.string(), message: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			await ctx.svc.engine.steer(input.runId, input.message);
			return { ok: true };
		}),

	respondApproval: projectProcedure
		.input(
			z.object({
				runId: z.string(),
				requestId: z.string().min(1),
				decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await ctx.svc.engine.respondApproval(
				input.runId,
				input.requestId,
				input.decision,
			);
			return { ok: true };
		}),

	/** The Run button: the hand-started path, attributed to "human" in the audit trail. */
	startTask: projectProcedure
		.input(z.object({ taskId: z.string(), model: z.string().optional() }))
		.mutation(({ ctx, input }) =>
			ctx.svc.engine.startTask(input.taskId, {
				model: input.model,
				actor: "human",
			}),
		),

	startAction: projectProcedure
		.input(
			z.object({ prompt: z.string().min(1), model: z.string().optional() }),
		)
		.mutation(({ ctx, input }) =>
			ctx.svc.engine.startAction(input.prompt, { model: input.model }),
		),

	startPlan: projectProcedure
		.input(z.object({ goal: z.string().min(1), model: z.string().optional() }))
		.mutation(({ ctx, input }) =>
			ctx.svc.engine.startPlan(input.goal, { model: input.model }),
		),

	startImport: projectProcedure
		.input(z.object({ model: z.string().optional() }))
		.mutation(({ ctx, input }) =>
			ctx.svc.engine.startImport({ model: input.model }),
		),
});

function isActive(state: string): boolean {
	return (
		state === "starting" ||
		state === "running" ||
		state === "ended" ||
		state === "finalizing" ||
		state === "merging"
	);
}
