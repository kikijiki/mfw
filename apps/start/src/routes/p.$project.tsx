import {
	createFileRoute,
	Outlet,
	useRouterState,
} from "@tanstack/react-router";

import { ProjectLayout } from "~/features/shell/ProjectLayout";

/** Project chrome; every `/p/$project/*` screen renders inside it. */
export const Route = createFileRoute("/p/$project")({
	component: ProjectRoute,
});

function ProjectRoute() {
	const { project } = Route.useParams();
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	return (
		<ProjectLayout project={project} pathname={pathname}>
			<Outlet />
		</ProjectLayout>
	);
}
