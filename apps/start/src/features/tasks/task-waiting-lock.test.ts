import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("task waiting for clarification", () => {
	// The editor lives in TaskDefinition; the status select stays in TaskPage.
	const definition = readFileSync(
		join(import.meta.dir, "TaskDefinition.tsx"),
		"utf8",
	);
	const page = readFileSync(join(import.meta.dir, "TaskPage.tsx"), "utf8");
	const source = definition;

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
		expect(page).toContain('status !== "in_progress" &&');
	});
});
