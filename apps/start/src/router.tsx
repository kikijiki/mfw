import { QueryClient } from "@tanstack/react-query";
import { createRouteMask, createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import SuperJSON from "superjson";

import { makeTRPCClient, TRPCProvider } from "~/lib/trpc";
import { routeTree } from "./routeTree.gen";

/**
 * MFW-26: a task opened from the board navigates to
 * `/p/$project/board/tasks/$taskId` (a child of the board route, so `BoardPage`
 * stays mounted), but that URL is masked back to the canonical
 * `/p/$project/tasks/$taskId` in the address bar and copied links.
 * `useOpenTaskFromBoard` (lib/nav.ts) relies on the mask being registered here.
 */
const taskOverlayMask = createRouteMask({
	routeTree,
	from: "/p/$project/board/tasks/$taskId",
	to: "/p/$project/tasks/$taskId",
	params: true,
});

export function getRouter() {
	const queryClient = new QueryClient({
		defaultOptions: {
			dehydrate: { serializeData: SuperJSON.serialize },
			hydrate: { deserializeData: SuperJSON.deserialize },
		},
	});
	const trpcClient = makeTRPCClient();
	const trpc = createTRPCOptionsProxy({ client: trpcClient, queryClient });

	const router = createRouter({
		routeTree,
		routeMasks: [taskOverlayMask],
		context: { queryClient, trpc },
		defaultPreload: "intent",
		Wrap: (props) => (
			<TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
				{props.children}
			</TRPCProvider>
		),
	});
	setupRouterSsrQueryIntegration({ router, queryClient });
	return router;
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
