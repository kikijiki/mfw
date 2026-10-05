import { join } from "node:path";
import {
	type BoardConfig,
	type BoardDocument,
	type BoardStore,
	effectiveDependencies,
	isTerminal,
	KeyedLock,
	overlappingPatterns,
} from "@mfw/board-core";
import { readLease, writeLease } from "./state.ts";

/**
 * mfw's orchestration semantics, layered on `@mfw/board-core`'s generic
 * `BoardStore.transact` primitive. None of this is expressible in `board.yaml`
 * (workflow enforcement beyond structure is out of scope for the generic
 * engine).
 *
 * `transact`'s per-document lock is NOT enough on its own here: ownership
 * overlap is a cross-document decision (does claiming THIS task race some
 * OTHER currently-active task's declared scope?), so two different tasks
 * being claimed at once could each see the other as "not yet active" and both
 * proceed. A single named `claim` lock, held for the whole decide-then-write
 * sequence, is what actually serializes claims against each other — ordinary
 * field edits on unrelated tasks are untouched by it (they only take their own
 * per-document lock via `transact`/`updateDocument`).
 */

export class TaskOwnershipHeldError extends Error {
	readonly code = "owns-overlap";
	constructor(
		readonly taskId: string,
		readonly waitingFor: readonly string[],
		readonly patterns: readonly [string, string][],
	) {
		super(
			`${taskId} is held by overlapping ownership from ${waitingFor.join(", ")}: ` +
				`${patterns.map(([a, b]) => `${a} ↔ ${b}`).join(", ")}`,
		);
		this.name = "TaskOwnershipHeldError";
	}
}

export interface ClaimConfig {
	/** The board root: the directory `board.yaml` lives in. */
	root: string;
	/** Field names, so this stays decoupled from any one `board.yaml`'s choices. */
	statusField: string;
	dependsOnField: string;
	ownsField: string;
	/** The status value that satisfies a dependency / marks "currently active". */
	doneStatus: string;
	activeStatus: string;
	/**
	 * The board config. When the task type declares `statusClasses`, a claim's
	 * dependency precondition is the `ready` rule (every effective dependency,
	 * `depends_on` plus hierarchy children, in the terminal class). Without it,
	 * or without status classes, dependencies are compared to `doneStatus`.
	 */
	boardConfig?: BoardConfig;
}

/** The named lock that serializes claims and the CLI's transitions. */
export function withClaimLock<T>(
	cfg: Pick<ClaimConfig, "root">,
	fn: () => Promise<T>,
): Promise<T> {
	return new KeyedLock(join(cfg.root, "locks")).with("::claim", fn);
}

/** Are all of `self`'s dependencies satisfied, given every task document? */
function dependenciesMet(
	cfg: ClaimConfig,
	self: BoardDocument,
	all: readonly BoardDocument[],
): boolean {
	const byId = new Map(all.map((d) => [d.id, d]));
	byId.set(self.id, self);
	const config = cfg.boardConfig;
	if (config?.types[self.type]?.workflow?.classes.terminal.length) {
		const deps =
			effectiveDependencies(config, [...byId.values()]).get(self.id) ?? [];
		return deps.every((id) => {
			const d = byId.get(id);
			return (
				d !== undefined &&
				isTerminal(
					config,
					d.type,
					d.fields[config.types[d.type]?.workflow?.statusField ?? "status"],
				)
			);
		});
	}
	const deps = (self.fields[cfg.dependsOnField] as string[] | undefined) ?? [];
	return deps.every(
		(id) => byId.get(id)?.fields[cfg.statusField] === cfg.doneStatus,
	);
}

/**
 * Claim a task. By default (`opts.start` true) this is claim-and-start under
 * one lock: `fromStatus → cfg.activeStatus`. With `start: false` it only BINDS
 * the task (lease + optional worktree) and never changes status; the task may
 * be in `fromStatus` or already `cfg.activeStatus`.
 *
 * Either way it refuses unless every dependency is done and no OTHER task that
 * is active or holds a live lease has an overlapping `owns`. Returns null on an
 * ordinary refusal (not ready, claimed by another live run, dependency not
 * done); throws `TaskOwnershipHeldError` for the actionable overlap case.
 */
