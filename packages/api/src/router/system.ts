import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
	dispatchStatusAll,
	setDispatching,
	setGlobalDispatching,
} from "@mfw/daemon/dispatch";
import { buildDigest } from "@mfw/daemon/history";
import { z } from "zod";
import {
	createTRPCRouter,
	projectProcedure,
	publicProcedure,
} from "../trpc.ts";

async function isRepositoryRoot(path: string): Promise<boolean> {
	return stat(join(path, ".git"))
		.then((entry) => entry.isDirectory() || entry.isFile())
		.catch(() => false);
}

/**
 * Lists one directory for the repository picker. Runs on the daemon because
 * browsers never reveal absolute paths and the daemon may be on another machine.
 */
async function listProjectDirectory(
	requested: string | undefined,
	attachedRoots: Set<string>,
) {
	const path = await realpath(resolve(requested?.trim() || homedir()));
	const info = await stat(path);
	if (!info.isDirectory()) throw new Error(`${path} is not a directory`);

	const children = await readdir(path, { withFileTypes: true });
	const directories = (
		await Promise.all(
			children
				.filter((entry) => entry.name !== ".git")
				.map(async (entry) => {
					const child = join(path, entry.name);
					const isDirectory = entry.isDirectory()
						? true
						: entry.isSymbolicLink()
							? await stat(child)
									.then((value) => value.isDirectory())
									.catch(() => false)
							: false;
					if (!isDirectory) return null;
					const resolved = await realpath(child).catch(() => child);
					return {
						name: entry.name,
						path: resolved,
						isRepository: await isRepositoryRoot(resolved),
						attached: attachedRoots.has(resolved),
					};
				}),
		)
	).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

	directories.sort(
		(a, b) =>
			Number(b.isRepository) - Number(a.isRepository) ||
			a.name.localeCompare(b.name),
	);

	return {
		path,
		name: basename(path),
		parent: dirname(path) === path ? null : dirname(path),
		isRepository: await isRepositoryRoot(path),
		attached: attachedRoots.has(path),
		directories,
	};
}

