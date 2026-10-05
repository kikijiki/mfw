import type { AgentEvent } from "@mfw/daemon/agents/events";
import { parseAgentEvents } from "@mfw/daemon/agents/events";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { useTRPC, useTRPCClient } from "../../lib/trpc";

/**
 * The transcript, assembled once and appended to.
 *
 * `runs.entries` returns the parsed log up to a byte offset; `live.runOutput`
 * yields the bytes past it. The log is fetched once per mount.
 *
 *  - A delta can end mid-line (the driver is still appending); the partial
 *    tail carries into the next delta.
 *  - A base offset change (invalidation after an outage) means the snapshot
 *    was retaken; the tail resets to avoid double-appending.
 */

const TERMINAL_STATES = new Set([
	"completed",
	"failed",
	"killed",
	"interrupted",
	"rate_limited",
	"needs_review",
	"finalize_error",
]);

export function isTerminalRunState(state: string | null | undefined): boolean {
	return state == null ? true : TERMINAL_STATES.has(state);
}

export interface RunTotals {
	costUsd: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	cachedInputTokens: number | null;
	reasoningOutputTokens: number | null;
	turns: number | null;
}

export interface RunStream {
	entries: AgentEvent[];
	/** True while the run-output subscription is open. */
	following: boolean;
	/** Stream failures render inline in the viewer, never as a toast (§3.7). */
	streamError: unknown;
	isLoading: boolean;
	error: unknown;
	refetch: () => void;
	totals: RunTotals;
}

/** Append a replayable stream delta exactly once, keyed by per-run sequence. */
export function appendUniqueAgentEvents(
	current: AgentEvent[],
	incoming: AgentEvent[],
): AgentEvent[] {
	if (incoming.length === 0) return current;
	const seen = new Set(current.map((event) => event.seq));
	const fresh = incoming.filter((event) => !seen.has(event.seq));
	return fresh.length === 0 ? current : [...current, ...fresh];
}

export function useRunStream(
	project: string,
	runId: string,
	opts: { runState?: string | null; enabled?: boolean } = {},
): RunStream {
	const trpc = useTRPC();
	const client = useTRPCClient();
	const queryClient = useQueryClient();
	const enabled = opts.enabled ?? true;
	const terminal = isTerminalRunState(opts.runState);

	const snapshot = useQuery({
		...trpc.runs.entries.queryOptions({ project, runId, offset: 0 }),
		enabled,
		// The snapshot covers bytes [0, offset) of an append-only file; only invalidation retakes it.
		staleTime: Number.POSITIVE_INFINITY,
	});

	const baseOffset = snapshot.data?.offset ?? null;
	const [tail, setTail] = useState<{ key: string; events: AgentEvent[] }>({
		key: "",
		events: [],
	});
	const [streamError, setStreamError] = useState<unknown>(null);
	const [following, setFollowing] = useState(false);
	const tailKeyRef = useRef<string>("");

	useEffect(() => {
		// A new key means a different snapshot: start the tail over.
		const key = `${project}:${runId}:${baseOffset}`;
		if (tailKeyRef.current !== key) {
			tailKeyRef.current = key;
			setTail({ key, events: [] });
		}
		if (
			!enabled ||
			baseOffset === null ||
			(terminal && snapshot.data?.complete !== false)
		)
			return;
		setStreamError(null);
		setFollowing(true);

		let carry = "";
		let closed = false;
		const sub = client.live.runOutput.subscribe(
			{ project, runId, offset: baseOffset },
			{
				onData: (frame) => {
					if (frame.kind === "ping") return; // keepalive
					if (frame.kind === "end") {
						closed = true;
						setFollowing(false);
						// Terminal state: the run row and finalize journal are stale.
						void queryClient.invalidateQueries(
							trpc.runs.get.queryFilter({ project, runId }),
						);
						void queryClient.invalidateQueries(
							trpc.runs.steps.queryFilter({ project, runId }),
						);
						return;
					}
					const text = carry + frame.chunk;
					const lastBreak = text.lastIndexOf("\n");
					// Everything after the final newline is an unfinished line.
					carry = lastBreak === -1 ? text : text.slice(lastBreak + 1);
					const complete = lastBreak === -1 ? "" : text.slice(0, lastBreak);
					if (!complete) return;
					const parsed = parseAgentEvents(complete);
					if (parsed.length > 0) {
						setTail((prev) => {
							const current = prev.key === key ? prev.events : [];
							const events = appendUniqueAgentEvents(current, parsed);
							return events === current ? prev : { key, events };
						});
					}
				},
				onError: (err) => {
					setFollowing(false);
					setStreamError(err);
				},
			},
		);

		return () => {
			sub.unsubscribe();
			if (!closed) setFollowing(false);
		};
	}, [
		enabled,
		terminal,
		snapshot.data?.complete,
		baseOffset,
		project,
		runId,
		client,
		queryClient,
		trpc,
	]);

	const entries = useMemo(() => {
		const base = snapshot.data?.entries ?? [];
		const key = `${project}:${runId}:${baseOffset}`;
		const tailEvents = tail.key === key ? tail.events : [];
		if (tailEvents.length === 0) return base;
		const lastSeq = base.at(-1)?.seq ?? -1;
		// A transport redial can replay deltas; seq is monotonic within a run, so it is the dedupe key.
		return [...base, ...tailEvents.filter((e) => e.seq > lastSeq)];
	}, [snapshot.data, tail, project, runId, baseOffset]);

	const totals = useMemo(() => foldUsage(entries), [entries]);

	return {
		entries,
		following,
		streamError,
		isLoading: snapshot.isLoading,
		error: snapshot.error,
		refetch: () => void snapshot.refetch(),
		totals,
	};
}

/**
 * Usage events are emitted per provider `result`. Cost and turn count are
 * cumulative within a session, so the largest value is the truth; token counts
 * are per-result and add up.
 */
export function foldUsage(entries: AgentEvent[]): RunTotals {
	let cost: number | null = null;
	let turns: number | null = null;
	let input: number | null = null;
	let output: number | null = null;
	let cached: number | null = null;
	let reasoning: number | null = null;
	for (const e of entries) {
		if (e.type !== "usage") continue;
		if (e.costUsd != null) cost = Math.max(cost ?? 0, e.costUsd);
		if (e.turns != null) turns = Math.max(turns ?? 0, e.turns);
		const fold = (current: number | null, value: number | undefined) =>
			value == null
				? current
				: e.cumulative
					? Math.max(current ?? 0, value)
					: (current ?? 0) + value;
		input = fold(input, e.inputTokens);
		output = fold(output, e.outputTokens);
		cached = fold(cached, e.cachedInputTokens);
		reasoning = fold(reasoning, e.reasoningOutputTokens);
	}
	return {
		costUsd: cost,
		turns,
		inputTokens: input,
		outputTokens: output,
		cachedInputTokens: cached,
		reasoningOutputTokens: reasoning,
	};
}
