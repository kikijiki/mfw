import { createFileRoute, redirect } from "@tanstack/react-router";

import { href } from "~/routes";

/**
 * Review is the task inspector's Changes tab now. This route only keeps old
 * links (and notifications that carried one) working: it redirects to the
 * board with the task selected on that tab.
 */
export const Route = createFileRoute("/p/$project/review/$taskId")({
	beforeLoad: ({ params }) => {
		throw redirect({
			to: href.changes(params.project, params.taskId),
			replace: true,
		});
	},
});
