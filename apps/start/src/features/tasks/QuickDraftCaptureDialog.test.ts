import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	quickDraftCanSubmit,
	quickDraftCaptureVariables,
} from "./QuickDraftCaptureDialog";

describe("quick draft capture dialog", () => {
	test("requires meaningful input beyond the initial prefix", () => {
		expect(quickDraftCanSubmit("", "")).toBe(false);
		expect(quickDraftCanSubmit("   ", "")).toBe(false);
		expect(quickDraftCanSubmit("Fix: ", "Fix: ")).toBe(false);
		expect(quickDraftCanSubmit("  Fix:  ", "Fix: ")).toBe(false);
		expect(quickDraftCanSubmit("Fix: flaky login", "Fix: ")).toBe(true);
	});

	test("trims the prompt and includes the stable request id", () => {
		expect(
			quickDraftCaptureVariables(
				"mfw",
				"  Fix: flaky login  ",
				"request-1",
				"backlog",
				true,
			),
		).toEqual({
			project: "mfw",
			text: "Fix: flaky login",
			requestId: "request-1",
			afterExpansion: "backlog",
			requireReview: true,
		});
	});

	test("uses quick capture and refreshes both task views", () => {
		const source = readFileSync(
			join(import.meta.dir, "QuickDraftCaptureDialog.tsx"),
			"utf8",
		);

		expect(source).toContain("trpc.tasks.captureQuick.mutationOptions");
		expect(source).not.toContain("trpc.tasks.create");
		expect(source).toContain("trpc.tasks.list.queryFilter");
		expect(source).toContain("trpc.tasks.graph.queryFilter");
		expect(source).toContain("retry: 2");
		expect(source).toContain("setSelectionRange(end, end)");
		expect(source).toContain("Move to ready");
		expect(source).toContain("Keep in backlog");
		expect(source).toContain("Require human review");
	});
});
