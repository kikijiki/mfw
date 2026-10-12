import { describe, expect, test } from "bun:test";
import { EventSchema, SETTLE_CLASSES, WAKE_CLASSES } from "../src/events.ts";

describe("brain-led event types", () => {
	const valid: unknown[] = [
		{
			type: "run.settled",
			runId: "r1",
			taskId: "T-1",
			payload: { groupId: null, class: "verify_failed", facts: { failing: 2 } },
		},
		{
			type: "brain.turn_started",
			runId: "r2",
			payload: {
				sessionId: "s",
				seq: 3,
				generation: 1,
				wakeClass: "settled",
				eventsFrom: 10,
				eventsTo: 14,
				resumed: true,
			},
		},
		{
			type: "brain.turn_ended",
			runId: "r2",
			payload: { sessionId: "s", status: "ok", actionsCount: 2 },
		},
		{
			type: "brain.action",
			payload: { actionId: "a1", tool: "spawn", status: "accepted" },
		},
		{
			type: "brain.rollover",
			payload: {
				sessionId: "s",
				reason: "resume_failed",
				fromGeneration: 1,
				toGeneration: 2,
			},
		},
		{
			type: "budget.threshold",
			payload: {
				key: "claude-cli",
				kind: "agent",
				unit: "tokens",
				used: 8,
				limit: 10,
				fraction: 0.8,
			},
		},
		{
			type: "budget.exhausted",
			payload: {
				key: "runpod:main",
				kind: "resource",
				unit: "usd",
				used: 200,
				limit: 200,
			},
		},
		{
			type: "budget.restored",
			payload: { key: "runpod:main", kind: "resource", reason: "window_reset" },
		},
		{
			type: "human.override",
			taskId: "T-1",
			payload: { decisionId: 9, overriddenDecisionId: 4, reason: "wrong" },
		},
		{ type: "human.brain_message", payload: { text: "hold off on T-4" } },
	];

	test("each new type parses", () => {
		for (const event of valid) {
			expect(EventSchema.safeParse(event).success, JSON.stringify(event)).toBe(
				true,
			);
		}
	});

	test("the enums are closed", () => {
		expect(
			EventSchema.safeParse({
				type: "run.settled",
				runId: "r",
				payload: { class: "made_up", facts: {} },
			}).success,
		).toBe(false);
		expect(SETTLE_CLASSES).toHaveLength(18);
		expect(WAKE_CLASSES).toHaveLength(7);
	});
});
