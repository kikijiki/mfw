/**
 * Walking the review queue, pure. The queue is a project's `kind: "review"`
 * items in `inbox.list` (so it is part of the same needs list the badge
 * counts); the review screen only decides *which* task is next and leaves
 * going there to whoever mounted it (see `ReviewPage`'s props).
 */

export interface ReviewQueueItem {
	taskId: string;
}

export function reviewQueue(
	items:
		| readonly { kind: string; project: string; taskId?: string }[]
		| undefined,
	project: string,
): ReviewQueueItem[] {
	const seen = new Set<string>();
	const out: ReviewQueueItem[] = [];
	for (const item of items ?? []) {
		if (item.kind !== "review" || item.project !== project) continue;
		if (!item.taskId || seen.has(item.taskId)) continue;
		seen.add(item.taskId);
		out.push({ taskId: item.taskId });
	}
	return out;
}

/** `[` and `]`: the neighbour of `taskId` in the queue, wrapping. Null when there is nowhere to go. */
export function stepReview(
	queue: readonly ReviewQueueItem[],
	taskId: string,
	delta: number,
): ReviewQueueItem | null {
	if (queue.length === 0) return null;
	const at = queue.findIndex((i) => i.taskId === taskId);
	const from = at === -1 ? 0 : at;
	// Leaving the queue (not in it) and stepping forward lands on its first item.
	const index =
		at === -1
			? delta < 0
				? queue.length - 1
				: 0
			: (from + delta + queue.length) % queue.length;
	const next = queue[index];
	return next && next.taskId !== taskId ? next : null;
}

/** After a decision: the next waiting task other than the one just decided, or null. */
export function nextAfterDecision(
	queue: readonly ReviewQueueItem[],
	taskId: string,
): ReviewQueueItem | null {
	const at = queue.findIndex((i) => i.taskId === taskId);
	const after =
		at === -1 ? queue : [...queue.slice(at + 1), ...queue.slice(0, at)];
	return after.find((i) => i.taskId !== taskId) ?? null;
}
