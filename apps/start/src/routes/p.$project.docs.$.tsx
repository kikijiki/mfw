import { createFileRoute } from "@tanstack/react-router";

import { DocsPage } from "~/features/docs/DocsPage";
import { parseDocsSplat } from "~/features/docs/docsModel";

/**
 * Docs. The splat is `<source>/<key...>`; `q` is the search text. A bare
 * `/docs` is the home: recent changes, sources and suggestions.
 */
export const Route = createFileRoute("/p/$project/docs/$")({
	validateSearch: (search: Record<string, unknown>): { q?: string } => ({
		q:
			typeof search.q === "string" && search.q.length > 0
				? search.q.slice(0, 200)
				: typeof search.q === "number"
					? String(search.q)
					: undefined,
	}),
	component: DocsRoute,
});

function DocsRoute() {
	const { project, _splat } = Route.useParams();
	const { q } = Route.useSearch();
	const at = parseDocsSplat(_splat);
	return (
		<DocsPage project={project} source={at.source} docKey={at.key} q={q} />
	);
}
