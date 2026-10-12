import { Info } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { TipButton } from "~/components/ui/tooltip";
import { ACTIVITY_LOOK, STATE_LOOK } from "../../components/agent/look";
import { MARK_LOOK, MARK_ORDER, MarkIcon, type MarkKind } from "./marks";

/**
 * The Flow legend: a "?" button in the toolbar that opens the key as a
 * popover (hover, keyboard focus, or click/tap; Escape closes). It reads the
 * same tables the cells draw from (`MARK_LOOK`, `ACTIVITY_LOOK`,
 * `STATE_LOOK`), so what it says is exactly what the timeline shows.
 */

export type LegendEntry =
	| {
			kind: "bar";
			label: string;
			meaning?: string;
			token: string;
			opacity: number;
	  }
	| {
			kind: "mark";
			mark: MarkKind;
			label: string;
			meaning: string;
			token: string;
	  };

/** Bars first (what runs did), then marks (what happened). */
export function legendEntries(): LegendEntry[] {
	return [
		{
			kind: "bar",
			opacity: 1,
			label: "working",
			token: ACTIVITY_LOOK.working.token,
		},
		{
			kind: "bar",
			opacity: 0.45,
			label: "idle (steer window)",
			token: ACTIVITY_LOOK.idle.token,
		},
		{
			kind: "bar",
			opacity: 1,
			label: "needs answer / approval",
			token: ACTIVITY_LOOK.needs_answer.token,
		},
		{
			kind: "bar",
			opacity: 1,
			label: "stalled",
			token: ACTIVITY_LOOK.stalled.token,
		},
		{
			kind: "bar",
			opacity: 0.28,
			label: "waiting (queued, held)",
			token: STATE_LOOK.starting.token,
		},
		{
			kind: "bar",
			opacity: 1,
			label: "brain turn (red = failed)",
			token: "--mfw-accent",
		},
		...MARK_ORDER.map((mark) => ({
			kind: "mark" as const,
			mark,
			label: MARK_LOOK[mark].name,
			meaning: MARK_LOOK[mark].meaning,
			token: MARK_LOOK[mark].token,
		})),
	];
}

export function LegendBody() {
	const entries = legendEntries();
	const bars = entries.filter((e) => e.kind === "bar");
	const marks = entries.filter((e) => e.kind === "mark");
	return (
		<section
			aria-label="Legend"
			data-legend=""
			className="grid gap-x-6 gap-y-3 p-3"
			style={{
				gridTemplateColumns: "minmax(0, 0.8fr) minmax(0, 1.6fr)",
				fontSize: "var(--mfw-text-xs)",
				color: "var(--mfw-fg)",
				width: 660,
				maxWidth: "calc(100vw - 24px)",
			}}
		>
			<section>
				<h3 className="m-0 mb-1" style={sectionStyle}>
					Bars (what a run was doing)
				</h3>
				<ul className="m-0 list-none p-0">
					{bars.map((e) => (
						<li key={e.label} className="flex items-center gap-2 py-0.5">
							<span
								aria-hidden
								className="inline-block shrink-0"
								style={{
									width: 22,
									height: 8,
									borderRadius: 1,
									background: `var(${e.token})`,
									opacity: e.kind === "bar" ? e.opacity : 1,
								}}
							/>
							{e.label}
						</li>
					))}
					<li className="flex items-center gap-2 py-0.5">
						<span
							aria-hidden
							className="inline-block shrink-0"
							style={{
								width: 22,
								height: 2,
								background: "var(--mfw-status-in-progress)",
								opacity: 0.55,
							}}
						/>
						task status (thin line, bottom)
					</li>
				</ul>
			</section>
			<section>
				<h3 className="m-0 mb-1" style={sectionStyle}>
					Marks (what happened, above the bars)
				</h3>
				<ul className="m-0 list-none p-0">
					{marks.map((e) =>
						e.kind === "mark" ? (
							<li key={e.mark} className="flex items-center gap-2 py-0.5">
								<MarkIcon kind={e.mark} size={16} />
								<span className="whitespace-nowrap" style={{ fontWeight: 600 }}>
									{e.label}
								</span>
								<span style={{ color: "var(--mfw-fg-muted)" }}>
									{e.meaning}
								</span>
							</li>
						) : null,
					)}
					<li className="flex items-center gap-2 py-0.5">
						<span
							aria-hidden
							className="inline-flex shrink-0 items-center justify-center"
							style={{
								width: 20,
								height: 16,
								borderRadius: 8,
								border: "2px solid var(--mfw-fg-muted)",
								fontSize: 10,
								fontWeight: 700,
							}}
						>
							3
						</span>
						<span style={{ fontWeight: 600 }}>cluster</span>
						<span style={{ color: "var(--mfw-fg-muted)" }}>
							several events close together; click to list, zoom to split
						</span>
					</li>
				</ul>
			</section>
		</section>
	);
}

const sectionStyle = {
	color: "var(--mfw-fg-faint)",
	fontSize: "var(--mfw-text-2xs)",
	letterSpacing: "0.06em",
	textTransform: "uppercase" as const,
	fontWeight: 500,
};

/** The "?" affordance: opens the legend on hover, keyboard focus and click. */
export function FlowLegend() {
	const [open, setOpen] = useState(false);
	const pinned = useRef(false);
	const root = useRef<HTMLSpanElement | null>(null);
	const id = useId();
	const close = useCallback(() => {
		pinned.current = false;
		setOpen(false);
	}, []);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") close();
		};
		const onDown = (e: MouseEvent | TouchEvent) => {
			if (!root.current?.contains(e.target as Node)) close();
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("mousedown", onDown);
		document.addEventListener("touchstart", onDown);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("touchstart", onDown);
		};
	}, [open, close]);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: hover is a convenience; the button inside is the control
		<span
			ref={root}
			className="relative inline-flex"
			data-flow-legend=""
			onMouseEnter={() => setOpen(true)}
			onMouseLeave={() => {
				if (!pinned.current) setOpen(false);
			}}
		>
			<TipButton
				type="button"
				aria-label="Legend"
				aria-expanded={open}
				aria-controls={id}
				tip="What the bars and marks mean"
				className="mfw-focus inline-flex size-6 items-center justify-center"
				style={{
					color: open ? "var(--mfw-fg)" : "var(--mfw-fg-muted)",
					borderRadius: "var(--mfw-radius-sm)",
					background: open ? "var(--mfw-bg-hover)" : "transparent",
				}}
				onClick={() => {
					if (open && pinned.current) close();
					else {
						pinned.current = true;
						setOpen(true);
					}
				}}
				onFocus={(e) => {
					// Keyboard focus opens it; a mouse click is handled by onClick.
					if (e.currentTarget.matches(":focus-visible")) {
						pinned.current = true;
						setOpen(true);
					}
				}}
				onBlur={() => close()}
			>
				<Info aria-hidden className="size-4" />
			</TipButton>
			{open ? (
				<div
					id={id}
					data-legend-popover=""
					className="absolute right-0 top-full z-50 mt-1"
					style={{
						background: "var(--mfw-bg-raised)",
						border: "1px solid var(--mfw-border-strong)",
						borderRadius: "var(--mfw-radius-md)",
						boxShadow: "var(--mfw-shadow-overlay)",
					}}
				>
					<LegendBody />
				</div>
			) : null}
		</span>
	);
}
