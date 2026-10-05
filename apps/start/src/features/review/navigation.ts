import { href } from "../../routes";

export type ReviewOrigin = "inbox" | "project-inbox" | undefined;

/** Pick the next location without losing the inbox scope that opened review. */
export function afterReviewDecisionHref(
	project: string,
	taskId: string,
	origin: ReviewOrigin,
	queue: { project: string; taskId: string }[],
): string {
	const next = queue.find(
		(item) =>
			item.taskId !== taskId &&
			(origin !== "project-inbox" || item.project === project),
	);
	if (next) return href.reviewTask(next.project, next.taskId, origin);
	return origin === "project-inbox" ? href.projectInbox(project) : href.inbox();
}
