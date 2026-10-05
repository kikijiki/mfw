import { createFileRoute } from "@tanstack/react-router";

import { InboxPage } from "~/features/inbox/InboxPage";

/** This project's attention queue: the same screen as /inbox, narrowed to one project. */
export const Route = createFileRoute("/p/$project/inbox")({
	component: ProjectInboxRoute,
});

function ProjectInboxRoute() {
	const { project } = Route.useParams();
	return <InboxPage project={project} />;
}
