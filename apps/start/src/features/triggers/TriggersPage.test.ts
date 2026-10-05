import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";

import { Button } from "~/components/ui/button";
import { QuickDraftCaptureDialog } from "../tasks/QuickDraftCaptureDialog";
import {
	TRIGGER_TASK_PROMPT_PREFIX,
	TriggerTaskCreateAction,
	triggerTaskCreatedToast,
} from "./TriggersPage";

type ElementWithProps = ReactElement<Record<string, unknown>>;

function creationEntry(overrides: Record<string, unknown> = {}) {
	const calls: boolean[] = [];
	const successes: unknown[] = [];
	const element = TriggerTaskCreateAction({
		project: "current-project",
		open: false,
		onOpenChange: (open) => calls.push(open),
		onSuccess: (task) => successes.push(task),
		...overrides,
	}) as ElementWithProps;
	const [button, dialog] = element.props.children as [
		ElementWithProps,
		ElementWithProps,
	];

	return { button, dialog, calls, successes };
}

describe("Triggers task-creation entry point", () => {
	const source = readFileSync(
		join(import.meta.dir, "TriggersPage.tsx"),
		"utf8",
	);

	test("renders the header action and opens it", () => {
		const { button, calls } = creationEntry();

		expect(button.type).toBe(Button);
		expect(button.props.children).toContain(" Create task");
		(button.props.onClick as () => void)();
		expect(calls).toEqual([true]);
	});

	test("uses the current project and trigger-oriented prompt prefix", () => {
		const { dialog } = creationEntry();

		expect(dialog.type).toBe(QuickDraftCaptureDialog);
		expect(dialog.props.project).toBe("current-project");
		expect(dialog.props.initialPromptPrefix).toBe(TRIGGER_TASK_PROMPT_PREFIX);
		expect(TRIGGER_TASK_PROMPT_PREFIX).toBe("Create a trigger: ");
	});

	test("cancel only closes the dialog and leaves trigger rows alone", () => {
		const triggerRows = [{ id: "deploy-on-merge" }];
		const { dialog, calls } = creationEntry({ open: true });

		(dialog.props.onOpenChange as (open: boolean) => void)(false);
		expect(calls).toEqual([false]);
		expect(triggerRows).toEqual([{ id: "deploy-on-merge" }]);
	});

	test("successful completion is handled in place and identifies the task", () => {
		const { dialog, successes, calls } = creationEntry({ open: true });
		const task = { id: "MFW-72", title: "Deploy after merge" };

		(dialog.props.onSuccess as (task: unknown) => void)(task);
		expect(successes).toEqual([task]);
		expect(calls).toEqual([]);
		expect(triggerTaskCreatedToast(task)).toEqual({
			tone: "success",
			title: "MFW-72 created",
			description: "Deploy after merge",
		});
		// The entry point has no navigation callback: quick capture closes its
		// controlled `open` state after success, leaving this page/tab mounted.
		expect(dialog.type).toBe(QuickDraftCaptureDialog);
	});

	test("arming requires reviewing the exact definition or its approved diff", () => {
		expect(source).toContain("Review changes");
		expect(source).toContain("First approval: review the complete definition.");
		expect(source).toContain("diffLines(approved, current)");
		expect(source).toContain("onClick={() => setArmReview(view)}");
		expect(source).toContain("expectedHash: armReview.hash");
		expect(source).toContain("Approve and arm");
		expect(source).not.toContain('meta: { label: "Arm trigger" }');
	});
});
