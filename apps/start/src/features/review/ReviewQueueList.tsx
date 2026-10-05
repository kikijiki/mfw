import { useQuery } from "@tanstack/react-query";
import { CircleCheck, GitMerge } from "lucide-react";
import { useMemo } from "react";

import { Button } from "~/components/ui/button";
import { AppLink } from "../../components/AppLink";
import { Mono } from "../../components/Cost";
import { Empty } from "../../components/Empty";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { Page, PageHeader, Panel, Scroller } from "../../components/Page";
import { RelativeTime } from "../../components/RelativeTime";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";

/** How far back "recently merged" reaches, enough to browse work that
 *  skipped review entirely without turning this into an unbounded history. */
const RECENT_MERGED_LIMIT = 20;

/**
 * The project's review queue: the list `[` / `]` walks on the judgement screen,
 * and the landing spot for "← Review queue".
 *
 * Work that merged without a review gate (project default or "no review"
 * opt-out) is reachable via the "Recently merged" panel (MFW-40).
 */
export function ReviewQueueList({ project }: { project: string }) {
	const trpc = useTRPC();
	const tasks = useQuery(
		trpc.tasks.list.queryOptions({ project, status: "review" }),
	);
	// A task in `review` whose branch is already queued or mid-merge has
	// nothing left to decide (MFW-50), split it out rather than offering it
	// alongside tasks that are genuinely waiting.
	const activeMerges = useQuery(
		trpc.review.activeMerges.queryOptions({ project }),
	);
	const mergeStateByTask = useMemo(
		() => new Map((activeMerges.data ?? []).map((m) => [m.taskId, m.state])),
		[activeMerges.data],
	);
	const allRows = tasks.data ?? [];
	const rows = useMemo(
		() => allRows.filter((t) => !mergeStateByTask.has(t.id)),
		[allRows, mergeStateByTask],
	);
	const mergingRows = useMemo(
		() => allRows.filter((t) => mergeStateByTask.has(t.id)),
		[allRows, mergeStateByTask],
	);

	const merged = useQuery(
		trpc.tasks.list.queryOptions({ project, status: "done" }),
	);
	const mergedRows = useMemo(
		() =>
			[...(merged.data ?? [])]
				.sort(
					(a, b) =>
						new Date(b.statusChangedAt).getTime() -
						new Date(a.statusChangedAt).getTime(),
				)
				.slice(0, RECENT_MERGED_LIMIT),
		[merged.data],
	);

	return (
		<Page className="h-full">
			{/* No title: the Review tab above already says where you are. */}
			<PageHeader
				meta={<span>{rows.length} waiting on a human decision</span>}
			/>
			<Scroller className="flex flex-col gap-4 p-3">
				{tasks.isLoading ? (
					<LoadingRows rows={4} />
				) : tasks.error ? (
					<ErrorState
						title="Could not load the queue"
						error={tasks.error}
						onRetry={() => void tasks.refetch()}
					/>
				) : rows.length === 0 ? (
					<Empty
						icon={CircleCheck}
						tone="success"
						title="Nothing waiting for review."
						description="Every finished attempt in this project has already been judged."
					/>
				) : (
					<ul className="flex flex-col gap-1">
						{rows.map((task) => (
							<li
								key={task.id}
								className="flex min-h-11 flex-wrap items-center gap-2 border p-2"
								style={{
									borderColor: "var(--mfw-border)",
									borderRadius: "var(--mfw-radius-md)",
									background: "var(--mfw-bg-raised)",
								}}
							>
								<Mono value={task.id} />
								<AppLink
									to={href.reviewTask(project, task.id)}
									className="min-w-0 flex-1 truncate font-medium"
								>
									{task.title}
								</AppLink>
								<span
									style={{
										color: "var(--mfw-fg-faint)",
										fontSize: "var(--mfw-text-xs)",
									}}
								>
									waiting <RelativeTime value={task.statusChangedAt} />
								</span>
								<Button size="sm" variant="outline" asChild>
									<AppLink to={href.reviewTask(project, task.id)}>
										Open review
									</AppLink>
								</Button>
							</li>
						))}
					</ul>
				)}

				{mergingRows.length > 0 ? (
					<Panel title={`Merging (${mergingRows.length})`} pad={false}>
						<ul className="flex flex-col gap-1 p-2">
							{mergingRows.map((task) => (
								<li
									key={task.id}
									className="flex min-h-9 flex-wrap items-center gap-2"
								>
									<GitMerge
										aria-hidden
										className="size-3.5 shrink-0"
										style={{ color: "var(--mfw-fg-muted)" }}
									/>
									<Mono value={task.id} />
									<AppLink
										to={href.reviewTask(project, task.id)}
										className="min-w-0 flex-1 truncate"
									>
										{task.title}
									</AppLink>
									<span
										style={{
											color: "var(--mfw-fg-faint)",
											fontSize: "var(--mfw-text-xs)",
										}}
									>
										{mergeStateByTask.get(task.id)}
									</span>
									<Button size="sm" variant="ghost" asChild>
										<AppLink to={href.reviewTask(project, task.id)}>
											View
										</AppLink>
									</Button>
								</li>
							))}
						</ul>
					</Panel>
				) : null}

				<Panel title="Recently merged" pad={false}>
					{merged.isLoading ? (
						<div className="p-2">
							<LoadingRows rows={3} />
						</div>
					) : merged.error ? (
						<div className="p-2">
							<ErrorState
								title="Could not load merged tasks"
								error={merged.error}
								onRetry={() => void merged.refetch()}
							/>
						</div>
					) : mergedRows.length === 0 ? (
						<p className="p-2" style={{ color: "var(--mfw-fg-faint)" }}>
							Nothing has merged yet.
						</p>
					) : (
						<ul className="flex flex-col gap-1 p-2">
							{mergedRows.map((task) => (
								<li
									key={task.id}
									className="flex min-h-9 flex-wrap items-center gap-2"
								>
									<Mono value={task.id} />
									<AppLink
										to={href.reviewTask(project, task.id)}
										className="min-w-0 flex-1 truncate"
									>
										{task.title}
									</AppLink>
									<span
										style={{
											color: "var(--mfw-fg-faint)",
											fontSize: "var(--mfw-text-xs)",
										}}
									>
										merged <RelativeTime value={task.statusChangedAt} />
									</span>
									<Button size="sm" variant="ghost" asChild>
										<AppLink to={href.reviewTask(project, task.id)}>
											View diff
										</AppLink>
									</Button>
								</li>
							))}
						</ul>
					)}
				</Panel>
			</Scroller>
		</Page>
	);
}
