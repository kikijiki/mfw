import type { StoredEvent } from "@mfw/db/eventlog";

/** HISTORY digest ("what happened while I was away"): folds the audit stream into a few sentences and drops routine churn. */

/** Machine chatter, never worth a digest line. */
const NOISE = new Set([
	"run.finalize_step",
	"task.claimed",
	"task.claim_released",
	"task.edited",
	"resource.locked",
	"resource.released",
]);

export interface DigestEntry {
	kind:
		| "done"
		| "merged"
		| "blocked"
		| "review"
		| "failed"
		| "created"
		| "clarify"
		| "main_red"
		| "rate_limited";
	count: number;
	taskIds: string[];
	detail?: string;
}

export interface Digest {
	project: string;
	sinceSeq: number;
	latestSeq: number;
	/** One-line prose summary, safe to render alone. */
	summary: string;
	entries: DigestEntry[];
	/** Whether anything in here needs the operator to act. */
	needsAttention: boolean;
}

/**
 * Kinds asserting a PRESENT-TENSE condition ("3 waiting for review"), checked
 * against the board rather than replayed. The rest ("7 tasks created") stay
 * true forever.
 */
const PRESENT_TENSE: Partial<Record<DigestEntry["kind"], string>> = {
	review: "review",
	blocked: "blocked",
};

/** Task-scoped kinds count tasks, not events (see `reconcile`). */
const TASK_SCOPED = new Set<DigestEntry["kind"]>([
	"done",
	"merged",
	"blocked",
	"review",
	"created",
]);

export function buildDigest(
	project: string,
	sinceSeq: number,
	events: StoredEvent[],
	/** Each task's current board status, or undefined if deleted. Optional to keep this pure; omitted means history only. */
	currentStatus?: (taskId: string) => string | undefined,
): Digest {
	const buckets = new Map<DigestEntry["kind"], DigestEntry>();
	const add = (kind: DigestEntry["kind"], taskId?: string, detail?: string) => {
		const entry = buckets.get(kind) ?? { kind, count: 0, taskIds: [] };
		entry.count++;
		if (taskId && !entry.taskIds.includes(taskId)) entry.taskIds.push(taskId);
		if (detail && !entry.detail) entry.detail = detail;
		buckets.set(kind, entry);
	};

	for (const e of events) {
		if (NOISE.has(e.type)) continue;
		switch (e.type) {
			case "task.created":
				add("created", e.taskId);
				break;
			case "merge.completed":
				add("merged", e.taskId);
				break;
			case "main.red":
				add("main_red", undefined, "merges are paused");
				break;
			case "rate_limit.hit":
				add("rate_limited", undefined, "dispatch was held");
				break;
			case "clarify.raised":
				add("clarify");
				break;
			case "task.status_changed": {
				const to = (e.payload as { to?: string }).to;
				const reason = (e.payload as { reason?: string }).reason;
				if (to === "done") add("done", e.taskId);
				else if (to === "blocked") add("blocked", e.taskId, reason);
				else if (to === "review") add("review", e.taskId);
				break;
			}
			case "run.state_changed": {
				const to = (e.payload as { to?: string }).to;
				if (to === "failed" || to === "finalize_error")
					add("failed", undefined, (e.payload as { note?: string }).note);
				break;
			}
		}
	}

	const entries = reconcile([...buckets.values()], currentStatus).sort(
		(a, b) => b.count - a.count,
	);
	const latestSeq = events.at(-1)?.seq ?? sinceSeq;
	const needsAttention = entries.some((e) =>
		["blocked", "review", "clarify", "main_red"].includes(e.kind),
	);

	return {
		project,
		sinceSeq,
		latestSeq,
		summary: summarize(entries),
		entries,
		needsAttention,
	};
}

/**
 * Drops present-tense entries that are no longer true (else a review badge for
 * deleted or merged tasks could never clear), and counts tasks rather than
 * events (a task can emit two `task.created` events, inflating the count).
 * Without `currentStatus` only the counting fix applies.
 */
function reconcile(
	entries: DigestEntry[],
	currentStatus?: (taskId: string) => string | undefined,
): DigestEntry[] {
	const out: DigestEntry[] = [];
	for (const entry of entries) {
		const wanted = PRESENT_TENSE[entry.kind];
		if (wanted && currentStatus) {
			const still = entry.taskIds.filter((id) => currentStatus(id) === wanted);
			// Every task moved on or was deleted: the condition is over.
			if (still.length === 0) continue;
			out.push({ ...entry, taskIds: still, count: still.length });
			continue;
		}
		out.push(
			TASK_SCOPED.has(entry.kind) && entry.taskIds.length > 0
				? { ...entry, count: entry.taskIds.length }
				: entry,
		);
	}
	return out;
}

const PHRASE: Record<DigestEntry["kind"], (n: number) => string> = {
	done: (n) => `${n} task${n === 1 ? "" : "s"} completed`,
	merged: (n) => `${n} merge${n === 1 ? "" : "s"} landed`,
	blocked: (n) => `${n} blocked`,
	review: (n) => `${n} waiting for review`,
	failed: (n) => `${n} run${n === 1 ? "" : "s"} failed`,
	created: (n) => `${n} task${n === 1 ? "" : "s"} created`,
	clarify: (n) => `${n} question${n === 1 ? "" : "s"} raised`,
	main_red: () => "main went red",
	rate_limited: () => "dispatch was rate-limited",
};

function summarize(entries: DigestEntry[]): string {
	if (entries.length === 0) return "Nothing happened.";
	const parts = entries.slice(0, 4).map((e) => PHRASE[e.kind](e.count));
	const rest = entries.length - parts.length;
	const tail =
		rest > 0
			? `, and ${rest} other kind${rest === 1 ? "" : "s"} of activity`
			: "";
	return `${parts.join(", ")}${tail}.`;
}
