import { createFileRoute, redirect } from "@tanstack/react-router";

import { href } from "~/routes";

/** The ADRs tab became Docs: `/adrs?adr=ID` lands on that ADR in the reader, a bare `/adrs` on the docs home. */
export const Route = createFileRoute("/p/$project/adrs")({
	validateSearch: (search: Record<string, unknown>): { adr?: string } => ({
		adr: typeof search.adr === "string" ? search.adr : undefined,
	}),
	beforeLoad: ({ params, search }) => {
		throw redirect({
			to: search.adr
				? href.adr(params.project, search.adr)
				: href.docs(params.project, { source: "adr" }),
			replace: true,
		});
	},
});
