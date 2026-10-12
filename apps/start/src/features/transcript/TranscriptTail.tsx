import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { humanizeError } from "../../lib/toast";
import type { RunControls } from "../agents/useRunControls";
import { buildItems, TranscriptEntry, type TranscriptItem } from "./entries";
import { depthOf, subagentGroups, visibleItems } from "./subagents";
import { useRunStream } from "./useRunStream";

const NO_TOGGLES: ReadonlySet<string> = new Set();

/** The last `lines` items in the order they last changed (a tool call moves when its result lands). */
export function tailItems(
	items: readonly TranscriptItem[],
	lines: number,
): TranscriptItem[] {
	return [...items]
		.sort((a, b) => (a.latestSeq ?? a.seq) - (b.latestSeq ?? b.seq))
		.slice(-lines);
}

/**
 * The live tail inside `RunConsole` (dock rows, the task panel).
 *
 * Same data path as the full viewer: one `runs.entries` snapshot plus the
 * `live.runOutput` delta stream, rendered dense and pinned to the bottom. It
 * shows the last few entries because that is what answers "is it stuck?";
 * the full transcript is one click away and does not need to be loaded twice.
 * Mount it only while it is visible: each mounted tail holds one stream.
 *
 * With `approval` (from `useRunControls`), pending approvals are answerable
 * right here instead of only in the full transcript.
 */
export function TranscriptTail({
	project,
	runId,
	runState,
	lines = 40,
	heightClass = "h-40",
	approval,
}: {
	project: string;
	runId: string;
	runState: string | null;
	lines?: number;
	heightClass?: string;
	approval?: RunControls["approval"];
}) {
	const stream = useRunStream(project, runId, { runState });
	// Rebuilt only when entries arrive, not on every render of the console around it.
	const items = useMemo(() => buildItems(stream.entries), [stream.entries]);
	// A running subagent's entries show under its call, indented; a finished
	// one is a single `N entries` chip (the tail is for "is it stuck?").
	const groups = useMemo(() => subagentGroups(items), [items]);
	const shown = useMemo(
		() => tailItems(visibleItems(items, NO_TOGGLES, groups), lines),
		[items, groups, lines],
	);
	const tailCursor = shown.at(-1)?.latestSeq ?? shown.at(-1)?.seq;
	const settle = approval?.settle;
	useEffect(() => {
		settle?.(items);
	}, [items, settle]);
	const boxRef = useRef<HTMLDivElement | null>(null);
	const pinnedRef = useRef(true);

	// Follow the tail unless the operator scrolled up inside the box.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the arrival of new entries IS the trigger
	useLayoutEffect(() => {
		const el = boxRef.current;
		if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
	}, [tailCursor]);

	useEffect(() => {
		const el = boxRef.current;
		if (!el) return;
		const onScroll = () => {
			pinnedRef.current =
				el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	}, []);

	if (stream.error) {
		return (
			<ErrorState
				title="Could not load the transcript"
				error={stream.error}
				onRetry={stream.refetch}
			/>
		);
	}

	return (
		<div className="flex flex-col gap-1">
			{stream.streamError ? (
				<div
					className="px-2 py-1"
					style={{
						background: "color-mix(in oklch, var(--mfw-warn) 14%, transparent)",
						color: "var(--mfw-fg-muted)",
						borderRadius: "var(--mfw-radius-sm)",
						fontSize: "var(--mfw-text-2xs)",
					}}
				>
					Live tail stopped: {humanizeError(stream.streamError)}
				</div>
			) : null}
			<div
				ref={boxRef}
				className={`${heightClass} overflow-auto p-1`}
				style={{
					background: "var(--mfw-bg-inset)",
					borderRadius: "var(--mfw-radius-sm)",
					fontFamily: "var(--mfw-font-mono)",
				}}
			>
				{stream.isLoading ? (
					<LoadingRows rows={3} />
				) : shown.length === 0 ? (
					<div
						className="px-1 py-2"
						style={{
							color: "var(--mfw-fg-faint)",
							fontSize: "var(--mfw-text-xs)",
						}}
					>
						No output yet.
					</div>
				) : (
					shown.map((item) => {
						const sub =
							item.kind === "tool" && groups.get(item.id)?.entries
								? groups.get(item.id)
								: undefined;
						return (
							<TranscriptEntry
								key={item.seq}
								item={item}
								depth={depthOf(item, groups)}
								{...(sub
									? {
											subagent: {
												entries: sub.entries,
												tools: sub.tools,
												finished: sub.finished,
												open: !sub.finished,
											},
										}
									: {})}
								density="tail"
								expanded={false}
								onToggle={() => {}}
								onApproval={approval?.respond}
								approvalPending={
									item.kind === "approval" &&
									approval?.respondingId === item.requestId
								}
							/>
						);
					})
				)}
			</div>
		</div>
	);
}
