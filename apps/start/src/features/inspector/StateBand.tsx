import type { FlowSpan } from "@mfw/daemon/flow";
import { type KeyboardEvent, type PointerEvent, useRef } from "react";
import { TipSpan } from "~/components/ui/tooltip";
import { formatDuration } from "../../lib/format";
import { bandSegments, fractionOf, tsAtFraction } from "./bandModel";

/** Fraction of the run one arrow key moves the cursor. */
const KEY_STEP = 0.05;

const clock = (ms: number) => {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/**
 * The run's life as one strip: what the agent was doing, when (design §7.2).
 * Dragging it (or the arrow keys) sets the cursor; the transcript scrolls to
 * the entry nearest that instant. It is a `slider` over time, so it is as
 * reachable from the keyboard as it is by pointer.
 */
export function StateBand({
	spans,
	start,
	end,
	now,
	cursor,
	onScrub,
}: {
	spans: readonly FlowSpan[];
	/** Run start and end (or now, while live), epoch ms. */
	start: number;
	end: number;
	now: number;
	/** The instant the transcript was last scrolled to. */
	cursor: number | null;
	onScrub: (ts: number) => void;
}) {
	const ref = useRef<HTMLDivElement | null>(null);
	const segments = bandSegments(spans, start, end, now);

	const at = (e: PointerEvent<HTMLDivElement>) => {
		const box = ref.current?.getBoundingClientRect();
		if (!box || box.width <= 0) return;
		onScrub(tsAtFraction(start, end, (e.clientX - box.left) / box.width));
	};
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const from = cursor ?? start;
		const f = fractionOf(start, end, from);
		let next: number | null = null;
		if (e.key === "ArrowRight") next = f + KEY_STEP;
		else if (e.key === "ArrowLeft") next = f - KEY_STEP;
		else if (e.key === "Home") next = 0;
		else if (e.key === "End") next = 1;
		if (next === null) return;
		e.preventDefault();
		onScrub(tsAtFraction(start, end, next));
	};

	return (
		<div
			className="flex shrink-0 flex-col gap-0.5 border-b px-3 py-1.5"
			style={{ borderColor: "var(--mfw-border)" }}
		>
			<div
				ref={ref}
				role="slider"
				tabIndex={0}
				aria-label="Run timeline"
				aria-valuemin={start}
				aria-valuemax={end}
				aria-valuenow={cursor ?? start}
				aria-valuetext={cursor === null ? "start" : clock(cursor)}
				data-state-band=""
				className="mfw-focus relative h-3.5 cursor-col-resize touch-none select-none"
				style={{
					background: "var(--mfw-bg-inset)",
					borderRadius: "var(--mfw-radius-sm)",
				}}
				onPointerDown={(e) => {
					e.currentTarget.setPointerCapture?.(e.pointerId);
					at(e);
				}}
				onPointerMove={(e) => {
					if (e.buttons !== 0) at(e);
				}}
				onKeyDown={onKeyDown}
			>
				{segments.map((s) => (
					<TipSpan
						key={`${s.lane}-${s.start}-${s.label}`}
						data-segment={s.label}
						tip={`${s.label} ${clock(s.start)} → ${clock(s.end)}, ${formatDuration(s.end - s.start)}${s.question ? `: ${s.question}` : ""}`}
						className="absolute top-0 h-full"
						style={{
							left: `${s.left}%`,
							width: `${s.width}%`,
							background: `var(${s.token})`,
							opacity: s.lane === "activity" ? 1 : 0.45,
							borderRadius: "1px",
						}}
					/>
				))}
				{cursor !== null ? (
					<span
						aria-hidden
						className="absolute top-[-2px] h-[calc(100%+4px)] w-0.5"
						style={{
							left: `${fractionOf(start, end, cursor) * 100}%`,
							background: "var(--mfw-fg)",
						}}
					/>
				) : null}
			</div>
			<div
				className="mfw-num flex justify-between"
				style={{
					color: "var(--mfw-fg-faint)",
					fontSize: "var(--mfw-text-2xs)",
				}}
			>
				<span>{clock(start)}</span>
				<span>{cursor === null ? "" : clock(cursor)}</span>
				<span>{clock(end)}</span>
			</div>
		</div>
	);
}
