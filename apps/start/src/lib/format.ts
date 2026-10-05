/** Formatting for the data surfaces, so columns stay aligned and units consistent. */

/** Sub-cent costs are shown as `<$0.01`, not rounded to zero. */
export function formatCost(usd: number | null | undefined): string {
	if (usd == null || !Number.isFinite(usd)) return "-";
	if (usd === 0) return "$0.00";
	if (usd < 0.01) return "<$0.01";
	if (usd < 100) return `$${usd.toFixed(2)}`;
	return `$${Math.round(usd).toLocaleString("en-US")}`;
}

export function formatTokens(n: number | null | undefined): string {
	if (n == null || !Number.isFinite(n)) return "-";
	if (n < 1_000) return String(n);
	if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

/** Compact duration: "12m", not "00:12:04.331". */
export function formatDuration(ms: number | null | undefined): string {
	if (ms == null || !Number.isFinite(ms) || ms < 0) return "-";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`;
	const h = Math.floor(m / 60);
	if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
	const d = Math.floor(h / 24);
	return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`;
}

/**
 * "3h ago" / "in 12m". Rounds toward the coarser unit so a row that says "2h"
 * does not flicker to "1h 59m" on the next tick.
 */
export function formatRelative(
	value: Date | number,
	now: number = Date.now(),
): string {
	const ts = value instanceof Date ? value.getTime() : value;
	if (!Number.isFinite(ts)) return "-";
	const delta = ts - now;
	const abs = Math.abs(delta);
	if (abs < 10_000) return "just now";
	const suffix = delta < 0 ? " ago" : "";
	const prefix = delta < 0 ? "" : "in ";
	return `${prefix}${formatDuration(abs)}${suffix}`;
}

export function formatAbsolute(value: Date | number): string {
	const d = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

/** Turns `in_progress` / `rate_limited` into `in progress` / `rate limited`. */
export function humanizeToken(value: string): string {
	return value.replace(/[_-]+/g, " ");
}

/**
 * One-line tail for an audit event, from whatever its payload carries. Shared
 * so the task timeline and the project event feed describe events identically.
 */
export function summarizePayload(payload: unknown): string {
	if (typeof payload !== "object" || payload === null) return "";
	const o = payload as Record<string, unknown>;
	const parts: string[] = [];
	if (typeof o.from === "string" && typeof o.to === "string") {
		parts.push(`${o.from} → ${o.to}`);
	} else if (typeof o.to === "string") {
		parts.push(`→ ${o.to}`);
	}
	if (typeof o.reason === "string" && o.reason) parts.push(o.reason);
	if (typeof o.check === "string") parts.push(o.check);
	return parts.length > 0 ? ` - ${parts.join(" · ")}` : "";
}
