import { createFileRoute } from "@tanstack/react-router";

import { RunPage } from "~/features/transcript/RunPage";

/** `?q=` keeps a transcript search in the URL and `?entry=` deep-links one entry. */
export const Route = createFileRoute("/p/$project/runs/$runId")({
	validateSearch: (
		search: Record<string, unknown>,
	): { q?: string; entry?: number } => {
		const entry = Number(search.entry);
		return {
			q: typeof search.q === "string" && search.q ? search.q : undefined,
			entry: Number.isFinite(entry) && entry >= 0 ? entry : undefined,
		};
	},
	component: RunRoute,
});

function RunRoute() {
	const { project, runId } = Route.useParams();
	const { q, entry } = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<RunPage
			key={`${project}:${runId}`}
			project={project}
			runId={runId}
			query={q ?? ""}
			entrySeq={entry}
			onQueryChange={(next) =>
				navigate({
					search: (prev) => ({ ...prev, q: next || undefined }),
					replace: true,
				})
			}
		/>
	);
}
