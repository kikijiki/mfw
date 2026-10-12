import type { FlowMarker, FlowSpan } from "@mfw/daemon/flow";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";

import { ACTIVITY_LOOK, STATE_LOOK } from "../../components/agent/look";
import { statusLook } from "../../components/icons";
import { formatDuration } from "../../lib/format";
import {
	kindsOf,
	type LaneItem,
	layoutMarks,
	MARK_PITCH,
	type MarkCluster,
} from "./laneLayout";
import { MARK_LOOK, MARK_SIZE, MarkIcon, type MarkKind } from "./marks";
import { barRect, type TimeScale } from "./timeScale";

/**
 * One row's slice of the time axis (design §5.1/§5.4).
 *
 * A cell has two lanes at fixed heights and a hairline rail, and nothing
 * crosses between them:
 *
 *   marker lane    point events, top, 18px: icons (or a counted cluster)
 *   activity lane  what the run was doing, below it, 8px: bars only
 *   status rail    the task's long-lived status, 2px along the bottom
 *
 * `cellModel` is the pure half (what to draw, in px and tokens, with the
 * marker clustering done); the component only turns it into SVG and buttons,
 * so the tests, the legend and the phone sparkline read the same table.
 *
 * The bars are an `aria-hidden` SVG (the row's accessible name already says
 * what the row is doing). The markers are real buttons: focusable, named, one
 * Tab stop per row and Left/Right between them.
 */

/** Pixel heights of the lanes; the cell is as tall as the row (30 to 36px). */
export const LANE = {
	/** Marker lane height, from the top edge. */
	marker: 18,
	/** Activity lane height. */
	activity: 8,
	/** Gap between the activity lane and the row's bottom edge. */
	bottom: 3,
	/** The status rail. */
	rail: 2,
} as const;

export type Band = "wait" | "state" | "main" | "rolled";

const BAND: Record<Band, { y: number; h: number; opacity: number }> = {
	wait: { y: 0, h: LANE.activity, opacity: 0.28 },
	state: { y: 0, h: LANE.activity, opacity: 0.45 },
	main: { y: 0, h: LANE.activity, opacity: 1 },
	rolled: { y: 2, h: 4, opacity: 0.6 },
};

/** What the hover card (and a cluster's list) says about a bar or a mark. */
export interface Tip {
	title: string;
	token: string;
	when: string;
	duration?: string;
	who?: string;
	cost?: string;
	text?: string;
}

interface SpanStyle {
	band: Band;
	token: string;
	label: string;
	/** A zero-length outcome, drawn as a mark where the run ended. */
	mark?: MarkKind;
	/** Draw as a narrow strip with a hairline gap (brain turns). */
	strip?: boolean;
}

/** Which mark a zero-length state span becomes; `null` draws nothing. */
export function outcomeMark(value: string): MarkKind | null {
	switch (value) {
		case "completed":
			return "passed";
		case "failed":
		case "finalize_error":
			return "failed";
		case "killed":
		case "interrupted":
		case "rate_limited":
			return "stopped";
		default:
			return null;
	}
}

/** What a span looks like: which band, which token, which word. `null` draws nothing. */
export function spanStyle(span: FlowSpan): SpanStyle | null {
	const instant =
		span.end !== null && span.end.getTime() === span.start.getTime();
	switch (span.lane) {
		case "activity": {
			const look = ACTIVITY_LOOK[span.value as keyof typeof ACTIVITY_LOOK];
			return look
				? { band: "main", token: look.token, label: look.label }
				: { band: "main", token: "--mfw-fg-faint", label: span.value };
		}
		case "state": {
			// A subagent's span is running / ok / error, not a run state.
			if (span.subject.startsWith("sub:")) {
				return span.value === "error"
					? { band: "state", token: "--mfw-critical", label: "failed" }
					: span.value === "ok"
						? { band: "state", token: "--mfw-ok", label: "done" }
						: {
								band: "state",
								token: "--mfw-status-in-progress",
								label: "running",
							};
			}
			const look = STATE_LOOK[span.value as keyof typeof STATE_LOOK];
			if (instant) {
				const mark = outcomeMark(span.value);
				return mark
					? {
							band: "state",
							token: MARK_LOOK[mark].token,
							label: look?.label ?? span.value,
							mark,
						}
					: null;
			}
			return {
				band: "state",
				token: look?.token ?? "--mfw-fg-faint",
				label: look?.label ?? span.value,
			};
		}
		case "turn": {
			// A brain turn: running reads as activity, a failure is loud, a clean
			// one is the brain's own accent.
			const failed = ["failed", "timeout", "aborted"].includes(span.value);
			return {
				band: "main",
				strip: true,
				token: failed
					? "--mfw-critical"
					: span.value === "running"
						? "--mfw-status-in-progress"
						: "--mfw-accent",
				label: `brain turn ${span.value}`,
			};
		}
		case "admission":
		case "hold":
			return { band: "wait", token: "--mfw-neutral", label: span.value };
		case "merge":
			if (instant) return null; // the marker draws it
			return {
				band: "main",
				token: "--mfw-warn",
				label: `merge ${span.value}`,
			};
		default:
			return null;
	}
}

