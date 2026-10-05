import { availableParallelism } from "node:os";
import type { HostProbeKind } from "@mfw/core/host-observation";
import { detectHostResourceRecommendations } from "@mfw/daemon/host-resource-detection";
import { HostStoreError } from "@mfw/daemon/host-resources/store";
import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../trpc.ts";

const id = z.string().trim().min(1).max(200);
const actor = z.string().trim().min(1).max(200);
const reason = z.string().trim().min(1).max(2_000);
const version = z.bigint().positive();
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const metadata = z.record(z.string(), z.unknown()).optional();

const cpuPressure = z
	.object({
		maxBusyFraction: z.number().min(0).max(1).optional(),
		maxRunnableProcesses: z.number().int().nonnegative().optional(),
	})
	.strict()
	.nullable()
	.optional();

const definition = z
	.object({
		id,
		accounting: z.enum(["slot", "quantity"]),
		provisioning: z.enum(["static", "dynamic"]),
		capacity: z.bigint().positive(),
		quantityUnit: z.enum(["integer", "bytes"]).nullable().optional(),
		safetyHeadroom: z.bigint().nonnegative().nullable().optional(),
		enabled: z.boolean(),
		draining: z.boolean(),
		observationKind: z
			.enum(["linux-cpu", "linux-memory", "amd-gpu", "nvidia-gpu"])
			.nullable()
			.optional(),
		ignoreObservation: z.boolean().optional(),
		cpuPressure,
		metadata,
	})
	.strict();

const binding = z
	.object({
		id,
		resourceId: id,
		stableKey: z.string().trim().min(1).max(500),
		enabled: z.boolean(),
		metadata,
	})
	.strict();

/**
 * The machine resource control plane. Every procedure resolves the one
 * Orchestrator-owned coordinator directly. Inputs are strict so a project id
 * is not silently accepted and discarded; there is no selected-project path.
 */
