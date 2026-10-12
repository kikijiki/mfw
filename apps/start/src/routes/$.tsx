import { createFileRoute, notFound, redirect } from "@tanstack/react-router";

import { legacyFleetPath } from "~/routes";

/**
 * Catches every path no other route owns. The four pre-Fleet machine pages
 * (`/models`, `/resources`, `/runpod`, `/openrouter`) redirect to the Fleet
 * page that replaced them; anything else is a plain not-found.
 */
export const Route = createFileRoute("/$")({
	beforeLoad: ({ location }) => {
		const to = legacyFleetPath(location.pathname);
		if (to) throw redirect({ to, replace: true });
		throw notFound();
	},
});
