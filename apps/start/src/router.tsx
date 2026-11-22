import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { createServerOnlyFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import SuperJSON from "superjson";
import { makeTRPCClient, TRPCProvider } from "~/lib/trpc";
import { routeTree } from "./routeTree.gen";
import { nonceFor } from "./server/security-headers";

/**
 * The CSP nonce the request middleware (`src/start.ts`) put in the request
 * context. The router stamps it on the inline scripts it emits. Server only:
 * the browser has no nonce to give (it never sees the attribute) and needs
 * none, since it only runs scripts that were already admitted.
 */
const requestNonce = createServerOnlyFn((): string | undefined =>
	nonceFor(getRequest()),
);

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
		context: { queryClient, trpc },
		defaultPreload: "intent",
		ssr: { nonce: import.meta.env.SSR ? requestNonce() : undefined },
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
