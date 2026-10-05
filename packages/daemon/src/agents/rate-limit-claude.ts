import type { RateLimitInfo } from "../rate-limit.ts";

/**
 * The claude CLI's `rate_limit_event` wire format. Vendor-specific, so it lives
 * next to `claudeAdapter` (via `AgentAdapter.parseRateLimit`); `rate-limit.ts`
 * keeps only the provider-agnostic text heuristic as fallback.
 */

/**
 * Any `allowed*` status means the request went through (`allowed` is a
 * heartbeat, `allowed_warning` a quota heads-up). Match by prefix, not
 * equality: treating the warning as a refusal once held dispatch until the
 * seven-day `resetsAt`. Anything else (`rejected`, unknown) counts as limited.
 */
export function isAllowedStatus(status: string): boolean {
	return status.toLowerCase().startsWith("allowed");
}

/** Structured verdict from stream-json `rate_limit_event` lines, or null if none. */
export function parseClaudeRateLimit(output: string): RateLimitInfo | null {
	if (!output.includes("rate_limit_event")) return null;

	let seen = false;
	let limited = false;
	let resetsAt: number | null = null;
	let utilization: number | null = null;

	for (const line of output.split("\n")) {
		const s = line.trim();
		if (!s.startsWith("{") || !s.includes("rate_limit_event")) continue;
		let o: { type?: string; rate_limit_info?: Record<string, unknown> };
		try {
			o = JSON.parse(s);
		} catch {
			continue; // truncated/interleaved line: ignore
		}
		if (o.type !== "rate_limit_event" || !o.rate_limit_info) continue;
		seen = true;
		const info = o.rate_limit_info;
		const status = typeof info.status === "string" ? info.status : "";
		if (status && !isAllowedStatus(status)) {
			limited = true;
			const r = info.resetsAt;
			if (typeof r === "number") resetsAt = toMs(r);
		} else if (typeof info.utilization === "number") {
			// A warning carries `utilization`/`surpassedThreshold` on an allowed event: keep, don't hold.
			utilization = info.utilization;
		}
	}
	return seen ? { limited, resetsAt, utilization } : null;
}

/** Normalize a unix timestamp to ms (10-digit = seconds, 13-digit = ms). */
function toMs(n: number): number {
	return n < 1e12 ? n * 1000 : n;
}
