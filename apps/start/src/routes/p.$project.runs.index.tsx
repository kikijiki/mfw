import { createFileRoute } from "@tanstack/react-router";

import { RunsListPage } from "~/features/transcript/RunsListPage";

export const Route = createFileRoute("/p/$project/runs/")({
	component: RunsRoute,
});

function RunsRoute() {
	const { project } = Route.useParams();
	return <RunsListPage project={project} />;
}
