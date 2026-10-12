import type { FlowMarker, FlowSpan } from "@mfw/daemon/flow";
import { ChevronLeft, ChevronRight, History } from "lucide-react";
import { TipButton } from "~/components/ui/tooltip";
import { formatRelative } from "../../lib/format";
import type { KeyBinding } from "../../lib/keyboard";

/**
 * The scrub cursor (design §5.4). `?t=` is the instant the view is shown at;
 * its absence is live. This module is the pure half (what `t` means, which
 * events a step lands on, the keys) and the two small views over it: the
 * banner every scrubbed surface shows, and the step controls the Flow lens
 * adds.
 *
 * Times are quantised to whole seconds, rounded up, because that is what
 * `flow.at` does: a step lands on the second that contains the event, so the
 * cursor and the server agree on what "at t" includes.
 */

const SECOND = 1000;

/** The whole second that contains `ms` (rounded up). */
export function quantise(ms: number): number {
	return Math.ceil(ms / SECOND) * SECOND;
}

/**
 * The instant a `t` search value scrubs to, or `null` for live: absent,
 * unparseable and any `t` at or after `now` all mean live.
 */
export function scrubbedAt(t: string | undefined, now: number): number | null {
	if (!t) return null;
	const ms = Date.parse(t);
	if (!Number.isFinite(ms) || ms >= now) return null;
	return ms;
}

/** Every instant something changed, quantised, ascending, unique. */
export function stepTimes(
	spans: readonly Pick<FlowSpan, "start" | "end">[],
	markers: readonly Pick<FlowMarker, "at">[],
): number[] {
	const set = new Set<number>();
	for (const s of spans) {
		set.add(quantise(s.start.getTime()));
		if (s.end) set.add(quantise(s.end.getTime()));
	}
	for (const m of markers) set.add(quantise(m.at.getTime()));
	return [...set].sort((a, b) => a - b);
}

/**
 * The event instant one step from `at`: the latest earlier one (`-1`) or the
 * earliest later one (`1`); `null` when there is none that way.
 */
export function stepFrom(
	times: readonly number[],
	at: number,
	dir: -1 | 1,
): number | null {
	const here = quantise(at);
	if (dir === 1) {
		for (const t of times) if (t > here) return t;
		return null;
	}
	for (let i = times.length - 1; i >= 0; i--) {
		const t = times[i] as number;
		if (t < here) return t;
	}
	return null;
}

/**
 * `[` and `]` step one event back and forward, `L` returns to live. Stepping
 * forward past the last event lands on live; stepping back with nothing
 * earlier stays where it is.
 */
export function scrubBindings(opts: {
	/** The scrubbed instant, `null` while live. */
	at: number | null;
	/** `stepTimes` of the loaded spans and markers. */
	times: readonly number[];
	now: number;
	/** Set `t` (an ISO instant), or `undefined` for live. */
	onT: (t: string | undefined) => void;
}): KeyBinding[] {
	const { at, times, now, onT } = opts;
	const from = at ?? now;
	const group = "Time";
	return [
		{
			key: "[",
			label: "Step back one event",
			group,
			run: () => {
				const prev = stepFrom(times, from, -1);
				if (prev !== null) onT(new Date(prev).toISOString());
			},
		},
		{
			key: "]",
			label: "Step forward one event",
			group,
			enabled: at !== null,
			run: () => {
				const next = stepFrom(times, from, 1);
				onT(
					next === null || next >= now
						? undefined
						: new Date(next).toISOString(),
				);
			},
		},
		{
			key: "L",
			label: "Back to live",
			group,
			enabled: at !== null,
			run: () => onT(undefined),
		},
	];
}

/**
 * The row-actions prop for the lens: the handler while live, nothing while
 * scrubbed (the actions menu is disabled on the past). Spread into props.
 */
export function rowActions(
	scrubbed: boolean,
	open: (ref: string) => void,
): { onActions?: (ref: string) => void } {
	return scrubbed ? {} : { onActions: open };
}

/** `10:42:13` in the viewer's locale. */
export function formatScrubTime(ms: number): string {
	return new Date(ms).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

/**
 * "Viewing 10:42:13 · 38m ago · read-only [Back to live (L)]". Shown by every
 * surface that honours `t`; you cannot steer the past.
 */
export function ScrubBanner({
	at,
	now,
	onLive,
	note,
}: {
	at: number;
	now: number;
	onLive: () => void;
	/** What is and is not as-of (a surface says what it cannot rewind). */
	note?: string;
}) {
	return (
		<div
			role="status"
			data-scrub-banner=""
			className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1"
			style={{
				borderColor: "var(--mfw-border)",
				background: "var(--mfw-accent-subtle)",
				fontSize: "var(--mfw-text-xs)",
			}}
		>
			<History aria-hidden className="size-3.5" />
			<span>
				Viewing <span className="mfw-num">{formatScrubTime(at)}</span>
			</span>
			<span style={{ color: "var(--mfw-fg-muted)" }}>
				{formatRelative(at, now)}
			</span>
			<span style={{ color: "var(--mfw-fg-muted)" }}>read-only</span>
			{note ? (
				<span style={{ color: "var(--mfw-fg-muted)" }}>{note}</span>
			) : null}
			<button
				type="button"
				onClick={onLive}
				className="mfw-focus ml-auto px-1.5 py-0.5"
				style={{
					border: "1px solid var(--mfw-border)",
					borderRadius: "var(--mfw-radius-sm)",
				}}
			>
				Back to live (L)
			</button>
		</div>
	);
}

/** The Flow lens's scrub strip: the banner with step buttons. Hidden while live. */
export function TimeCursor({
	at,
	now,
	times,
	onT,
}: {
	at: number | null;
	now: number;
	times: readonly number[];
	onT: (t: string | undefined) => void;
}) {
	if (at === null) return null;
	const prev = stepFrom(times, at, -1);
	return (
		<div data-time-cursor="" className="flex shrink-0 flex-col">
			<ScrubBanner at={at} now={now} onLive={() => onT(undefined)} />
			<div
				className="flex shrink-0 items-center gap-1 border-b px-3 py-0.5"
				style={{ borderColor: "var(--mfw-border)" }}
			>
				<TipButton
					type="button"
					aria-label="Step back one event ([)"
					tip="Step back one event ([)"
					disabled={prev === null}
					onClick={() => prev !== null && onT(new Date(prev).toISOString())}
					className="mfw-focus inline-flex size-6 items-center justify-center disabled:opacity-40"
				>
					<ChevronLeft aria-hidden className="size-4" />
				</TipButton>
				<TipButton
					type="button"
					aria-label="Step forward one event (])"
					tip="Step forward one event (])"
					onClick={() => {
						const next = stepFrom(times, at, 1);
						onT(
							next === null || next >= now
								? undefined
								: new Date(next).toISOString(),
						);
					}}
					className="mfw-focus inline-flex size-6 items-center justify-center"
				>
					<ChevronRight aria-hidden className="size-4" />
				</TipButton>
				<span
					className="mfw-num"
					style={{
						color: "var(--mfw-fg-faint)",
						fontSize: "var(--mfw-text-2xs)",
					}}
				>
					{times.length} events in range
				</span>
			</div>
		</div>
	);
}
