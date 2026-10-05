import { PLACEHOLDER_RE } from "./def.ts";
import type { TriggerEvent } from "./events.ts";

/**
 * Renders the fixed, escaped placeholder set into a prompt or notify message.
 *
 * `def.ts` quarantines names outside `PROMPT_PLACEHOLDERS` at load, so the
 * `default` branch is effectively unreachable; it leaves the literal in place
 * so a list mismatch is visible in output rather than throwing mid-action.
 */

export interface PlaceholderValues {
	eventType: string;
	eventSeq: number;
	deliveryId: string;
	taskId?: string;
	taskTitle?: string;
	mergeSha?: string;
	mergeTarget?: string;
}

/** `taskId` / `runId` exist on only some `MfwEvent` variants; reaching past the union is done once here. */
export function eventRefs(event: TriggerEvent): {
	taskId?: string;
	runId?: string;
} {
	const e = event as unknown as { taskId?: string; runId?: string };
	return { taskId: e.taskId, runId: e.runId };
}

export function renderPlaceholders(text: string, v: PlaceholderValues): string {
	return text.replace(PLACEHOLDER_RE, (match, name: string) => {
		switch (name) {
			case "event.type":
				return v.eventType;
			case "event.seq":
				return String(v.eventSeq);
			case "delivery.id":
				return v.deliveryId;
			case "task.id":
				return v.taskId ?? "";
			case "task.title":
				return v.taskTitle ?? "";
			case "merge.sha":
				return v.mergeSha ?? "";
			case "merge.target":
				return v.mergeTarget ?? "";
			default:
				return match;
		}
	});
}

/** `taskId` is passed separately (from `eventRefs`) since not every triggerable event carries it. */
export async function placeholderValues(
	event: Pick<TriggerEvent, "type" | "seq" | "payload">,
	deliveryId: string,
	taskId: string | undefined,
	tasks?: { get(id: string): Promise<{ title: string } | null> },
): Promise<PlaceholderValues> {
	const payload = (event.payload ?? {}) as Record<string, unknown>;
	const taskTitle = taskId
		? ((await tasks?.get(taskId))?.title ?? undefined)
		: undefined;
	return {
		eventType: event.type,
		eventSeq: event.seq,
		deliveryId,
		taskId,
		taskTitle,
		mergeSha: typeof payload.sha === "string" ? payload.sha : undefined,
		mergeTarget:
			typeof payload.target === "string" ? payload.target : undefined,
	};
}
