import { createFileRoute } from "@tanstack/react-router";

import { LeadPage } from "~/features/lead/LeadPage";

export const Route = createFileRoute("/p/$project/")({
	component: function LeadRoute() {
		const { project } = Route.useParams();
		return <LeadPage project={project} />;
	},
});
