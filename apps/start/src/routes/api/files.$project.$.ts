import { createFileRoute } from "@tanstack/react-router";
import { getOrchestrator } from "~/server/orchestrator";

/**
 * Raw bytes of an image for `<img>` in the Files and Repo viewers: from the
 * working tree (`?run=<id>` for a run's worktree) or, with `?ref=`, from that
 * branch, tag or commit. The daemon owns the rules: `WorkspaceService.readImage`
 * (realpath containment) and `RepoViewService.blobBytes` (the same ref and path
 * validation as `repo.blob`). Only image extensions are served, capped at 5 MiB,
 * `nosniff` and sandboxed so a hostile SVG navigated to directly cannot run
 * script in the app origin.
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

export const Route = createFileRoute("/api/files/$project/$")({
	server: {
		handlers: {
			GET: async ({ params, request }) => {
				const orchestrator = await getOrchestrator();
				let svc: ReturnType<typeof orchestrator.get>;
				try {
					svc = orchestrator.get(params.project);
				} catch {
					return text(404, "unknown project");
				}
				const path = params._splat ?? "";
				const query = new URL(request.url).searchParams;
				const ref = query.get("ref") || undefined;
				const run = query.get("run") || undefined;
				if (!path) return text(400, "a file path is required");
				try {
					const { data, mime } = ref
						? await svc.repoView.blobBytes({ ref, path })
						: await svc.workspace.readImage({ path, runId: run });
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
						return text(403, "outside the workspace");
					if (name === "NotFoundError") return text(404, "not found");
					if (name === "InvalidRefError")
						return text(400, "invalid ref or path");
					console.error("[mfw] file image read failed:", err);
					return text(500, "could not read the file");
				}
			},
		},
	},
});
