import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";

import { AppLink } from "../../components/AppLink";
import { Empty } from "../../components/Empty";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { useNow } from "../../components/RelativeTime";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import { NodeRow } from "../flow/NodeRow";
import { liveProjects, liveRows } from "./live";

/**
 * What is running, per project, as the same tree rows the Flow lens draws
 * (`flow.live`: live runs plus the epic and task above them). A row links to
 * that node in the project's Flow, inspector docked. The query is kept
 * current by the live channel's patches, so this opens no transcript and
 * polls nothing.
 */
export function LiveSection({
	runs,
}: {
	/** `runs.active`: which projects have live work, and how much. */
	runs: readonly { project: string }[];
}) {
	const projects = liveProjects(runs);
	if (projects.length === 0) {
		return (
			<Empty
				icon={Activity}
				className="py-4"
				title="Nothing is running."
				description="No agent is working right now."
			/>
		);
	}
	return (
		<ul className="m-0 flex list-none flex-col gap-3 p-0">
			{projects.map((p) => (
				<ProjectLive key={p.project} {...p} />
			))}
		</ul>
	);
}

function ProjectLive({
	project,
	runCount,
}: {
	project: string;
	runCount: number;
}) {
	const trpc = useTRPC();
	const now = useNow();
	const live = useQuery(trpc.flow.live.queryOptions({ project }));
	const rows = liveRows(live.data?.nodes, now);
	return (
		<li className="flex flex-col gap-1" data-live-project={project}>
			<div className="flex items-center gap-2">
				<AppLink to={href.flow(project)} className="font-medium no-underline">
					{project}
				</AppLink>
				<span
					style={{
						color: "var(--mfw-fg-faint)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					{runCount} live
				</span>
			</div>
			{live.isLoading ? (
				<LoadingRows rows={2} />
			) : live.error ? (
				<ErrorState
					title={`Could not load ${project}'s live work`}
					error={live.error}
					onRetry={() => void live.refetch()}
				/>
			) : (
				// NodeRow draws `role="listitem"` divs; a `ul` would make them invalid children.
				// biome-ignore lint/a11y/useSemanticElements: see above
				<div role="list" aria-label={`${project} live work`}>
					{rows.map((row) => (
						<NodeRow
							key={row.key}
							row={row}
							now={now}
							mode="list"
							{...(row.node
								? {
										to: href.flow(project, { node: row.node.ref }),
									}
								: {})}
						/>
					))}
				</div>
			)}
		</li>
	);
}
