import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("task waiting for clarification", () => {
	const source = readFileSync(join(import.meta.dir, "TaskPage.tsx"), "utf8");

	test("locks content, status, deletion, keyboard save, and destination edits", () => {
		expect(source).toContain('task?.draftPhase === "waiting_for_answers"');
		expect(source).toContain(
			"const taskLocked = taskOwned || taskWaitingForAnswers",
		);
		expect(source).toContain("<fieldset disabled={taskLocked}");
		expect(source).toContain(
			"enabled: dirty && !save.isPending && !taskLocked",
		);
		expect(source).toContain(
			"if (!draft || !task || baseRev === null || taskLocked) return",
		);
		expect(source).toContain("{!taskLocked ? (");
	});

	test("does not offer In progress as a manual destination", () => {
		expect(source).toContain('status !== "in_progress" &&');
	});
});
