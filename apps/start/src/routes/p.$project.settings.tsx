import { createFileRoute } from "@tanstack/react-router";

import { ProjectSettingsPage } from "~/features/settings/ProjectSettingsPage";

/** Per-project configuration, a route beside Board / Review / Runs / Files. */
export const Route = createFileRoute("/p/$project/settings")({
	component: ProjectSettingsRoute,
});

function ProjectSettingsRoute() {
	const { project } = Route.useParams();
	return <ProjectSettingsPage project={project} />;
}
