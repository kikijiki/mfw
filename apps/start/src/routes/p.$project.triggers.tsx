import { createFileRoute } from "@tanstack/react-router";

import { TriggersPage } from "~/features/triggers/TriggersPage";

/** Project triggers (MFW-117 phase 3): armed state, last delivery, dry run,
 *  retry. `highlight` is a defId an inbox row can point at directly. */
export const Route = createFileRoute("/p/$project/triggers")({
	validateSearch: (
		search: Record<string, unknown>,
	): { highlight?: string } => ({
		highlight:
			typeof search.highlight === "string" ? search.highlight : undefined,
	}),
	component: TriggersRoute,
});

function TriggersRoute() {
	const { project } = Route.useParams();
	const { highlight } = Route.useSearch();
	return <TriggersPage project={project} highlight={highlight} />;
}
