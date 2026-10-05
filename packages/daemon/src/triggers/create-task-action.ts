import type { DefinitionOfDone } from "../tasks/types.ts";
import type { TriggerActionHandler } from "./actions.ts";

/**
 * `action: create_task` (MFW-33 item 2).
 *
 * The `lifetime.ts` shape, reached through the trigger pipeline: a `cron:`
 * trigger with this action IS a `.mfw/lifetime/` definition, minus the
 * separate loader/state table. Dedupe is the same rule
 * (`skip_if_active` skips while a task this definition created is still
 * open, checked by `lifetimeDefId`, exactly as `LifetimeManager.hasOpenTask`
 * does): a task created this way is stamped `source: "lifetime"` and
 * `lifetimeDefId: <trigger id>` for that reason, not because it came from
 * `.mfw/lifetime/`.
 */

export interface CreateTaskActionDeps {
	tasks: {
		list(): Promise<{ lifetimeDefId: string | null; status: string }[]>;
		create(input: {
			title: string;
			body: string;
			type: "implementation" | "spike" | "epic" | "maintenance";
			source: "lifetime";
			lifetimeDefId: string;
			dod?: DefinitionOfDone | null;
		}): Promise<{ id: string }>;
	};
}

export function createCreateTaskAction(
	deps: CreateTaskActionDeps,
): TriggerActionHandler {
	return async (dispatch) => {
		const action = dispatch.def.action;
		if (action.kind !== "create_task") {
			throw new Error(
				"createCreateTaskAction wired to a non-create_task action",
			);
		}
		if (action.dedupe === "skip_if_active") {
			const open = await deps.tasks.list();
			const active = open.some(
				(t) =>
					t.lifetimeDefId === dispatch.def.id &&
					!["done", "archived"].includes(t.status),
			);
			if (active) {
				return {
					ok: true,
					detail:
						"skipped: a task from this definition is still open (dedupe: skip_if_active)",
				};
			}
		}
		const task = await deps.tasks.create({
			title: dispatch.def.title,
			body: dispatch.def.body,
			type: action.type,
			source: "lifetime",
			lifetimeDefId: dispatch.def.id,
			// Frontmatter is untyped YAML by construction, `lifetime.ts` casts the
			// same way for the same reason.
			dod: action.dod as DefinitionOfDone | null,
		});
		return { ok: true, detail: `created task ${task.id}` };
	};
}
