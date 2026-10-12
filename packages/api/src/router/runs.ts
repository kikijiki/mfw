import {
	isRunActivity,
	type RunActivity,
	type RunActivityDetail,
} from "@mfw/core/activity";
import { parseAgentEvents } from "@mfw/daemon/agents/events";
import { recordHumanAction, taskOfRun } from "@mfw/daemon/human-actions";
import { rerouteRun } from "@mfw/daemon/reroute";
import { parseRoutingRecord } from "@mfw/daemon/routing";
import { runPipsByTask } from "@mfw/daemon/run-pips";
import type { ProjectServices } from "@mfw/daemon/services";
import { z } from "zod";
import {
	createTRPCRouter,
	projectProcedure,
	publicProcedure,
} from "../trpc.ts";

/** What the UI shows of a run's routing decision: where it ran and why. Null on pre-routing rows. */
function routeOf(row: { routing: Record<string, unknown> | null }): {
	key: string;
	reason: string;
	detail: string;
	endpoint: string | null;
	/** Registry SSH host the run executed on; null = the daemon machine/RunPod. */
	hostId: string | null;
} | null {
	const d = parseRoutingRecord(row.routing);
	if (!d) return null;
	return {
		key: d.holdKey ?? d.provider,
		reason: d.reason,
		detail: d.detail ?? "",
		endpoint: d.endpoint?.id ?? null,
		hostId: d.hostId ?? null,
	};
}

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
			const titles = titlesFor(svc, rows);
			out.push(
				...rows.map((r) => ({
					project: svc.name,
					runId: r.id,
					kind: r.kind,
					state: r.state,
					label: r.label,
					model: r.model,
					providerId: r.providerId,
					route: routeOf(r),
					reasoningEffort: r.reasoningEffort,
					taskId: r.taskId,
					taskTitle: r.taskId ? (titles.get(r.taskId) ?? null) : null,
					attempt: r.attempt,
					activity: activityOf(r),
					activityDetail: r.activityDetail as RunActivityDetail | null,
					/** Diff-scope sample once the scope watchdog writes one; null until then. */
					scopeSample: r.scopeSample,
					capabilities: r.capabilities,
					steerable:
						r.state === "running" &&
						r.capabilities.verified &&
						r.capabilities.steer,
					/** The running cost sampled while live (`run.usage_sampled`); null until the first sample. */
					liveCostUsd: r.usageLive?.costUsd ?? null,
					startedAt: r.startedAt.getTime(),
				})),
			);
		}
		out.sort((a, b) => b.startedAt - a.startedAt);
		return out;
	}),

	/**
	 * History pips for board cards: per task, its settled task runs (newest 12,
	 * oldest first) as `{ref, glyph}`. One query for the whole board.
	 */
	pipsByTask: projectProcedure
		.input(
			z.object({
				/** Omitted = every task with a settled run. */
				taskIds: z.array(z.string()).max(5000).optional(),
			}),
		)
		.query(({ ctx, input }) =>
			runPipsByTask(
				ctx.svc.handle.db,
				input.taskIds ? { taskIds: input.taskIds } : {},
			),
		),

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
			const sorted = rows.sort(activeFirst).slice(0, input.limit);
			const titles = titlesFor(ctx.svc, sorted);
			return sorted.map((row) => ({
				...row,
				taskTitle: row.taskId ? (titles.get(row.taskId) ?? null) : null,
			}));
		}),

	/**
	 * Every project's runs in one call: the global Agents page. Live runs first,
	 * then newest. Rows drop the launch argv and the initial prompt (the run
	 * page reads those through `runs.get`), so a page of a few hundred rows
	 * across projects stays small. One title lookup per project, never per row.
	 */
	listAll: publicProcedure
		.input(
			z
				.object({
					limit: z.number().int().positive().max(500).default(100),
					includeInternal: z.boolean().default(false),
				})
				.default({ limit: 100, includeInternal: false }),
		)
		.query(async ({ ctx, input }) => {
			const perProject = await Promise.all(
				ctx.orchestrator.list().map(async (svc) => {
					const rows = (await svc.registry.list())
						.filter((row) => input.includeInternal || row.kind !== "brain")
						.sort(activeFirst)
						.slice(0, input.limit);
					const titles = titlesFor(svc, rows);
					return rows.map(
						({ argv: _argv, initialPrompt: _prompt, ...row }) => ({
							project: svc.name,
							...row,
							taskTitle: row.taskId ? (titles.get(row.taskId) ?? null) : null,
						}),
					);
				}),
			);
			return perProject.flat().sort(activeFirst).slice(0, input.limit);
		}),

	/**
	 * What the run is doing, separate from its lifecycle state (see
	 * `@mfw/core/activity`). Null activity: a row older than the
	 * classification, or a run the supervisor has not observed yet.
	 */
	activity: projectProcedure
		.input(z.object({ runId: z.string() }))
		.query(async ({ ctx, input }) => {
			const row = await ctx.svc.registry.get(input.runId);
			if (!row) return null;
			return {
				runId: row.id,
				state: row.state,
				activity: activityOf(row),
				detail: row.activityDetail as RunActivityDetail | null,
			};
		}),

	get: projectProcedure
		.input(z.object({ runId: z.string() }))
		.query(async ({ ctx, input }) => {
			const row = await ctx.svc.registry.get(input.runId);
			if (!row) return null;
			const titles = titlesFor(ctx.svc, [row]);
			return {
				...row,
				/** The harness's own session handle (Claude session uuid, Codex thread id); null until reported. */
				nativeSessionId: row.nativeSessionId,
				route: routeOf(row),
				taskTitle: row.taskId ? (titles.get(row.taskId) ?? null) : null,
			};
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
			await recordHumanAction(ctx.svc, {
				action: "runs.stop",
				runId: input.runId,
				taskId: await taskOfRun(ctx.svc, input.runId),
			});
			return { ok: true };
		}),

	/** Saves the run's worktree and branch to `wip/<task>-<run>`, then removes both. PRECONDITION_FAILED (`RunLiveError`) while the run is live. */
	discard: projectProcedure
		.input(z.object({ runId: z.string() }))
		.mutation(({ ctx, input }) => ctx.svc.lifecycle.discardRun(input.runId)),

	/** Rejects with PRECONDITION_FAILED unless the run's driver verified it drains the steer channel. */
	steer: projectProcedure
		.input(z.object({ runId: z.string(), message: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			await ctx.svc.engine.steer(input.runId, input.message);
			await recordHumanAction(ctx.svc, {
				action: "runs.steer",
				runId: input.runId,
				taskId: await taskOfRun(ctx.svc, input.runId),
				reason: input.message,
			});
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
		.mutation(async ({ ctx, input }) => {
			const started = await ctx.svc.engine.startTask(input.taskId, {
				model: input.model,
				actor: "human",
			});
			await recordHumanAction(ctx.svc, {
				action: "runs.start",
				runId: started.runId,
				taskId: input.taskId,
				input: { kind: "task", ...(input.model ? { model: input.model } : {}) },
			});
			return started;
		}),

	startAction: projectProcedure
		.input(
			z.object({ prompt: z.string().min(1), model: z.string().optional() }),
		)
		.mutation(async ({ ctx, input }) => {
			const started = await ctx.svc.engine.startAction(input.prompt, {
				model: input.model,
				originRef: "human:ui",
			});
			await recordHumanAction(ctx.svc, {
				action: "runs.start",
				runId: started.runId,
				reason: input.prompt,
				input: { kind: "action" },
			});
			return started;
		}),

	startPlan: projectProcedure
		.input(z.object({ goal: z.string().min(1), model: z.string().optional() }))
		.mutation(async ({ ctx, input }) => {
			const started = await ctx.svc.engine.startPlan(input.goal, {
				model: input.model,
				originRef: "human:ui",
			});
			await recordHumanAction(ctx.svc, {
				action: "runs.start",
				runId: started.runId,
				reason: input.goal,
				input: { kind: "plan" },
			});
			return started;
		}),

	startImport: projectProcedure
		.input(
			z.object({
				model: z.string().optional(),
				/** Ids of `docs.suggestions` to record as doc sources along with the survey. */
				docSources: z.array(z.string().min(1)).max(40).optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			// Recorded before the run starts: the survey prompt then names them.
			const docSources = await ctx.svc.docs.adopt(input.docSources ?? []);
			const started = await ctx.svc.engine.startImport({
				model: input.model,
				originRef: "human:ui",
			});
			await recordHumanAction(ctx.svc, {
				action: "runs.start",
				runId: started.runId,
				input: {
					kind: "import",
					...(docSources.length
						? { docSources: docSources.map((d) => d.id) }
						: {}),
				},
			});
			return { ...started, docSources };
		}),

	/**
	 * Move a run's work to another harness, model or host: stop it (the
	 * worktree is kept), then spawn `continue:<runId>` there through the brain's
	 * own launch path. Recorded as a human decision that wakes the brain.
	 * PRECONDITION_FAILED with `data.fix` when it cannot be done.
	 */
	reroute: projectProcedure
		.input(
			z.object({
				runId: z.string().min(1),
				harness: z.string().min(1).optional(),
				model: z.string().min(1).optional(),
				effort: z
					.enum(["none", "low", "medium", "high", "xhigh", "max"])
					.optional(),
				target: z.string().min(1).optional(),
				/** Resume on the run's own route: nothing else needs to change. */
				keepRoute: z.boolean().optional(),
				brief: z.string().max(4000).optional(),
				reason: z.string().max(1000).optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const { project: _project, ...rest } = input;
			const out = await rerouteRun(
				{
					handle: ctx.svc.handle,
					bus: ctx.svc.bus,
					registry: ctx.svc.registry,
					engine: ctx.svc.engine,
					wake: () => ctx.svc.supervisor.wake(),
				},
				rest,
			);
			return { ok: true as const, ...out };
		}),
});

/** The stored activity, narrowed to the vocabulary (an unknown value reads as null). */
function activityOf(row: { activity: string | null }): RunActivity | null {
	return isRunActivity(row.activity) ? row.activity : null;
}

/** One pass over the in-memory task index per project; see `TaskService.titles`. */
function titlesFor(
	svc: ProjectServices,
	rows: readonly { taskId: string | null }[],
): Map<string, string> {
	const ids = new Set<string>();
	for (const row of rows) if (row.taskId) ids.add(row.taskId);
	return svc.tasks.titles(ids);
}

function activeFirst(
	a: { state: string; startedAt: Date },
	b: { state: string; startedAt: Date },
): number {
	const activity = Number(isActive(b.state)) - Number(isActive(a.state));
	return activity || b.startedAt.getTime() - a.startedAt.getTime();
}

function isActive(state: string): boolean {
	return (
		state === "starting" ||
		state === "running" ||
		state === "ended" ||
		state === "finalizing" ||
		state === "merging"
	);
}
