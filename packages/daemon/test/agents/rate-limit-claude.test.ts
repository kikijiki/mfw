import { describe, expect, test } from "bun:test";
import { parseClaudeRateLimit } from "../../src/agents/rate-limit-claude.ts";

/**
 * Regression: a successful run was discarded as "rate limited" because the
 * detector scanned all output, matched phrases from the rate-limit source the
 * agent had read, and lifted `resetsAt` from a routine `allowed` heartbeat.
 * Claude's wire format is parsed here, reached via `AgentAdapter.parseRateLimit`.
 */

/** Routine heartbeat; means "not limited". */
const ALLOWED = JSON.stringify({
	type: "rate_limit_event",
	rate_limit_info: {
		status: "allowed",
		resetsAt: 1786121400,
		rateLimitType: "five_hour",
		overageStatus: "allowed",
		isUsingOverage: false,
	},
});

/**
 * Payload that once halted dispatch for 66 hours. `allowed_warning` is a
 * utilisation heads-up; the request was allowed. Its `resetsAt` is the end of
 * the seven-day window and must not become a hold expiry.
 */
const ALLOWED_WARNING = JSON.stringify({
	type: "rate_limit_event",
	rate_limit_info: {
		status: "allowed_warning",
		resetsAt: 1787068800,
		rateLimitType: "seven_day",
		utilization: 0.78,
		isUsingOverage: false,
		surpassedThreshold: 0.75,
	},
});

/** What an actual limit looks like. */
const REJECTED = JSON.stringify({
	type: "rate_limit_event",
	rate_limit_info: {
		status: "rejected",
		resetsAt: 1786121400,
		rateLimitType: "five_hour",
	},
});

const SUCCESS = JSON.stringify({
	type: "result",
	subtype: "success",
	duration_ms: 728733,
});

describe("parseClaudeRateLimit", () => {
	test("a routine allowed heartbeat is not a limit", () => {
		expect(parseClaudeRateLimit(ALLOWED)?.limited).toBe(false);
	});

	test("an allowed_warning is a heads-up, not a limit: the request went through", () => {
		const r = parseClaudeRateLimit(ALLOWED_WARNING);
		expect(r?.limited).toBe(false);
		expect(r?.resetsAt).toBeNull();
		expect(r?.utilization).toBe(0.78);
	});

	test("a warning followed by a successful run stays not-limited", () => {
		const output = [ALLOWED, ALLOWED_WARNING, SUCCESS].join("\n");
		expect(parseClaudeRateLimit(output)?.limited).toBe(false);
	});

	test("a real rejection still wins over an earlier warning", () => {
		const output = [ALLOWED_WARNING, REJECTED].join("\n");
		const r = parseClaudeRateLimit(output);
		expect(r?.limited).toBe(true);
		expect(r?.resetsAt).toBe(1786121400_000);
	});

	test("an allowed heartbeat does not become a limit because the agent discussed rate limiting", async () => {
		const src = await Bun.file(
			"packages/daemon/src/agents/rate-limit-claude.ts",
		).text();
		const output = [
			ALLOWED,
			`{"tool_result":${JSON.stringify(src)}}`,
			SUCCESS,
		].join("\n");
		expect(parseClaudeRateLimit(output)?.limited).toBe(false);
	});

	test("a rejected event is a limit, with its reset time", () => {
		const r = parseClaudeRateLimit([ALLOWED, REJECTED].join("\n"));
		expect(r?.limited).toBe(true);
		expect(r?.resetsAt).toBe(1786121400 * 1000);
	});

	test("the reset time comes from the limiting event, not a heartbeat", () => {
		expect(parseClaudeRateLimit(ALLOWED)?.resetsAt).toBeNull();
	});

	test("no rate_limit_event at all returns null, not a verdict", () => {
		expect(parseClaudeRateLimit(SUCCESS)).toBeNull();
	});
});
