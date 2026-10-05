import { describe, expect, test } from "bun:test";

import { afterReviewDecisionHref } from "./navigation";

describe("review decision navigation", () => {
	const queue = [
		{ project: "mfw", taskId: "MFW-70" },
		{ project: "other", taskId: "OTHER-1" },
		{ project: "mfw", taskId: "MFW-71" },
	];

	test("a project inbox stays in that project", () => {
		expect(
			afterReviewDecisionHref("mfw", "MFW-70", "project-inbox", queue),
		).toBe("/p/mfw/review/MFW-71?from=project-inbox");
	});

	test("an exhausted project queue returns to its project inbox", () => {
		expect(
			afterReviewDecisionHref("mfw", "MFW-70", "project-inbox", [
				{ project: "mfw", taskId: "MFW-70" },
				{ project: "other", taskId: "OTHER-1" },
			]),
		).toBe("/p/mfw/inbox");
	});

	test("the fleet inbox keeps walking the fleet queue", () => {
		expect(afterReviewDecisionHref("mfw", "MFW-70", "inbox", queue)).toBe(
			"/p/other/review/OTHER-1?from=inbox",
		);
	});
});
