import { appRouter } from "@mfw/api";
import { createFileRoute } from "@tanstack/react-router";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { getOrchestrator } from "~/server/orchestrator";

/**
 * The tRPC mount. `endpoint` must carry the build-time base path (tRPC strips
 * it from the pathname to find the procedure), so it is derived from `BASE_URL`.
 */
const endpoint = `${import.meta.env.BASE_URL}api/trpc`.replace(/\/{2,}/g, "/");

const handler = async (req: Request) => {
	const orchestrator = await getOrchestrator();
	return fetchRequestHandler({
		endpoint,
		router: appRouter,
		req,
		createContext: () => ({ orchestrator }),
		onError({ error, path }) {
			console.error(`[mfw] tRPC error on '${path}':`, error.message);
		},
	});
};

export const Route = createFileRoute("/api/trpc/$")({
	server: {
		handlers: {
			GET: ({ request }) => handler(request),
			POST: ({ request }) => handler(request),
		},
	},
});
