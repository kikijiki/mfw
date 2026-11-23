import { createFileRoute } from "@tanstack/react-router";
import { guard, serverAuth } from "~/server/auth-guard";
import { handleAuthAction } from "~/server/auth-routes";

const handler = async (request: Request, action: string) => {
	const guarded = await guard(request);
	if (!guarded.ok) return guarded.response;
	return handleAuthAction(action, request, guarded, await serverAuth());
};

export const Route = createFileRoute("/api/auth/$action")({
	server: {
		handlers: {
			GET: ({ request, params }) => handler(request, params.action),
			POST: ({ request, params }) => handler(request, params.action),
		},
	},
});
