import { ChevronLeft, ChevronRight } from "lucide-react";
import { TipButton } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { Glyph } from "../../components/icons";
import { FIT_WINDOW, type TimeScale, ticks, WINDOW_PRESETS } from "./timeScale";

/**
 * The timeline's header: the axis (ticks and the now line) and the window
 * controls (presets, pan, LIVE). Both read the same `TimeScale` the cells
 * use, so a tick sits exactly over the bars it labels.
 */

/** About one label per this many pixels. */
const TICK_SPACING_PX = 90;

export function TimeAxis({
	scale,
	now,
	className,
}: {
	scale: TimeScale;
	now: number;
	className?: string;
}) {
	const marks = ticks(
		scale,
		Math.max(2, Math.floor(scale.width / TICK_SPACING_PX)),
	);
	const nowX = scale.x(now);
	return (
		<div
			aria-hidden
			data-time-axis=""
			className={cn("relative shrink-0 overflow-hidden", className)}
			style={{
				width: scale.width,
				height: "var(--mfw-row-h)",
				fontSize: "var(--mfw-text-2xs)",
				color: "var(--mfw-fg-muted)",
			}}
		>
			{marks.map((t) => (
				<span
					key={t.at}
					className="mfw-num absolute top-0 flex h-full items-center border-l pl-1"
					style={{
						left: t.x,
						borderColor: t.major
							? "var(--mfw-border-strong)"
							: "var(--mfw-border)",
					}}
				>
					{t.label}
				</span>
			))}
			<span
				data-time-readout=""
				className="mfw-num absolute top-0 flex h-full items-center px-1"
				style={{
					left: "var(--flow-readout-x, -100px)",
					transform: "translateX(-50%)",
					background: "var(--mfw-fg)",
					color: "var(--mfw-bg)",
					pointerEvents: "none",
					whiteSpace: "nowrap",
					zIndex: 2,
				}}
			/>
			{nowX >= 0 && nowX <= scale.width ? (
				<span
					className="absolute top-0 h-full border-r"
					style={{
						left: nowX - 1,
						width: 1,
						borderColor: "var(--mfw-accent)",
					}}
				/>
			) : null}
		</div>
	);
}

/**
 * Window presets, pan arrows and the LIVE toggle. Pure props, no data: the
 * page owns the URL and passes what to change.
 */
export function TimeControls({
	windowId,
	live,
	onWindow,
	onPan,
	onLive,
}: {
	/** The `w` in effect (a preset id, or a custom length that matches none). */
	windowId: string;
	live: boolean;
	onWindow: (id: string) => void;
	onPan: (dir: -1 | 1) => void;
	onLive: () => void;
}) {
	return (
		<div className="flex flex-wrap items-center gap-1" data-time-controls="">
			<button
				type="button"
				aria-label="Earlier"
				className="mfw-focus inline-flex size-6 items-center justify-center"
				onClick={() => onPan(-1)}
			>
				<ChevronLeft aria-hidden className="size-4" />
			</button>
			<fieldset
				aria-label="Time window"
				className="m-0 flex items-center border-0 p-0"
			>
				{[{ id: FIT_WINDOW as string }, ...WINDOW_PRESETS].map((p) => {
					const on = p.id === windowId;
					return (
						<TipButton
							key={p.id}
							type="button"
							aria-pressed={on}
							tip={
								p.id === FIT_WINDOW
									? "Frame the activity: from the first run to now"
									: `Last ${p.id}`
							}
							onClick={() => onWindow(p.id)}
							className="mfw-focus mfw-num px-1.5 py-0.5"
							style={{
								fontSize: "var(--mfw-text-xs)",
								color: on ? "var(--mfw-fg)" : "var(--mfw-fg-muted)",
								background: on ? "var(--mfw-bg-hover)" : "transparent",
								borderRadius: "var(--mfw-radius-sm)",
							}}
						>
							{p.id === FIT_WINDOW ? "fit" : p.id}
						</TipButton>
					);
				})}
			</fieldset>
			<button
				type="button"
				aria-label="Later"
				className="mfw-focus inline-flex size-6 items-center justify-center"
				onClick={() => onPan(1)}
			>
				<ChevronRight aria-hidden className="size-4" />
			</button>
			<TipButton
				type="button"
				aria-pressed={live}
				tip={live ? "Following now" : "Jump to now and follow"}
				onClick={onLive}
				className="mfw-focus inline-flex items-center gap-1 px-1.5 py-0.5"
				style={{
					fontSize: "var(--mfw-text-xs)",
					color: live ? "var(--mfw-ok)" : "var(--mfw-fg-muted)",
					border: "1px solid var(--mfw-border)",
					borderRadius: "var(--mfw-radius-sm)",
				}}
			>
				<Glyph name="dot" className="size-2.5" />
				LIVE
			</TipButton>
		</div>
	);
}
