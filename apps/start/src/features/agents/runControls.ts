import type { QueryClient, QueryKey } from "@tanstack/react-query";

import type { TRPCProxy } from "../../lib/trpc";
import type { TranscriptItem } from "../transcript/entries";

/**
 * The pure half of `useRunControls`: what a run allows, and the optimistic
 * cache patch a stop makes. Kept free of React so the rules are tested
 * directly (`runControls.test.ts`).
 */

export interface RunCapabilities {
	verified?: boolean;
	steer?: boolean;
	interrupt?: boolean;
	approvals?: boolean;
}

export interface RunControlState {
	/** The provider process is live: Stop can reach it. */
	stoppable: boolean;
	/** The driver verified it drains the steer channel (`RunEngine.steer` refuses otherwise). */
	steerable: boolean;
	/** Pending approvals can be answered from here (`RunEngine.respondApproval`). */
	approvals: boolean;
	/** Stop first asks the harness to interrupt the turn, then kills on timeout (`RunEngine.stop`). */
	gracefulStop: boolean;
}

/** The same gates the daemon enforces, so a button is never offered only to be refused. */
export function runControlState(run: {
	state: string;
	capabilities: RunCapabilities | null | undefined;
}): RunControlState {
	const live = run.state === "running";
	const caps = run.capabilities ?? {};
	const verified = caps.verified === true;
	return {
		stoppable: live,
		steerable: live && verified && caps.steer === true,
		approvals: live && verified && caps.approvals === true,
		gracefulStop: verified && caps.interrupt === true,
	};
}

/** Cache entries a stop rewrote, so `restoreRunSnapshot` can put them back. */
export type RunSnapshot = Array<[QueryKey, unknown]>;

/**
 * Optimistic stop: every cached view of this run stops claiming the agent is
 * working the instant the operator asks. `ended` is the real state the daemon
 * moves through on its way to finalizing, and the live channel's
 * `run.state_changed` replaces it with the truth.
 *
 * Covers the dock and NOW (`runs.active`), the run page (`runs.get`) and both
 * Agents lists (`runs.list`, `runs.listAll`).
 */
export function markRunStopping(
	queryClient: QueryClient,
	trpc: TRPCProxy,
	project: string,
	runId: string,
): RunSnapshot {
	const snapshot: RunSnapshot = [];
	const remember = (key: QueryKey, data: unknown) => snapshot.push([key, data]);

	const activeKey = trpc.runs.active.queryKey();
	const active = queryClient.getQueryData(activeKey);
	if (active?.some((r) => r.project === project && r.runId === runId)) {
		remember(activeKey, active);
		queryClient.setQueryData(
			activeKey,
			active.map((r) =>
				r.project === project && r.runId === runId
					? { ...r, state: "ended" as const, steerable: false }
					: r,
			),
		);
	}

	const getKey = trpc.runs.get.queryKey({ project, runId });
	const one = queryClient.getQueryData(getKey);
	if (one) {
		remember(getKey, one);
		queryClient.setQueryData(getKey, {
			...one,
			state: "ended" as const,
		} as typeof one);
	}

	for (const [key, rows] of queryClient.getQueriesData<
		Array<{ id: string; state: string }>
	>(trpc.runs.list.queryFilter({ project }))) {
		if (!Array.isArray(rows) || !rows.some((r) => r.id === runId)) continue;
		remember(key, rows);
		queryClient.setQueryData(
			key,
			rows.map((r) => (r.id === runId ? { ...r, state: "ended" as const } : r)),
		);
	}

	for (const [key, rows] of queryClient.getQueriesData<
		Array<{ id: string; project: string; state: string }>
	>(trpc.runs.listAll.queryFilter())) {
		if (
			!Array.isArray(rows) ||
			!rows.some((r) => r.project === project && r.id === runId)
		)
			continue;
		remember(key, rows);
		queryClient.setQueryData(
			key,
			rows.map((r) =>
				r.project === project && r.id === runId ? { ...r, state: "ended" } : r,
			),
		);
	}

	return snapshot;
}

