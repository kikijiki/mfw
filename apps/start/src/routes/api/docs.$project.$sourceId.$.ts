import { createFileRoute } from "@tanstack/react-router";
import { getOrchestrator } from "~/server/orchestrator";

/**
 * Raw bytes of an image or SVG inside a doc source, for `<img>` in the Docs
 * reader. The daemon (`DocsService.readImage`) owns containment: the path must
 * resolve, physically, inside the source's directory, and only image types are
 * served. Responses are `nosniff` and sandboxed, so even a hostile SVG
 * navigated to directly cannot run script in the app origin.
 */
const text = (status: number, message: string) =>
	new Response(message, {
		status,
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "sandbox",
			"Cache-Control": "private, no-cache",
		},
	});

export const Route = createFileRoute("/api/docs/$project/$sourceId/$")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const orchestrator = await getOrchestrator();
				let svc: ReturnType<typeof orchestrator.get>;
				try {
					svc = orchestrator.get(params.project);
				} catch {
					return text(404, "unknown project");
				}
				const key = params._splat ?? "";
				try {
					const { data, mime } = await svc.docs.readImage(params.sourceId, key);
					return new Response(new Uint8Array(data), {
						headers: {
							"Content-Type": mime,
							"Content-Length": String(data.byteLength),
							"X-Content-Type-Options": "nosniff",
							"Content-Security-Policy": "sandbox",
							"Cache-Control": "private, no-cache",
						},
					});
				} catch (err) {
					const name = err instanceof Error ? err.name : "";
					if (name === "PathEscapeError")
						return text(403, "outside the source");
					if (name === "NotFoundError") return text(404, "not found");
					console.error("[mfw] doc asset read failed:", err);
					return text(500, "could not read the file");
				}
			},
		},
	},
});
