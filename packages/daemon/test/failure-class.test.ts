import { describe, expect, test } from "bun:test";
import {
	classifyCheckFailure,
	classifyRunFailure,
	isShownAsFailure,
} from "../src/failure-class.ts";

describe("classifyRunFailure", () => {
	test("clean finishes, review hand-offs and manual kills are not failures", () => {
		expect(classifyRunFailure({ state: "completed" })).toBeNull();
		expect(classifyRunFailure({ state: "needs_review" })).toBeNull();
		expect(
			classifyRunFailure({ state: "killed", outcome: "killed_manual" }),
		).toBeNull();
		expect(
			classifyRunFailure({ state: "killed", killReason: "manual" }),
		).toBeNull();
	});

	test("an interrupted run is unconfirmed and never shown as a failure", () => {
		const c = classifyRunFailure({ state: "interrupted" });
		expect(c).toBe("unconfirmed");
		expect(isShownAsFailure(c as "unconfirmed")).toBe(false);
		expect(isShownAsFailure("agent")).toBe(true);
	});

	test("rate limits win over any text", () => {
		expect(
			classifyRunFailure({
				state: "rate_limited",
				outcome: "rate_limited",
				text: "401 unauthorized",
			}),
		).toBe("rate_limit");
	});

	test("watchdog kills split into timeout and agent (scope)", () => {
		for (const r of ["watchdog-idle", "watchdog-wall", "watchdog-turns"])
			expect(classifyRunFailure({ state: "killed", killReason: r })).toBe(
				"timeout",
			);
		expect(
			classifyRunFailure({ state: "killed", killReason: "watchdog-scope" }),
		).toBe("agent");
	});

	test("auth text is auth, even when it mentions other things", () => {
		expect(
			classifyRunFailure({
				state: "failed",
				text: "Error: not logged in. Please run /login",
			}),
		).toBe("auth");
		expect(
			classifyRunFailure({ state: "failed", text: "API error status 401" }),
		).toBe("auth");
		expect(
			classifyRunFailure({ state: "failed", text: "invalid api key" }),
		).toBe("auth");
	});

	test("provider, rate limit and timeout text", () => {
		expect(
			classifyRunFailure({ state: "failed", text: "Overloaded, try later" }),
		).toBe("provider");
		expect(
			classifyRunFailure({ state: "failed", text: "HTTP error 503" }),
		).toBe("provider");
		expect(
			classifyRunFailure({ state: "failed", text: "too many requests" }),
		).toBe("rate_limit");
		expect(
			classifyRunFailure({ state: "failed", text: "request timed out" }),
		).toBe("timeout");
	});

	test("only the tail of the text is read", () => {
		const text = `401 unauthorized\n${"x".repeat(20_000)}`;
		expect(classifyRunFailure({ state: "failed", text })).toBe("other");
	});

	test("a bare 401 in a line count is not auth", () => {
		expect(
			classifyRunFailure({ state: "failed", text: "wrote 401 lines" }),
		).toBe("other");
	});

	test("runtime: start failure, finalize error, signal death", () => {
		expect(
			classifyRunFailure({ state: "failed", outcome: "start_failed" }),
		).toBe("runtime");
		expect(classifyRunFailure({ state: "finalize_error" })).toBe("runtime");
		expect(classifyRunFailure({ state: "failed", exitCode: 137 })).toBe(
			"runtime",
		);
	});

	test("agent: verification failed; other: unexplained failure", () => {
		expect(classifyRunFailure({ state: "failed", text: "verify failed" })).toBe(
			"agent",
		);
		expect(classifyRunFailure({ state: "failed", exitCode: 1 })).toBe("other");
	});
});

describe("classifyCheckFailure", () => {
	test("maps the verifier's facts to actionable classes", () => {
		expect(classifyCheckFailure("timeout")).toBe("timeout");
		expect(classifyCheckFailure("crashed")).toBe("runtime");
		expect(classifyCheckFailure("failed")).toBe("agent");
		expect(classifyCheckFailure("missing-file")).toBe("agent");
		expect(classifyCheckFailure("no-change")).toBe("agent");
	});
});
