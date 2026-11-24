import { createFileRoute, notFound } from "@tanstack/react-router";

/** Catches every path no other route owns: a plain not-found. */
export const Route = createFileRoute("/$")({
	beforeLoad: () => {
		throw notFound();
	},
});
