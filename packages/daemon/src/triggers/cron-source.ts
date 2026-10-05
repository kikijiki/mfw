import { cronMatches } from "../cron.ts";
import type { TriggerEvent } from "./events.ts";

/**
 * Due-checking for a `cron:` source, shared with schedule-driven
 * `.mfw/lifetime/` definitions (extracted from `lifetime.ts`) so both follow one rule.
 *
 * Missed-while-down catch-up is capped at ONE occurrence (mirrors
 * `lifetime.ts`'s `MAX_CATCHUP = 1` and systemd's `Persistent=true`), and is not
 * generalised to the event path's `catchup: all`. `catchup: none` never fires for a miss.
 */

/** One week of 1-minute lookback: enough to notice downtime without scanning forever. */
const LOOKBACK_MINUTES = 60 * 24 * 7;

/**
 * Stand-in for `cronDue`'s `lastFired: null`, since `trigger_cursor.last_seq` is
 * `NOT NULL`. Arm time would suppress a firing on the arming minute, and `0`
 * would make the whole lookback look missed.
 */
export const CRON_NEVER_FIRED = -1;

export function cronCursorToLastFired(stored: number): number | null {
	return stored === CRON_NEVER_FIRED ? null : stored;
}

export type CronDue = "fired" | "caught-up" | "not-due";

export function sameMinute(a: number, b: number): boolean {
	return Math.floor(a / 60_000) === Math.floor(b / 60_000);
}

/** Was there a scheduled occurrence strictly after `since` and at/before `at`? */
export function missedCronOccurrence(
	schedule: string,
	at: Date,
	since: number,
): boolean {
	for (let i = 1; i <= LOOKBACK_MINUTES; i++) {
		const t = at.getTime() - i * 60_000;
		if (t <= since) break;
		if (cronMatches(schedule, new Date(t))) return true;
	}
	return false;
}

/**
 * `lastFired`: last actual fire time, or `null` if never. `not-due` covers both
 * "schedule does not match now" and "already fired this minute" (a pass running
 * twice in one minute must not fire twice).
 */
export function cronDue(
	schedule: string,
	at: Date,
	lastFired: number | null,
): CronDue {
	if (cronMatches(schedule, at)) {
		if (lastFired !== null && sameMinute(lastFired, at.getTime())) {
			return "not-due";
		}
		return "fired";
	}
	if (lastFired === null) return "not-due"; // never fired: no backlog to catch up
	return missedCronOccurrence(schedule, at, lastFired)
		? "caught-up"
		: "not-due";
}

/** Synthetic `TriggerEvent` for a cron tick. With no log row, `atMs` stands in for `seq` and `ts`, giving `deliveryIdFor(defId, seq)` a fresh, stable id per firing. */
export function cronTickEvent(
	defId: string,
	atMs: number,
	schedule: string,
): TriggerEvent {
	return {
		type: "trigger.cron_tick",
		seq: atMs,
		ts: atMs,
		payload: { defId, schedule },
	};
}
