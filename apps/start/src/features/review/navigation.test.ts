import { describe, expect, test } from "bun:test";

import { nextAfterDecision, reviewQueue, stepReview } from "./navigation";

const item = (project: string, taskId: string, kind = "review") => ({
	kind,
	project,
	taskId,
});

describe("review queue", () => {
	test("is this project's review items from the inbox, in order, once each", () => {
		const queue = reviewQueue(
			[
				item("mfw", "MFW-70"),
				item("other", "OTHER-1"),
				item("mfw", "MFW-71", "needs_answer"),
				item("mfw", "MFW-72"),
				item("mfw", "MFW-70"),
			],
			"mfw",
		);
		expect(queue.map((q) => q.taskId)).toEqual(["MFW-70", "MFW-72"]);
		expect(reviewQueue(undefined, "mfw")).toEqual([]);
	});
});

describe("walking with [ and ]", () => {
	const queue = [{ taskId: "A" }, { taskId: "B" }, { taskId: "C" }];

	test("steps and wraps", () => {
		expect(stepReview(queue, "A", 1)?.taskId).toBe("B");
		expect(stepReview(queue, "C", 1)?.taskId).toBe("A");
		expect(stepReview(queue, "A", -1)?.taskId).toBe("C");
	});

	test("from a task that is not in the queue, enters it at the near end", () => {
		expect(stepReview(queue, "Z", 1)?.taskId).toBe("A");
		expect(stepReview(queue, "Z", -1)?.taskId).toBe("C");
	});

	test("with nowhere else to go, stays", () => {
		expect(stepReview([{ taskId: "A" }], "A", 1)).toBeNull();
		expect(stepReview([], "A", 1)).toBeNull();
	});
});

describe("after a decision", () => {
	const queue = [{ taskId: "A" }, { taskId: "B" }, { taskId: "C" }];

	test("moves to the next waiting task, wrapping, never the one just decided", () => {
		expect(nextAfterDecision(queue, "A")?.taskId).toBe("B");
		expect(nextAfterDecision(queue, "C")?.taskId).toBe("A");
	});

	test("an exhausted queue has no next", () => {
		expect(nextAfterDecision([{ taskId: "A" }], "A")).toBeNull();
		expect(nextAfterDecision([], "A")).toBeNull();
	});
});
