import { createFileRoute } from "@tanstack/react-router";
import { guard, serverAuth } from "~/server/auth-guard";
import { handleAuthAction } from "~/server/auth-routes";
import { getOrchestrator } from "~/server/orchestrator";

const attachedProjects = async () =>
	(await getOrchestrator()).list().map((svc) => svc.name);

const handler = async (request: Request, action: string) => {
	const guarded = await guard(request, { api: true });
	if (!guarded.ok) return guarded.response;
	return handleAuthAction(
		action,
		request,
		guarded,
		await serverAuth(),
		// Base path and throttle identity: the handler's own defaults.
		undefined,
		undefined,
		attachedProjects,
	);
};

export const Route = createFileRoute("/api/auth/$action")({
	server: {
		handlers: {
			GET: ({ request, params }) => handler(request, params.action),
			POST: ({ request, params }) => handler(request, params.action),
		},
	},
});
