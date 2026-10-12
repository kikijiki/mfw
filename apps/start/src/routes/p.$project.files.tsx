import { createFileRoute, redirect } from "@tanstack/react-router";

import { href } from "~/routes";

/**
 * The workspace browser moved under the repository view
 * (`/p/$project/repo/files`). This path survives so bookmarks, notifications
 * and old links keep working; `run`, `path` and `file` are carried over.
 */
export const Route = createFileRoute("/p/$project/files")({
	validateSearch: (
		search: Record<string, unknown>,
	): { run?: string; path?: string; file?: string } => ({
		run: asPath(search.run),
		path: asPath(search.path),
		file: asPath(search.file),
	}),
	beforeLoad: ({ params, search }) => {
		throw redirect({
			to: href.files(params.project, search),
			replace: true,
		});
	},
});

function asPath(value: unknown): string | undefined {
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return typeof value === "string" && value ? value : undefined;
}
