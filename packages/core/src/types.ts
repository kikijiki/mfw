/**
 * Shared domain primitives.
 *
 * Task and spec SHAPES are not here: parsing owns them (`taskfile.ts`) and the
 * board on disk owns their state (`board.ts` + `.mfw/tasks/`). This
 * file holds only the small vocabulary every side agrees on, so the enums
 * cannot drift apart.
 */

export type TaskStatus =
	| "draft"
	| "backlog"
	| "ready"
	| "in_progress"
	| "blocked"
	| "review"
	| "done"
	| "archived";

export const TASK_STATUSES: readonly TaskStatus[] = [
	"draft",
	"backlog",
	"ready",
	"in_progress",
	"blocked",
	"review",
	"done",
	"archived",
];

export type TaskType = "implementation" | "spike" | "epic" | "maintenance";

export type Priority = "critical" | "high" | "medium" | "low";

export type TaskSize = "xs" | "s" | "m" | "l" | "xl";
export const TASK_SIZES: readonly TaskSize[] = ["xs", "s", "m", "l", "xl"];

export type VerifierKind = "deterministic" | "llm-judge";

/** Who put this task on the board. */
export type TaskSource =
	| "human"
	| "planner"
	| "importer"
	| "lifetime"
	| "split"
	| "followup";

export const TASK_SOURCES: readonly TaskSource[] = [
	"human",
	"planner",
	"importer",
	"lifetime",
	"split",
	"followup",
];
