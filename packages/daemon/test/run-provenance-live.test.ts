import { describe, expect, test } from "bun:test";
import { exitProvenance, parseExitClaim } from "../src/run-exit-evidence.ts";
import { installCleanup } from "./support/review-fixes.ts";

/**
 * A hostile agent in a real sandbox: it forges an exit and a report, tries to
 * overwrite the host's record, then fails. Fixtures live under a temp HOME.
 */

installCleanup();

describe("exit evidence", () => {
	test("only the host's records are host-observed", () => {
		expect(exitProvenance("host-exit-record", null)).toBe("host-observed");
		expect(exitProvenance("control-exit", "split")).toBe("host-observed");
		expect(exitProvenance("control-exit", null)).toBe("sandbox-reported");
		expect(exitProvenance("flat-exit", "split")).toBe("sandbox-reported");
		expect(exitProvenance("flat-exit", null)).toBe("sandbox-reported");
	});

	test("a claim is parsed strictly", () => {
		expect(parseExitClaim("exit:0\n")).toEqual({ kind: "exit", code: 0 });
		expect(parseExitClaim("killed:manual")).toEqual({
			kind: "killed",
			reason: "manual",
		});
		for (const bad of [
			"",
			"exit:",
			"exit:-1",
			"exit:99999",
			"ok",
			"killed:<b>",
		]) {
			expect(parseExitClaim(bad)).toEqual({ kind: "invalid" });
		}
	});
});
