import { describe, expect, test } from "bun:test";
import { blockedReasonText } from "./format";

describe("blockedReasonText", () => {
	test("a brain block reads as words, without the task id", () => {
		expect(
			blockedReasonText(
				'product_decision: DUMMYTODO-5: what does "better" mean?',
			),
		).toBe('Needs your decision: what does "better" mean?');
	});

	test("anything else is left as written", () => {
		expect(blockedReasonText("waiting for the schema")).toBe(
			"waiting for the schema",
		);
	});
});
