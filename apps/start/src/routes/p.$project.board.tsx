import { createFileRoute } from "@tanstack/react-router";

import { type BoardFilters, BoardPage } from "~/features/board/BoardPage";
import { closeNodeSearch, useDockSide } from "~/features/inspector/dock";
import { Inspector, InspectorDockLayout } from "~/features/inspector/Inspector";
import { taskIdOf } from "~/lib/nodeRef";
import { type NodeSearch, parseNodeSearch } from "~/routes";

/**
 * Board filters and the selected node are URL state: a filtered board with a
 * task open is a shareable board. `?node=` opens the docked inspector beside
 * the board (design §2.3); the board stays mounted underneath it.
 */
export const Route = createFileRoute("/p/$project/board")({
	validateSearch: (
		search: Record<string, unknown>,
	): BoardFilters & NodeSearch => ({
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
		gate: search.gate === "review" ? "review" : undefined,
		...parseNodeSearch(search),
	}),
	component: BoardRoute,
});

function BoardRoute() {
	const { project } = Route.useParams();
	const { node, tab, t, f, w, ...filters } = Route.useSearch();
	const navigate = Route.useNavigate();
	const side = useDockSide();
	return (
		<InspectorDockLayout
			side={side}
			inspector={
				node ? (
					<Inspector
						project={project}
						nodeRef={node}
						presentation="dock"
						tab={tab}
						at={t}
						onLive={() =>
							navigate({
								search: (prev) => ({ ...prev, t: undefined }),
								replace: true,
							})
						}
						onTab={(next) =>
							navigate({
								search: (prev) => ({ ...prev, tab: next }),
								replace: true,
							})
						}
						onClose={() =>
							navigate({ search: (prev) => closeNodeSearch(prev) })
						}
					/>
				) : null
			}
		>
			<BoardPage
				project={project}
				filters={filters}
				selectedTask={taskIdOf(node)}
				at={t}
				onLive={() =>
					navigate({
						search: (prev) => ({ ...prev, t: undefined }),
						replace: true,
					})
				}
				// Filters replace the board's own params and keep the selection and time.
				onFilters={(next) =>
					navigate({ search: () => ({ ...next, node, tab, t, f, w }) })
				}
			/>
		</InspectorDockLayout>
	);
}
