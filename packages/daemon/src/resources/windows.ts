import type { z } from "zod";
import type { WindowSpec } from "../../../plugin-api/src/resource.ts";
import { ResourceError } from "./types.ts";

type Spec = z.infer<typeof WindowSpec>;

interface LocalParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
	weekday: number;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function formatter(tz: string): Intl.DateTimeFormat {
	try {
		return new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
			weekday: "short",
		});
	} catch {
		throw new ResourceError(`unknown time zone '${tz}'`, "REFUSED");
	}
}

function partsAt(fmt: Intl.DateTimeFormat, at: number): LocalParts {
	const out: Record<string, string> = {};
	for (const part of fmt.formatToParts(new Date(at)))
		out[part.type] = part.value;
	return {
		year: Number(out.year),
		month: Number(out.month),
		day: Number(out.day),
		hour: Number(out.hour),
		minute: Number(out.minute),
		second: Number(out.second),
		weekday: WEEKDAYS.indexOf(out.weekday ?? ""),
	};
}

/** The instant a local wall-clock midnight occurs, or the first one after it. */
function localMidnight(
	fmt: Intl.DateTimeFormat,
	year: number,
	month: number,
	day: number,
): number {
	const wall = Date.UTC(year, month - 1, day);
	let guess = wall;
	for (let i = 0; i < 3; i++) {
		const p = partsAt(fmt, guess);
		const shown = Date.UTC(
			p.year,
			p.month - 1,
			p.day,
			p.hour,
			p.minute,
			p.second,
		);
		const next = guess + (wall - shown);
		if (next === guess) return guess;
		guess = next;
	}
	// Midnight does not exist on a spring-forward day: use the first instant
	// of that local date.
	let low = wall - 86_400_000;
	let high = wall + 86_400_000;
	// Zone transitions fall on whole seconds, so search on that grid.
	while (high - low > 1_000) {
		const mid = low + Math.floor((high - low) / 2_000) * 1_000;
		const p = partsAt(fmt, mid);
		if (Date.UTC(p.year, p.month - 1, p.day) < wall) low = mid;
		else high = mid;
	}
	return high;
}

export function assertValidWindow(spec: Spec): void {
	if (spec.type === "calendar" && spec.tz) formatter(spec.tz);
}

/** Start of the window containing `now`, inclusive. */
export function windowStart(spec: Spec, now: number): number {
	if (spec.type === "rolling") return now - spec.seconds * 1000;
	const tz = spec.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	const fmt = formatter(tz);
	const p = partsAt(fmt, now);
	if (spec.period === "day") return localMidnight(fmt, p.year, p.month, p.day);
	if (spec.period === "month") return localMidnight(fmt, p.year, p.month, 1);
	// Weeks start on Monday. Date.UTC normalizes a day before the 1st.
	const monday = new Date(Date.UTC(p.year, p.month - 1, p.day - p.weekday));
	return localMidnight(
		fmt,
		monday.getUTCFullYear(),
		monday.getUTCMonth() + 1,
		monday.getUTCDate(),
	);
}
