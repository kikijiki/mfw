/**
 * Bounds on what an agent's event may carry into the host's `events.jsonl`.
 * Text fields are capped by the bridges; identifiers come straight from the
 * provider's stream and nothing else limits them.
 *
 * Imported by the drivers: no dependencies.
 */

export const MAX_EVENT_ID_CHARS = 256;

const cap = (value: unknown): unknown =>
	typeof value === "string" && value.length > MAX_EVENT_ID_CHARS
		? value.slice(0, MAX_EVENT_ID_CHARS)
		: value;

/** The event with its identifiers capped. */
export function limitAgentEvent<T extends Record<string, unknown>>(
	event: T,
): T {
	const out: Record<string, unknown> = { ...event };
	for (const key of ["id", "name", "sessionId", "provider"]) {
		if (key in out) out[key] = cap(out[key]);
	}
	const parent = out.parent;
	if (parent && typeof parent === "object") {
		const p = parent as Record<string, unknown>;
		out.parent = {
			...p,
			...("toolUseId" in p ? { toolUseId: cap(p.toolUseId) } : {}),
			...("threadId" in p ? { threadId: cap(p.threadId) } : {}),
		};
	}
	return out as T;
}
