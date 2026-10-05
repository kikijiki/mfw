import { describe, expect, test } from "bun:test";
import { parseClaudeRateLimit } from "../src/agents/rate-limit-claude.ts";
import { detectRateLimit } from "../src/rate-limit.ts";

/**
 * `detectRateLimit` is provider-agnostic: the claude CLI's `rate_limit_event`
 * format is parsed by `parseClaudeRateLimit` (via `AgentAdapter.parseRateLimit`).
 * It owns only the plain-text fallback heuristic and the composition "adapter
 * parser first, then text".
 *
 * Regression: scanning the entire raw output for loose phrases flagged a
 * successful run as rate limited, because the agent had read this module's own
 * source and its phrases ("usage limit reached", "429") appeared in tool output.
 */

describe("detectRateLimit, composes with an adapter's structured parser", () => {
	const ALLOWED_WARNING = JSON.stringify({
		type: "rate_limit_event",
		rate_limit_info: { status: "allowed_warning", utilization: 0.78 },
	});
	const REJECTED = JSON.stringify({
		type: "rate_limit_event",
		rate_limit_info: { status: "rejected", resetsAt: 1786121400 },
	});

	test("the adapter's verdict wins, including a not-limited one the text heuristic would have caught", () => {
		expect(detectRateLimit(ALLOWED_WARNING, parseClaudeRateLimit).limited).toBe(
			false,
		);
	});

	test("a real rejection is read from the adapter's parser", () => {
		const r = detectRateLimit(REJECTED, parseClaudeRateLimit);
		expect(r.limited).toBe(true);
		expect(r.resetsAt).toBe(1786121400 * 1000);
	});

	test("with no adapter parser, the same text falls through to the heuristic", () => {
		// `REJECTED` has no SIGNALS phrase, so the fallback alone reads it as not limited.
		expect(detectRateLimit(REJECTED).limited).toBe(false);
	});
});

describe("detectRateLimit, text fallback for non-CLI providers", () => {
	test("still catches a real limit message", () => {
		expect(detectRateLimit("Claude usage limit reached").limited).toBe(true);
		expect(detectRateLimit("HTTP 429 Too Many Requests").limited).toBe(true);
		expect(detectRateLimit("quota exceeded for this key").limited).toBe(true);
	});

	test("prose about rate limiting is not a limit", () => {
		for (const s of [
			"the scheduler pauses on rate limit events",
			"§4 covers rate limiting and the scheduler hold",
			"added a rate limiting section to the docs",
		]) {
			expect([s, detectRateLimit(s).limited]).toEqual([s, false]);
		}
	});

	test("a bare 429 in ordinary output is not a limit", () => {
		expect(detectRateLimit("processed 429 files").limited).toBe(false);
		expect(
			detectRateLimit("   429 packages/daemon/src/daemon.ts").limited,
		).toBe(false);
	});

	test("only the tail is scanned, so mid-run discussion cannot trip it", () => {
		const output = `usage limit reached${"\n.".repeat(20_000)}\nall done`;
		expect(detectRateLimit(output).limited).toBe(false);
	});

	test("a reset time is only read near a reset keyword", () => {
		// An unrelated timestamp must not become the pause-until.
		const r = detectRateLimit(
			"usage limit reached\nlast commit 2020-01-01T00:00:00Z",
		);
		expect(r.limited).toBe(true);
		expect(r.resetsAt).toBeNull();
	});

	test("parses the pipe-suffixed epoch the CLI emits", () => {
		expect(detectRateLimit("usage limit reached|1786121400").resetsAt).toBe(
			1786121400 * 1000,
		);
	});
});
