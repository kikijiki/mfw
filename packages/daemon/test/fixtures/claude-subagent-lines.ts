/**
 * The stream-json lines a real `claude` prints when the model calls its
 * `Agent` tool: the call itself, then the messages of the subagent it started,
 * each carrying `parent_tool_use_id` (the Agent call's id), then the call's
 * result with no parent. Shared by the fake agents so the driver and bridge
 * tests exercise the same traffic.
 */
export const SUBAGENT_CALL_ID = "ag1";

const line = (
	type: "assistant" | "user",
	content: unknown[],
	parent: string | null,
): string =>
	JSON.stringify({ type, message: { content }, parent_tool_use_id: parent });

export function subagentLines(): string[] {
	const p = SUBAGENT_CALL_ID;
	return [
		line(
			"assistant",
			[
				{
					type: "tool_use",
					id: p,
					name: "Agent",
					input: {
						description: "scan the repo",
						subagent_type: "Explore",
						prompt: "look around",
					},
				},
			],
			null,
		),
		line("user", [{ type: "text", text: "look around" }], p),
		line(
			"assistant",
			[{ type: "tool_use", id: "s1", name: "Read", input: { path: "a" } }],
			p,
		),
		line("user", [{ type: "tool_result", tool_use_id: "s1", content: "A" }], p),
		line("assistant", [{ type: "text", text: "found A" }], p),
		line(
			"user",
			[{ type: "tool_result", tool_use_id: p, content: "found A" }],
			null,
		),
	];
}
