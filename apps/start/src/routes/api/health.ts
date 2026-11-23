import { createFileRoute } from "@tanstack/react-router";
import { guard, jsonResponse } from "~/server/auth-guard";

/** Liveness only. Public, so it says nothing about projects, runs or setup. */
export const Route = createFileRoute("/api/health")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const guarded = await guard(request);
				if (!guarded.ok) return guarded.response;
				return jsonResponse(200, { ok: true });
			},
		},
	},
});
