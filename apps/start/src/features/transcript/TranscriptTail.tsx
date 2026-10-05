import { useEffect, useLayoutEffect, useRef } from "react";

import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { humanizeError } from "../../lib/toast";
import { buildItems, TranscriptEntry } from "./entries";
import { useRunStream } from "./useRunStream";

/**
 * The live tail on a NOW card.
 *
 * Same data path as the full viewer: one `runs.entries` snapshot plus the
 * `live.runOutput` delta stream, rendered dense and pinned to the bottom. The
 * card shows the last few entries because that is what answers "is it stuck?";
 * the full transcript is one click away and does not need to be loaded twice.
 */
export function TranscriptTail({
	project,
	runId,
	runState,
	lines = 40,
	heightClass = "h-40",
}: {
	project: string;
	runId: string;
	runState: string | null;
	lines?: number;
	heightClass?: string;
}) {
	const stream = useRunStream(project, runId, { runState });
	const items = buildItems(stream.entries);
	const shown = [...items]
		.sort((a, b) => (a.latestSeq ?? a.seq) - (b.latestSeq ?? b.seq))
		.slice(-lines);
	const tailCursor = shown.at(-1)?.latestSeq ?? shown.at(-1)?.seq;
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
					shown.map((item) => (
						<TranscriptEntry
							key={item.seq}
							item={item}
							density="tail"
							expanded={false}
							onToggle={() => {}}
						/>
					))
				)}
			</div>
		</div>
	);
}
