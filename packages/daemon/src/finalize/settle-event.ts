import type { SettleClass } from "@mfw/core/events";
import type { ProjectDbHandle } from "@mfw/db/client";
import { appendEvent, type EventBus } from "@mfw/db/eventlog";
import { events, groupIdOf } from "@mfw/db/schema";
import { and, eq } from "drizzle-orm";
import { markAwaiting } from "../brain-runtime/awaiting.ts";
import type { Logger } from "../log.ts";
import type { MergeJobView } from "../merge-queue.ts";
import type { RunRegistry } from "../run-registry.ts";
import type { TaskService } from "../task-service.ts";

/**
 * The write half of a settle, shared by finalize's `settle` step and by the
 * merge queue's parked jobs (class `merge_parked`): park the task
 * `awaiting_brain` and append `run.settled` once per run. The append is what
 * wakes the brain; a replay after a crash finds the event and does nothing.
 */
export async function recordSettled(
	deps: { handle: ProjectDbHandle; bus: EventBus },
	input: {
		runId: string;
		taskId: string | null;
		groupId: string | null;
		class: SettleClass;
		facts: Record<string, unknown>;
		at?: number;
	},
): Promise<{ appended: boolean }> {
	const at = input.at ?? Date.now();
	if (input.taskId) {
		await markAwaiting(deps.handle, input.taskId, {
			runId: input.runId,
			class: input.class,
			groupId: input.groupId,
			at,
		});
	}
	const [already] = await deps.handle.db
		.select({ seq: events.seq })
		.from(events)
		.where(and(eq(events.type, "run.settled"), eq(events.runId, input.runId)))
		.limit(1);
	if (already) return { appended: false };
	const stored = await deps.handle.withTx((tx) =>
		appendEvent(
			tx,
			{
				type: "run.settled",
				runId: input.runId,
				...(input.taskId ? { taskId: input.taskId } : {}),
				payload: {
					groupId: input.groupId,
					class: input.class,
					facts: input.facts,
				},
			},
			at,
		),
	);
	deps.bus.publish([stored]);
	return { appended: true };
}

/**
 * A merge job that exhausted its automatic retries (rebase and re-verify
 * against the current tip, each time) is the `merge_parked` settle: the
 * task goes back to `ready` with its worktree and branch kept, the run ends
 * failed, the job is closed (the inbox does not carry it) and the brain is
 * woken to choose a conflict-resolution run, another attempt, or a person.
 * Nothing here spawns a run or pages anyone.
 */
export async function settleParkedMerge(
	deps: {
		handle: ProjectDbHandle;
		bus: EventBus;
		registry: Pick<RunRegistry, "get" | "finish">;
		tasks: Pick<TaskService, "release" | "recordPreservedWorktree">;
		mergeQueue: { abandon(jobId: number): Promise<void> };
		log: Logger;
	},
	job: MergeJobView,
	reason: string,
	kind: "conflict" | "reverify",
): Promise<void> {
	const run = await deps.registry.get(job.runId);
	if (job.taskId) {
		if (run?.worktreePath && run.branch) {
			await deps.tasks
				.recordPreservedWorktree(job.taskId, run.worktreePath, run.branch)
				.catch(() => {
					// best-effort: the pointer only helps the brain's continuation
				});
		}
		await deps.tasks.release(
			job.taskId,
			job.runId,
			"ready",
			"scheduler",
			reason,
		);
	}
	await deps.registry.finish(job.runId, "failed", reason);
	await deps.mergeQueue.abandon(job.id).catch((e) => {
		deps.log.warn({ err: e, job: job.id }, "could not close the parked job");
	});
	await recordSettled(deps, {
		runId: job.runId,
		taskId: job.taskId ?? null,
		groupId: run ? groupIdOf(run) : null,
		class: "merge_parked",
		facts: {
			reason,
			kind,
			mergeJobId: job.id,
			target: job.targetBranch,
			branch: job.branch,
			retries: job.parkRetries,
			worktree: run?.worktreePath ?? null,
		},
	});
}
