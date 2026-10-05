import type { InboxItem } from "@mfw/daemon/inbox";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useTRPC } from "../../lib/trpc";

/**
 * The inbox, optionally narrowed to one project. `inbox.list` is cross-project
 * (derived once in `daemon/inbox.ts`), so narrowing happens here on the rows.
 * Scoped lists and counts both go through this hook so they cannot disagree.
 */
export interface InboxCounts {
	total: number;
	critical: number;
	attention: number;
}

export function useInbox(project?: string) {
	const trpc = useTRPC();
	const query = useQuery(trpc.inbox.list.queryOptions());
	const all = query.data?.items;
	const serverCounts = query.data?.counts;

	const items = useMemo<InboxItem[]>(() => {
		const rows = all ?? [];
		return project ? rows.filter((item) => item.project === project) : rows;
	}, [all, project]);

	/** Unscoped uses the server's counts (the badge contract); scoped tallies the filtered rows. */
	const counts = useMemo<InboxCounts | undefined>(() => {
		if (!project) return serverCounts;
		if (!all) return undefined;
		return {
			total: items.length,
			critical: items.filter((i) => i.severity === "critical").length,
			attention: items.filter((i) => i.severity === "attention").length,
		};
	}, [project, serverCounts, all, items]);

	return { query, items, counts };
}