export interface Bar {
	key: string;
	x: number;
	width: number;
	y: number;
	height: number;
	token: string;
	opacity: number;
	tip: Tip;
}

/** One event on the marker lane. */
export interface Mark extends LaneItem {
	kind: MarkKind;
	/** Selecting it selects this ref (and the node it sits on). */
	ref?: string;
	subject: string;
	/** The one-line text (`name: label`), also its accessible name. */
	label: string;
	tip: Tip;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number, seconds = false) => {
	const d = new Date(ms);
	const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
	return seconds ? `${hm}:${pad2(d.getSeconds())}` : hm;
};

function spanTip(
	span: FlowSpan,
	style: SpanStyle,
	now: number,
	who?: string,
	cost?: string,
): Tip {
	const start = span.start.getTime();
	const end = span.end?.getTime() ?? null;
	const q = span.detail?.question;
	const spent = span.detail?.costUsd;
	const bits: string[] = [];
	if (typeof q === "string") bits.push(q);
	if (typeof span.detail?.wakeClass === "string")
		bits.push(`woken by ${span.detail.wakeClass}`);
	if (typeof span.detail?.actions === "number")
		bits.push(
			`${span.detail.actions} action${span.detail.actions === 1 ? "" : "s"}`,
		);
	if (typeof span.detail?.error === "string") bits.push(span.detail.error);
	const costText = typeof spent === "number" ? `$${spent.toFixed(2)}` : cost;
	return {
		title: style.label,
		token: style.token,
		when: `${clock(start)} to ${end === null ? "now" : clock(end)}`,
		duration: formatDuration((end ?? now) - start),
		...(who ? { who } : {}),
		...(costText ? { cost: costText } : {}),
		...(bits.length > 0 ? { text: bits.join(" · ") } : {}),
	};
}

export interface CellInput {
	scale: TimeScale;
	now: number;
	spans: readonly FlowSpan[];
	/** Activity of the subtree below a collapsed row, drawn small in the activity lane. */
	rolled?: readonly FlowSpan[];
	markers?: readonly FlowMarker[];
	/** Who the row is (harness and model), for hover cards. */
	who?: string;
	/** What the row cost, for hover cards. */
	cost?: string;
}

export interface CellModel {
	/** Behind the activity bars: queued / held and run-state bars. */
	bars: Bar[];
	/** The status rail along the bottom. */
	rail: Bar[];
	/** Every mark in the window, before clustering. */
	marks: Mark[];
	/** The marks as laid out: clusters of one or more, `MARK_PITCH` apart. */
	clusters: MarkCluster<Mark>[];
}

