import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@mfw/board-core";

/**
 * The claim lease, as disposable machine state — never in markdown (ADR-0001's
 * sidecar boundary). `.mfw/state/tasks/<ID>.json`, relative to the board root
 * (the directory `board.yaml` lives in).
 *
 * This is deliberately narrow: just enough for `claim`/`releaseClaim` to work
 * standalone, with the daemon stopped. Run-engine bookkeeping (attempt counts,
 * preserved worktrees, draft-expansion budgets) is orchestration state, not
 * board state, and stays in `@mfw/daemon`.
 */
export interface TaskLease {
	claimedByRunId: string | null;
	claimedAt: number | null;
	leaseExpiresAt: number | null;
	statusChangedAt: number | null;
	/** The worktree the claim binds the task to, when known. */
	worktree: string | null;
}

export function emptyLease(): TaskLease {
	return {
		claimedByRunId: null,
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
		) as Partial<TaskLease>;
		return { ...emptyLease(), ...raw };
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
	if (lease.claimedByRunId === null && lease.leaseExpiresAt === null) return;
	await writeLease(root, id, {
		...emptyLease(),
		statusChangedAt: Date.now(),
	});
}
