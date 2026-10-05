import { createFileRoute } from "@tanstack/react-router";

import { BoardPage } from "~/features/board/BoardPage";
import { TaskOverlay } from "~/features/tasks/TaskOverlay";

/**
 * MFW-26: the canonical, shareable task URL, used when deep-linked, refreshed,
 * or opened from anywhere but the board (Inbox, History, a run's task link).
 * Those have no board instance to inherit, so this route mounts its own as the
 * backdrop.
 *
 * Opened FROM the board, this route is not matched: the board's
 * `/p/$project/board/tasks/$taskId` child is, and its URL is masked to this
 * path (see `routeMasks` in router.tsx).
 */
export const Route = createFileRoute("/p/$project/tasks/$taskId")({
	component: TaskRoute,
});

function TaskRoute() {
	const { project, taskId } = Route.useParams();
	const navigate = Route.useNavigate();
	return (
		<>
			<BoardPage
				project={project}
				filters={{}}
				onFilters={(next) =>
					navigate({
						to: "/p/$project/board",
						params: { project },
						search: next,
					})
				}
			/>
			<TaskOverlay project={project} taskId={taskId} />
		</>
	);
}
