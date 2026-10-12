/**
 * What a run is doing right now, separate from its lifecycle `state`.
 *
 * `state` says where the run is in its life (starting, running, finalizing,
 * merged...). `activity` says whether it needs anyone: a running run can be
 * working, waiting on an approval, waiting on an answer, stalled, or idle in
 * the short window after a turn ends. The daemon folds it from the run's
 * `events.jsonl` and persists it on `runs.activity`.
 */

export const RUN_ACTIVITIES = [
	"working",
	"awaiting_approval",
	"needs_answer",
	"stalled",
	"idle",
	"ended",
] as const;

export type RunActivity = (typeof RUN_ACTIVITIES)[number];

export function isRunActivity(v: unknown): v is RunActivity {
	return (
		typeof v === "string" && (RUN_ACTIVITIES as readonly string[]).includes(v)
	);
}

/** Activities where a human is the next move. */
export const ATTENTION_ACTIVITIES: ReadonlySet<RunActivity> = new Set([
	"needs_answer",
	"awaiting_approval",
	"stalled",
]);

/** Why the run is `stalled`. */
export type StallCause = "background" | "silent";

/** Where a question came from. Only `report` changes control flow. */
export type QuestionSource = "report" | "tool" | "user_input" | "heuristic";

/** A background job the agent started and never saw finish. */
export interface BackgroundJob {
	/** The tool call that started it. */
	callId: string;
	tool: string;
	/** Shell/agent id the provider assigned, when its result named one. */
	jobId?: string;
	summary: string;
}

/** `runs.activity_detail`: the facts behind the activity, small and bounded. */
export interface RunActivityDetail {
	/** Approvals still pending (request ids), newest last. */
	pendingApprovals: string[];
	approvalSummary?: string;
	question?: string;
	questionSource?: QuestionSource;
	options?: string[];
	/** Background jobs started and not seen to finish. */
	background: BackgroundJob[];
	stallCause?: StallCause;
	/** Assistant messages so far. */
	turns: number;
	/** ISO timestamp of the newest event folded. */
	lastEventAt: string | null;
}
