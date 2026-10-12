import { createFileRoute } from "@tanstack/react-router";

import { FlowPage, type FlowSearch } from "~/features/flow/FlowPage";
import { closeNodeSearch, useDockSide } from "~/features/inspector/dock";
import { Inspector, InspectorDockLayout } from "~/features/inspector/Inspector";
import { type NodeSearch, parseNodeSearch } from "~/routes";

/**
 * The Flow lens: the work tree with a time axis. The filter (`f`), window
 * (`w`), right edge (`t`, absent = LIVE) and selection (`node`, `tab`) are all
 * URL state, so a filtered, windowed tree with a node open is a link. Selecting
 * a node docks the inspector beside the lens, as on the board.
 */
export const Route = createFileRoute("/p/$project/flow")({
	validateSearch: (search: Record<string, unknown>): NodeSearch =>
		parseNodeSearch(search),
	component: FlowRoute,
});

function FlowRoute() {
	const { project } = Route.useParams();
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const side = useDockSide();
	const { node, tab } = search;
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
						at={search.t}
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
						onSelectNode={(ref) =>
							navigate({
								search: (prev) => ({ ...prev, node: ref, tab: undefined }),
							})
						}
					/>
				) : null
			}
		>
			<FlowPage
				project={project}
				search={search}
				onSearch={(patch: Partial<FlowSearch>) =>
					navigate({
						search: (prev) => ({ ...prev, ...patch }),
						// A window or filter tweak is not a place to go back to.
						replace: !("node" in patch),
					})
				}
			/>
		</InspectorDockLayout>
	);
}