/** Health, metrics, scheduler control, and the HISTORY digest. */
export const systemRouter = createTRPCRouter({
	/** Real liveness, not a config echo: loop staleness, queue depth, counts. */
	health: publicProcedure.query(async ({ ctx }) => {
		const projects = [];
		for (const svc of ctx.orchestrator.list()) {
			projects.push({ project: svc.name, ...(await svc.health.snapshot()) });
		}
		return {
			bootId: ctx.orchestrator.bootId,
			startedAt: ctx.orchestrator.startedAt,
			projects,
		};
	}),

	metrics: projectProcedure
		.input(z.object({ windowMs: z.number().int().positive().optional() }))
		.query(({ ctx, input }) => ctx.svc.health.metrics(input.windowMs)),

	/** One call answers "why is this task here" (runs + decisions + events). */
	taskTrace: projectProcedure
		.input(z.object({ taskId: z.string() }))
		.query(({ ctx, input }) => ctx.svc.health.taskTrace(input.taskId)),

	/** Dispatch control. `status` is the truthful read; `set` is the play/stop button and moves both switches (see `@mfw/daemon/dispatch`). */
	scheduler: createTRPCRouter({
		status: projectProcedure.query(({ ctx }) => ctx.svc.scheduler.status()),
		set: projectProcedure
			.input(
				z.object({
					enabled: z.boolean(),
					reason: z.string().min(1).optional(),
				}),
			)
			.mutation(({ ctx, input }) =>
				setDispatching(ctx.svc, input.enabled, input.reason),
			),
		/** Every project's switch, the tri-state summary and the master switch. */
		all: publicProcedure.query(({ ctx }) =>
			dispatchStatusAll(
				ctx.orchestrator.list(),
				ctx.orchestrator.globalDispatch.paused() === null,
			),
		),
		/**
		 * Master stop: one machine-wide switch, ANDed with each project's own.
		 * Deliberately not a fan-out, so projects keep their own setting while it is off.
		 */
		setGlobal: publicProcedure
			.input(
				z.object({
					enabled: z.boolean(),
					reason: z.string().min(1).optional(),
				}),
			)
			.mutation(async ({ ctx, input }) => {
				await setGlobalDispatching(
					ctx.orchestrator.globalDispatch,
					input.enabled,
					input.reason,
				);
				return dispatchStatusAll(
					ctx.orchestrator.list(),
					ctx.orchestrator.globalDispatch.paused() === null,
				);
			}),
		/** Wakes the scheduler loop. */
		kick: projectProcedure.mutation(({ ctx }) => {
			ctx.svc.scheduler.wake();
			return { ok: true };
		}),
		hold: projectProcedure
			.input(z.object({ untilMs: z.number().int(), reason: z.string() }))
			.mutation(async ({ ctx, input }) => {
				await ctx.svc.scheduler.hold(input.untilMs, input.reason);
				return ctx.svc.scheduler.status();
			}),
	}),

	/** "While you were away": the audit stream folded into readable prose, across projects. */
	digest: publicProcedure
		.input(z.object({ sinceSeq: z.record(z.string(), z.number()).default({}) }))
		.query(async ({ ctx, input }) => {
			const digests = [];
			for (const svc of ctx.orchestrator.list()) {
				const since = input.sinceSeq[svc.name] ?? 0;
				const events = await svc.events.since(since, 2000);
				// Current board state, so present-tense claims come from it rather than a replay.
				const board = new Map(
					(await svc.tasks.list()).map((t) => [t.id, t.status as string]),
				);
				digests.push(
					buildDigest(svc.name, since, events, (id) => board.get(id)),
				);
			}
			return {
				digests,
				needsAttention: digests.some((d) => d.needsAttention),
			};
		}),

	/** A query, not a `projects` sub-router: a tRPC path cannot be both a procedure and a router. */
	projects: publicProcedure.query(({ ctx }) =>
		ctx.orchestrator.list().map((s) => ({
			name: s.name,
			root: s.root,
			integrationBranch: s.integrationBranch,
		})),
	),

	/** A daemon-side folder browser used by the sidebar's project picker. */
	projectDirectory: publicProcedure
		.input(z.object({ path: z.string().optional() }))
		.query(async ({ ctx, input }) => {
			const attachedRoots = await Promise.all(
				ctx.orchestrator
					.list()
					.map((project) => realpath(project.root).catch(() => project.root)),
			);
			return listProjectDirectory(input.path, new Set(attachedRoots));
		}),

	/** Attach a repository. The path must be a git repo root, validated before anything is persisted. */
	addProject: publicProcedure
		.input(
			z.object({
				name: z.string().min(1).optional(),
				root: z.string().min(1),
				boardRoot: z.string().min(1).optional(),
				integrationBranch: z.string().min(1).optional(),
				model: z.string().min(1).optional(),
				schedulerAutostart: z.boolean().optional(),
				assistance: z
					.object({
						failureDiagnosis: z.enum(["assisted", "escalate"]),
						conflictResolution: z.enum(["assisted", "escalate"]),
						changeReview: z.enum(["off", "assisted", "human"]),
					})
					.optional(),
				maxConcurrent: z.number().int().positive().max(64).optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const names = new Set(
				ctx.orchestrator.list().map((project) => project.name),
			);
			const baseName = input.name?.trim() || basename(resolve(input.root));
			let name = baseName;
			for (let suffix = 2; names.has(name); suffix++) {
				name = `${baseName}-${suffix}`;
			}
			const svc = await ctx.orchestrator.attach({ ...input, name });
			return {
				name: svc.name,
				root: svc.root,
				integrationBranch: svc.integrationBranch,
			};
		}),

	/**
	 * Detach a project: stops its loops, closes its database, releases its lock
	 * and drops it from config.json. Repo code and `.mfw` data are kept; shutdown
	 * may first commit a pending board change.
	 */
	removeProject: publicProcedure
		// Zod strips retired fields (e.g. the old deleteMfwData) sent by stale browser tabs.
		.input(z.object({ name: z.string().min(1) }))
		.mutation(({ ctx, input }) => ctx.orchestrator.detach(input.name)),
});
