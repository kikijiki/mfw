import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@mfw/board-core";

/**
 * The claim lease, as disposable machine state — never in markdown (ADR-0001's
 * sidecar boundary). `state/tasks/<ID>.json`, relative to the board root
 * (the directory `board.yaml` lives in).
 *
 * This is deliberately narrow: just enough for `claim`/`releaseClaim` to work
 * standalone, with the daemon stopped. Run-engine bookkeeping (attempt counts,
 * preserved worktrees, draft-expansion budgets) is orchestration state, not
 * board state, and stays in `@mfw/daemon`.
 */
export interface TaskLease {
	/**
	 * The attempt group that holds the claim. A group of one is named after its
	 * only run, so a pre-group sidecar's `claimedByRunId` value IS this id and
	 * the migration only renames the key.
	 */
	claimedByGroupId: string | null;
	/**
	 * Display only: the run that leads the holding group (the first attempt, or
	 * the latest continuation). Null means the group id is itself a run id.
	 */
	leadRunId?: string | null;
	claimedAt: number | null;
	leaseExpiresAt: number | null;
	statusChangedAt: number | null;
	/** The worktree the claim binds the task to, when known. */
	worktree: string | null;
}

export function emptyLease(): TaskLease {
	return {
		claimedByGroupId: null,
		leadRunId: null,
		claimedAt: null,
		leaseExpiresAt: null,
		statusChangedAt: null,
		worktree: null,
	};
}

function stateFile(root: string, id: string): string {
	return join(root, "state", "tasks", `${id}.json`);
}

export async function readLease(root: string, id: string): Promise<TaskLease> {
	try {
		const raw = JSON.parse(
			await readFile(stateFile(root, id), "utf8"),
		) as Partial<TaskLease> & { claimedByRunId?: string | null };
		// A sidecar written before attempt groups names its holder `claimedByRunId`;
		// the value is already the group id of a group of one.
		const { claimedByRunId: legacy, ...rest } = raw;
		return {
			...emptyLease(),
			...rest,
			claimedByGroupId: rest.claimedByGroupId ?? legacy ?? null,
		};
	} catch {
		return emptyLease();
	}
}

export async function writeLease(
	root: string,
	id: string,
	lease: TaskLease,
): Promise<void> {
	await mkdir(join(root, "state", "tasks"), { recursive: true });
	await writeFileAtomic(
		stateFile(root, id),
		`${JSON.stringify(lease, null, 2)}\n`,
	);
}

/**
 * Drop the claim binding for `id` (a no-op when none is held, so no state file
 * is created for a never-claimed task). Keeps the worktree-free, empty shape
 * `releaseClaim` writes.
 */
export async function clearLease(root: string, id: string): Promise<void> {
	const lease = await readLease(root, id);
	if (lease.claimedByGroupId === null && lease.leaseExpiresAt === null) return;
	await writeLease(root, id, {
		...emptyLease(),
		statusChangedAt: Date.now(),
	});
}
