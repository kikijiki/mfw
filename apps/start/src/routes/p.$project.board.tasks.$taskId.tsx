import { createFileRoute } from "@tanstack/react-router";

import { TaskOverlay } from "~/features/tasks/TaskOverlay";

/**
 * MFW-26: reached only through a masked navigation from the board (see
 * `BoardPage`'s `useOpenTask` and `routeMasks` in router.tsx); the address bar
 * shows the flat `/p/$project/tasks/$taskId`. Being a child of
 * `/p/$project/board` keeps the board's `<BoardPage>` mounted underneath.
 */
export const Route = createFileRoute("/p/$project/board/tasks/$taskId")({
	component: BoardTaskRoute,
});

function BoardTaskRoute() {
	const { project, taskId } = Route.useParams();
	return <TaskOverlay project={project} taskId={taskId} />;
}
