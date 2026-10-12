import { describe, expect, test } from "bun:test";
import type { AppRouter } from "@mfw/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ToastProvider } from "../../lib/toast";
import { TRPCProvider } from "../../lib/trpc";
import { ReviewPage } from "./ReviewPage";

/** ReviewPage with its data seeded, so it renders without a daemon. */
function render(embedded: boolean): string {
	const queryClient = new QueryClient();
	const client = createTRPCClient<AppRouter>({ links: [] });
	const trpc = createTRPCOptionsProxy<AppRouter>({ client, queryClient });
	queryClient.setQueryData(
		trpc.review.bundle.queryKey({ project: "mfw", taskId: "MFW-70" }),
		{ branch: null, files: [], mergeJob: null, run: null } as never,
	);
	queryClient.setQueryData(
		trpc.review.comments.list.queryKey({ project: "mfw", taskId: "MFW-70" }),
		[] as never,
	);
	queryClient.setQueryData(
		trpc.tasks.get.queryKey({ project: "mfw", id: "MFW-70" }),
		{ id: "MFW-70", title: "Parse config v2", status: "review" } as never,
	);
	queryClient.setQueryData(trpc.inbox.list.queryKey(), {
		items: [],
		counts: { total: 0, critical: 0, attention: 0 },
	} as never);
	return renderToStaticMarkup(
		createElement(
			ToastProvider,
			null,
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(TRPCProvider, {
					trpcClient: client,
					queryClient,
					// biome-ignore lint/correctness/noChildrenProp: createElement(TRPCProvider, props) needs children inside props to typecheck
					children: createElement(ReviewPage, {
						project: "mfw",
						taskId: "MFW-70",
						embedded,
						onSelectFile: () => {},
					}),
				}),
			),
		),
	);
}

describe("ReviewPage mounted as a tab", () => {
	test("embedded, it carries no page chrome of its own", () => {
		const html = render(true);
		expect(html).toContain("Parse config v2");
		expect(html).not.toContain("/p/mfw/board");
		expect(html).not.toContain("/p/mfw/tasks/MFW-70");
	});

	test("as a page it keeps its way back to the board and the task", () => {
		const html = render(false);
		expect(html).toContain("/p/mfw/board");
		expect(html).toContain("/p/mfw/tasks/MFW-70");
	});
});
