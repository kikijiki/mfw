import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../trpc.ts";

/**
 * Process-global RunPod account surface. It intentionally has no project input:
 * inventory, policy, burn and cleanup authority belong to the account service.
 */
export const runpodAccountRouter = createTRPCRouter({
	get: publicProcedure.query(({ ctx }) => ctx.orchestrator.runpod.readModel()),

	refresh: publicProcedure
		.input(
			z
				.object({ reason: z.string().trim().min(1).max(500) })
				.default({ reason: "operator_refresh" }),
		)
		.mutation(({ ctx, input }) =>
			ctx.orchestrator.runpod.refresh(input.reason),
		),

	updateSafety: publicProcedure
		.input(
			z.object({
				expectedVersion: z.number().int().positive(),
				safety: z.object({
					enabled: z.literal(true),
					maxHourlyPrice: z.number().finite().positive(),
					maxAggregateHourlyPrice: z.number().finite().positive(),
					maxRuntimeMinutes: z.number().int().positive(),
					maxRunSpend: z.number().finite().positive(),
				}),
				actor: z.string().trim().min(1).max(200),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				return await ctx.orchestrator.runpod.updateMachineSafety(input);
			} catch (error) {
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "settings_version_conflict"
				) {
					throw new TRPCError({ code: "CONFLICT", message: error.message });
				}
				throw error;
			}
		}),

	updatePolicy: publicProcedure
		.input(
			z.object({
				expectedVersion: z.number().int().positive(),
				policy: z.unknown(),
				actor: z.string().trim().min(1).max(200),
				reason: z.string().trim().min(1).max(500).optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				return await ctx.orchestrator.runpod.updateMachinePolicy(input);
			} catch (error) {
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "settings_version_conflict"
				) {
					throw new TRPCError({ code: "CONFLICT", message: error.message });
				}
				throw error;
			}
		}),

	setPaused: publicProcedure
		.input(
			z.object({
				expectedVersion: z.number().int().positive(),
				paused: z.boolean(),
				actor: z.string().trim().min(1).max(200),
				reason: z.string().trim().min(1).max(500).optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				return await ctx.orchestrator.runpod.setDispatchPaused(input);
			} catch (error) {
				if (
					error instanceof Error &&
					"code" in error &&
					error.code === "settings_version_conflict"
				) {
					throw new TRPCError({ code: "CONFLICT", message: error.message });
				}
				throw error;
			}
		}),

	cleanup: publicProcedure
		.input(
			z.object({
				podId: z.string().trim().min(1).max(256),
				reason: z.string().trim().min(1).max(500),
				actor: z.string().trim().min(1).max(200),
				confirmed: z.literal(true),
				expectedOwnershipFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
				expectedObservedAt: z.number().int().positive(),
			}),
		)
		.mutation(({ ctx, input }) =>
			ctx.orchestrator.runpod.requestCleanup(input),
		),
});