/** Everything one row draws, in px and tokens. */
export function cellModel(input: CellInput): CellModel {
	const { scale, now, who, cost } = input;
	const order: Band[] = ["wait", "state", "main"];
	const own: { band: Band; bar: Bar }[] = [];
	const rail: Bar[] = [];
	const marks: Mark[] = [];

	input.spans.forEach((span, i) => {
		const start = span.start.getTime();
		const end = span.end?.getTime() ?? null;
		if (span.lane === "status") {
			const look = statusLook(span.value, span.value);
			const rect = barRect(scale, start, end, now);
			if (!rect) return;
			rail.push({
				key: `t${i}`,
				x: rect.x,
				width: rect.width,
				y: 0,
				height: LANE.rail,
				token: look.token,
				opacity: 0.55,
				tip: spanTip(
					span,
					{ band: "wait", token: look.token, label: look.label },
					now,
				),
			});
			return;
		}
		const style = spanStyle(span);
		if (style?.mark) {
			if (start < scale.from || start > scale.to) return;
			marks.push({
				key: `s${i}`,
				at: start,
				kind: style.mark,
				subject: span.subject,
				label: MARK_LOOK[style.mark].name,
				tip: {
					...spanTip(span, style, now, who, cost),
					title: MARK_LOOK[style.mark].name,
					token: MARK_LOOK[style.mark].token,
					when: clock(start, true),
					duration: "",
				},
			});
			return;
		}
		if (
			span.lane === "hold" &&
			end !== null &&
			end >= scale.from &&
			end <= scale.to
		) {
			marks.push({
				key: `h${i}`,
				at: end,
				kind: "released",
				subject: span.subject,
				label: `hold released (${span.value})`,
				tip: {
					title: MARK_LOOK.released.name,
					token: MARK_LOOK.released.token,
					when: clock(end, true),
					text: `held ${formatDuration(end - start)} for ${span.value}`,
				},
			});
		}
		if (!style) return;
		const rect = barRect(scale, start, end, now);
		if (!rect) return;
		const band = BAND[style.band];
		own.push({
			band: style.band,
			bar: {
				key: `s${i}`,
				x: style.strip ? rect.x + 0.5 : rect.x,
				width: style.strip ? Math.max(2, rect.width - 1) : rect.width,
				y: band.y,
				height: band.h,
				token: style.token,
				opacity: band.opacity,
				tip: spanTip(span, style, now, who, cost),
			},
		});
	});
	const bars: Bar[] = [];
	for (const band of order)
		for (const o of own) if (o.band === band) bars.push(o.bar);

	(input.rolled ?? []).forEach((span, i) => {
		if (span.lane !== "activity") return;
		const style = spanStyle(span);
		if (!style) return;
		const rect = barRect(
			scale,
			span.start.getTime(),
			span.end?.getTime() ?? null,
			now,
		);
		if (!rect) return;
		bars.push({
			key: `r${i}`,
			x: rect.x,
			width: rect.width,
			y: BAND.rolled.y,
			height: BAND.rolled.h,
			token: style.token,
			opacity: BAND.rolled.opacity,
			tip: spanTip(span, style, now),
		});
	});

	(input.markers ?? []).forEach((m, i) => {
		const at = m.at.getTime();
		if (at < scale.from || at > scale.to) return;
		const look = MARK_LOOK[m.kind];
		marks.push({
			key: `m${i}`,
			at,
			kind: m.kind,
			ref: m.ref,
			subject: m.subject,
			label: `${look.name}: ${m.label}`,
			tip: {
				title: look.name,
				token: look.token,
				when: clock(at, true),
				text: m.label,
				...(who ? { who } : {}),
			},
		});
	});

	return {
		bars,
		rail,
		marks,
		clusters: layoutMarks(marks, scale, MARK_PITCH),
	};
}

// ---------------------------------------------------------------------------
// marks
// ---------------------------------------------------------------------------

const LANE_BTN =
	"mfw-focus mfw-flow-mark absolute flex items-center justify-center border-0 bg-transparent p-0";

/** One lone mark: a real button, so it can be focused, named and clicked. */
export function MarkButton({
	mark,
	x,
	tabIndex,
	onMarker,
}: {
	mark: Mark;
	x: number;
	tabIndex: 0 | -1;
	onMarker: ((ref: string, subject: string) => void) | undefined;
}) {
	const target = mark.ref;
	return (
		<button
			type="button"
			data-marker={mark.kind}
			data-mark-key={mark.key}
			data-tip={JSON.stringify(mark.tip)}
			aria-label={`${mark.label}, ${mark.tip.when}`}
			tabIndex={tabIndex}
			className={LANE_BTN}
			style={{
				left: x - MARK_SIZE / 2,
				top: 1,
				width: MARK_SIZE,
				height: MARK_SIZE,
				cursor: target ? "pointer" : "default",
			}}
			onClick={(e) => {
				e.stopPropagation();
				if (target && onMarker) onMarker(target, mark.subject);
			}}
		>
			<MarkIcon kind={mark.kind} />
		</button>
	);
}

