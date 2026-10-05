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

		expect(successFlow).toContain("setMobileStatus(task.status)");
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
		expect(source).toContain(
			'task.status === "draft" ? "expanding" : "working"',
		);
		expect(source).toContain("draftPhaseLabel(task.draftPhase");
		expect(source).toContain("task.afterExpansion");
		expect(source).toContain("draggable={draggable && !locked}");
		expect(source).toContain(
			'task.status !== "draft" || status === "archived"',
		);
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
		expect(source).toContain("Expansion moves Drafts");
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
		expect(source).toContain(
			'compact ? "ml-auto flex gap-1" : "grid grid-cols-2 gap-1"',
		);
	});

	test("human controls cannot manufacture an unclaimed In progress task", () => {
		expect(source).toContain('acceptsDrop={status !== "in_progress"}');
		expect(source).toContain('previous !== "in_progress"');
		expect(source).toContain('next !== "in_progress"');
		expect(source).toContain('status !== "in_progress" &&');
		expect(source).toContain("Tasks enter In progress when a run starts");
	});
});
