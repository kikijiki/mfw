import { createFileRoute } from "@tanstack/react-router";

import { TaskRoutePage } from "~/features/tasks/TaskRoutePage";

/**
 * The canonical, shareable task URL (MFW-26): deep links, refreshes, and
 * opens from anywhere but the board (Home, a run's task link). On wide
 * screens it redirects to the board with the task docked; otherwise it is the
 * task inspector as a full-width page. See `TaskRoutePage`.
 */
export const Route = createFileRoute("/p/$project/tasks/$taskId")({
	component: TaskRoute,
});

function TaskRoute() {
	const { project, taskId } = Route.useParams();
	return <TaskRoutePage project={project} taskId={taskId} />;
}
