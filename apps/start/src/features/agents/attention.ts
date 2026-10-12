/**
 * "What needs me first": an open question a run asked (`clarify.open`), a
 * live run's activity (`runs.activity`: waiting on an answer or an approval,
 * or stalled), an open escalation brief naming the run (`sessions.open`), an
 * inbox item pointing at the run (`inbox.list`, e.g. a failed run or an
 * import awaiting approval), and whether the run is live.
 *
 * Activity counts only while the run is live: a finished run's label is
 * history, and a question it left behind is already an open clarification.
 * A question guessed from a final message ending in "?" (`heuristic`) is a
 * label, never a reason to page anyone.
 */

export type AttentionReason =
	| "question"
	| "approval"
	| "stalled"
	| "escalated"
	| "inbox";

/** Most urgent first; the dock and the Agents page sort by this, then by age. */
export const ATTENTION_ORDER: readonly AttentionReason[] = [
	"question",
	"approval",
	"stalled",
	"escalated",
	"inbox",
];

/** The run fields attention reads; activity is optional (older rows have none). */
export interface AttentionRun {
	project: string;
	runId: string;
	state?: string;
	activity?: string | null;
	/** Stored JSON; only `questionSource` is read. */
	activityDetail?: unknown;
}

/** Which signal a run carries, keyed `project\u0000runId`. */
export interface AttentionSignals {
	questions: ReadonlySet<string>;
	escalations: ReadonlySet<string>;
	inbox: ReadonlySet<string>;
}

export const runKey = (project: string, runId: string) =>
	`${project}\u0000${runId}`;

export function attentionSignals(sources: {
	questions?: readonly { project: string; runId: string }[];
	sessions?: readonly { project: string; runId: string | null }[];
	inbox?: readonly { project: string; runId?: string }[];
}): AttentionSignals {
	const keys = (
		rows: readonly { project: string; runId?: string | null }[] | undefined,
	) =>
		new Set(
			(rows ?? []).flatMap((r) =>
				r.runId ? [runKey(r.project, r.runId)] : [],
			),
		);
	return {
		questions: keys(sources.questions),
		escalations: keys(sources.sessions),
		inbox: keys(sources.inbox),
	};
}

/** What a live run's activity asks of a human, if anything. */
export function activityAttention(run: AttentionRun): AttentionReason | null {
	if (!run.state || !isActiveRunState(run.state)) return null;
	switch (run.activity) {
		case "needs_answer":
			return (run.activityDetail as { questionSource?: unknown } | null)
				?.questionSource === "heuristic"
				? null
				: "question";
		case "awaiting_approval":
			return "approval";
		case "stalled":
			return "stalled";
		default:
			return null;
	}
}

export function attentionOf(
	run: AttentionRun,
	signals: AttentionSignals,
): AttentionReason | null {
	const key = runKey(run.project, run.runId);
	if (signals.questions.has(key)) return "question";
	const live = activityAttention(run);
	if (live) return live;
	if (signals.escalations.has(key)) return "escalated";
	if (signals.inbox.has(key)) return "inbox";
	return null;
}

export const ATTENTION_LABEL: Record<AttentionReason, string> = {
	question: "question",
	approval: "approval",
	stalled: "stalled",
	escalated: "escalated",
	inbox: "needs you",
};

const ACTIVE = new Set([
	"starting",
	"running",
	"ended",
	"finalizing",
	"merging",
]);
export const isActiveRunState = (state: string) => ACTIVE.has(state);

/**
 * Rank: needs a human (most urgent reason first, see `ATTENTION_ORDER`), then
 * live, then the rest; newest first within a rank.
 */
export function sortByAttention<
	T extends AttentionRun & {
		state: string;
		startedAt: number;
	},
>(
	runs: readonly T[],
	signals: AttentionSignals,
): Array<T & { attention: AttentionReason | null }> {
	const live = ATTENTION_ORDER.length;
	const rank = (r: T & { attention: AttentionReason | null }) =>
		r.attention
			? ATTENTION_ORDER.indexOf(r.attention)
			: isActiveRunState(r.state)
				? live
				: live + 1;
	return runs
		.map((r) => ({ ...r, attention: attentionOf(r, signals) }))
		.sort((a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt);
}
