import type { QueryClient, QueryFilters } from "@tanstack/react-query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Unsubscribable } from "@trpc/server/observable";
import {
	createContext,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import type { RouterOutputs, TRPCProxy, YieldOf } from "./trpc";
import { useTRPC, useTRPCClient } from "./trpc";

/**
 * The live channel: one SSE subscription per attached project, and the ONLY
 * thing that keeps the cache fresh. There is no polling. The single degraded
 * path is a full invalidation when the channel comes back after being down
 * (or on a daemon `gap` sentinel), since one snapshot is cheaper than trying
 * to trust a backfill.
 */

/** One frame off the `live.events` subscription. */
export type LiveFrame = YieldOf<RouterOutputs["live"]["events"]>;
/** The `kind: "event"` frame's payload: an audit event plus its seq/ts. */
export type StoredEvent = Extract<LiveFrame, { kind: "event" }>["event"];

/** Events are per-project (own database and seq counter), so the project rides along for cache keys. */
export interface LiveEnvelope {
	project: string;
	event: StoredEvent;
}

/** Return the frame's new cursor, or null when it was already applied. */
export function nextLiveSeq(current: number, frame: LiveFrame): number | null {
	if (frame.kind === "ping") return null;
	const incoming = frame.kind === "gap" ? frame.lastSeq : frame.event.seq;
	return incoming > current ? incoming : null;
}

export type LiveStatus = "connected" | "reconnecting" | "offline";

export interface LiveChannel {
	status: LiveStatus;
	/** Epoch ms of the last frame of any kind (event or keepalive ping). */
	lastContactAt: number | null;
	/** Last applied audit seq per project, also the HISTORY resume point. */
	seqByProject: Readonly<Record<string, number>>;
	/** Tear the subscriptions down and dial again, now. */
	reconnect: () => void;
}

/** A dropped connection is "reconnecting" until this long has passed. */
const OFFLINE_AFTER_MS = 30_000;
/** Don't announce a drop until it has lasted this long; the transport redials on its own in a few hundred ms. */
const RECONNECT_BANNER_AFTER_MS = 1500;
const SEQ_STORAGE_PREFIX = "mfw:v2:live:seq:";
/** Invalidations are coalesced over one tick so a 500-event backfill costs one
 *  refetch per query, not five hundred. */
const FLUSH_MS = 60;

// ---------------------------------------------------------------------------
// applyEvent: the cache-patch / invalidate table
// ---------------------------------------------------------------------------

export interface ApplyOptions {
	/** Where invalidations go. Defaults to immediate; the live hook passes a collector so a burst becomes one flush. */
	invalidate?: (filters: QueryFilters) => void;
}

const warnedUnknown = new Set<string>();

/**
 * Apply ONE audit event to the query cache.
 *
 *  - Patch only when the payload carries enough to be certainly correct
 *    (status moves, lease claims).
 *  - Invalidate the narrowest filter that can have changed.
 *  - Unknown event types: no-op plus one console warning per type. Never
 *    invalidate everything on an unknown type.
 *
 * This function is the source of truth for the table documented in README.md.
 */
export function applyEvent(
	queryClient: QueryClient,
	trpc: TRPCProxy,
	envelope: LiveEnvelope,
	opts: ApplyOptions = {},
): void {
	const { project, event } = envelope;
	const invalidate =
		opts.invalidate ??
		((filters: QueryFilters) => {
			void queryClient.invalidateQueries(filters);
		});

	// Ownership conflicts are derived from the same task set, so they refresh with it.
	const tasksList = () => {
		invalidate(trpc.tasks.list.queryFilter({ project }));
		invalidate(trpc.tasks.ownershipConflicts.queryFilter({ project }));
	};
	const taskGet = (id: string) =>
		invalidate(trpc.tasks.get.queryFilter({ project, id }));
	const taskGraph = () => invalidate(trpc.tasks.graph.queryFilter({ project }));
	const runsActive = () => invalidate(trpc.runs.active.queryFilter());
	const runsList = () => invalidate(trpc.runs.list.queryFilter({ project }));
	const runGet = (runId: string) => {
		invalidate(trpc.runs.get.queryFilter({ project, runId }));
		invalidate(trpc.runs.steps.queryFilter({ project, runId }));
	};
	const inbox = () => invalidate(trpc.inbox.list.queryFilter());
	const health = () => invalidate(trpc.system.health.queryFilter());
	const resources = (p: string) =>
		invalidate(trpc.resources.list.queryFilter({ project: p }));
	// The project's own status plus the fleet-wide roll-up (a tri-state over
	// every project, so one project's pause changes it too).
	const scheduler = () => {
		invalidate(trpc.system.scheduler.status.queryFilter({ project }));
		invalidate(trpc.system.scheduler.all.queryFilter());
	};
	const trace = (taskId: string) =>
		invalidate(trpc.system.taskTrace.queryFilter({ project, taskId }));

	switch (event.type) {
		// ---- tasks -----------------------------------------------------------
		case "task.created":
			tasksList();
			taskGraph();
			inbox();
			health();
			break;

		case "task.status_changed": {
			// Patch first so the board/inbox row moves in the same frame the event
			// lands, then refetch for the fields the payload does not carry.
			patchTaskRows(queryClient, trpc, project, event.taskId, (row) => ({
				...row,
				status: event.payload.to as typeof row.status,
			}));
			tasksList();
			taskGet(event.taskId);
			taskGraph();
			trace(event.taskId);
			// Entering or leaving review/blocked/done changes the attention queue.
			inbox();
			health();
			break;
		}

		case "task.edited":
			taskGet(event.taskId);
			tasksList();
			inbox();
			break;

		case "task.reopen_check":
			trace(event.taskId);
			break;

		case "task.deleted":
			tasksList();
			taskGraph();
			inbox();
			health();
			break;

		case "task.claimed":
			patchTaskRows(queryClient, trpc, project, event.taskId, (row) => ({
				...row,
				claimedByRunId: event.payload.runId,
			}));
			tasksList();
			runsActive();
			break;

		case "task.claim_released":
			patchTaskRows(queryClient, trpc, project, event.taskId, (row) => ({
				...row,
				claimedByRunId: null,
				claimedAt: null,
				leaseExpiresAt: null,
			}));
			tasksList();
			taskGet(event.taskId);
			runsActive();
			health();
			break;

		case "task.lease_expired":
			patchTaskRows(queryClient, trpc, project, event.taskId, (row) => ({
				...row,
				claimedByRunId: null,
			}));
			tasksList();
			runsActive();
			health();
			break;

		case "task.held_for_resource":
			tasksList();
			taskGet(event.taskId);
			health();
			break;

		case "task.conflict":
			// The editor raises its conflict bar on this; refetch the authoritative copy for the merge.
			taskGet(event.taskId);
			tasksList();
			break;

		case "task.quarantined":
			tasksList();
			inbox();
			health();
			break;

		// ---- runs ------------------------------------------------------------
		case "run.started":
			runsActive();
			runsList();
			runGet(event.runId);
			if (event.payload.taskId) tasksList();
			health();
			break;

		case "run.state_changed":
			runsActive();
			runsList();
			runGet(event.runId);
			tasksList();
			// A run reaching a terminal failure state creates an inbox item.
			inbox();
			health();
			break;

		case "run.finalize_step":
			runGet(event.runId);
			break;

		// ---- verification / merge / main health ------------------------------
		case "verify.check":
			runGet(event.runId);
			taskGet(event.taskId);
			trace(event.taskId);
			break;

		case "merge.completed":
			tasksList();
			if (event.taskId) {
				taskGet(event.taskId);
				trace(event.taskId);
			}
			runsList();
			runGet(event.runId);
			inbox();
			health();
			break;

		case "merge.deferred":
			taskGet(event.taskId);
			tasksList();
			inbox();
			health();
			break;

		case "main.red":
		case "main.green":
			// The red-main breaker stops dispatch without the operator doing so, and
			// the dispatch chip shows which cause, so refetch here, not only the inbox.
			scheduler();
			inbox();
			health();
			break;

		// The board index froze or thawed; dispatch is gated on it either way, and
		// the chip says so.
		case "board.suspended":
		case "board.resumed":
			scheduler();
			tasksList();
			health();
			break;

		// ---- scheduler / rate limits -----------------------------------------
		case "scheduler.paused":
		case "scheduler.resumed":
			scheduler();
			health();
			break;

		case "rate_limit.hit":
		case "rate_limit.cleared":
			scheduler();
			inbox();
			health();
			break;

		// ---- resources -------------------------------------------------------
		case "resource.locked":
		case "resource.released":
		case "resource.leaked":
		case "resource.cleanup":
			// Settings renders `resources.list`; health alone leaves the panel stale.
			resources(project);
			health();
			break;

		// ---- brain -----------------------------------------------------------
		case "clarify.raised":
		case "clarify.resolved":
			inbox();
			health();
			break;

		case "lifetime.fired":
			tasksList();
			taskGraph();
			break;

		default: {
			const type = (event as { type: string }).type;
			if (!warnedUnknown.has(type)) {
				warnedUnknown.add(type);
				console.warn(`[live] no cache rule for event type '${type}'`);
			}
		}
	}
}

type TaskRow = RouterOutputs["tasks"]["list"][number];

/**
 * Patch every cached `tasks.list` page for a project (one per status filter).
 * Missing rows are left alone; the accompanying invalidation fetches them.
 */
function patchTaskRows(
	queryClient: QueryClient,
	trpc: TRPCProxy,
	project: string,
	taskId: string,
	patch: (row: TaskRow) => TaskRow,
): void {
	const filter = trpc.tasks.list.queryFilter({ project });
	for (const [key, data] of queryClient.getQueriesData<TaskRow[]>(filter)) {
		if (!Array.isArray(data)) continue;
		if (!data.some((row) => row.id === taskId)) continue;
		queryClient.setQueryData<TaskRow[]>(key, (rows) =>
			rows?.map((row) => (row.id === taskId ? patch(row) : row)),
		);
	}
}

// ---------------------------------------------------------------------------
// useLiveChannel: one subscription per project, plus connection state
// ---------------------------------------------------------------------------

function readSeq(project: string): number {
	if (typeof window === "undefined") return 0;
	const raw = window.localStorage.getItem(SEQ_STORAGE_PREFIX + project);
	const n = raw === null ? Number.NaN : Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : 0;
}

function writeSeq(project: string, seq: number): void {
	if (typeof window === "undefined") return;
	window.localStorage.setItem(SEQ_STORAGE_PREFIX + project, String(seq));
}

/**
 * Subscribe to `live.events` for every attached project. Call ONCE, from the
 * shell; the rest of the app reads it via `useLive()`.
 *
 * Each subscription starts at the last seq this browser applied
 * (localStorage). The transport reconnects with the ORIGINAL `sinceSeq`, so
 * events can be redelivered; they are deduped by seq.
 */
export function useLiveChannel(): LiveChannel {
	const trpc = useTRPC();
	const client = useTRPCClient();
	const queryClient = useQueryClient();

	// The project set changes rarely and nothing invalidates it.
	const projectsQuery = useQuery({
		...trpc.system.projects.queryOptions(),
		staleTime: 5 * 60_000,
	});
	// Stable string key: re-run the effect when the project set changes, not the query identity.
	const projectNames = JSON.stringify(
		(projectsQuery.data ?? []).map((p) => p.name),
	);

	const [status, setStatus] = useState<LiveStatus>("connected");
	const [lastContactAt, setLastContactAt] = useState<number | null>(null);
	const [seqByProject, setSeqByProject] = useState<Record<string, number>>({});
	const [attempt, setAttempt] = useState(0);

	/** Subscription identity: project set plus reconnect counter. A fresh object tears every stream down and redials. */
	const channel = useMemo(
		() => ({
			attempt,
			names: JSON.parse(projectNames) as string[],
		}),
		[attempt, projectNames],
	);

	// Read by subscription callbacks, which outlive any render.
	const seqRef = useRef<Record<string, number>>({});
	const stateRef = useRef<Record<string, "connecting" | "pending" | "error">>(
		{},
	);
	const wasOfflineRef = useRef(false);

	useEffect(() => {
		const names = channel.names;

		// --- batched invalidation -------------------------------------------
		const pending = new Map<string, QueryFilters>();
		let flushTimer: ReturnType<typeof setTimeout> | null = null;
		const flush = () => {
			flushTimer = null;
			const filters = [...pending.values()];
			pending.clear();
			for (const f of filters) void queryClient.invalidateQueries(f);
		};
		const collect = (filters: QueryFilters) => {
			pending.set(JSON.stringify(filters.queryKey), filters);
			if (flushTimer === null) flushTimer = setTimeout(flush, FLUSH_MS);
		};

		// --- connection state -------------------------------------------------
		let timer: ReturnType<typeof setTimeout> | null = null;
		let contact = 0;
		const at = (ms: number) => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				recompute();
			}, ms);
		};
		const recompute = () => {
			const states = names.map((n) => stateRef.current[n] ?? "connecting");
			const healthy =
				states.length === 0
					? !projectsQuery.isError
					: states.every((s) => s === "pending");
			if (healthy) {
				if (timer) {
					clearTimeout(timer);
					timer = null;
				}
				setStatus("connected");
				if (wasOfflineRef.current) {
					wasOfflineRef.current = false;
					// After a real outage the backfill window may have closed; take a full snapshot.
					void queryClient.invalidateQueries();
				}
				return;
			}
			const downFor = Date.now() - (contact || Date.now());
			if (downFor >= OFFLINE_AFTER_MS) {
				wasOfflineRef.current = true;
				setLastContactAt(contact || null);
				setStatus("offline");
				return;
			}
			// A redial that resolves within a few hundred ms is not worth a banner.
			if (downFor < RECONNECT_BANNER_AFTER_MS) {
				at(RECONNECT_BANNER_AFTER_MS - downFor + 50);
				return;
			}
			setLastContactAt(contact || null);
			setStatus("reconnecting");
			// One scheduled check (not a poll) for when the reconnecting window expires.
			at(OFFLINE_AFTER_MS - downFor + 100);
		};

		const touch = () => {
			// Deliberately not React state: pings arrive every few seconds and
			// `lastContactAt` is only rendered while disconnected. `recompute`
			// publishes it when it matters.
			contact = Date.now();
		};

		// --- subscriptions ----------------------------------------------------
		const subs: Unsubscribable[] = [];
		for (const project of names) {
			const sinceSeq = seqRef.current[project] ?? readSeq(project);
			seqRef.current[project] = sinceSeq;
			stateRef.current[project] = "connecting";

			subs.push(
				client.live.events.subscribe(
					{ project, sinceSeq },
					{
						onStarted: () => {
							stateRef.current[project] = "pending";
							touch();
							recompute();
						},
						onConnectionStateChange: (s) => {
							stateRef.current[project] =
								s.state === "pending" ? "pending" : "connecting";
							if (s.state === "pending") touch();
							recompute();
						},
						onData: (frame) => {
							touch();
							if (frame.kind === "ping") {
								recompute();
								return;
							}
							const currentSeq = seqRef.current[project] ?? 0;
							const nextSeq = nextLiveSeq(currentSeq, frame);
							if (frame.kind === "gap") {
								// Too far behind to replay: refetch everything, then resume
								// from the daemon's durable head. Never regress if a
								// reconnect redelivers an older gap sentinel.
								if (nextSeq === null) return;
								seqRef.current[project] = nextSeq;
								writeSeq(project, nextSeq);
								setSeqByProject({ ...seqRef.current });
								void queryClient.invalidateQueries();
								return;
							}
							// Duplicate from a transport reconnect (it redials with its original sinceSeq).
							if (nextSeq === null) return;
							seqRef.current[project] = nextSeq;
							writeSeq(project, nextSeq);
							setSeqByProject({ ...seqRef.current });
							applyEvent(
								queryClient,
								trpc,
								{ project, event: frame.event },
								{ invalidate: collect },
							);
						},
						onError: (err) => {
							stateRef.current[project] = "error";
							console.error(`[live] ${project} subscription error`, err);
							recompute();
						},
					},
				),
			);
		}

		recompute();

		return () => {
			for (const sub of subs) sub.unsubscribe();
			if (flushTimer !== null) {
				clearTimeout(flushTimer);
				flush();
			}
			if (timer) clearTimeout(timer);
		};
	}, [channel, projectsQuery.isError, client, queryClient, trpc]);

	return {
		status,
		lastContactAt,
		seqByProject,
		reconnect: () => setAttempt((n) => n + 1),
	};
}

// ---------------------------------------------------------------------------
// Context: the shell subscribes, everyone else reads
// ---------------------------------------------------------------------------

const OFFLINE_FALLBACK: LiveChannel = {
	status: "offline",
	lastContactAt: null,
	seqByProject: {},
	reconnect: () => {},
};

export const LiveContext = createContext<LiveChannel | null>(null);

/** Read the live channel's state. Outside the provider returns an `offline` stand-in, not a false "connected". */
export function useLive(): LiveChannel {
	return useContext(LiveContext) ?? OFFLINE_FALLBACK;
}
