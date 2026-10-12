import {
	listAttemptOutcomes,
	listReviewVerdicts,
	OUTCOME_GROUP_KEYS,
	type OutcomeRow,
	type ReviewVerdictRow,
	summarizeOutcomes,
	summarizeReviewers,
} from "@mfw/db/outcomes";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../trpc.ts";

/**
 * Outcome statistics over `task_attempt_outcomes` (one row per task attempt
 * chain), aggregated server-side across projects. Rates count closed chains
 * only; chains still running are reported as `open`.
 */
export const statsRouter = createTRPCRouter({
	outcomes: publicProcedure
		.input(
			z.object({
				/** One project; omitted = every attached project. */
				project: z.string().min(1).optional(),
				/** Epoch ms; chains started before it are ignored. */
				since: z.number().int().nonnegative().optional(),
				groupBy: z
					.array(z.enum(OUTCOME_GROUP_KEYS))
					.max(OUTCOME_GROUP_KEYS.length)
					.default(["harness", "model", "tier"]),
			}),
		)
		.query(async ({ ctx, input }) => {
			const projects = input.project
				? ctx.orchestrator.list().filter((p) => p.name === input.project)
				: ctx.orchestrator.list();
			if (input.project && projects.length === 0)
				throw new TRPCError({
					code: "NOT_FOUND",
					message: `unknown project '${input.project}'`,
				});
			const since =
				input.since !== undefined ? new Date(input.since) : undefined;
			const rows: OutcomeRow[] = [];
			for (const svc of projects)
				rows.push(...(await listAttemptOutcomes(svc.handle.db, { since })));
			return {
				groupBy: input.groupBy,
				projects: projects.map((p) => p.name),
				groups: summarizeOutcomes(rows, [...new Set(input.groupBy)]),
			};
		}),

	/** Review verdicts per reviewer (mode, harness, model) across projects. */
	reviewers: publicProcedure
		.input(
			z
				.object({
					project: z.string().min(1).optional(),
					since: z.number().int().nonnegative().optional(),
				})
				.default({}),
		)
		.query(async ({ ctx, input }) => {
			const projects = input.project
				? ctx.orchestrator.list().filter((p) => p.name === input.project)
				: ctx.orchestrator.list();
			if (input.project && projects.length === 0)
				throw new TRPCError({
					code: "NOT_FOUND",
					message: `unknown project '${input.project}'`,
				});
			const since =
				input.since !== undefined ? new Date(input.since) : undefined;
			const rows: ReviewVerdictRow[] = [];
			for (const svc of projects)
				rows.push(...(await listReviewVerdicts(svc.handle.db, { since })));
			return {
				projects: projects.map((p) => p.name),
				reviewers: summarizeReviewers(rows),
			};
		}),
});
