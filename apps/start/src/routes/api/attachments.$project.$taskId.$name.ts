import { createFileRoute } from "@tanstack/react-router";
import { getOrchestrator } from "~/server/orchestrator";

/**
 * Raw task attachment bytes. Uploaded files are untrusted: only a small
 * allowlist of inert types is served under its real type; everything else
 * (always svg and html) is an opaque download. `sandbox` CSP plus `nosniff`
 * mean nothing served here can run script in the app origin.
 */
const TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	pdf: "application/pdf",
	txt: "text/plain; charset=utf-8",
	md: "text/plain; charset=utf-8",
	json: "application/json",
	csv: "text/csv; charset=utf-8",
};

function contentType(name: string): string | null {
	const dot = name.lastIndexOf(".");
	if (dot < 0) return null;
	return TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}

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

export const Route = createFileRoute("/api/attachments/$project/$taskId/$name")(
	{
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
					let data: Buffer | null;
					try {
						data = await svc.tasks.getAttachment(params.taskId, params.name);
					} catch (err) {
						if (err instanceof Error && err.name === "ExtrasError")
							return text(400, err.message);
						console.error("[mfw] attachment read failed:", err);
						return text(500, "could not read attachment");
					}
					if (!data) return text(404, "not found");

					const type = contentType(params.name);
					const headers: Record<string, string> = {
						"Content-Type": type ?? "application/octet-stream",
						"Content-Length": String(data.byteLength),
						"X-Content-Type-Options": "nosniff",
						"Content-Security-Policy": "sandbox",
						"Cache-Control": "private, no-cache",
					};
					if (!type) {
						const safe = params.name.replace(/["\\\r\n]/g, "_");
						headers["Content-Disposition"] = `attachment; filename="${safe}"`;
					}
					return new Response(new Uint8Array(data), { headers });
				},
			},
		},
	},
);
