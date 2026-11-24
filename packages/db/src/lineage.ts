import type { RunKind, RunRelation } from "./schema.ts";

/**
 * Typed run lineage (data-and-api §2.1). `parent_run_id` alone is overloaded:
 * workspace continuation for task children, source plan for re-plans, subject
 * run for brain runs. These rules read the signals the engine writes (kind +
 * label suffix).
 */

/** Relations whose run reuses its parent's workspace: they extend a chain. */
export const CHAIN_RELATIONS: ReadonlySet<RunRelation> = new Set([
	"continue",
	"repair",
	"resume",
	"answer",
	"unblock",
]);

export interface RelationInput {
	kind: RunKind;
	label: string;
	parentRunId: string | null | undefined;
}

/** The relation a run has to its parent, from its kind, label and parent link. */
export function relationOf(run: RelationInput): RunRelation {
	switch (run.kind) {
		case "brain":
			return "judge";
		case "repair":
			return run.label.startsWith("recovery:") ? "recovery" : "repair";
		case "task": {
			if (run.label.endsWith("#repair")) return "repair";
			if (run.label.endsWith("#resume")) return "resume";
			if (run.label.endsWith("#answer")) return "answer";
			if (run.label.endsWith("#unblock")) return "unblock";
			return run.parentRunId ? "continue" : "fresh";
		}
		case "plan":
			return run.parentRunId || run.label.endsWith("#replan")
				? "replan"
				: "fresh";
		case "action":
			return run.label === "session" ? "session" : "fresh";
		default:
			return "fresh";
	}
}
