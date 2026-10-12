import {
	HierarchyError,
	InvalidFieldsError,
	RuleViolationError,
} from "@mfw/board-core";
import { z } from "zod";
import { StatusMapError } from "../board-status-map.ts";
import { TaskUnmergedError } from "../lifecycle.ts";
import {
	BatchRefusedError,
	ConflictError,
	type CreateTaskInput,
	type EditTaskPatch,
	OwnsOverlapError,
	TaskClaimedError,
} from "../task-service.ts";
import { REF_PATTERN } from "../tasks/batch.ts";

/**
 * The board tools' vocabulary and translations (design §2.3): the argument
 * shape of a new task, how a brain's spec and patch become the daemon's
 * `CreateTaskInput` / `EditTaskPatch`, and how a refusal from the board turns
 * into the `{code, message, fix}` the model reads.
 */

export const TaskType = z.enum([
	"implementation",
	"spike",
	"epic",
	"maintenance",
]);
export const Size = z.enum(["xs", "s", "m", "l", "xl"]);
export const Priority = z.enum(["critical", "high", "medium", "low"]);
export const OwnsList = z.array(z.string().min(1)).max(50);

/** One new task. `ref` names it inside the batch so tasks can point at each other. */
export const NewTask = z
	.object({
		ref: z.string().regex(REF_PATTERN).optional(),
		title: z.string().min(1).max(200),
		body: z.string().max(20_000).optional(),
		spec: z.string().max(40_000).optional(),
		type: TaskType,
		size: Size,
		priority: Priority.optional(),
		/** An id on the board, or the `ref` of another task in this call. */
		parent: z.string().optional(),
		/** Ids on the board, or `ref`s of other tasks in this call. */
		depends_on: z.array(z.string()).max(50).optional(),
		owns: OwnsList.optional(),
		verification: z.record(z.string(), z.unknown()).optional(),
		acceptance: z.array(z.record(z.string(), z.unknown())).max(50).optional(),
		requires_resources: z.array(z.unknown()).max(20).optional(),
		execution_target: z.string().optional(),
		status: z.enum(["backlog", "ready", "draft"]).optional(),
	})
	.strict();
export type NewTaskSpec = z.infer<typeof NewTask>;

export interface BoardRefusal {
	code: string;
	message: string;
	fix?: { kind: "setting" | "command" | "ui"; text: string };
}

/** Acceptance items arrive as `{text, done?|checked?}` records. */
export function criteriaOf(
	items: readonly Record<string, unknown>[] | undefined,
): { text: string; checked: boolean }[] | undefined {
	if (!items) return undefined;
	return items.map((i) => ({
		text: String(i.text ?? "").trim(),
		checked: i.done === true || i.checked === true,
	}));
}

/** A brain task spec as the daemon's create input (ids and refs resolved by `createBatch`). */
export function specToCreateInput(
	t: NewTaskSpec,
): CreateTaskInput & { ref?: string } {
	return {
		...(t.ref ? { ref: t.ref } : {}),
		title: t.title,
		body: t.body ?? "",
		type: t.type,
		size: t.size,
		priority: t.priority ?? "medium",
		parentId: t.parent ?? null,
		dependsOn: t.depends_on ?? [],
		owns: t.owns ?? [],
		...(t.verification
			? {
					verification:
						t.verification as unknown as CreateTaskInput["verification"],
				}
			: {}),
		...(t.acceptance ? { criteria: criteriaOf(t.acceptance) ?? [] } : {}),
		...(t.requires_resources
			? {
					requiresResources:
						t.requires_resources as CreateTaskInput["requiresResources"],
				}
			: {}),
		...(t.execution_target ? { executionTarget: t.execution_target } : {}),
		...(t.status ? { status: t.status } : {}),
		// A person filing straight into backlog means "parked", as in the UI.
		readyMode: t.status === "backlog" ? "manual" : "automatic",
		source: "planner",
	};
}

/** An `update_task` patch as the daemon's edit patch. */
export function patchToEdit(p: Record<string, unknown>): EditTaskPatch {
	const out: EditTaskPatch = {};
	if (p.title !== undefined) out.title = p.title as string;
	if (p.body !== undefined) out.body = p.body as string;
	if (p.depends_on !== undefined) out.dependsOn = p.depends_on as string[];
	if (p.owns !== undefined) out.owns = p.owns as string[];
	if (p.verification !== undefined) {
		out.verification =
			p.verification as unknown as EditTaskPatch["verification"];
	}
	if (p.acceptance !== undefined) {
		out.criteria = criteriaOf(p.acceptance as Record<string, unknown>[]) ?? [];
	}
	if (p.priority !== undefined) {
		out.priority = p.priority as EditTaskPatch["priority"];
	}
	if (p.size !== undefined) out.size = p.size as EditTaskPatch["size"];
	if (p.labels !== undefined) out.labels = p.labels as string[];
	if (p.provider !== undefined) out.provider = p.provider as string | null;
	if (p.model !== undefined) out.model = p.model as string | null;
	return out;
}

const HIERARCHY_CODES: Record<string, string> = {
	"parent-not-found": "parent_not_found",
	"parent-type-not-allowed": "parent_type_not_allowed",
	cycle: "hierarchy_cycle",
	"max-depth": "max_depth",
};

/**
 * What the board refused, as the rejection the model reads. Null when the
 * error is not one the board's rules raise (an infrastructure failure stays a
 * plain `effect_failed`).
 */
export function boardRefusal(e: unknown): BoardRefusal | null {
	if (e instanceof ConflictError) {
		return {
			code: "stale_rev",
			message: `${e.current.id} moved on to rev ${e.current.contentRev} while your edit was being applied`,
			fix: {
				kind: "ui",
				text: "Re-read the task (task tool), then apply your change to the current rev.",
			},
		};
	}
	if (e instanceof OwnsOverlapError) {
		return {
			code: "owns_overlap",
			message: e.message,
			fix: {
				kind: "ui",
				text: `Depend on ${e.overlaps.map((o) => o.id).join(", ")} or narrow owns.`,
			},
		};
	}
	if (e instanceof TaskClaimedError) {
		return {
			code: "task_claimed",
			message: e.message,
			fix: {
				kind: "ui",
				text: "Stop the run first (stop), then change the task.",
			},
		};
	}
	if (e instanceof TaskUnmergedError) {
		return {
			code: "unmerged_work",
			message: e.message,
			fix: {
				kind: "ui",
				text: "Merge or discard the run's branch before archiving, or leave the task as it is.",
			},
		};
	}
	if (e instanceof HierarchyError) {
		return {
			code: HIERARCHY_CODES[e.code] ?? "hierarchy",
			message: e.message,
			fix: {
				kind: "ui",
				text: "Pick a parent the board's hierarchy rules allow (see the board's config), or none.",
			},
		};
	}
	if (e instanceof BatchRefusedError) {
		return {
			code: e.code,
			message: e.message,
			fix: { kind: "ui", text: "Remove the cycle from the batch." },
		};
	}
	if (e instanceof RuleViolationError) {
		return {
			code: "rule_violation",
			message: e.message,
			fix: {
				kind: "ui",
				text: "Change the task so the board's rule holds; the message names the rule.",
			},
		};
	}
	if (e instanceof InvalidFieldsError) {
		return { code: "invalid_fields", message: e.message };
	}
	if (e instanceof StatusMapError) {
		return {
			code: "status_unavailable",
			message: e.message,
			fix: {
				kind: "setting",
				text: "This board has no column for that status; use one it declares.",
			},
		};
	}
	return null;
}
