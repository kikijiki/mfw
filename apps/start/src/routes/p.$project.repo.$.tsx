import { createFileRoute } from "@tanstack/react-router";

import { RepoPage, type RepoSearch } from "~/features/repo/RepoPage";

/**
 * The repository view. One splat route so branch names keep their slashes
 * (`/repo/branches/feature/x`) and compare can say `a...b`; the section and
 * its subject are parsed from the splat by `features/repo/repoModel.ts`, and
 * the filters are search params.
 */
export const Route = createFileRoute("/p/$project/repo/$")({
	validateSearch: (search: Record<string, unknown>): RepoSearch => ({
		ref: asString(search.ref),
		run: asString(search.run),
		path: asString(search.path),
		file: asString(search.file),
		q: asString(search.q),
		kind: asString(search.kind),
		mode: search.mode === "two-dot" ? "two-dot" : undefined,
		f: asString(search.f),
	}),
	component: RepoRoute,
});

/**
 * The router's search parser coerces bare numbers and `true`/`false`, so a
 * directory named `2024` (or a short sha of digits) arrives as a number.
 */
function asString(value: unknown): string | undefined {
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return typeof value === "string" && value ? value : undefined;
}

function RepoRoute() {
	const { project, _splat } = Route.useParams();
	const search = Route.useSearch();
	return <RepoPage project={project} splat={_splat ?? ""} search={search} />;
}
