import { isRunActivity, type RunActivity } from "@mfw/core/activity";

import { isActiveRunState } from "./attention";

/**
 * How a run's activity (`runs.activity`, see `@mfw/core/activity`) reads in
 * the UI: a short chip label, a tone, and a one-line explanation from the
 * detail. Pure, so the dock, the board, the run page and the Agents list
 * agree.
 */

export type ChipTone =
	| "neutral"
	| "accent"
	| "ok"
	| "warn"
	| "critical"
	| "info";

export const ACTIVITY_LABEL: Record<RunActivity, string> = {
	working: "working",
	awaiting_approval: "approval",
	needs_answer: "question",
	stalled: "stalled",
	idle: "idle",
	ended: "ended",
};

export const ACTIVITY_TONE: Record<RunActivity, ChipTone> = {
	working: "accent",
	awaiting_approval: "warn",
	needs_answer: "warn",
	stalled: "critical",
	idle: "neutral",
	ended: "neutral",
};

/** The subset of `RunActivityDetail` the UI reads; every field optional (it is stored JSON). */
export interface ActivityDetailView {
	question?: string;
	questionSource?: string;
	options?: string[];
	approvalSummary?: string;
	pendingApprovals?: string[];
	stallCause?: string;
	background?: { tool?: string; summary?: string }[];
}

export function asActivity(v: unknown): RunActivity | null {
	return isRunActivity(v) ? v : null;
}

export function asActivityDetail(v: unknown): ActivityDetailView | null {
	return typeof v === "object" && v !== null ? (v as ActivityDetailView) : null;
}

/**
 * The activity worth showing for a run: only while it is live (a finished
 * run's state already says enough), and never a label for a question that
 * was merely guessed from a final "?" while the run is still working.
 */
export function shownActivity(run: {
	state: string;
	activity?: unknown;
}): RunActivity | null {
	if (!isActiveRunState(run.state)) return null;
	return asActivity(run.activity);
}

/** One line for the chip's tooltip and the run header. */
export function activityExplanation(
	activity: RunActivity,
	detail: ActivityDetailView | null,
): string {
	switch (activity) {
		case "working":
			return "The agent is working.";
		case "idle":
			return "The turn ended; the run closes in a moment unless steered.";
		case "ended":
			return "The session has ended.";
		case "awaiting_approval": {
			const n = detail?.pendingApprovals?.length ?? 0;
			const what = detail?.approvalSummary ? `: ${detail.approvalSummary}` : "";
			return `Waiting for ${n > 1 ? `${n} approvals` : "an approval"}${what}`;
		}
		case "needs_answer":
			return detail?.question
				? `${detail.questionSource === "heuristic" ? "Its last message asks" : "It asked"}: ${detail.question}`
				: "The agent asked a question.";
		case "stalled": {
			if (detail?.stallCause === "background") {
				const jobs = (detail.background ?? [])
					.map((j) => j.summary)
					.filter(Boolean);
				return `Its turn ended with background work still running${jobs.length ? ` (${jobs.join(", ")})` : ""}; it is resumed to re-run it in the foreground.`;
			}
			return "No output for a while; the idle watchdog stops it if this goes on.";
		}
	}
}

/**
 * The diff-scope sample once the scope watchdog writes one. Read defensively:
 * the shape is the watchdog's to define, so counts or path lists are both
 * accepted and anything else reads as "no sample".
 */
export function scopeCounts(sample: unknown): {
	files: number;
	outside: number;
	foreign: number;
	/** The file limit in force when sampled; null if the sample has none. */
	maxFiles: number | null;
	/** First paths another claimed task owns, with that task. */
	foreignFiles: { path: string; taskId: string }[];
} | null {
	if (typeof sample !== "object" || sample === null) return null;
	const o = sample as Record<string, unknown>;
	const count = (v: unknown): number | null =>
		typeof v === "number" && Number.isFinite(v) && v >= 0
			? v
			: Array.isArray(v)
				? v.length
				: null;
	const files = count(o.files);
	if (files === null) return null;
	const maxFiles =
		typeof o.maxFiles === "number" && o.maxFiles > 0 ? o.maxFiles : null;
	const foreignFiles = Array.isArray(o.foreignFiles)
		? o.foreignFiles.filter(
				(f): f is { path: string; taskId: string } =>
					typeof f?.path === "string" && typeof f?.taskId === "string",
			)
		: [];
	return {
		files,
		outside: count(o.outside) ?? 0,
		foreign: count(o.foreign) ?? 0,
		maxFiles,
		foreignFiles,
	};
}

/** Why the watchdog (or a person) stopped a run, from `runs.kill_reason`. */
export const KILL_REASON_LABEL: Record<string, string> = {
	manual: "stopped by hand",
	"watchdog-idle": "stopped: no output",
	"watchdog-wall": "stopped: ran too long",
	"watchdog-turns": "stopped: too many turns",
	"watchdog-timebox": "stopped: timebox",
	"watchdog-scope": "stopped: touched another task's files",
	"watchdog-files": "stopped: too many files changed",
};

export function killReasonLabel(reason: unknown): string | null {
	if (typeof reason !== "string" || reason === "") return null;
	return KILL_REASON_LABEL[reason] ?? `stopped: ${reason}`;
}