export function restoreRunSnapshot(
	queryClient: QueryClient,
	snapshot: RunSnapshot | undefined,
): void {
	for (const [key, data] of snapshot ?? []) queryClient.setQueryData(key, data);
}

/**
 * An approval answer is in flight until the transcript shows the request
 * resolved; until then its buttons stay disabled so a second click cannot
 * race the first.
 */
export function approvalSettled(
	items: readonly TranscriptItem[],
	requestId: string,
): boolean {
	const item = items.find(
		(i) => i.kind === "approval" && i.requestId === requestId,
	);
	return item?.kind === "approval" && item.status !== "pending";
}

// ---------------------------------------------------------------------------
// moves a run allows beyond stop and steer (U4-04)
// ---------------------------------------------------------------------------

/** Settled states whose worktree is still there to continue in. */
const CONTINUABLE_STATES: ReadonlySet<string> = new Set([
	"failed",
	"killed",
	"interrupted",
	"rate_limited",
	"needs_review",
	"finalize_error",
]);

export interface RunMoves {
	/** Stop it and keep the worktree (design §10.1 "Pause"). */
	pause: boolean;
	/** Continue a settled run on its own route. */
	resume: boolean;
	/** Stop (if live) and continue on another harness, model or host. */
	reroute: boolean;
}

/** What the run-level moves are for a run in `state`; the server still has the last word (it refuses a merged run's missing worktree with a fix). */
export function runMoves(state: string): RunMoves {
	const live = state === "running";
	const settled = CONTINUABLE_STATES.has(state);
	return { pause: live, resume: settled, reroute: live || settled };
}

// ---------------------------------------------------------------------------
// optimistic winner (select_winner)
// ---------------------------------------------------------------------------

interface GroupCacheNode {
	ref: string;
	group?: { status: string; winner: string | null } & Record<string, unknown>;
	run?: {
		attempt?: { groupRef: string; winner: boolean } & Record<string, unknown>;
	} & Record<string, unknown>;
}

/**
 * Optimistic "this attempt won": the group reads `selecting` with the winner
 * set in `groups.get` and in every cached `flow.tree` / `flow.live`, so the
 * star appears the instant the person presses it. The daemon's
 * `run.group_changed` brings the truth; a refusal restores the snapshot.
 */
export function markGroupWinner(
	queryClient: QueryClient,
	trpc: TRPCProxy,
	project: string,
	groupId: string,
	runId: string,
): RunSnapshot {
	const snapshot: RunSnapshot = [];
	const groupRef = `group:${groupId}`;

	const getKey = trpc.groups.get.queryKey({ project, groupId });
	const view = queryClient.getQueryData(getKey);
	if (view) {
		snapshot.push([getKey, view]);
		queryClient.setQueryData(getKey, {
			...view,
			status: "selecting",
			winnerRunId: runId,
			attempts: view.attempts.map((a) => ({ ...a, winner: a.runId === runId })),
		});
	}

	for (const filter of [
		trpc.flow.tree.queryFilter({ project }),
		trpc.flow.live.queryFilter({ project }),
	]) {
		for (const [key, data] of queryClient.getQueriesData<{
			nodes: GroupCacheNode[];
		}>(filter)) {
			if (!data?.nodes?.some((n) => n.ref === groupRef)) continue;
			snapshot.push([key, data]);
			queryClient.setQueryData(key, {
				...data,
				nodes: data.nodes.map((n) => {
					if (n.ref === groupRef && n.group) {
						return {
							...n,
							group: {
								...n.group,
								status: "selecting",
								winner: `run:${runId}`,
							},
						};
					}
					const attempt = n.run?.attempt;
					if (attempt && attempt.groupRef === groupRef) {
						return {
							...n,
							run: {
								...n.run,
								attempt: { ...attempt, winner: n.ref === `run:${runId}` },
							},
						};
					}
					return n;
				}),
			});
		}
	}
	return snapshot;
}
