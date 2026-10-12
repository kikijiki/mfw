import { createFileRoute } from "@tanstack/react-router";

import { Inspector } from "~/features/inspector/Inspector";
import { useGo } from "~/lib/nav";
import { href, type NodeSearch, parseNodeSearch } from "~/routes";

/**
 * The inspector as a page: `/p/mfw/n/run:01J…?tab=transcript`. The same
 * component as the dock, so a link copied from the dock opens the same thing
 * full width. `$ref` is a node ref; an invalid one renders a not-found state.
 */
export const Route = createFileRoute("/p/$project/n/$ref")({
	validateSearch: (
		search: Record<string, unknown>,
	): Pick<NodeSearch, "tab" | "t"> => {
		const { tab, t } = parseNodeSearch(search);
		return { tab, t };
	},
	component: NodeRoute,
});

function NodeRoute() {
	const { project, ref } = Route.useParams();
	const { tab, t } = Route.useSearch();
	const navigate = Route.useNavigate();
	const go = useGo();
	return (
		<div className="flex h-full min-h-0 flex-col">
			<Inspector
				key={`${project}:${ref}`}
				project={project}
				nodeRef={ref}
				presentation="page"
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
				onClose={() => go(href.board(project))}
			/>
		</div>
	);
}
