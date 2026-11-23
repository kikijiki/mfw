import { createFileRoute } from "@tanstack/react-router";
import { guard, serverAuth } from "~/server/auth-guard";
import { getOrchestrator } from "~/server/orchestrator";
import { serveTrpc } from "~/server/trpc-handler";

/**
 * The tRPC mount. `endpoint` must carry the build-time base path (tRPC strips
 * it from the pathname to find the procedure), so it is derived from `BASE_URL`.
 */
const endpoint = `${import.meta.env.BASE_URL}api/trpc`.replace(/\/{2,}/g, "/");

const handler = async (req: Request) =>
	serveTrpc(req, await guard(req), {
		auth: await serverAuth(),
		endpoint,
		orchestrator: getOrchestrator,
	});

export const Route = createFileRoute("/api/trpc/$")({
	server: {
		handlers: {
			GET: ({ request }) => handler(request),
			POST: ({ request }) => handler(request),
		},
	},
});
