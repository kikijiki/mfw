import { createFileRoute, redirect } from "@tanstack/react-router";

import { href } from "~/routes";

/** `/` has no content of its own; NOW is the home route. */
export const Route = createFileRoute("/")({
	beforeLoad: () => {
		throw redirect({ to: href.now(), replace: true });
	},
});
