import type { SettleClass } from "@mfw/core/events";
import type { ProjectDb, ProjectDbHandle, ProjectDbTx } from "@mfw/db/client";
import { engineKv } from "@mfw/db/schema";
import { eq } from "drizzle-orm";

/**
 * `awaiting_brain`: the tasks whose last run settled and which the brain has
 * not acted on yet (design §6.2). A hold, not a board status, so the board
 * does not churn: it lives in `engine_kv` beside the brain's other task holds.
 *
 * Written by the finalize `settle` step, cleared when the brain's effect
 * lands on the task (`BrainActionExecutor`), and pruned on read when the task
 * moved on by itself (a person moved it, a newer run started, it was deleted).
 * It survives a brain outage: when the brain session is failed the entries
 * stay put and the merge queue keeps draining.
 */

export const AWAITING_BRAIN_KEY = "brain_awaiting";

export interface AwaitingEntry {
	runId: string;
	class: SettleClass;
	groupId: string | null;
	/** Epoch ms of the settle. */
	at: number;
}
export type AwaitingBrain = Record<string, AwaitingEntry>;

type Db = Pick<ProjectDbHandle, "db" | "withTx">;

async function read(
	db: ProjectDb | ProjectDbTx,
): Promise<{ awaiting: AwaitingBrain }> {
	const [row] = await db
		.select()
		.from(engineKv)
		.where(eq(engineKv.key, AWAITING_BRAIN_KEY));
	const v = row?.value as { awaiting?: AwaitingBrain } | undefined;
	return { awaiting: v?.awaiting ?? {} };
}

export async function readAwaiting(handle: Db): Promise<AwaitingBrain> {
	return (await read(handle.db)).awaiting;
}

async function mutate(
	handle: Db,
	fn: (cur: AwaitingBrain) => AwaitingBrain,
): Promise<AwaitingBrain> {
	return handle.withTx(async (tx) => {
		const { awaiting } = await read(tx);
		const next = fn({ ...awaiting });
		await tx
			.insert(engineKv)
			.values({
				key: AWAITING_BRAIN_KEY,
				value: { awaiting: next },
				updatedAt: new Date(),
			})
			.onConflictDoUpdate({
				target: engineKv.key,
				set: { value: { awaiting: next }, updatedAt: new Date() },
			});
		return next;
	});
}

/** The newest settle for a task wins; a replayed settle is idempotent. */
export async function markAwaiting(
	handle: Db,
	taskId: string,
	entry: AwaitingEntry,
): Promise<void> {
	await mutate(handle, (cur) => {
		const prior = cur[taskId];
		if (prior && prior.at > entry.at) return cur;
		cur[taskId] = entry;
		return cur;
	});
}

/** The brain's effect landed on these tasks. Returns the ones that were awaiting. */
export async function clearAwaiting(
	handle: Db,
	taskIds: readonly string[],
): Promise<string[]> {
	if (taskIds.length === 0) return [];
	const cleared: string[] = [];
	await mutate(handle, (cur) => {
		for (const id of taskIds) {
			if (cur[id]) {
				cleared.push(id);
				delete cur[id];
			}
		}
		return cur;
	});
	return cleared;
}

/**
 * The live `awaiting_brain` set. An entry is dropped when the task moved on
 * without the brain: it is gone, a person moved it out of `ready` /
 * `in_progress`, or a run of it started after the settle (the brain's spawn
 * landed, or somebody started one by hand). Written back when it changed.
 */
export async function pruneAwaiting(
	handle: Db,
	deps: {
		tasks: { get(id: string): Promise<{ status: string } | null> };
		registry: {
			list(opts: {
				taskId: string;
			}): Promise<{ id: string; kind: string; startedAt: Date }[]>;
		};
	},
): Promise<AwaitingBrain> {
	const cur = await readAwaiting(handle);
	const drop: string[] = [];
	for (const [taskId, entry] of Object.entries(cur)) {
		const task = await deps.tasks.get(taskId);
		if (
			!task ||
			(task.status !== "ready" &&
				task.status !== "in_progress" &&
				task.status !== "draft")
		) {
			drop.push(taskId);
			continue;
		}
		const runs = await deps.registry.list({ taskId });
		if (
			runs.some(
				(r) =>
					r.kind !== "brain" &&
					r.id !== entry.runId &&
					r.startedAt.getTime() > entry.at,
			)
		) {
			drop.push(taskId);
		}
	}
	if (drop.length === 0) return cur;
	const next = await mutate(handle, (m) => {
		for (const id of drop) delete m[id];
		return m;
	});
	return next;
}
