import {
	DirectionError,
	type DirectionErrorCode,
} from "@mfw/daemon/brain-runtime/directions";
import { brainIntents, summarizeBrain } from "@mfw/daemon/brain-view";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
	brainTurnBound,
	createTRPCRouter,
	projectProcedure,
	publicProcedure,
} from "../trpc.ts";

const DIRECTION_CODES: Record<DirectionErrorCode, TRPCError["code"]> = {
	invalid: "BAD_REQUEST",
	key_reused: "CONFLICT",
	rate_limited: "TOO_MANY_REQUESTS",
	no_brain: "PRECONDITION_FAILED",
};

/**
 * The project brain. The four plain queries (`session`, `turns`, `decisions`,
 * `plan`) are what the UI reads. `read` and `act` are the transport behind the
 * brain's MCP tools (`@mfw/mcp --brain`): a read tool is a query, an act tool
 * is a mutation that validates, records and executes (or, for a spawn, hands
 * to the scheduler). The
 * daemon attributes an act call to a live turn by `turnRunId`; no credential
 * is involved and the id is not a security boundary.
 */
export const brainRouter = createTRPCRouter({
	/** The session row, whether the brain is enabled, and 24h turn and spend counters. */
	session: projectProcedure.query(({ ctx }) => ctx.svc.brainRuntime.view()),

	/** Turns, newest first. */
	turns: projectProcedure
		.input(
			z.object({
				limit: z.number().int().positive().max(200).optional(),
				beforeSeq: z.number().int().positive().optional(),
			}),
		)
		.query(({ ctx, input }) => ctx.svc.brainRuntime.turnList(input)),

	/** The brain's audit trail (actions, plans, notes, rollovers), newest first. */
	decisions: projectProcedure
		.input(
			z.object({
				taskId: z.string().optional(),
				kind: z
					.enum([
						"action",
						"plan",
						"note",
						"rollover",
						"escalation",
						"judge",
						"override",
					])
					.optional(),
				turnRunId: z.string().optional(),
				beforeId: z.number().int().positive().optional(),
				limit: z.number().int().positive().max(200).optional(),
			}),
		)
		.query(({ ctx, input }) => ctx.svc.brainRuntime.decisionList(input)),

	/** The latest `set_plan`: the brain's own memory. */
	plan: projectProcedure.query(({ ctx }) => ctx.svc.brainRuntime.latestPlan()),

	/**
	 * What the brain intends for each task: its newest non-rejected action
	 * about it, only while no run has started since. One query for the whole
	 * board, so cards add no observer of their own.
	 */
	intents: projectProcedure.query(({ ctx }) => brainIntents(ctx.svc.handle.db)),

	/**
	 * Every project's brain in one read, for the rail, the presence bar and
	 * headers (they span projects). `enabled: false` means no `brain.routes`.
	 */
	states: publicProcedure.query(async ({ ctx }) =>
		Promise.all(
			ctx.orchestrator.list().map(async (svc) => ({
				project: svc.name,
				...summarizeBrain(await svc.brainRuntime.view()),
			})),
		),
	),

	/**
	 * What overriding one decision would do, before anything is applied: the
	 * inverse operation, step by step. Read-only.
	 */
	overridePreview: projectProcedure
		.input(z.object({ decisionId: z.number().int().positive() }))
		.query(({ ctx, input }) =>
			ctx.svc.brainRuntime.human.preview(input.decisionId),
		),

	/**
	 * Reverse a brain decision by its inverse operation. The reason is
	 * required; the override is audited, marks the original `overridden_by`,
	 * wakes the brain (`human.override`) and shows in its next digest.
	 */
	override: projectProcedure
		.input(
			z.object({
				decisionId: z.number().int().positive(),
				reason: z.string().trim().min(1).max(2000),
			}),
		)
		.mutation(({ ctx, input }) =>
			ctx.svc.brainRuntime.human.override(input.decisionId, input.reason),
		),

	/**
	 * A durable note to the brain; wakes it. `about` is a node ref
	 * (`task:<id>`, `run:<id>`, `decision:<n>`) when the note concerns one thing.
	 */
	message: projectProcedure
		.input(
			z.object({
				text: z.string().trim().min(1).max(4000),
				about: z.string().min(1).max(200).optional(),
			}),
		)
		.mutation(({ ctx, input }) =>
			ctx.svc.brainRuntime.human.message({
				text: input.text,
				...(input.about ? { about: input.about } : {}),
			}),
		),

	/**
	 * The owner's one-sentence direction; wakes the brain, which drafts the
	 * work. Authorship is set by the server: the input has no field for it.
	 * `key` makes a double submit one direction.
	 */
	giveDirection: projectProcedure
		.input(
			z.object({
				text: z.string().min(1).max(2000),
				key: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				return await ctx.svc.brainRuntime.directions.give({
					text: input.text,
					key: input.key,
				});
			} catch (e) {
				if (!(e instanceof DirectionError)) throw e;
				throw new TRPCError({
					code: DIRECTION_CODES[e.code],
					message: e.message,
					cause: e,
				});
			}
		}),

	/** Recent directions, newest first, each with its derived status. */
	directions: projectProcedure.query(({ ctx }) =>
		ctx.svc.brainRuntime.directions.list(),
	),

	/** A person fixed the cause of an open circuit and presses retry. */
	resetCircuit: projectProcedure.mutation(async ({ ctx }) => {
		await ctx.svc.brainRuntime.resetCircuit();
		return ctx.svc.brainRuntime.view();
	}),

	/** A human hold: no wake starts a turn while paused (a failed brain is retried, not paused). */
	setPaused: projectProcedure
		.input(z.object({ paused: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			await ctx.svc.brainRuntime.setPaused(input.paused);
			return ctx.svc.brainRuntime.view();
		}),

	/**
	 * The owner's answer on a decision card. Idempotent: answering a card
	 * twice runs the held action at most once.
	 */
	resolveDecision: projectProcedure
		.input(
			z.object({
				actionId: z.string().min(1),
				approve: z.boolean(),
				reason: z.string().trim().max(2000).optional(),
			}),
		)
		.mutation(({ ctx, input }) =>
			ctx.svc.brainRuntime.actions.resolveHeld({
				actionId: input.actionId,
				approve: input.approve,
				...(input.reason ? { reason: input.reason } : {}),
			}),
		),

	/** The owner closes the act breaker. */
	resetActBreaker: projectProcedure.mutation(async ({ ctx }) => {
		await ctx.svc.brainRuntime.actions.breaker.reset();
		return { ok: true };
	}),

	/** One read tool of the brain's MCP server. */
	read: projectProcedure
		.input(
			z.object({
				tool: z.string().min(1),
				args: z.record(z.string(), z.unknown()).default({}),
				turnRunId: z.string().optional(),
			}),
		)
		.use(brainTurnBound)
		.query(({ ctx, input }) =>
			ctx.svc.brainRuntime.reads.read(input.tool, input.args, {
				...(input.turnRunId ? { turnRunId: input.turnRunId } : {}),
			}),
		),

	/** One act tool call from a live turn. */
	act: projectProcedure
		.input(
			z.object({
				turnRunId: z.string().min(1),
				tool: z.string().min(1),
				args: z.record(z.string(), z.unknown()).default({}),
			}),
		)
		.use(brainTurnBound)
		.mutation(({ ctx, input }) => ctx.svc.brainRuntime.actions.act(input)),
});
