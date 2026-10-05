import type { AppRouter } from "@mfw/api";
import { MutationCache, QueryClient } from "@tanstack/react-query";
import {
	createTRPCClient,
	httpBatchLink,
	httpSubscriptionLink,
	loggerLink,
	splitLink,
	type TRPCClientErrorLike,
} from "@trpc/client";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import {
	createTRPCContext,
	type TRPCOptionsProxy,
} from "@trpc/tanstack-react-query";
import SuperJSON from "superjson";

import { humanizeError, toastBus } from "./toast";

/**
 * Origin + mount prefix for the HTTP links. `BASE_URL` is Vite's slash-terminated
 * `base`; the server route (`routes/api/trpc.$.ts`) strips this same prefix.
 */
export function trpcEndpoint(): string {
	const prefix = import.meta.env.BASE_URL.replace(/\/+$/, "");
	const origin =
		typeof window !== "undefined"
			? window.location.origin
			: `http://localhost:${process.env.PORT ?? "7777"}`;
	return `${origin}${prefix}/api/trpc`;
}

/** Subscriptions are SSE and cannot use the batch link, so `splitLink` routes by operation type. */
export function makeTRPCClient() {
	const url = trpcEndpoint();
	return createTRPCClient<AppRouter>({
		links: [
			loggerLink({
				enabled: (op) => op.direction === "down" && op.result instanceof Error,
			}),
			splitLink({
				condition: (op) => op.type === "subscription",
				true: httpSubscriptionLink({ transformer: SuperJSON, url }),
				false: httpBatchLink({ transformer: SuperJSON, url }),
			}),
		],
	});
}

export const { TRPCProvider, useTRPC, useTRPCClient } =
	createTRPCContext<AppRouter>();

/** The options proxy type, for modules that take `trpc` as a parameter. */
export type TRPCProxy = TRPCOptionsProxy<AppRouter>;
export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type TRPCError = TRPCClientErrorLike<AppRouter>;

/** Subscription procedures return an async iterable; screens want the element. */
export type YieldOf<T> = T extends AsyncIterable<infer U> ? U : never;

export interface QueryClientOptions {
	/** Overrides the default error toast. Route errors elsewhere; do not silence them. */
	onMutationError?: (error: unknown, label: string | undefined) => void;
}

/**
 * Long `staleTime` and no focus refetch: the live channel (lib/live.ts) keeps
 * the cache fresh. Failed mutations always toast; opt out with
 * `meta: { toast: false }`, label with `meta: { label: "Approve" }`.
 */
export function makeQueryClient(opts: QueryClientOptions = {}): QueryClient {
	return new QueryClient({
		mutationCache: new MutationCache({
			onError: (error, _vars, _ctx, mutation) => {
				const meta = mutation.options.meta as
					| { toast?: boolean; label?: string }
					| undefined;
				if (meta?.toast === false) return;
				if (opts.onMutationError) {
					opts.onMutationError(error, meta?.label);
					return;
				}
				toastBus.push({
					tone: "error",
					title: meta?.label ? `${meta.label} failed` : "Action failed",
					description: humanizeError(error),
					// Errors never auto-dismiss.
					duration: 0,
				});
			},
		}),
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				retry: 1,
				refetchOnWindowFocus: false,
				refetchOnReconnect: true,
			},
			// SuperJSON on both ends of SSR hydration.
			dehydrate: { serializeData: SuperJSON.serialize },
			hydrate: { deserializeData: SuperJSON.deserialize },
		},
	});
}
