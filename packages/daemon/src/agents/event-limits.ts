/**
 * Bounds on what an agent's event may carry into the host's `events.jsonl`.
 * Text fields are capped by the bridges; identifiers come straight from the
 * provider's stream and nothing else limits them. Terminal control sequences
 * are removed from every string, so no later view of a log can replay an
 * agent's OSC 52 or cursor movement.
 *
 * Imported by the drivers: no dependencies.
 */

export const MAX_EVENT_ID_CHARS = 256;

const MAX_DEPTH = 32;

/** OSC, DCS, SOS, PM and APC strings; CSI; other escapes; remaining controls. */
const TERMINAL_CONTROLS =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
	/(?:\u001b\]|\u009d)[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?|(?:\u001b[PX^_]|[\u0090\u0098\u009e\u009f])[^\u001b\u009c]*(?:\u001b\\|\u009c)?|(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?|\u001b[ -/]*[0-~]?|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** The text with terminal control sequences removed. Tabs and newlines stay. */
export function stripTerminalControls(text: string): string {
	return text.replace(TERMINAL_CONTROLS, "");
}

function stripDeep(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return stripTerminalControls(value);
	if (value === null || typeof value !== "object") return value;
	if (depth >= MAX_DEPTH) return "[…truncated…]";
	if (Array.isArray(value)) return value.map((v) => stripDeep(v, depth + 1));
	return Object.fromEntries(
		Object.entries(value).map(([k, v]) => [
			stripTerminalControls(k),
			stripDeep(v, depth + 1),
		]),
	);
}

const cap = (value: unknown): unknown =>
	typeof value === "string" && value.length > MAX_EVENT_ID_CHARS
		? value.slice(0, MAX_EVENT_ID_CHARS)
		: value;

/** The event with its identifiers capped and its strings free of escapes. */
export function limitAgentEvent<T extends Record<string, unknown>>(
	event: T,
): T {
	const out = stripDeep(event) as Record<string, unknown>;
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
