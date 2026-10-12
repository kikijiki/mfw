import { TASK_STATUSES } from "@mfw/core/types";
import {
	applyBoardConfigEdit,
	type BoardConfigPatch,
	patchFromTemplate,
	planBoardConfigEdit,
	readBoardConfig,
} from "@mfw/daemon/board-config-edit";
import { BOARD_TEMPLATES } from "@mfw/daemon/board-templates";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
	createTRPCRouter,
	projectProcedure,
	publicProcedure,
} from "../trpc.ts";

/**
 * BOARDCONFIG router: the board's own configuration (statuses and the daemon
 * role of each, task types, hierarchy depth) as an editable view, a dry-run
 * preview and an apply that validates before it writes. The daemon reads
 * `board.yaml` at attach, so an applied edit takes effect on restart.
 */

const patchSchema = z.object({
	statuses: z
		.array(
			z.object({
				value: z.string().min(1),
				role: z.enum(TASK_STATUSES as [string, ...string[]]),
			}),
		)
		.optional(),
	types: z.array(z.string()).optional(),
	maxDepth: z.number().int().nullable().optional(),
	defaultStatus: z.string().optional(),
	remapTo: z.record(z.string(), z.string()).optional(),
	renames: z.record(z.string(), z.string()).optional(),
});

/** An explicit patch, or a template's statuses/map plus the caller's remaps. */
const editInput = z.object({
	patch: patchSchema.optional(),
	template: z.string().min(1).optional(),
});

function resolvePatch(input: z.infer<typeof editInput>): BoardConfigPatch {
	const explicit = (input.patch ?? {}) as BoardConfigPatch;
	if (!input.template) return explicit;
	const fromTemplate = patchFromTemplate(input.template);
	if (!fromTemplate) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `no board template '${input.template}'`,
		});
	}
	return {
		...fromTemplate,
		...(explicit.remapTo ? { remapTo: explicit.remapTo } : {}),
		...(explicit.renames ? { renames: explicit.renames } : {}),
	};
}

export const boardConfigRouter = createTRPCRouter({
	/** Templates as statuses with their daemon role, to start a board edit from. */
	templates: publicProcedure.query(() =>
		BOARD_TEMPLATES.map(({ id, title, description }) => {
			const patch = patchFromTemplate(id);
			return {
				id,
				title,
				description,
				statuses: patch?.statuses ?? [],
				types: patch?.types ?? null,
			};
		}),
	),

	/** The editable view, including the raw yaml. */
	get: projectProcedure.query(({ ctx }) =>
		readBoardConfig(ctx.svc.boardDir, { stateDir: ctx.svc.mfwDir }),
	),

	/** Validate and diff without writing: `{ok:false,errors,orphans?}` or `{ok:true,yaml,diff,remaps,warnings}`. */
	preview: projectProcedure.input(editInput).mutation(({ ctx, input }) =>
		planBoardConfigEdit(ctx.svc.boardDir, resolvePatch(input), {
			stateDir: ctx.svc.mfwDir,
		}),
	),

	/** Apply: remap, write atomically and commit path-scoped; refusals come back as data. */
	save: projectProcedure.input(editInput).mutation(async ({ ctx, input }) => {
		const result = await applyBoardConfigEdit(
			ctx.svc.boardDir,
			resolvePatch(input),
			{
				stateDir: ctx.svc.mfwDir,
				integrationBranch: ctx.svc.integrationBranch,
			},
		);
		return { ...result, needsRestart: result.ok && result.changed };
	}),
});
