import { recordHumanAction } from "@mfw/daemon/human-actions";
import { RoutingError, resolveProviderRef } from "@mfw/daemon/routing";
import type { ProjectServices } from "@mfw/daemon/services";
import { TaskClaimedError } from "@mfw/daemon/task-service";
import {
	LocalStagingResourceRequirementSchema,
	MODEL_TIERS,
	OwnsSchema,
	ReopenConditionSchema,
	TaskResourceRequirementSchema,
	VerificationPlanSchema,
} from "@mfw/daemon/tasks/types";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createTRPCRouter, projectProcedure } from "../trpc.ts";

/** Tasks router. Inputs are validated here; the server owns markdown serialization. */

const statusEnum = z.enum([
	"draft",
	"backlog",
	"ready",
	"in_progress",
	"blocked",
	"review",
	"done",
	"archived",
]);
const creatableStatusEnum = z.enum([
	"backlog",
	"ready",
	"in_progress",
	"blocked",
	"review",
	"done",
	"archived",
]);

/** Routing pin: a harness (`claude-cli`, `codex-cli`) or a project endpoint id; null clears. */
const providerPin = z
	.string()
	.regex(/^[A-Za-z0-9_-]+$/)
	.nullish();
/** Routing pin: an exact model id; null clears. */
const modelPin = z.string().trim().min(1).nullish();

/** Refuse a provider pin the project cannot route, with the fix, before anything is written. */
async function assertRoutable(
	svc: ProjectServices,
	provider: string | null | undefined,
): Promise<void> {
	if (!provider) return;
	const { values } = await svc.settings.get();
	try {
		resolveProviderRef(provider, values.routing);
	} catch (e) {
		if (e instanceof RoutingError)
			throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
		throw e;
	}
}

type MoveInput = {
	id: string;
	to: z.infer<typeof statusEnum>;
	reason?: string | undefined;
	cancelRun?: boolean | undefined;
	discard?: boolean | undefined;
};

/** The guarded human move, with the cancel-run escape. */
async function moveTask(svc: ProjectServices, input: MoveInput) {
	try {
		return await svc.tasks.move(input.id, input.to, "human", input.reason, {
			discard: input.discard,
		});
	} catch (e) {
		if (!(e instanceof TaskClaimedError) || !input.cancelRun) throw e;
		// Stopping a run that already committed work and closing its task
		// would strand that work: refuse before killing anything.
		await svc.tasks.assertClosable(input.id, input.to);
		try {
			await svc.engine.stop(e.runId);
		} catch (stopErr) {
			// Best-effort: the run may already be dead; the claim is cleared anyway.
			svc.log.warn(
				{ err: stopErr, runId: e.runId, taskId: input.id },
				"cancelRun: engine.stop failed, releasing the claim anyway",
			);
		}
		svc.supervisor.wake(); // finalize promptly, never inline
		const released = await svc.tasks.release(
			input.id,
			e.runId,
			input.to,
			"human",
			input.reason,
		);
		// Claim was reassigned since the guard (a resume): re-run the guarded
		// move so a live claim surfaces as a conflict.
		return (
			released ??
			(await svc.tasks.move(input.id, input.to, "human", input.reason))
		);
	}
}

/** One acceptance criterion; `id` is the checklist item id as read (omit for a new item). */
const criterionInput = z.object({
	id: z.string().min(1).optional(),
	text: z.string().min(1),
	checked: z.boolean().default(false),
});

/** One operation on the acceptance checklist; a selector is an item id or a unique text prefix. */
const criteriaOpInput = z.discriminatedUnion("op", [
	z.object({
		op: z.literal("add"),
		text: z.string().min(1),
		checked: z.boolean().optional(),
	}),
	z.object({ op: z.literal("toggle"), selector: z.string().min(1) }),
	z.object({ op: z.literal("remove"), selector: z.string().min(1) }),
	z.object({
		op: z.literal("set"),
		selector: z.string().min(1),
		checked: z.boolean(),
	}),
	z.object({
		op: z.literal("edit"),
		selector: z.string().min(1),
		text: z.string().min(1),
	}),
]);

