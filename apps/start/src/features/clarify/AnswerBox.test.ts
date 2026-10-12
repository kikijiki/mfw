import { describe, expect, test } from "bun:test";

import { answerMode } from "./AnswerBox";

describe("where a question is answered", () => {
	test("a task run's single question is answered inline; anything else in the dialog", () => {
		expect(answerMode({ kind: "task", items: [{ answer: null }] })).toBe(
			"inline",
		);
		expect(
			answerMode({ kind: "task", items: [{ answer: null }, { answer: null }] }),
		).toBe("dialog");
		expect(answerMode({ kind: "planner", items: [{ answer: null }] })).toBe(
			"dialog",
		);
		expect(answerMode({ kind: "importer", items: [{ answer: null }] })).toBe(
			"dialog",
		);
	});
});
