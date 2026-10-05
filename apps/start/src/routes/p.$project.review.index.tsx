import { createFileRoute } from "@tanstack/react-router";

import { ReviewQueueList } from "~/features/review/ReviewQueueList";

export const Route = createFileRoute("/p/$project/review/")({
	component: ReviewQueueRoute,
});

function ReviewQueueRoute() {
	const { project } = Route.useParams();
	return <ReviewQueueList project={project} />;
}
