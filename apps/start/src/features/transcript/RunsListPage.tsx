import { useQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";

import { AppLink } from "../../components/AppLink";
import { Cost, Duration, Mono, Tokens } from "../../components/Cost";
import { Empty } from "../../components/Empty";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { Chip, Page, PageHeader, Scroller } from "../../components/Page";
import { RelativeTime } from "../../components/RelativeTime";
import { StatusPill } from "../../components/StatusPill";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";

/** Every run this project has made, newest first, the way into a transcript. */
export function RunsListPage({ project }: { project: string }) {
	const trpc = useTRPC();
	const runs = useQuery(
		trpc.runs.list.queryOptions({
			project,
			limit: 100,
			includeInternal: false,
		}),
	);
	const rows = runs.data ?? [];

	return (
		<Page className="h-full">
			{/* No title: the Runs tab above already says where you are. */}
			<PageHeader
				title="Runs"
				meta={<span>{rows.length} most recent agent sessions</span>}
			/>
			<Scroller className="p-3">
				{runs.isLoading ? (
					<LoadingRows rows={8} />
				) : runs.error ? (
					<ErrorState
						title="Could not load runs"
						error={runs.error}
						onRetry={() => void runs.refetch()}
					/>
				) : rows.length === 0 ? (
					<Empty
						icon={ScrollText}
						title="No runs yet."
						description="Nothing has been dispatched in this project."
					/>
				) : (
					<ul className="flex min-w-0 flex-col gap-2">
						{rows.map((run) => (
							<li
								key={run.id}
								className="grid min-w-0 grid-cols-1 items-center gap-x-3 gap-y-3 border p-3 lg:grid-cols-[minmax(0,1fr)_5.5rem_6.5rem_6.5rem] lg:gap-y-2"
								style={{
									borderColor: "var(--mfw-border)",
									borderRadius: "var(--mfw-radius-md)",
									background: "var(--mfw-bg-raised)",
								}}
							>
								<div className="flex min-w-0 flex-col gap-1.5">
									<div className="flex min-w-0 items-start gap-2">
										<StatusPill kind="run" value={run.state} />
										<div className="flex min-w-0 flex-1 flex-col items-start gap-x-2 gap-y-1 sm:flex-row sm:items-baseline">
											<AppLink
												to={href.run(project, run.id)}
												className="w-full min-w-0 truncate font-medium sm:w-auto sm:flex-1"
												title={primaryLabel(run)}
											>
												{primaryLabel(run)}
											</AppLink>
											{run.taskId ? (
												<AppLink
													to={href.task(project, run.taskId)}
													className="min-w-0 max-w-full truncate"
													title={`Task ${run.taskId}`}
												>
													<Mono value={run.taskId} className="block truncate" />
												</AppLink>
											) : null}
										</div>
									</div>
									<div
										className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
										style={{
											color: "var(--mfw-fg-muted)",
											fontSize: "var(--mfw-text-xs)",
										}}
									>
										{run.providerId ? (
											<Chip
												className="min-w-0 max-w-full truncate"
												title={run.providerId}
											>
												{run.providerId}
											</Chip>
										) : null}
										<span
											className="min-w-0 max-w-full truncate"
											title={run.model}
										>
											{run.model}
										</span>
										{run.reasoningEffort ? (
											<span>{run.reasoningEffort} effort</span>
										) : null}
										<span>{run.kind}</span>
										<span>attempt {run.attempt}</span>
										<RelativeTime value={run.startedAt} />
									</div>
								</div>
								<RunMetrics {...runMetricValues(run)} />
							</li>
						))}
					</ul>
				)}
			</Scroller>
		</Page>
	);
}

/** The compact values shown in every row, including explicit missing values. */
export function runMetricValues(run: {
	startedAt: Date;
	finishedAt: Date | null;
	usage: {
		inputTokens?: number | null;
		outputTokens?: number | null;
		costUsd?: number | null;
	} | null;
}) {
	return {
		durationMs: run.finishedAt
			? run.finishedAt.getTime() - run.startedAt.getTime()
			: null,
		tokens: run.usage
			? (run.usage.inputTokens ?? 0) + (run.usage.outputTokens ?? 0)
			: null,
		costUsd: run.usage?.costUsd ?? null,
	};
}

/** A labelled group on phones; the same three cells align as columns on desktop. */
function RunMetrics({
	durationMs,
	tokens,
	costUsd,
}: ReturnType<typeof runMetricValues>) {
	return (
		<dl
			aria-label="Run metrics"
			className="grid min-w-0 grid-cols-3 gap-2 border-t pt-2 lg:col-span-3 lg:grid-cols-[5.5rem_6.5rem_6.5rem] lg:gap-3 lg:border-t-0 lg:pt-0"
			style={{ borderColor: "var(--mfw-border)" }}
		>
			<div className="flex min-w-0 flex-col gap-0.5 lg:block">
				<dt className="truncate text-xs lg:sr-only">Duration</dt>
				<dd>
					<Duration
						className="block min-w-0 tabular-nums lg:text-right"
						ms={durationMs}
					/>
				</dd>
			</div>
			<div className="flex min-w-0 flex-col gap-0.5 lg:block">
				<dt className="truncate text-xs lg:sr-only">Tokens</dt>
				<dd>
					<Tokens
						className="block min-w-0 tabular-nums lg:text-right"
						count={tokens}
					/>
				</dd>
			</div>
			<div className="flex min-w-0 flex-col gap-0.5 lg:block">
				<dt className="truncate text-xs lg:sr-only">Cost</dt>
				<dd>
					<Cost
						className="block min-w-0 tabular-nums lg:text-right"
						usd={costUsd}
					/>
				</dd>
			</div>
		</dl>
	);
}

/**
 * What the row's flexible column should say.
 *
 * A task run's `label` IS its task id (`RunEngine.startTask` passes
 * `label: taskId`), and the id already has its own column, so falling back to
 * the label there would put the id on the row twice: the bug this replaces.
 * When a task run has no title yet, the run's own short id is at least
 * something the row does not already show.
 */
export function primaryLabel(run: {
	id: string;
	label: string;
	taskId: string | null;
	taskTitle: string | null;
}): string {
	if (run.taskTitle) return run.taskTitle;
	if (run.taskId && run.label === run.taskId) return run.id.slice(-8);
	return run.label;
}
