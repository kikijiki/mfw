import { expect, test } from "bun:test";
import type { AgentEvent } from "@mfw/daemon/agents/events";
import { appendUniqueAgentEvents, foldUsage } from "./useRunStream";

const event = (seq: number): AgentEvent => ({
	type: "message",
	ts: "2026-08-19T00:00:00.000Z",
	seq,
	role: "assistant",
	text: String(seq),
});

test("replayed transcript deltas append each sequence only once", () => {
	const current = [event(1), event(2)];
	expect(appendUniqueAgentEvents(current, [event(2), event(3)])).toEqual([
		event(1),
		event(2),
		event(3),
	]);
	expect(appendUniqueAgentEvents(current, [event(1), event(2)])).toBe(current);
});

test("cumulative App Server usage takes the latest total instead of double counting", () => {
	const usage = (seq: number, inputTokens: number): AgentEvent => ({
		type: "usage",
		ts: "2026-08-19T00:00:00.000Z",
		seq,
		inputTokens,
		cachedInputTokens: inputTokens / 2,
		cumulative: true,
	});
	expect(foldUsage([usage(1, 100), usage(2, 150)])).toMatchObject({
		inputTokens: 150,
		cachedInputTokens: 75,
	});
});
