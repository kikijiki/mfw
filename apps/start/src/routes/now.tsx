import { createFileRoute } from "@tanstack/react-router";

import { NowPage } from "~/features/now/NowPage";

/**
 * NOW. The selected run lives in the URL so a card you are watching survives a
 * reload and can be sent to someone else.
 */
export const Route = createFileRoute("/now")({
	validateSearch: (search: Record<string, unknown>): { run?: string } => ({
		run: typeof search.run === "string" ? search.run : undefined,
	}),
	component: NowRoute,
});

function NowRoute() {
	const { run } = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<NowPage
			selectedRunId={run}
			onSelect={(runId) =>
				navigate({ search: () => ({ run: runId ?? undefined }) })
			}
		/>
	);
}
