import {
	RunPodPlacementRequestSchema,
	RunPodProjectPolicySchema,
} from "@mfw/daemon/runpod-policy";
import { VerificationPlanSchema } from "@mfw/daemon/tasks/types";
import { z } from "zod";
import {
	createTRPCRouter,
	projectProcedure,
	publicProcedure,
} from "../trpc.ts";

/**
 * Settings router.
 *
 * `SettingsService` owns persistence (`~/.local/share/mfw/config.json`) and
 * live-apply rules; this file owns the shape of the safe subset. Identity
 * fields (name, root, integrationBranch, taskKey) are excluded from the patch:
 * changing a root at runtime would orphan worktrees, runs and the database.
 *
 * `provider` is patchable: run rows record their `providerId`, so a switch
 * only affects later runs. It applies on restart (RunEngine takes it as a
 * constructor arg). The response's `needsRestart` says which changes wait.
 */

const notifyInput = z.object({
	webhook: z.string().url().optional(),
	command: z.string().optional(),
	timeoutMs: z.number().int().positive().optional(),
});

export const settingsRouter = createTRPCRouter({
	get: projectProcedure.query(({ ctx }) => ctx.svc.settings.get()),

	update: projectProcedure
		.input(
			z.object({
				patch: z.object({
					maxConcurrent: z.number().int().positive().max(64).optional(),
					schedulerAutostart: z.boolean().optional(),
					assistance: z
						.object({
							failureDiagnosis: z.enum(["assisted", "escalate"]),
							conflictResolution: z.enum(["assisted", "escalate"]),
							changeReview: z.enum(["off", "assisted", "human"]),
						})
						.optional(),
					/** Only `id` (+ extra env); `type` comes from the catalogue, and the daemon rejects ids with no adapter before persisting. */
					provider: z
						.object({
							id: z.string().min(1),
							env: z.record(z.string(), z.string()).optional(),
						})
						.optional(),
					/** Free text: the catalogue list is only a suggestion, so newer models stay usable. */
					model: z.string().min(1).optional(),
					/** Model per task `model_tier`. A missing tier falls back to the
					 *  project model for standard, or provider tier default then model for light/strong. */
					modelTiers: z
						.object({
							light: z.string().min(1).optional(),
							standard: z.string().min(1).optional(),
							strong: z.string().min(1).optional(),
						})
						.nullish(),
					/** Model for the semantic change review (critic); unset = the brain's own model. */
					reviewModel: z.string().min(1).nullish(),
					reasoningEffort: z
						.enum(["none", "low", "medium", "high", "xhigh", "max"])
						.optional(),
					approvalMode: z.enum(["autonomous", "interactive"]).optional(),
					maxRepairs: z.number().int().nonnegative().max(20).optional(),
					maxStalls: z.number().int().positive().max(20).optional(),
					maxResumes: z.number().int().nonnegative().max(20).optional(),
					leaseMs: z.number().int().min(1000).optional(),
					checkPrefix: z.string().nullish(),
					/** What a verification check may read from the ambient environment (`EnvPolicy` in `verifier.ts`). */
					envPolicy: z
						.object({
							allow: z.array(z.string()).optional(),
							inherit: z.boolean().optional(),
						})
						.nullish(),
					/** Repository-wide checks applied to every merge candidate. */
					mergeChecks: VerificationPlanSchema.nullish(),
					notify: notifyInput.nullish(),
					/** Exempt the task that broke main from the red-main dispatch gate. Default: see `PROJECT_DEFAULTS`. */
					selfRepairMainRed: z.boolean().optional(),
					/** Publish the integration branch after each merge. Default: see `PROJECT_DEFAULTS`. */
					pushOnMerge: z.boolean().optional(),
					/** Project opt-in may only narrow the global account policy. */
					runpod: RunPodProjectPolicySchema.nullish(),
					/** Default shape for tasks selecting execution_target: runpod. */
					runpodTarget: RunPodPlacementRequestSchema.nullish(),
				}),
			}),
		)
		.mutation(({ ctx, input }) => ctx.svc.settings.update(input.patch)),

	/**
	 * Provider API keys. Process-global (one credentials file per machine), so
	 * public procedures. A stored key is never returned: `ProviderSettings` only
	 * answers `hasKey`, enforced by its return type.
	 */
	providers: createTRPCRouter({
		/**
		 * Known agent CLIs, whether installed here (with version), auth mode and
		 * whether it is satisfied, and accepted models. `drivable` marks those
		 * selectable as a provider; the rest are informational and rejected by `update`.
		 */
		catalogue: publicProcedure.query(({ ctx }) =>
			ctx.orchestrator.providers.catalogue(),
		),

		/** Stored credential keys only. Presence, never the key itself. */
		list: publicProcedure.query(({ ctx }) => ctx.orchestrator.providers.list()),

		set: publicProcedure
			.input(z.object({ id: z.string().min(1), apiKey: z.string().min(1) }))
			.mutation(({ ctx, input }) =>
				ctx.orchestrator.providers.set(input.id, input.apiKey),
			),

		remove: publicProcedure
			.input(z.object({ id: z.string().min(1) }))
			.mutation(({ ctx, input }) =>
				ctx.orchestrator.providers.remove(input.id),
			),
	}),
});