/** Shared core schema: the parser, verifier and this endpoint all validate against it. */
const verificationInput = VerificationPlanSchema.nullable();

export const tasksRouter = createTRPCRouter({
	list: projectProcedure
		.input(z.object({ status: statusEnum.optional() }))
		.query(({ ctx, input }) => ctx.svc.tasks.list(input.status)),

	get: projectProcedure
		.input(z.object({ id: z.string() }))
		.query(({ ctx, input }) => ctx.svc.tasks.get(input.id)),

	graph: projectProcedure.query(({ ctx }) => ctx.svc.tasks.graph()),

	/** Unfinished tasks whose `owns` overlap with no dependency ordering them. */
	ownershipConflicts: projectProcedure.query(({ ctx }) =>
		ctx.svc.tasks.ownershipConflicts(),
	),

	/** The template a task of this type is written against, or null. */
	template: projectProcedure
		.input(
			z.object({
				type: z.enum(["implementation", "spike", "epic", "maintenance"]),
			}),
		)
		.query(({ ctx, input }) => ctx.svc.tasks.templateFor(input.type)),

	create: projectProcedure
		.input(
			z.object({
				title: z.string().min(1),
				body: z.string().default(""),
				type: z
					.enum(["implementation", "spike", "epic", "maintenance"])
					.default("implementation"),
				priority: z
					.enum(["critical", "high", "medium", "low"])
					.default("medium"),
				size: z.enum(["xs", "s", "m", "l", "xl"]).nullish(),
				labels: z.array(z.string()).default([]),
				dependsOn: z.array(z.string()).default([]),
				criteria: z.array(criterionInput).default([]),
				verification: verificationInput.optional(),
				/** @deprecated Legacy request field. */
				dod: verificationInput.optional(),
				requiresResources: z.array(TaskResourceRequirementSchema).default([]),
				executionTarget: z.string().min(1).default("local"),
				localStagingResources: z
					.array(LocalStagingResourceRequirementSchema)
					.default([]),
				requireReview: z.boolean().default(false),
				owns: OwnsSchema.default([]),
				modelTier: z.enum(MODEL_TIERS).nullish(),
				provider: providerPin,
				model: modelPin,
				reopenWhen: z.array(ReopenConditionSchema).default([]),
				/** Usually omitted (backlog, through the DoR gate); lets a human file straight into `ready`. */
				status: creatableStatusEnum.optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await assertRoutable(ctx.svc, input.provider);
			const created = await ctx.svc.tasks.create({
				...input,
				readyMode: input.status === "backlog" ? "manual" : "automatic",
				source: "human",
			});
			await recordHumanAction(ctx.svc, {
				action: "tasks.create",
				taskId: created.id,
				input: {
					title: input.title,
					type: input.type,
					...(input.status ? { status: input.status } : {}),
				},
			});
			return created;
		}),

	/** Quick capture: one line in, a `draft` card out with no LLM call. Expansion runs async with bounded retries; the raw text is kept as `draftPrompt`. */
	captureQuick: projectProcedure
		.input(
			z.object({
				text: z.string().min(1),
				afterExpansion: z.enum(["backlog", "ready"]).default("ready"),
				requireReview: z.boolean().default(false),
				/** Stable across retries so a lost mobile response cannot duplicate. */
				requestId: z.string().min(1).max(128).optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const captured = await ctx.svc.tasks.captureQuick(
				input.text,
				input.requestId,
				input.afterExpansion,
				input.requireReview,
			);
			await recordHumanAction(ctx.svc, {
				action: "tasks.capture",
				taskId: captured.id,
				input: { afterExpansion: input.afterExpansion },
			});
			return captured;
		}),

	/** `baseRev` is the optimistic-concurrency token; omitting it is last-write-wins. The UI always sends it so concurrent edits raise CONFLICT. */
	update: projectProcedure
		.input(
			z.object({
				id: z.string(),
				baseRev: z.number().int().optional(),
				patch: z.object({
					title: z.string().min(1).optional(),
					body: z.string().optional(),
					type: z
						.enum(["implementation", "spike", "epic", "maintenance"])
						.optional(),
					priority: z.enum(["critical", "high", "medium", "low"]).optional(),
					size: z.enum(["xs", "s", "m", "l", "xl"]).nullish(),
					labels: z.array(z.string()).optional(),
					dependsOn: z.array(z.string()).optional(),
					criteria: z.array(criterionInput).optional(),
					verification: verificationInput.optional(),
					/** @deprecated Legacy request field. */
					dod: verificationInput.optional(),
					requiresResources: z.array(TaskResourceRequirementSchema).optional(),
					executionTarget: z.string().min(1).optional(),
					localStagingResources: z
						.array(LocalStagingResourceRequirementSchema)
						.optional(),
					requireReview: z.boolean().optional(),
					afterExpansion: z.enum(["backlog", "ready"]).optional(),
					owns: OwnsSchema.optional(),
					modelTier: z.enum(MODEL_TIERS).nullish(),
					provider: providerPin,
					model: modelPin,
					reopenWhen: z.array(ReopenConditionSchema).optional(),
				}),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await assertRoutable(ctx.svc, input.patch.provider);
			const edited = await ctx.svc.tasks.edit(input.id, input.patch, {
				baseRev: input.baseRev,
				source: "api",
			});
			await recordHumanAction(ctx.svc, {
				action: "tasks.update",
				taskId: input.id,
				input: {
					fields: Object.keys(input.patch),
					...(input.baseRev !== undefined ? { baseRev: input.baseRev } : {}),
				},
			});
			return edited;
		}),

	/** One acceptance checklist operation, applied under the task's lock (concurrent toggles both land). A board rule that refuses it is `PRECONDITION_FAILED`, listing the violations. */
	criteria: projectProcedure
		.input(
			z.object({
				id: z.string(),
				baseRev: z.number().int().optional(),
				op: criteriaOpInput,
			}),
		)
		.mutation(({ ctx, input }) =>
			ctx.svc.tasks.editCriteria(input.id, input.op, {
				baseRev: input.baseRev,
				source: "api",
			}),
		),

	/** Moving a claimed task fails with `PRECONDITION_FAILED` (`TaskClaimedError`) unless `cancelRun` is set, which kills the run and releases the claim with the status change. */
	move: projectProcedure
		.input(
			z.object({
				id: z.string(),
				to: statusEnum,
				reason: z.string().optional(),
				cancelRun: z.boolean().optional(),
				/** Closing (done/archived) over unmerged work: save it to `wip/` and remove the branch instead of refusing with `TaskUnmergedError`. */
				discard: z.boolean().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const moved = await moveTask(ctx.svc, input);
			await recordHumanAction(ctx.svc, {
				action: "tasks.move",
				taskId: input.id,
				reason: input.reason ?? null,
				input: {
					to: input.to,
					...(input.cancelRun ? { cancelRun: true } : {}),
					...(input.discard ? { discard: true } : {}),
				},
			});
			return moved;
		}),

	/** Moves a column's cards through the guarded transition path; `from` stops a stale screen moving cards that changed state. */
	moveMany: projectProcedure
		.input(
			z.object({
				ids: z.array(z.string()).min(1).max(500),
				from: statusEnum,
				to: statusEnum,
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const result = await ctx.svc.tasks.moveMany(
				input.ids,
				input.from,
				input.to,
				"human",
			);
			for (const id of result.moved) {
				await recordHumanAction(ctx.svc, {
					action: "tasks.move",
					taskId: id,
					input: { from: input.from, to: input.to, bulk: true },
				});
			}
			return result;
		}),

	/** Approval goes through the merge queue, the single serialized path to the integration branch. */
	approve: projectProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const task = await ctx.svc.tasks.get(input.id);
			if (!task) throw new Error(`unknown task ${input.id}`);
			if (task.status !== "review")
				throw new Error(
					`task ${input.id} is not awaiting review (status: ${task.status})`,
				);
			// Newest first: a re-dispatched task has older stale branches, and
			// ReviewService shows the newest; merge the diff that was reviewed.
			const runs = await ctx.svc.registry.list({ taskId: input.id });
			const run = runs
				.filter((r) => r.branch)
				.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
			if (!run?.branch)
				throw new Error(`task ${input.id} has no branch to merge`);
			await ctx.svc.mergeQueue.enqueue({
				runId: run.id,
				taskId: input.id,
				branch: run.branch,
				targetBranch: run.integrationBranch ?? ctx.svc.integrationBranch,
			});
			return { queued: true };
		}),

	/** The reason is required: it feeds the next run's prompt. */
	reject: projectProcedure
		.input(z.object({ id: z.string(), reason: z.string().min(1) }))
		.mutation(({ ctx, input }) =>
			ctx.svc.review.reject(input.id, input.reason),
		),

	/** Archive every finished run of the task to `wip/` and remove its worktrees and branches. PRECONDITION_FAILED (`RunLiveError`) while one is live. */
	discard: projectProcedure
		.input(z.object({ id: z.string() }))
		.mutation(({ ctx, input }) => ctx.svc.lifecycle.discardTask(input.id)),

	promoteReady: projectProcedure.mutation(({ ctx }) =>
		ctx.svc.tasks.promoteReady(),
	),

	/** Delete one task. Irreversible here; see `wipe` on the git safety net. */
	remove: projectProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const removed = await ctx.svc.tasks.remove(input.id);
			if (removed) {
				await recordHumanAction(ctx.svc, {
					action: "tasks.remove",
					taskId: input.id,
				});
			}
			return { removed };
		}),

	/**
	 * Delete every task on the board. `confirm` is a typed literal so a default or
	 * stale form value cannot trigger it. The response reports whether the board
	 * is git-tracked, the only recovery path.
	 */
	wipe: projectProcedure
		.input(z.object({ confirm: z.literal("wipe the board") }))
		.mutation(async ({ ctx }) => {
			const { deleted } = await ctx.svc.tasks.wipe();
			const versioned = ctx.svc.board.isEnabled;
			return {
				deleted: deleted.length,
				ids: deleted,
				versioned,
				recovery: versioned
					? "The board is tracked in git: `git revert` the mfw commit that " +
						"removed these files, or `git checkout <sha> -- tasks`."
					: "This board is NOT in git (not a repository, or tasks/ is " +
						"ignored). Nothing here is recoverable.",
			};
		}),
	// --- spec and attachments ---

	/** The task's `spec.md` (empty when it has none) and the hash to save against. */
	getSpec: projectProcedure
		.input(z.object({ id: z.string() }))
		.query(async ({ ctx, input }) => {
			const doc = await ctx.svc.tasks.getSpec(input.id);
			if (!doc) throw new TRPCError({ code: "NOT_FOUND" });
			return doc;
		}),

	/** `baseHash` is the hash from `getSpec`; a stale one is a CONFLICT. */
	setSpec: projectProcedure
		.input(
			z.object({
				id: z.string(),
				body: z.string(),
				baseHash: z.string().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const doc = await ctx.svc.tasks.setSpec(
				input.id,
				input.body,
				input.baseHash,
			);
			if (!doc) throw new TRPCError({ code: "NOT_FOUND" });
			return doc;
		}),

	listAttachments: projectProcedure
		.input(z.object({ id: z.string() }))
		.query(async ({ ctx, input }) => {
			const list = await ctx.svc.tasks.listTaskAttachments(input.id);
			if (!list) throw new TRPCError({ code: "NOT_FOUND" });
			return list;
		}),

	/** Upload one attachment as base64. Size caps live in the daemon; the zod bound only rejects absurd payloads before decoding (5 MiB is ~7 MiB of base64). */
	addAttachment: projectProcedure
		.input(
			z.object({
				id: z.string(),
				name: z.string().min(1).max(200),
				dataBase64: z
					.string()
					.min(1)
					.max(8 * 1024 * 1024),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const info = await ctx.svc.tasks.addAttachment(
				input.id,
				input.name,
				Buffer.from(input.dataBase64, "base64"),
			);
			if (!info) throw new TRPCError({ code: "NOT_FOUND" });
			return info;
		}),

	removeAttachment: projectProcedure
		.input(z.object({ id: z.string(), name: z.string().min(1).max(200) }))
		.mutation(async ({ ctx, input }) => ({
			removed: await ctx.svc.tasks.removeAttachment(input.id, input.name),
		})),
});
