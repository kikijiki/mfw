import { createFileRoute } from "@tanstack/react-router";

import { ReviewPage } from "~/features/review/ReviewPage";

/** `?file=` deep-links a file; `?from=` preserves the inbox that opened it. */
export const Route = createFileRoute("/p/$project/review/$taskId")({
	validateSearch: (
		search: Record<string, unknown>,
	): {
		file?: string;
		from?: "inbox" | "project-inbox";
	} => ({
		file: typeof search.file === "string" ? search.file : undefined,
		from:
			search.from === "inbox" || search.from === "project-inbox"
				? search.from
				: undefined,
	}),
	component: ReviewRoute,
});

function ReviewRoute() {
	const { project, taskId } = Route.useParams();
	const { file, from } = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<ReviewPage
			key={`${project}:${taskId}`}
			project={project}
			taskId={taskId}
			origin={from}
			selectedFile={file}
			onSelectFile={(path) =>
				navigate({ search: () => ({ file: path, from }) })
			}
		/>
	);
}
