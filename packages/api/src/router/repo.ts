import { z } from "zod";
import { createTRPCRouter, projectProcedure } from "../trpc.ts";

/**
 * The repository view: branches, worktrees, commits, compare. READ ONLY.
 *
 * One-line delegations on purpose, like `files`: ref and path validation is a
 * security property and lives in `RepoViewService` (`validateRefName`,
 * `validateRepoPath`), where it is tested directly. The zod shapes here only
 * bound length; they are not the check. A bad ref is BAD_REQUEST, an unknown
 * one NOT_FOUND.
 */
const ref = z.string().min(1).max(256);
const path = z.string().max(4096);

export const repoRouter = createTRPCRouter({
	/** Counts for the nav and the page header. */
	summary: projectProcedure.query(({ ctx }) => ctx.svc.repoView.summary()),

	/** Every branch and tag name, for the ref pickers. */
	refs: projectProcedure.query(({ ctx }) => ctx.svc.repoView.refs()),

	/** Local and remote-tracking branches with ahead/behind and mfw ownership. */
	branches: projectProcedure.query(({ ctx }) => ctx.svc.repoView.branches()),

	/** `git worktree list` joined with runs, merge jobs and wip archives. */
	worktrees: projectProcedure.query(({ ctx }) => ctx.svc.repoView.worktrees()),

	/** A branch's history, paged by an opaque cursor. */
	commits: projectProcedure
		.input(
			z.object({
				ref,
				exclude: ref.optional(),
				path: path.optional(),
				search: z.string().max(100).optional(),
				cursor: z.string().max(16).optional(),
				limit: z.number().int().min(1).max(200).optional(),
				firstParent: z.boolean().optional(),
			}),
		)
		.query(({ ctx, input }) => ctx.svc.repoView.commits(input)),

	/** One commit: message, parents, and its changed-file list. */
	commit: projectProcedure
		.input(z.object({ sha: ref }))
		.query(({ ctx, input }) => ctx.svc.repoView.commit(input)),

	/** Both sides of one file between two revisions (commit view, compare). */
	diffFile: projectProcedure
		.input(
			z.object({
				from: ref.optional(),
				to: ref,
				path: path.min(1),
				oldPath: path.optional(),
			}),
		)
		.query(({ ctx, input }) => ctx.svc.repoView.fileDiff(input)),

	/** `a...b` (three-dot, like a PR) or `a..b` (two-dot). */
	compare: projectProcedure
		.input(
			z.object({
				a: ref,
				b: ref,
				mode: z.enum(["three-dot", "two-dot"]).optional(),
			}),
		)
		.query(({ ctx, input }) => ctx.svc.repoView.compare(input)),

	/** A directory of a tree at any ref. */
	tree: projectProcedure
		.input(z.object({ ref, path: path.optional() }))
		.query(({ ctx, input }) => ctx.svc.repoView.tree(input)),

	/** A file at any ref. */
	blob: projectProcedure
		.input(z.object({ ref, path: path.min(1) }))
		.query(({ ctx, input }) => ctx.svc.repoView.blob(input)),

	/** Uncommitted changes of one worktree: `git diff HEAD` plus untracked. */
	worktreeChanges: projectProcedure
		.input(z.object({ id: z.string().min(1).max(64) }))
		.query(({ ctx, input }) => ctx.svc.repoView.worktreeChanges(input)),

	/** HEAD against the disk for one file of a worktree. */
	worktreeDiffFile: projectProcedure
		.input(
			z.object({
				id: z.string().min(1).max(64),
				path: path.min(1),
				oldPath: path.optional(),
			}),
		)
		.query(({ ctx, input }) => ctx.svc.repoView.worktreeFileDiff(input)),
});
