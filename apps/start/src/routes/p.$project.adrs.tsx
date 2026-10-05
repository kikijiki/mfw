import { createFileRoute } from "@tanstack/react-router";

import { AdrsPage } from "~/features/adrs/AdrsPage";

export const Route = createFileRoute("/p/$project/adrs")({
	validateSearch: (search: Record<string, unknown>): { adr?: string } => ({
		adr: typeof search.adr === "string" ? search.adr : undefined,
	}),
	component: AdrsRoute,
});

function AdrsRoute() {
	const { project } = Route.useParams();
	const { adr } = Route.useSearch();
	return <AdrsPage project={project} selectedId={adr} />;
}
