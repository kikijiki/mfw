import type { TriggerActionHandler } from "./actions.ts";
import {
	eventRefs,
	placeholderValues,
	renderPlaceholders,
} from "./placeholders.ts";

/**
 * `action: agent` (§8.2): a thin wrapper over `RunEngine.startAction(prompt)`
 * (fresh worktree, counted against `maxConcurrent` via `COUNTED_KINDS`).
 *
 * Fire-and-forget: the delivery is terminal once the run has started. The
 * supervisor pass that finalizes runs also awaits `TriggerService.dispatch()`
 * (`supervisor.ts`), so waiting here for the run to finish would deadlock on
 * a finalize that only happens in a later pass. The run's outcome lives on
 * the run itself.
 */

export interface AgentActionDeps {
	engine: {
		startAction(
			prompt: string,
			opts?: { model?: string },
		): Promise<{ runId: string }>;
	};
	tasks?: { get(id: string): Promise<{ title: string } | null> };
}

export function createAgentAction(deps: AgentActionDeps): TriggerActionHandler {
	return async (dispatch) => {
		const action = dispatch.def.action;
		if (action.kind !== "agent") {
			throw new Error("createAgentAction wired to a non-agent action");
		}
		const { taskId } = eventRefs(dispatch.event);
		const values = await placeholderValues(
			dispatch.event,
			dispatch.deliveryId,
			taskId,
			deps.tasks,
		);
		const prompt = renderPlaceholders(action.prompt, values);
		const { runId } = await deps.engine.startAction(prompt, {
			model: action.model,
		});
		return { ok: true, runId };
	};
}
