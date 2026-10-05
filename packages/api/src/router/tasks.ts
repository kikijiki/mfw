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

const criterionInput = z.object({
	text: z.string().min(1),
	checked: z.boolean().default(false),
});

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
				reopenWhen: z.array(ReopenConditionSchema).default([]),
				/** Usually omitted (backlog, through the DoR gate); lets a human file straight into `ready`. */
				status: creatableStatusEnum.optional(),
			}),
		)
		.mutation(({ ctx, input }) =>
			ctx.svc.tasks.create({
				...input,
				readyMode: input.status === "backlog" ? "manual" : "automatic",
				source: "human",
			}),
		),

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
		.mutation(({ ctx, input }) =>
			ctx.svc.tasks.captureQuick(
				input.text,
				input.requestId,
				input.afterExpansion,
				input.requireReview,
			),
		),

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
					reopenWhen: z.array(ReopenConditionSchema).optional(),
				}),
			}),
		)
		.mutation(({ ctx, input }) =>
			ctx.svc.tasks.edit(input.id, input.patch, {
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
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				return await ctx.svc.tasks.move(
					input.id,
					input.to,
					"human",
					input.reason,
				);
			} catch (e) {
				if (!(e instanceof TaskClaimedError) || !input.cancelRun) throw e;
				try {
					await ctx.svc.engine.stop(e.runId);
				} catch (stopErr) {
					// Best-effort: the run may already be dead; the claim is cleared anyway.
					ctx.svc.log.warn(
						{ err: stopErr, runId: e.runId, taskId: input.id },
						"cancelRun: engine.stop failed, releasing the claim anyway",
					);
				}
				ctx.svc.supervisor.wake(); // finalize promptly, never inline
				const released = await ctx.svc.tasks.release(
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
					(await ctx.svc.tasks.move(input.id, input.to, "human", input.reason))
				);
			}
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
		.mutation(({ ctx, input }) =>
			ctx.svc.tasks.moveMany(input.ids, input.from, input.to, "human"),
		),

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

	/** The reason is required: it feeds the repair prompt. */
	reject: projectProcedure
		.input(z.object({ id: z.string(), reason: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const task = await ctx.svc.tasks.get(input.id);
			if (!task) throw new Error(`unknown task ${input.id}`);
			if (task.status !== "review")
				throw new Error(
					`task ${input.id} is not awaiting review (status: ${task.status})`,
				);
			return ctx.svc.tasks.move(input.id, "ready", "human", input.reason);
		}),

	promoteReady: projectProcedure.mutation(({ ctx }) =>
		ctx.svc.tasks.promoteReady(),
	),

	/** Delete one task. Irreversible here; see `wipe` on the git safety net. */
	remove: projectProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ ctx, input }) => ({
			removed: await ctx.svc.tasks.remove(input.id),
		})),

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
						"removed these files, or `git checkout <sha> -- .mfw/tasks`."
					: "This board is NOT in git (not a repository, or .mfw/tasks is " +
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
