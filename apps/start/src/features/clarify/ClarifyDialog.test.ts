import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	mergeClarificationDrafts,
	parseSavedClarificationDrafts,
} from "./ClarifyDialog";

describe("clarification answer drafts", () => {
	test("restores only a matching string answer set", () => {
		expect(parseSavedClarificationDrafts('["one","two"]', 2)).toEqual([
			"one",
			"two",
		]);
		expect(parseSavedClarificationDrafts('["one"]', 2)).toBeNull();
		expect(parseSavedClarificationDrafts('["one",2]', 2)).toBeNull();
		expect(parseSavedClarificationDrafts("not json", 2)).toBeNull();
	});

	test("server answers win while unsent local text fills blanks", () => {
		expect(
			mergeClarificationDrafts(
				["saved remotely", ""],
				["stale local value", "unsent answer"],
			),
		).toEqual(["saved remotely", "unsent answer"]);
	});
});

describe("clarification actions", () => {
	const source = readFileSync(
		join(import.meta.dir, "ClarifyDialog.tsx"),
		"utf8",
	);

	test("offers one action appropriate to answer completeness", () => {
		expect(source).toContain("replannable && complete ? (");
		expect(source).toContain('"Continue expansion"');
		expect(source).toContain('"Save progress"');
		expect(source).not.toContain("Save &amp; re-plan");
	});

	test("does not overwrite browser drafts during initial restoration", () => {
		expect(source).toContain("if (!storageLoaded) return;");
		expect(source).toContain("localStorage.setItem(storageKey");
	});

	test("keeps a failed continuation open and makes persistence explicit", () => {
		expect(source).toContain('role="alert"');
		expect(source).toContain("Your answers are saved.");
		expect(source).toContain("Expansion did not start");
	});

	test("refetches task ownership even when answering or launch fails", () => {
		expect(source).toContain("trpc.tasks.list.queryFilter({ project })");
		expect(source).toContain("trpc.tasks.get.queryFilter({");
		expect(source).toContain("onSettled: invalidate");
	});

	test("offers a deliberate coordinated archive escape only for a Draft", () => {
		expect(source).toContain("clarification.draftTaskId");
		expect(source).toContain("trpc.clarify.archiveDraft.mutationOptions");
		expect(source).toContain("Archive this draft?");
		expect(source).toContain("expansion will not restart");
	});
});
