import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@mfw/board-core";
import type { ReopenCondition } from "./types.ts";

/**
 * Daemon-only run bookkeeping with no home in `@mfw/board`: attempt/stall/
 * resume counters, preserved-worktree pointers, and draft-expansion state.
 * `@mfw/board`'s `TaskLease` (`.mfw/state/tasks/<ID>.json`) only carries the
 * claim itself (`claimedByRunId`/`claimedAt`/`leaseExpiresAt`/
 * `statusChangedAt`) — this is everything else the old `TaskState` had,
 * at a sibling path so the two sidecars never collide:
 * `.mfw/state/tasks/<ID>.run.json`.
 */
export interface RunState {
	attemptCount: number;
	stallCount: number;
	resumeCount: number;
	preservedWorktree: string | null;
	preservedBranch: string | null;
	/** Consecutive failed expansion runs against a `draft` task. */
	draftAttempts: number;
	/** Expansion retries exhausted. Editing the captured intent clears it. */
	draftExhausted: boolean;
	/** Retained until the ready transition and one-shot field cleanup both finish. */
	reopenIntent?: { conditions: ReopenCondition[] };
	/** Last time anything about this task changed; `task-service.ts`'s `touch()`. */
	updatedAt: number | null;
}

export function emptyRunState(): RunState {
	return {
		attemptCount: 0,
		stallCount: 0,
		resumeCount: 0,
		preservedWorktree: null,
		preservedBranch: null,
		draftAttempts: 0,
		draftExhausted: false,
		updatedAt: null,
	};
}

function runStateFile(root: string, id: string): string {
	return join(root, "state", "tasks", `${id}.run.json`);
}

export async function readRunState(
	root: string,
	id: string,
): Promise<RunState> {
	try {
		const raw = JSON.parse(
			await readFile(runStateFile(root, id), "utf8"),
		) as Partial<RunState>;
		return { ...emptyRunState(), ...raw };
	} catch {
		return emptyRunState();
	}
}

export async function writeRunState(
	root: string,
	id: string,
	state: RunState,
): Promise<void> {
	await mkdir(join(root, "state", "tasks"), { recursive: true });
	await writeFileAtomic(
		runStateFile(root, id),
		`${JSON.stringify(state, null, 2)}\n`,
	);
}

/** Read, merge, write, return the new state — same merge semantics as the
 * old `TaskStore.patchState`. */
export async function patchRunState(
	root: string,
	id: string,
	patch: Partial<RunState> | ((state: RunState) => Partial<RunState>),
): Promise<RunState> {
	const current = await readRunState(root, id);
	const next = {
		...current,
		...(typeof patch === "function" ? patch(current) : patch),
	};
	await writeRunState(root, id, next);
	return next;
}
