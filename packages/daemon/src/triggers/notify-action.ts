import type { Notifier } from "../notify.ts";
import type { TriggerActionHandler } from "./actions.ts";
import {
	eventRefs,
	placeholderValues,
	renderPlaceholders,
} from "./placeholders.ts";

/**
 * `action: notify` (MFW-117 §8.3, §13.1).
 *
 * Reuses the project's `Notifier` exactly as it is, same sinks, same
 * delivery confirmation, same failure counters, same Health surface. Zero new
 * delivery code: the only thing this file adds is turning a trigger dispatch
 * into the `Notification` shape the notifier already understands.
 */

export interface NotifyActionDeps {
	notifier: Notifier;
	tasks?: { get(id: string): Promise<{ title: string } | null> };
}

export function createNotifyAction(
	deps: NotifyActionDeps,
): TriggerActionHandler {
	return async (dispatch) => {
		const action = dispatch.def.action;
		if (action.kind !== "notify") {
			throw new Error("createNotifyAction wired to a non-notify action");
		}
		// `configured: false` means this project has no webhook/command sink at
		// all: the trigger can never deliver, and looking the other way would
		// be exactly the silent "why didn't it fire" failure M4 exists to
		// prevent, not a quiet no-op.
		if (!deps.notifier.stats().configured) {
			return {
				ok: false,
				detail:
					"action: notify has no sink configured for this project (notify.webhook / notify.command)",
			};
		}

		const { taskId, runId } = eventRefs(dispatch.event);
		const values = await placeholderValues(
			dispatch.event,
			dispatch.deliveryId,
			taskId,
			deps.tasks,
		);
		const message = renderPlaceholders(action.message, values);

		const results = await deps.notifier.notify("trigger", {
			project: dispatch.projectName,
			taskId,
			runId,
			message,
		});
		const failed = results.filter((r) => !r.ok);
		if (failed.length > 0) {
			return {
				ok: false,
				detail: failed
					.map((f) => `${f.sink}: ${f.detail ?? "failed"}`)
					.join("; "),
			};
		}
		return { ok: true, detail: message };
	};
}