/** Several marks closer than the icon pitch: one badge with the count. */
function ClusterButton({
	cluster,
	tabIndex,
	open,
	onToggle,
}: {
	cluster: MarkCluster<Mark>;
	tabIndex: 0 | -1;
	open: boolean;
	onToggle: (el: HTMLButtonElement) => void;
}) {
	const kinds = kindsOf(cluster);
	const first = cluster.members[0] as Mark;
	const last = cluster.members.at(-1) as Mark;
	const single = kinds.length === 1 ? (kinds[0]?.kind as MarkKind) : null;
	const token = single ? MARK_LOOK[single].token : "--mfw-fg-muted";
	const n = cluster.members.length;
	const width = n > 9 ? 24 : 20;
	const summary = kinds
		.map((k) => `${k.count} ${MARK_LOOK[k.kind as MarkKind].name}`)
		.join(", ");
	return (
		<button
			type="button"
			data-cluster={n}
			data-cluster-key={cluster.key}
			// The list itself is the explanation once it is open.
			{...(open
				? {}
				: {
						"data-tip": JSON.stringify({
							title: `${n} events`,
							token,
							when: `${first.tip.when} to ${last.tip.when}`,
							text: summary,
						} satisfies Tip),
					})}
			aria-label={`${n} events (${summary}), ${first.tip.when} to ${last.tip.when}`}
			aria-expanded={open}
			aria-haspopup="dialog"
			tabIndex={tabIndex}
			className={LANE_BTN}
			style={{
				left: cluster.x - width / 2,
				top: 1,
				width,
				height: MARK_SIZE,
				borderRadius: 8,
				border: `2px solid var(${token})`,
				background: open ? `var(${token})` : "var(--mfw-bg-raised)",
				color: open ? "var(--mfw-bg-raised)" : "var(--mfw-fg)",
				fontSize: 10,
				fontWeight: 700,
				lineHeight: 1,
				cursor: "pointer",
			}}
			onClick={(e) => {
				e.stopPropagation();
				onToggle(e.currentTarget);
			}}
		>
			<span className="mfw-num" aria-hidden>
				{n}
			</span>
		</button>
	);
}

/** The cluster's members: time, kind, one line, click to select. */
function ClusterPopover({
	cluster,
	anchor,
	onPick,
	onClose,
}: {
	cluster: MarkCluster<Mark>;
	anchor: HTMLElement;
	onPick: (ref: string, subject: string) => void;
	onClose: () => void;
}) {
	const ref = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const onKey = (e: globalThis.KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				onClose();
				anchor.focus();
			}
		};
		const onDown = (e: MouseEvent) => {
			const t = e.target as Node;
			if (!ref.current?.contains(t) && !anchor.contains(t)) onClose();
		};
		document.addEventListener("keydown", onKey, true);
		document.addEventListener("mousedown", onDown);
		ref.current?.querySelector("button")?.focus();
		return () => {
			document.removeEventListener("keydown", onKey, true);
			document.removeEventListener("mousedown", onDown);
		};
	}, [anchor, onClose]);
	const r = anchor.getBoundingClientRect();
	const shown = cluster.members.slice(0, 40);
	const width = 300;
	const left = Math.max(
		8,
		Math.min(window.innerWidth - width - 8, r.left - 20),
	);
	const below = r.bottom + 4;
	const style = {
		position: "fixed" as const,
		left,
		width,
		zIndex: 60,
		...(below + 260 > window.innerHeight
			? { bottom: window.innerHeight - r.top + 4 }
			: { top: below }),
		maxHeight: 260,
		overflowY: "auto" as const,
		background: "var(--mfw-bg-raised)",
		border: "1px solid var(--mfw-border-strong)",
		borderRadius: "var(--mfw-radius-md)",
		boxShadow: "var(--mfw-shadow-overlay)",
		fontSize: "var(--mfw-text-xs)",
	};
	return createPortal(
		<div
			ref={ref}
			role="dialog"
			aria-label={`${cluster.members.length} events`}
			data-cluster-popover=""
			style={style}
		>
			<ul className="m-0 list-none p-1">
				{shown.map((m) => (
					<li key={m.key}>
						<button
							type="button"
							className="mfw-focus flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-[var(--mfw-bg-hover)]"
							style={{
								background: "transparent",
								border: 0,
								color: "var(--mfw-fg)",
							}}
							onClick={() => {
								if (m.ref) onPick(m.ref, m.subject);
								onClose();
							}}
						>
							<span
								className="mfw-num shrink-0"
								style={{ color: "var(--mfw-fg-muted)" }}
							>
								{m.tip.when}
							</span>
							<MarkIcon kind={m.kind} size={14} />
							<span className="min-w-0 flex-1 truncate">
								<span style={{ fontWeight: 600 }}>
									{MARK_LOOK[m.kind].name}
								</span>
								{m.tip.text ? (
									<span style={{ color: "var(--mfw-fg-muted)" }}>
										{" "}
										· {m.tip.text}
									</span>
								) : null}
							</span>
						</button>
					</li>
				))}
			</ul>
			{cluster.members.length > shown.length ? (
				<div className="px-3 pb-2" style={{ color: "var(--mfw-fg-muted)" }}>
					and {cluster.members.length - shown.length} more; zoom in to separate
					them
				</div>
			) : null}
		</div>,
		document.body,
	);
}

// ---------------------------------------------------------------------------
// the cell
// ---------------------------------------------------------------------------

