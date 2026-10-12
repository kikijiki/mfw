import type { FlowSpan } from "@mfw/daemon/flow";

import { ACTIVITY_LOOK, STATE_LOOK } from "../../components/agent/look";

/**
 * The run inspector's state band, pure: the run's life drawn as one strip
 * (what it was doing, when), and the maths for scrubbing it. Dragging the
 * band moves the transcript to the entry nearest that instant.
 */

/** The instant a fraction (0 to 1) of the way along `[start, end]`. Clamped. */
export function tsAtFraction(
	start: number,
	end: number,
	fraction: number,
): number {
	const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
	return start + f * Math.max(0, end - start);
}

/** Where an instant sits on `[start, end]`, 0 to 1, clamped. */
export function fractionOf(start: number, end: number, ts: number): number {
	const span = end - start;
	if (span <= 0) return 0;
	return Math.min(1, Math.max(0, (ts - start) / span));
}

/**
 * The index of the timestamp nearest `ts` in an ascending list; `-1` for an
 * empty list. Ties go to the earlier entry (the one the person has already
 * seen). Unparseable stamps (NaN) are skipped by callers, not handled here.
 */
export function nearestIndexByTs(
	stamps: readonly number[],
	ts: number,
): number {
	if (stamps.length === 0) return -1;
	let lo = 0;
	let hi = stamps.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if ((stamps[mid] as number) < ts) lo = mid + 1;
		else hi = mid;
	}
	// `lo` is the first stamp >= ts; the one before it may be nearer.
	if (lo > 0) {
		const before = stamps[lo - 1] as number;
		const at = stamps[lo] as number;
		if (ts - before <= at - ts) return lo - 1;
	}
	return lo;
}

export interface BandSegment {
	/** Percent from the left, 0 to 100. */
	left: number;
	/** Percent of the band's width. */
	width: number;
	token: string;
	label: string;
	lane: "activity" | "state";
	start: number;
	end: number;
	question?: string;
}

/** The lifecycle states worth drawing where no activity covers the time. */
const STATE_ONLY = new Set(["starting", "finalizing", "merging", "ended"]);

/**
 * Segments for the band over `[start, end]`: the activity spans, and the
 * lifecycle states (queued, finalizing, merging) the activity does not cover.
 * Open spans run to `now`.
 */
export function bandSegments(
	spans: readonly FlowSpan[],
	start: number,
	end: number,
	now: number,
): BandSegment[] {
	const total = end - start;
	if (total <= 0) return [];
	const out: BandSegment[] = [];
	for (const s of spans) {
		const isActivity = s.lane === "activity";
		const isState = s.lane === "state" && STATE_ONLY.has(s.value);
		if (!isActivity && !isState) continue;
		const a = Math.max(start, s.start.getTime());
		const b = Math.min(end, s.end?.getTime() ?? now);
		if (b < a) continue;
		const look = isActivity
			? ACTIVITY_LOOK[s.value as keyof typeof ACTIVITY_LOOK]
			: STATE_LOOK[s.value as keyof typeof STATE_LOOK];
		const question = s.detail?.question;
		out.push({
			left: ((a - start) / total) * 100,
			width: Math.max(0.4, ((b - a) / total) * 100),
			token: look?.token ?? "--mfw-fg-faint",
			label: look?.label ?? s.value,
			lane: isActivity ? "activity" : "state",
			start: a,
			end: b,
			...(typeof question === "string" ? { question } : {}),
		});
	}
	return out;
}
