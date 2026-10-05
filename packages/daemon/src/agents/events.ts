import { z } from "zod";

/**
 * AgentEvent: the one transcript schema. Each driver translates its provider's
 * output into these lines in `events.jsonl` (single writer: the driver process);
 * everything downstream consumes only validated AgentEvents.
 */

const base = {
	ts: z.string(), // ISO timestamp, driver-stamped
	seq: z.number().int(), // monotonic within the run
};

export const AgentEventSchema = z.discriminatedUnion("type", [
	z.object({
		...base,
		type: z.literal("hello"),
		provider: z.string(), // "claude-cli" | "acp:<agent>" | "pty"
		capabilities: z.object({
			steer: z.boolean(),
			interrupt: z.boolean().optional(),
			approvals: z.boolean().optional(),
			plan: z.boolean().optional(),
			fileChanges: z.boolean().optional(),
			commandProgress: z.boolean().optional(),
			mcp: z.boolean().optional(),
		}),
	}),
	z.object({
		...base,
		type: z.literal("message"),
		role: z.enum(["assistant", "user"]),
		text: z.string(),
	}),
	z.object({ ...base, type: z.literal("thinking"), text: z.string() }),
	z.object({
		...base,
		type: z.literal("tool_call"),
		id: z.string(),
		name: z.string(),
		input: z.unknown(),
	}),
	z.object({
		...base,
		type: z.literal("tool_result"),
		id: z.string(),
		ok: z.boolean(),
		output: z.string(), // capped at 16 KiB by the driver
	}),
	z.object({
		...base,
		type: z.literal("usage"),
		inputTokens: z.number().optional(),
		outputTokens: z.number().optional(),
		cachedInputTokens: z.number().optional(),
		reasoningOutputTokens: z.number().optional(),
		/** True when this sample is the provider's running session total. */
		cumulative: z.boolean().optional(),
		costUsd: z.number().optional(),
		turns: z.number().optional(),
	}),
	z.object({
		...base,
		type: z.literal("session"),
		provider: z.string(),
		sessionId: z.string(),
		turnId: z.string().optional(),
		status: z.enum(["started", "active", "completed", "failed", "interrupted"]),
		ordinal: z.number().int().nonnegative(),
	}),
	z.object({
		...base,
		type: z.literal("plan"),
		explanation: z.string().optional(),
		steps: z.array(
			z.object({
				step: z.string(),
				status: z.enum(["pending", "in_progress", "completed"]),
			}),
		),
	}),
	z.object({
		...base,
		type: z.literal("diff"),
		turnId: z.string(),
		diff: z.string(),
	}),
	z.object({
		...base,
		type: z.literal("file_change"),
		id: z.string(),
		phase: z.enum(["started", "completed"]),
		status: z.string().optional(),
		changes: z.array(
			z.object({
				path: z.string(),
				kind: z.enum(["add", "update", "delete", "unknown"]),
				diff: z.string().optional(),
			}),
		),
	}),
	z.object({
		...base,
		type: z.literal("tool_progress"),
		id: z.string(),
		output: z.string(),
	}),
	z.object({
		...base,
		type: z.literal("mcp_activity"),
		id: z.string(),
		server: z.string().optional(),
		tool: z.string(),
		phase: z.enum(["started", "completed"]),
		input: z.unknown().optional(),
		output: z.unknown().optional(),
		ok: z.boolean().optional(),
	}),
	z.object({
		...base,
		type: z.literal("approval"),
		requestId: z.string(),
		itemId: z.string().optional(),
		kind: z.enum([
			"command",
			"file_change",
			"permissions",
			"user_input",
			"other",
		]),
		status: z.enum(["pending", "accepted", "declined", "cancelled"]),
		summary: z.string(),
		details: z.unknown().optional(),
	}),
	z.object({
		...base,
		type: z.literal("notice"),
		category: z.enum(["warning", "model_reroute", "safety", "provider"]),
		message: z.string(),
		metadata: z.unknown().optional(),
	}),
	z.object({
		...base,
		type: z.literal("rate_limit"),
		/** Provider's wire-format status, display/debug only. Decide from `limited`, not this. */
		status: z.string(),
		limited: z.boolean(),
		resetsAt: z.number().nullable(),
		/** Fraction of quota used (0-1), when reported on an allowed event. */
		utilization: z.number().nullable().optional(),
	}),
	z.object({
		...base,
		type: z.literal("error"),
		message: z.string(),
		fatal: z.boolean(),
	}),
	z.object({
		...base,
		type: z.literal("done"),
		reason: z.enum(["complete", "error", "killed"]),
		resultText: z.string().optional(), // the "result" payload plan-parse reads
	}),
]);

export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type AgentEventType = AgentEvent["type"];

/** Parse one events.jsonl line; null for blank/corrupt lines (a torn tail line is expected after a crash). */
export function parseAgentEventLine(line: string): AgentEvent | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		return AgentEventSchema.parse(JSON.parse(trimmed));
	} catch {
		return null;
	}
}

/** Parse an events.jsonl chunk into events (newest last). Used by classify, which needs only the stream tail. */
export function parseAgentEvents(chunk: string): AgentEvent[] {
	const out: AgentEvent[] = [];
	for (const line of chunk.split("\n")) {
		const e = parseAgentEventLine(line);
		if (e) out.push(e);
	}
	return out;
}
