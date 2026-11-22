import type { FailureClass } from "./verifier.ts";

/**
 * Actionable failure classes (the sandbox-era design's attention patterns):
 * what a person or the scheduler can DO about a failed run or check, not how
 * it failed internally.
 *
 * - `auth`: credentials are missing or rejected. Retrying cannot help; the
 *   caller holds the provider fleet-wide and raises one `act` item.
 * - `rate_limit`: a quota or throttle. Wait for the reset; not a task fault.
 * - `timeout`: a wall, idle, turn or per-check time limit expired.
 * - `provider`: the vendor or the network is unhealthy (5xx, overload).
 * - `runtime`: the machine, harness or tooling broke (spawn failure, signal
 *   death, finalize error), not the code under test.
 * - `agent`: the agent's work did not meet the bar (a check ran and failed,
 *   scope violation, nothing changed).
 * - `other`: a failure nothing above explains.
 * - `unconfirmed`: the run's end is unknown (daemon restart, interruption).
 *   It is never shown as a failure and never counts toward a breaker.
 *
 * Pure functions over observed facts only. Output text is a last resort and
 * only the tail is read, so an agent merely discussing a 401 is not misread.
 */
export type ActionableFailureClass =
	| "auth"
	| "rate_limit"
	| "timeout"
	| "provider"
	| "runtime"
	| "agent"
	| "other"
	| "unconfirmed";

/** Classes a person can be paged for; `unconfirmed` is excluded by design. */
export function isShownAsFailure(c: ActionableFailureClass): boolean {
	return c !== "unconfirmed";
}

const TAIL_CHARS = 8192;

const AUTH = [
	/\bnot (?:logged|signed) in\b/i,
	/\bplease (?:run )?\/?login\b/i,
	/\binvalid (?:api[ _-]?key|x-api-key|credentials?|token)\b/i,
	/\b(?:authentication|authorization)[ _-](?:failed|error|required)\b/i,
	/\bunauthorized\b/i,
	/\b(?:oauth )?token (?:has )?(?:expired|revoked)\b/i,
	/(?:status|code|http|error)\D{0,12}\b40[13]\b/i,
];
const RATE_LIMIT = [
	/usage limit reached/i,
	/rate[- ]?limit(?:ed\b|\s+reached|\s+exceeded|\s+hit)/i,
	/quota (?:exceeded|exhausted)/i,
	/too many requests/i,
	/(?:status|code|http|error)\D{0,12}\b429\b/i,
];
const PROVIDER = [
	/\boverloaded\b/i,
	/\bservice unavailable\b/i,
	/\bbad gateway\b/i,
	/\bECONN(?:RESET|REFUSED)\b/,
	/\bgetaddrinfo\b/i,
	/(?:status|code|http|error)\D{0,12}\b(?:5\d\d)\b/i,
];
const TIMEOUT = [/\btimed? ?out\b/i, /\bETIMEDOUT\b/];

const hit = (res: RegExp[], text: string) => res.some((re) => re.test(text));

export interface RunFailureFacts {
	/** The run's settled state (`failed`, `killed`, `finalize_error`, ...). */
	state: string;
	outcome?: string | null;
	killReason?: string | null;
	exitCode?: number | null;
	/** The run's note or the tail of its output, when there is one. */
	text?: string | null;
}

/**
 * The class of a settled run, or null when it did not fail (a clean finish, a
 * human review hand-off, a manual kill).
 */
export function classifyRunFailure(
	f: RunFailureFacts,
): ActionableFailureClass | null {
	if (f.outcome === "rate_limited" || f.state === "rate_limited")
		return "rate_limit";
	if (f.state === "completed" || f.state === "needs_review") return null;
	if (f.outcome === "killed_manual" || f.killReason === "manual") return null;
	if (f.state === "interrupted" || f.outcome === "interrupted")
		return "unconfirmed";

	if (f.killReason?.startsWith("watchdog-")) {
		return f.killReason === "watchdog-scope" ||
			f.killReason === "watchdog-files"
			? "agent"
			: "timeout";
	}

	const text = f.text
		? f.text.length > TAIL_CHARS
			? f.text.slice(-TAIL_CHARS)
			: f.text
		: "";
	if (text) {
		if (hit(AUTH, text)) return "auth";
		if (hit(RATE_LIMIT, text)) return "rate_limit";
		if (hit(PROVIDER, text)) return "provider";
		if (hit(TIMEOUT, text)) return "timeout";
	}

	if (f.outcome === "start_failed" || f.state === "finalize_error")
		return "runtime";
	// 128+n is a signal death: the process was killed, it did not decide to fail.
	if (typeof f.exitCode === "number" && f.exitCode > 128) return "runtime";
	if (f.state === "failed") return /verif/i.test(text) ? "agent" : "other";
	if (f.state === "killed") return "other";
	return null;
}

/** The actionable class of one failed DoD check. */
export function classifyCheckFailure(c: FailureClass): ActionableFailureClass {
	switch (c) {
		case "timeout":
			return "timeout";
		case "crashed":
			return "runtime";
		default:
			// `failed`, `missing-file`, `no-change`: the work did not meet the bar.
			return "agent";
	}
}
