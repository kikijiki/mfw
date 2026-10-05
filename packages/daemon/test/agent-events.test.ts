import { describe, expect, test } from "bun:test";

import { parseAgentEventLine } from "../src/agents/events";

const line = (event: Record<string, unknown>) =>
	JSON.stringify({ ts: "2026-08-19T00:00:00.000Z", seq: 1, ...event });

describe("AgentEvent rich extensions", () => {
	test("keeps old hello and usage logs valid", () => {
		expect(
			parseAgentEventLine(
				line({
					type: "hello",
					provider: "claude-cli",
					capabilities: { steer: true },
				}),
			),
		).not.toBeNull();
		expect(
			parseAgentEventLine(line({ type: "usage", inputTokens: 10 })),
		).not.toBeNull();
	});

	test("accepts optional capabilities and token detail", () => {
		expect(
			parseAgentEventLine(
				line({
					type: "hello",
					provider: "codex-cli",
					capabilities: {
						steer: true,
						interrupt: true,
						approvals: true,
						plan: true,
						fileChanges: true,
						commandProgress: true,
						mcp: true,
					},
				}),
			),
		).not.toBeNull();
		expect(
			parseAgentEventLine(
				line({ type: "usage", cachedInputTokens: 4, reasoningOutputTokens: 8 }),
			),
		).not.toBeNull();
	});

	test("accepts every rich event variant", () => {
		const events = [
			{
				type: "session",
				provider: "codex-cli",
				sessionId: "thread",
				turnId: "turn",
				status: "active",
				ordinal: 1,
			},
			{ type: "plan", steps: [{ step: "test", status: "in_progress" }] },
			{ type: "diff", turnId: "turn", diff: "+line" },
			{
				type: "file_change",
				id: "file",
				phase: "completed",
				changes: [{ path: "a.ts", kind: "update" }],
			},
			{ type: "tool_progress", id: "command", output: "running" },
			{
				type: "mcp_activity",
				id: "mcp",
				server: "git",
				tool: "status",
				phase: "started",
				input: {},
			},
			{
				type: "approval",
				requestId: "request",
				kind: "command",
				status: "pending",
				summary: "run command",
			},
			{
				type: "notice",
				category: "warning",
				message: "heads up",
				metadata: {},
			},
		];
		expect(
			events.map((event) => parseAgentEventLine(line(event))).every(Boolean),
		).toBe(true);
	});
});