export async function claimTask(
	store: BoardStore,
	taskId: string,
	runId: string,
	leaseMs: number,
	fromStatus: string,
	cfg: ClaimConfig,
	opts: { start?: boolean; worktree?: string } = {},
): Promise<BoardDocument | null> {
	const start = opts.start ?? true;
	return withClaimLock(cfg, async () => {
		const lease = await readLease(cfg.root, taskId);
		if (start) {
			if (lease.claimedByRunId !== null) return null;
		} else if (
			lease.claimedByRunId !== null &&
			lease.claimedByRunId !== runId &&
			isLive(lease)
		) {
			return null;
		}

		const all = await store.listDocuments("task");
		const self = all.find((d) => d.id === taskId);
		const status = self?.fields[cfg.statusField];
		if (!self) return null;
		if (
			start
				? status !== fromStatus
				: status !== fromStatus && status !== cfg.activeStatus
		)
			return null;

		if (!dependenciesMet(cfg, self, all)) return null;

		const myOwns = (self.fields[cfg.ownsField] as string[] | undefined) ?? [];
		if (myOwns.length > 0) {
			const waitingFor: string[] = [];
			const patterns: [string, string][] = [];
			for (const other of all) {
				if (other.id === taskId) continue;
				const otherOwns =
					(other.fields[cfg.ownsField] as string[] | undefined) ?? [];
				const overlap = overlappingPatterns(myOwns, otherOwns);
				if (overlap.length === 0) continue;
				const otherLease = await readLease(cfg.root, other.id);
				const otherActive =
					other.fields[cfg.statusField] === cfg.activeStatus ||
					(otherLease.claimedByRunId !== null && isLive(otherLease));
				if (!otherActive) continue;
				waitingFor.push(other.id);
				patterns.push(...overlap);
			}
			if (waitingFor.length > 0)
				throw new TaskOwnershipHeldError(taskId, waitingFor, patterns);
		}

		// The final status/dependency re-check runs under the document's own
		// lock (`transact`), so a concurrent transition or edit that does not
		// take the claim lock cannot slip in before the status/lease write.
		const recheck = async (current: BoardDocument): Promise<boolean> => {
			const st = current.fields[cfg.statusField];
			if (
				start ? st !== fromStatus : st !== fromStatus && st !== cfg.activeStatus
			)
				return false;
			return dependenciesMet(cfg, current, await store.listDocuments("task"));
		};
		const lease0 = (now: number) => ({
			claimedByRunId: runId,
			claimedAt: now,
			leaseExpiresAt: now + leaseMs,
			statusChangedAt: start ? now : lease.statusChangedAt,
			worktree: opts.worktree ?? null,
		});

		let claimed: BoardDocument | null = null;
		if (start) {
			claimed = await store.transact("task", taskId, async (current) => {
				if (!(await recheck(current))) return null; // lost the race
				return { fields: { [cfg.statusField]: cfg.activeStatus } };
			});
			if (!claimed) return null;
			await writeLease(cfg.root, taskId, lease0(Date.now()));
		} else {
			// Bind only: re-check and write the lease inside the document lock;
			// returning null means "no document write".
			await store.transact("task", taskId, async (current) => {
				if (!(await recheck(current))) return null;
				claimed = current;
				await writeLease(cfg.root, taskId, lease0(Date.now()));
				return null;
			});
		}
		return claimed;
	});
}

function isLive(lease: { leaseExpiresAt: number | null }): boolean {
	return lease.leaseExpiresAt === null || lease.leaseExpiresAt > Date.now();
}

/**
 * Clear a claim and move the task's status (`to` null: clear the lease only). A compare-and-swap on
 * `expectedRunId`: returns null if a different run holds the claim (only a
 * claim held by a DIFFERENT run refuses — an unclaimed task must go through,
 * since e.g. `review → done` releases a claim this call already cleared once).
 */
export async function releaseClaim(
	store: BoardStore,
	taskId: string,
	expectedRunId: string | null,
	toStatus: string | null,
	cfg: Pick<ClaimConfig, "root" | "statusField">,
): Promise<BoardDocument | null> {
	const lease = await readLease(cfg.root, taskId);
	if (lease.claimedByRunId !== null && lease.claimedByRunId !== expectedRunId)
		return null;
	const record =
		toStatus === null
			? await store.readDocument("task", taskId)
			: await store.updateDocument("task", taskId, {
					fields: { [cfg.statusField]: toStatus },
				});
	await writeLease(cfg.root, taskId, {
		claimedByRunId: null,
		claimedAt: null,
		leaseExpiresAt: null,
		statusChangedAt: toStatus === null ? lease.statusChangedAt : Date.now(),
		worktree: null,
	});
	return record;
}