export const hostResourcesRouter = createTRPCRouter({
	read: publicProcedure
		.input(z.object({}).strict().optional())
		.query(({ ctx }) => ctx.orchestrator.hostResources.readModel()),

	detect: publicProcedure
		.input(z.object({}).strict().optional())
		.query(async ({ ctx }) => {
			const { model, probedKinds } =
				await ctx.orchestrator.hostResources.refreshObservationsForDetection();
			const healthyKinds = new Set<HostProbeKind>(
				probedKinds.filter((kind) =>
					model.health.some(
						(health) =>
							health.kind === kind &&
							(health.result === "ok" || health.result === "degraded") &&
							health.processBootId === model.processBootId &&
							health.kernelBootId === model.kernelBootId,
					),
				),
			);
			if (probedKinds.length === 0) {
				throw new HostStoreError(
					"Fresh host probe refresh is unavailable; no resource recommendations were produced",
					"INVALID_TRANSITION",
				);
			}
			const unavailableKinds = probedKinds.filter(
				(kind) => !healthyKinds.has(kind),
			);
			return {
				generation: model.generation,
				recommendations: detectHostResourceRecommendations(
					model,
					availableParallelism(),
					healthyKinds,
				),
				probe: {
					status:
						healthyKinds.size === 0
							? ("unavailable" as const)
							: unavailableKinds.length > 0
								? ("partial" as const)
								: ("fresh" as const),
					checkedAt: Date.now(),
					kinds: [...healthyKinds],
					unavailableKinds,
				},
			};
		}),

	applyDetected: publicProcedure
		.input(
			z
				.object({
					recommendations: z
						.array(z.object({ id, fingerprint }).strict())
						.min(1),
					expectedGeneration: z.bigint().nonnegative(),
				})
				.strict(),
		)
		.mutation(async ({ ctx, input }) => {
			const coordinator = ctx.orchestrator.hostResources;
			const model = coordinator.readModel();
			if (model.generation !== input.expectedGeneration) {
				throw new HostStoreError(
					"Host state changed after detection; review a fresh proposal",
					"STALE_VERSION",
				);
			}
			const detected = detectHostResourceRecommendations(
				model,
				availableParallelism(),
			);
			const requested = new Set(input.recommendations.map((item) => item.id));
			if (requested.size !== input.recommendations.length) {
				throw new HostStoreError("Detected resources must be unique");
			}
			const recommendations = input.recommendations.map((reviewed) => {
				const recommendation = detected.find((item) => item.id === reviewed.id);
				if (!recommendation) {
					throw new HostStoreError(
						"A detected resource is no longer available",
						"NOT_FOUND",
					);
				}
				if (recommendation.fingerprint !== reviewed.fingerprint) {
					throw new HostStoreError(
						"Detected resources changed after review; review a fresh proposal",
						"STALE_VERSION",
					);
				}
				if (!recommendation.canApply) {
					throw new HostStoreError(
						"A detected resource is already configured or conflicts with existing host state",
						"INVALID_TRANSITION",
					);
				}
				return recommendation;
			});

			return coordinator.applyDetectedResources(
				recommendations.map((recommendation) => ({
					definition: recommendation.definition,
					bindings: recommendation.bindings,
				})),
				{
					expectedGeneration: input.expectedGeneration,
					actor: "local-operator",
				},
			);
		}),

	audit: publicProcedure
		.input(
			z
				.object({
					after: z.bigint().nonnegative().optional(),
					limit: z.number().int().min(1).max(1_000).default(200),
				})
				.strict()
				.default({ limit: 200 }),
		)
		.query(({ ctx, input }) =>
			ctx.orchestrator.hostResources.auditEntries(input),
		),

	createDefinition: publicProcedure
		.input(definition.extend({ actor }).strict())
		.mutation(({ ctx, input }) => {
			const { actor: operator, ...values } = input;
			return ctx.orchestrator.hostResources.putDefinition(
				{ ...values, version: 1n },
				{ expectedVersion: null, actor: operator },
			);
		}),

	updateDefinition: publicProcedure
		.input(
			definition
				.extend({ expectedVersion: version, actor, reason: reason.optional() })
				.strict(),
		)
		.mutation(({ ctx, input }) => {
			const {
				expectedVersion,
				actor: operator,
				reason: why,
				...values
			} = input;
			return ctx.orchestrator.hostResources.putDefinition(
				{ ...values, version: expectedVersion },
				{ expectedVersion, actor: operator, reason: why },
			);
		}),

	setDrain: publicProcedure
		.input(
			z
				.object({
					resourceId: id,
					expectedVersion: version,
					draining: z.boolean(),
					actor,
					reason: reason.optional(),
				})
				.strict(),
		)
		.mutation(({ ctx, input }) =>
			ctx.orchestrator.hostResources.setDefinitionDrain(input),
		),

	setEnabled: publicProcedure
		.input(
			z
				.object({
					resourceId: id,
					expectedVersion: version,
					enabled: z.boolean(),
					actor,
					reason,
				})
				.strict(),
		)
		.mutation(({ ctx, input }) =>
			ctx.orchestrator.hostResources.setDefinitionEnabled(input),
		),

	createBinding: publicProcedure
		.input(binding.extend({ actor }).strict())
		.mutation(({ ctx, input }) => {
			const { actor: operator, ...values } = input;
			return ctx.orchestrator.hostResources.putBinding(
				{ ...values, version: 1n },
				{ expectedVersion: null, actor: operator },
			);
		}),

	updateBinding: publicProcedure
		.input(
			binding
				.extend({ expectedVersion: version, actor, reason: reason.optional() })
				.strict(),
		)
		.mutation(({ ctx, input }) => {
			const {
				expectedVersion,
				actor: operator,
				reason: why,
				...values
			} = input;
			return ctx.orchestrator.hostResources.putBinding(
				{ ...values, version: expectedVersion },
				{ expectedVersion, actor: operator, reason: why },
			);
		}),

	refresh: publicProcedure
		.input(z.object({}).strict().optional())
		.mutation(({ ctx }) =>
			ctx.orchestrator.hostResources.refreshObservations(),
		),

	reconcile: publicProcedure
		.input(z.object({}).strict().optional())
		.mutation(({ ctx }) => ctx.orchestrator.hostResources.reconcile("manual")),

	forceRelease: publicProcedure
		.input(
			z
				.object({
					leaseId: id,
					expectedFence: z.bigint().positive(),
					actor,
					reason,
					confirmed: z.literal(true),
				})
				.strict(),
		)
		.mutation(({ ctx, input }) => {
			const { confirmed: _confirmed, ...force } = input;
			return ctx.orchestrator.hostResources.forceRelease(force);
		}),
});
