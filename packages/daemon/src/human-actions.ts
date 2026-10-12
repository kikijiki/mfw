import type { ProjectDbHandle } from "@mfw/db/client";
import { type DecisionKind, decisions } from "@mfw/db/schema";
import type { Logger } from "./log.ts";

/**
 * The human's half of the audit trail (U4-03). The brain writes one
 * `decisions` row per act call; a person who creates, edits, moves or deletes
 * a task, or starts, stops, steers or answers a run, leaves the same kind of
 * row (`role: "human"`), so "who changed this and why" has one answer whoever
 * did it, and the brain's next digest can see what the owner did.
 *
 * Best-effort by design: the mutation already happened, and an audit write
 * failing must not turn a successful action into an error for the person.
 * The failure is logged.
 */

export type HumanAction =
	| "tasks.create"
	| "tasks.capture"
	| "tasks.update"
	| "tasks.move"
	| "tasks.remove"
	| "runs.start"
	| "runs.stop"
	| "runs.steer"
	| "runs.answer"
	// Overrides of the brain (human-override.ts): written before the effect.
	| "select_winner"
	| "add_attempt"
	| "reroute"
	| "resume"
	| "pause"
	// Levers on the brain (human-override.ts).
	| "override"
	| "brain.message";

export interface HumanActionInput {
	action: HumanAction;
	taskId?: string | null;
	runId?: string | null;
	/** Why, when the person said (a move's reason, a steer message). */
	reason?: string | null;
	/** What was asked for: small, structured, never a whole document. */
	input?: Record<string, unknown>;
	/** `override` for a person doing what the brain would have; default `action`. */
	kind?: DecisionKind;
	/** The row's output; default `{ status: "applied" }`. */
	output?: Record<string, unknown>;
}

const MAX_REASON = 2000;

/** Record one human mutation. Never throws. */
export async function recordHumanAction(
	svc: { handle?: ProjectDbHandle; log?: Logger },
	a: HumanActionInput,
	now: () => number = Date.now,
): Promise<number | null> {
	if (!svc.handle) return null;
	const ts = new Date(now());
	try {
		const [row] = await svc.handle.db
			.insert(decisions)
			.values({
				ts,
				role: "human",
				taskId: a.taskId ?? null,
				subjectRunId: a.runId ?? null,
				model: "human",
				status: "ok",
				action: a.action,
				reason: a.reason ? a.reason.slice(0, MAX_REASON) : null,
				input: a.input ?? {},
				output: a.output ?? { status: "applied" },
				durationMs: 0,
				finishedAt: ts,
				kind: a.kind ?? "action",
			})
			.returning({ id: decisions.id });
		return row?.id ?? null;
	} catch (err) {
		svc.log?.warn({ err, action: a.action }, "human action audit write failed");
		return null;
	}
}

/** The task a run belongs to, for the audit row; null when it cannot be told. */
export async function taskOfRun(
	svc: {
		registry?: { get(id: string): Promise<{ taskId: string | null } | null> };
	},
	runId: string,
): Promise<string | null> {
	try {
		return (await svc.registry?.get(runId))?.taskId ?? null;
	} catch {
		return null;
	}
}
