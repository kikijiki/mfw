/**
 * The Flow lens's time axis, pure (design §5.4): a window of time mapped onto
 * the timeline column's pixels, the ticks along it, and the rectangle a span
 * becomes. No React and no clock of its own, so every rule is a unit test.
 *
 * The window is the URL: `w` is its length (`15m`, `2h`, `7d`, `all`) and
 * `t`, when present, is its right edge. Absent `t` means LIVE: the right edge
 * is now and the view follows it.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const WINDOW_PRESETS = [
	{ id: "15m", ms: 15 * MIN },
	{ id: "1h", ms: HOUR },
	{ id: "2h", ms: 2 * HOUR },
	{ id: "8h", ms: 8 * HOUR },
	{ id: "24h", ms: DAY },
	{ id: "7d", ms: 7 * DAY },
] as const;

export const DEFAULT_WINDOW = "2h";
/** The window id for "frame the activity" (`fitWindowMs`): what a bare URL means. */
export const FIT_WINDOW = "fit";
const MIN_WINDOW_MS = MIN;
const MAX_WINDOW_MS = 30 * DAY;
const UNIT: Record<string, number> = { m: MIN, h: HOUR, d: DAY, w: 7 * DAY };

/**
 * A window length from `w`. A preset id, or any `<n><m|h|d|w>` (custom), is
 * itself; `all` reaches back to `earliest` (at least an hour); anything else
 * is the default. Clamped to a minute .. thirty days.
 */
export function windowMs(
	w: string | undefined,
	now: number,
	earliest?: number | null,
	fitMs?: number | null,
): number {
	let ms: number | null = null;
	if (w === FIT_WINDOW) {
		ms = fitMs ?? null;
	} else if (w === "all") {
		ms = Math.max(earliest != null ? now - earliest : HOUR, HOUR);
	} else if (w) {
		const m = /^(\d{1,3})([mhdw])$/.exec(w);
		if (m) ms = Number(m[1]) * (UNIT[m[2] as string] as number);
	}
	if (ms === null)
		ms = WINDOW_PRESETS.find((p) => p.id === DEFAULT_WINDOW)?.ms ?? 2 * HOUR;
	return Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, ms));
}

export interface TimeWindow {
	from: number;
	to: number;
	/** The right edge is now, and the view follows it. */
	live: boolean;
}

/** The window for the URL's `w` and `t`. A `t` at or after now is live. */
export function resolveWindow(opts: {
	w?: string;
	t?: string;
	now: number;
	earliest?: number | null;
	/** The length `fit` stands for (`fitWindowMs` of the activity). */
	fitMs?: number | null;
}): TimeWindow {
	const length = windowMs(opts.w, opts.now, opts.earliest, opts.fitMs);
	const t = opts.t ? Date.parse(opts.t) : Number.NaN;
	const live = !Number.isFinite(t) || t >= opts.now;
	const to = live ? opts.now : t;
	return { from: to - length, to, live };
}

/** The `t` after panning by half a window in `dir`: `null` once it reaches now (back to LIVE). */
export function panned(
	win: TimeWindow,
	dir: -1 | 1,
	now: number,
): string | null {
	const length = win.to - win.from;
	const to = win.to + dir * (length / 2);
	return to >= now ? null : new Date(to).toISOString();
}

export interface TimeScale {
	from: number;
	to: number;
	width: number;
	/** Pixels from the left for a time. Not clamped. */
	x: (ms: number) => number;
	/** The time under a pixel. */
	at: (px: number) => number;
}

export function makeScale(from: number, to: number, width: number): TimeScale {
	const span = Math.max(1, to - from);
	const w = Math.max(0, width);
	return {
		from,
		to,
		width: w,
		x: (ms) => ((ms - from) / span) * w,
		at: (px) => from + (w === 0 ? 0 : (px / w) * span),
	};
}

export interface Tick {
	at: number;
	x: number;
	label: string;
	/** A day boundary. */
	major: boolean;
}

const STEPS = [
	MIN,
	5 * MIN,
	10 * MIN,
	15 * MIN,
	30 * MIN,
	HOUR,
	2 * HOUR,
	3 * HOUR,
	6 * HOUR,
	12 * HOUR,
	DAY,
	2 * DAY,
	7 * DAY,
];

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

function labelFor(ms: number, step: number): string {
	const d = new Date(ms);
	if (step >= DAY) return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Evenly spaced, round-numbered ticks (in local time) that fit `maxTicks` along the scale. */
export function ticks(scale: TimeScale, maxTicks: number): Tick[] {
	const span = scale.to - scale.from;
	if (span <= 0 || maxTicks < 1) return [];
	const step =
		STEPS.find((s) => span / s <= maxTicks) ?? (STEPS.at(-1) as number);
	// Align to local clock boundaries, not UTC ones.
	const offset = -new Date(scale.from).getTimezoneOffset() * MIN;
	const first = Math.ceil((scale.from + offset) / step) * step - offset;
	const out: Tick[] = [];
	for (let at = first; at <= scale.to; at += step) {
		const d = new Date(at);
		out.push({
			at,
			x: scale.x(at),
			label: labelFor(at, step),
			major: step < DAY && d.getHours() === 0 && d.getMinutes() === 0,
		});
	}
	return out;
}

export interface BarRect {
	x: number;
	width: number;
	/** Cut off at the left or right edge of the window. */
	clippedStart: boolean;
	clippedEnd: boolean;
}

/** Narrowest a span is drawn: a one-second blip must still be visible and clickable. */
export const MIN_BAR_PX = 2;

/**
 * The rectangle for a span, or `null` when it lies outside the window. An
 * open span (`end` null) runs to `now`.
 */
export function barRect(
	scale: TimeScale,
	start: number,
	end: number | null,
	now: number,
): BarRect | null {
	const stop = end ?? now;
	if (stop < scale.from || start > scale.to) return null;
	const x0 = Math.max(0, scale.x(start));
	const x1 = Math.min(scale.width, scale.x(stop));
	return {
		x: x0,
		width: Math.max(MIN_BAR_PX, x1 - x0),
		clippedStart: start < scale.from,
		clippedEnd: stop > scale.to,
	};
}

/**
 * The `flow.spans` range to ask for. Snapped outward to a bucket so the query
 * key is the same while LIVE ticks forward (a key that moved every second
 * would refetch every second); the live patches keep rows inside a bucket
 * current.
 */
export function spanRange(
	win: TimeWindow,
	now: number,
): { from: number; to: number } {
	const length = win.to - win.from;
	const bucket = Math.max(MIN, Math.round(length / 8 / MIN) * MIN);
	const from = Math.floor(win.from / bucket) * bucket - bucket;
	const to = Math.floor(Math.max(win.to, now) / bucket) * bucket + 2 * bucket;
	return { from, to };
}
