import { createFileRoute } from "@tanstack/react-router";

import { type FilesLocation, FilesPage } from "~/features/files/FilesPage";

/**
 * The workspace browser. All three coordinates are URL state: `run` picks the
 * base (project root when absent), `path` is the open directory and `file` the
 * open file.
 */
export const Route = createFileRoute("/p/$project/files")({
	validateSearch: (search: Record<string, unknown>): FilesLocation => ({
		run: asPath(search.run),
		path: asPath(search.path),
		file: asPath(search.file),
	}),
	component: FilesRoute,
});

/**
 * The router's search parser coerces bare numbers and `true`/`false`
 * (`router-core/qss.ts`), so a directory named `2024` arrives as a number.
 * Stringify it back so such paths stay openable.
 */
function asPath(value: unknown): string | undefined {
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return typeof value === "string" && value ? value : undefined;
}

function FilesRoute() {
	const { project } = Route.useParams();
	const at = Route.useSearch();
	return <FilesPage project={project} at={at} />;
}
