import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("mobile quick capture", () => {
	const source = readFileSync(join(import.meta.dir, "BoardPage.tsx"), "utf8");

	test("the primary create button becomes the form submit action", () => {
		expect(source).toContain('form="quick-capture-task"');
		expect(source).toContain('id="quick-capture-task"');
		expect(source).toContain(
			'{captureQuick.isPending ? "Creating…" : "Create task"}',
		);
		expect(source).not.toContain('Capturing…" : "Capture"');
	});

	test("a successful capture selects the mobile status without changing collapsed columns", () => {
		const successFlow = source.match(
			/onSuccess: \(task\) => \{([\s\S]*?)\n\t\t\t\},\n\t\t\}\),/,
		)?.[1];

		// The captured task's column (by role), not a hardcoded status.
		expect(successFlow).toContain("setMobileStatus(");
		expect(successFlow).toContain("c.role === task.status");
		expect(successFlow).not.toContain("setCollapsedColumns");
		expect(successFlow).not.toContain("writeCollapsedColumns");
		expect(source).toContain("It will move to ready after expansion.");
	});

	test("retries carry a stable request id until success", () => {
		expect(source).toContain("retry: 2");
		expect(source).toContain("requestId: captureRequestId");
		expect(source).toContain(
			"setCaptureRequestId(globalThis.crypto.randomUUID())",
		);
	});

	test("draft expansion state and safe moves are visible", () => {
		// A draft's live run reads "expanding" in the card's agent strip
		// (CardAgentStrip.test.tsx); the move rules live in columns.test.ts.
		expect(source).toContain('isDraft={task.status === "draft"}');
		expect(source).toContain("draftPhaseLabel(task.draftPhase");
		expect(source).toContain("task.afterExpansion");
		expect(source).toContain("draggable={draggable && !locked}");
		expect(source).toContain("dropVerdict(c, task).ok");
		expect(source).toContain("Questions · action required");
		expect(source).toContain(
			'owned || task.draftPhase === "waiting_for_answers"',
		);
	});

	test("capture restores post-expansion status and human-review controls", () => {
		expect(source).toContain('aria-label="After expansion"');
		expect(source).toContain(
			'<SelectItem value="ready">Move to ready</SelectItem>',
		);
		expect(source).toContain(
			'<SelectItem value="backlog">Keep in backlog</SelectItem>',
		);
		expect(source).toContain("Human review");
		expect(source).toContain("afterExpansion,");
		expect(source).toContain("requireReview: captureRequireReview");
	});

	test("each board column exposes guarded previous and next bulk moves", () => {
		expect(source).toContain("function ColumnMoveControls");
		expect(source).toContain("trpc.tasks.moveMany.mutationOptions");
		expect(source).toContain("Move all shown tasks to");
		expect(source).toContain("bulkMoveTarget(column, next");
		expect(source).toContain('confirmLabel="Move all"');
	});

	test("desktop bulk moves are compact actions inside the column header", () => {
		const header = source.match(
			/<header className="flex items-center gap-2">([\s\S]*?)<\/header>/,
		)?.[1];

		expect(header).toContain("<ColumnMoveControls");
		expect(header).toContain("compact");
		expect(header).toContain('size="icon-xs"');
		expect(source).toContain('size={compact ? "icon-xs" : "xs"}');
		expect(source).toContain('cn("flex gap-1", !vertical && "ml-auto")');
	});

	test("human controls cannot manufacture an unclaimed In progress task", () => {
		// Every drop, bulk move and phone move goes through the one rule
		// (columns.ts, tested in columns.test.ts), which names its reason.
		expect(source).toContain("dropVerdict(column, task)");
		expect(source).toContain("bulkMoveTarget(column, previous");
		expect(source).toContain("dropVerdict(c, task).ok");
	});
});
