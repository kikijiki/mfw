import { createFileRoute, Outlet } from "@tanstack/react-router";

import { type BoardFilters, BoardPage } from "~/features/board/BoardPage";

/** Board filters are URL state: a filtered board is a shareable board. */
export const Route = createFileRoute("/p/$project/board")({
	validateSearch: (search: Record<string, unknown>): BoardFilters => ({
		q: typeof search.q === "string" && search.q ? search.q : undefined,
		label:
			typeof search.label === "string" && search.label
				? search.label
				: undefined,
		priority:
			typeof search.priority === "string" && search.priority
				? search.priority
				: undefined,
		type:
			typeof search.type === "string" && search.type ? search.type : undefined,
	}),
	component: BoardRoute,
});

function BoardRoute() {
	const { project } = Route.useParams();
	const filters = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<>
			<BoardPage
				project={project}
				filters={filters}
				onFilters={(next) => navigate({ search: () => next })}
			/>
			{/* MFW-26: `/p/$project/board/tasks/$taskId` matches here as a child, so
			    opening a task never unmounts `BoardPage`; its URL is masked to the
			    flat `/p/$project/tasks/$taskId` (see `routeMasks` in router.tsx). */}
			<Outlet />
		</>
	);
}