export function TimelineCell({
	scale,
	now,
	spans,
	rolled,
	markers,
	who,
	cost,
	label,
	onMarker,
	compact = false,
	className,
}: CellInput & {
	/** Called with the ref a marker points at and the node it sits on. */
	onMarker?: (ref: string, subject: string) => void;
	/** Names the marker group for assistive tech ("Events on MFW-41"). */
	label?: string;
	/** The phone sparkline: no markers, no pointer. */
	compact?: boolean;
	className?: string;
}) {
	const model = cellModel({
		scale,
		now,
		spans,
		...(rolled ? { rolled } : {}),
		...(markers && !compact ? { markers } : {}),
		...(who ? { who } : {}),
		...(cost ? { cost } : {}),
	});
	const [open, setOpen] = useState<{ key: string; anchor: HTMLElement } | null>(
		null,
	);
	const close = useCallback(() => setOpen(null), []);
	const laneRef = useRef<HTMLDivElement | null>(null);
	const openCluster = open
		? model.clusters.find((c) => c.key === open.key)
		: undefined;

	// Left/Right move between a row's marks; the treegrid's keys stay its own.
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
		const items = [...(laneRef.current?.querySelectorAll("button") ?? [])];
		const i = items.indexOf(e.target as HTMLButtonElement);
		if (i < 0) return;
		const next = items[i + (e.key === "ArrowRight" ? 1 : -1)];
		e.preventDefault();
		e.stopPropagation();
		if (next) {
			for (const b of items) b.tabIndex = -1;
			next.tabIndex = 0;
			next.focus();
		}
	};

	return (
		<div
			data-timeline-wrap=""
			className={className}
			style={{
				position: "relative",
				flex: "none",
				width: scale.width,
				height: "100%",
				overflow: "hidden",
			}}
		>
			{/* Decorative: the row's accessible name carries its state and age. */}
			{/* biome-ignore lint/a11y/noSvgWithoutTitle: aria-hidden; hover cards come from data-tip */}
			<svg
				aria-hidden
				focusable={false}
				width={scale.width}
				height={LANE.activity}
				data-timeline-cell=""
				data-lane="activity"
				style={{
					position: "absolute",
					left: 0,
					bottom: LANE.bottom,
					display: "block",
				}}
			>
				{model.bars.map((b) => (
					<rect
						key={b.key}
						className="mfw-flow-bar"
						data-tip={JSON.stringify(b.tip)}
						x={b.x}
						width={b.width}
						y={b.y}
						height={b.height}
						rx={1}
						fill={`var(${b.token})`}
						opacity={b.opacity}
					/>
				))}
			</svg>
			{model.rail.length > 0 ? (
				// biome-ignore lint/a11y/noSvgWithoutTitle: aria-hidden; the status icon is in the tree column
				<svg
					aria-hidden
					focusable={false}
					width={scale.width}
					height={LANE.rail}
					data-lane="rail"
					style={{ position: "absolute", left: 0, bottom: 0, display: "block" }}
				>
					{model.rail.map((b) => (
						<rect
							key={b.key}
							data-tip={JSON.stringify(b.tip)}
							x={b.x}
							width={b.width}
							y={0}
							height={b.height}
							fill={`var(${b.token})`}
							opacity={b.opacity}
						/>
					))}
				</svg>
			) : null}
			{!compact && model.clusters.length > 0 ? (
				// biome-ignore lint/a11y/useSemanticElements: a positioned strip of buttons, not a form fieldset
				<div
					ref={laneRef}
					role="group"
					aria-label={label ?? "Events"}
					data-marker-lane=""
					style={{
						position: "absolute",
						left: 0,
						top: 0,
						width: scale.width,
						height: LANE.marker,
					}}
					onKeyDown={onKeyDown}
				>
					{model.clusters.map((c, i) => {
						const tabIndex = i === 0 ? 0 : -1;
						const only = c.members[0] as Mark;
						return c.members.length === 1 ? (
							<MarkButton
								key={c.key}
								mark={only}
								x={c.x}
								tabIndex={tabIndex}
								onMarker={onMarker}
							/>
						) : (
							<ClusterButton
								key={c.key}
								cluster={c}
								tabIndex={tabIndex}
								open={open?.key === c.key}
								onToggle={(el) =>
									setOpen((cur) =>
										cur?.key === c.key ? null : { key: c.key, anchor: el },
									)
								}
							/>
						);
					})}
				</div>
			) : null}
			{open && openCluster ? (
				<ClusterPopover
					cluster={openCluster}
					anchor={open.anchor}
					onPick={(ref, subject) => onMarker?.(ref, subject)}
					onClose={close}
				/>
			) : null}
			<span aria-hidden data-crosshair="" className="mfw-flow-crosshair" />
		</div>
	);
}
