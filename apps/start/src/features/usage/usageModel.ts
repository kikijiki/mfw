import type {
	UsageStatus,
	UsageSubscription,
	UsageWindow,
} from "@mfw/daemon/usage-monitor";

/**
 * Pure view model for the subscription usage meters (sidebar, phone strip,
 * Fleet page): thresholds, "resets in 2h13m", and what to say when the numbers
 * are stale or unknown. Colour is never the only signal: every severity has a
 * word and a glyph name the component renders.
 */

export type UsageSeverity = "ok" | "warn" | "critical";

/** At or above: the meter warns. */
export const WARN_AT = 80;
/** At or above: the meter is critical. */
export const CRITICAL_AT = 95;

export function severityOf(percent: number): UsageSeverity {
	if (percent >= CRITICAL_AT) return "critical";
	if (percent >= WARN_AT) return "warn";
	return "ok";
}

const SEVERITY_WORD: Record<UsageSeverity, string> = {
	ok: "",
	warn: "high",
	critical: "nearly out",
};

/**
 * "2h13m", "4d 3h", "45m", "<1m". Minutes resolution under a day; a day or
 * more drops the minutes so a week-long window does not read as noise.
 */
export function formatResetIn(
	resetsAt: number | null,
	now: number,
): string | null {
	if (resetsAt === null || !Number.isFinite(resetsAt)) return null;
	const ms = resetsAt - now;
	if (ms <= 0) return "now";
	const totalMin = Math.floor(ms / 60_000);
	if (totalMin < 1) return "<1m";
	const days = Math.floor(totalMin / 1440);
	const hours = Math.floor((totalMin % 1440) / 60);
	const mins = totalMin % 60;
	if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	if (hours > 0)
		return mins > 0
			? `${hours}h${String(mins).padStart(2, "0")}m`
			: `${hours}h`;
	return `${mins}m`;
}

/** "resets in 2h13m", "resetting now", or null when the vendor gave no time. */
export function resetPhrase(
	resetsAt: number | null,
	now: number,
): string | null {
	const r = formatResetIn(resetsAt, now);
	if (r === null) return null;
	return r === "now" ? "resetting now" : `resets in ${r}`;
}

export interface MeterView {
	label: string;
	/** Whole percent for display, clamped 0..100. */
	percent: number;
	/** The bar fill, 0..100 (same as `percent`). */
	fill: number;
	severity: UsageSeverity;
	reset: string | null;
	/** True when this window is from a stale read. */
	stale: boolean;
	/** Full sentence for the accessible name. */
	text: string;
	/**
	 * The hover tooltip: only what the bar row does not already show, with no
	 * stale or unavailable explanation (the provider block states that once).
	 */
	tip: string;
}

export function meterOf(
	w: UsageWindow,
	now: number,
	status: UsageStatus,
): MeterView {
	const percent = Math.round(Math.min(100, Math.max(0, w.usedPercent)));
	const severity = severityOf(w.usedPercent);
	const reset = resetPhrase(w.resetsAt, now);
	const stale = status === "stale";
	const word = SEVERITY_WORD[severity];
	const text = [
		`${w.label} window: ${percent}% used${word ? ` (${word})` : ""}`,
		reset,
		stale ? "last read is stale" : null,
	]
		.filter(Boolean)
		.join(", ");
	return {
		label: w.label,
		percent,
		fill: percent,
		severity,
		reset,
		stale,
		text,
		tip: reset ? `${percent}% used · ${reset}` : `${percent}% used`,
	};
}

export interface SubscriptionView {
	provider: string;
	name: string;
	plan: string | null;
	status: UsageStatus;
	meters: MeterView[];
	/** The most used window, for the collapsed rail. Null with no windows. */
	worst: MeterView | null;
	/** What to show instead of meters, or beside them when stale. */
	note: string | null;
	/** One-line summary for a tooltip or aria-label. */
	summary: string;
}

/** Order: 5h before 7d before the rest, then by label. */
function windowRank(w: UsageWindow): number {
	const m = w.windowMinutes;
	if (m !== null) return m;
	return Number.MAX_SAFE_INTEGER;
}

export function subscriptionOf(
	s: UsageSubscription,
	now: number,
): SubscriptionView {
	const windows = [...s.windows].sort(
		(a, b) => windowRank(a) - windowRank(b) || a.label.localeCompare(b.label),
	);
	const meters = windows.map((w) => meterOf(w, now, s.status));
	const worst =
		meters.length === 0
			? null
			: meters.reduce((a, b) => (b.percent > a.percent ? b : a));
	let note: string | null = null;
	if (s.status === "unavailable") {
		note = `usage unavailable${s.error ? `: ${s.error}` : ""}`;
	} else if (s.status === "stale") {
		note = `stale${s.fetchedAt ? `, read ${ageText(s.fetchedAt, now)} ago` : ""}${s.error ? ` (${s.error})` : ""}`;
	}
	const plan = s.accountLabel ? ` (${s.accountLabel})` : "";
	const summary =
		meters.length > 0
			? `${s.name}${plan}: ${meters.map((m) => `${m.label} ${m.percent}%`).join(", ")}${note ? `, ${note}` : ""}`
			: `${s.name}${plan}: ${note ?? "no usage data"}`;
	return {
		provider: s.provider,
		name: s.name,
		plan: s.accountLabel,
		status: s.status,
		meters,
		worst,
		note,
		summary,
	};
}

function ageText(at: number, now: number): string {
	const min = Math.max(0, Math.floor((now - at) / 60_000));
	if (min < 1) return "<1m";
	if (min < 60) return `${min}m`;
	return `${Math.floor(min / 60)}h`;
}

/** Severity of a whole subscription: its worst window; unknown reads as ok (shown by note). */
export function subscriptionSeverity(v: SubscriptionView): UsageSeverity {
	return v.worst?.severity ?? "ok";
}

export const SEVERITY_TOKEN: Record<UsageSeverity, string> = {
	ok: "--mfw-accent",
	warn: "--mfw-warn",
	critical: "--mfw-critical",
};

export { SEVERITY_WORD };
