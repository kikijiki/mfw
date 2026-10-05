import { createFileRoute, redirect } from "@tanstack/react-router";

import { href } from "~/routes";

export const Route = createFileRoute("/p/$project/")({
	beforeLoad: ({ params }) => {
		throw redirect({ to: href.board(params.project), replace: true });
	},
});
