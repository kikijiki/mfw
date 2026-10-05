/**
 * Detect a usage/rate-limit outage in an agent's output. A quota hit is not a
 * task failure: dispatch pauses until reset and the task requeues without
 * consuming a repair attempt (see daemon.finalizeRun).
 *
 * Provider-agnostic: vendor wire formats are parsed by the adapter
 * (`AgentAdapter.parseRateLimit`); this is the plain-text fallback. Only the
 * tail is scanned so an agent merely discussing rate limits is not misread.
 */
export interface RateLimitInfo {
	limited: boolean;
	/** Epoch ms when the limit resets, if the message carried a parseable time. */
	resetsAt: number | null;
	/** Fraction of quota used (0-1) on an otherwise-allowed event: a heads-up, not a hold. Null/absent when unreported. */
	utilization?: number | null;
}

/** Phrases meaning a limit was hit; prose like "rate limiting" must not match. */
const SIGNALS: RegExp[] = [
	/usage limit reached/i,
	/\b\d+\s*-?\s*hour limit reached/i,
	/rate[- ]?limit(?:ed\b|\s+reached|\s+exceeded|\s+hit)/i,
	/claude (?:ai )?usage limit/i,
	/quota (?:exceeded|exhausted)/i,
	/too many requests/i,
	// A bare 429 matches line counts and byte offsets, so require HTTP context.
	/(?:status|code|http|error)\D{0,12}\b429\b/i,
];

/** Only the tail is scanned in the text fallback: a real limit ends the run. */
const TAIL_BYTES = 8192;

/**
 * `parse` is the adapter's provider-specific interpretation, tried first on the
 * full output and trusted even when it says "not limited". Only if absent or
 * empty do we fall back to the text heuristic.
 */
export function detectRateLimit(
	output: string | null | undefined,
	parse?: (output: string) => RateLimitInfo | null,
): RateLimitInfo {
	if (!output) return { limited: false, resetsAt: null };

	const structured = parse?.(output);
	if (structured) return structured;

	const tail = output.length > TAIL_BYTES ? output.slice(-TAIL_BYTES) : output;
	if (!SIGNALS.some((re) => re.test(tail)))
		return { limited: false, resetsAt: null };
	return { limited: true, resetsAt: parseResetAt(tail) };
}

/**
 * Best-effort reset time: pipe-suffixed epoch (`limit reached|1719400000`),
 * epoch near "reset", or ISO-8601 near "reset". Null means the caller applies
 * a default backoff.
 */
function parseResetAt(output: string): number | null {
	// pipe-suffixed epoch immediately after the limit phrase
	const pipe = /limit reached\s*\|\s*(\d{10,13})/i.exec(output);
	if (pipe) return toMs(Number(pipe[1]));

	// a bare epoch near a "reset" keyword
	const epoch = /reset\D{0,30}(\d{10,13})/i.exec(output);
	if (epoch) return toMs(Number(epoch[1]));

	// ISO-8601 must be anchored to "reset", or any timestamp in the output matches.
	const iso =
		/reset\D{0,30}(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(
			output,
		);
	if (iso) {
		const t = Date.parse(iso[1] as string);
		if (!Number.isNaN(t)) return t;
	}
	return null;
}

/** Normalize a unix timestamp to ms (10-digit = seconds, 13-digit = ms). */
function toMs(n: number): number {
	return n < 1e12 ? n * 1000 : n;
}
