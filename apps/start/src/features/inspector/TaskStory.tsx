import { useInfiniteQuery } from "@tanstack/react-query";

import { Button } from "~/components/ui/button";
import { Empty } from "../../components/Empty";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { nodeRef } from "../../lib/nodeRef";
import type { TRPCProxy } from "../../lib/trpc";
import { useTRPC, useTRPCClient } from "../../lib/trpc";
import {
	groupByDay,
	newestFirst,
	StoryEntryView,
	type StoryPage,
} from "./story";

/** Entries per request; "load older" asks for the next page of this size. */
export const STORY_PAGE_SIZE = 50;

/**
 * The cache key of a task's Story pages. It extends the `node.story` query key
 * for `{project, ref}`, so `trpc.node.story.queryFilter({project, ref})`
 * (what the live channel invalidates) matches it.
 */
export function storyKey(
	trpc: TRPCProxy,
	project: string,
	taskId: string,
): readonly unknown[] {
	return [
		...trpc.node.story.queryKey({ project, ref: nodeRef.task(taskId) }),
		"pages",
	];
}

/** One page of the Story: the newest when `before` is absent, else the page ending just before that cursor. */
export function fetchStoryPage(
	client: {
		node: {
			story: {
				query: (input: {
					project: string;
					ref: string;
					before?: string;
					limit: number;
				}) => Promise<StoryPage>;
			};
		};
	},
	input: { project: string; taskId: string; before?: string },
): Promise<StoryPage> {
	return client.node.story.query({
		project: input.project,
		ref: nodeRef.task(input.taskId),
		...(input.before ? { before: input.before } : {}),
		limit: STORY_PAGE_SIZE,
	});
}

/**
 * The task inspector's Story tab: one chronological spine, newest first,
 * grouped by day, paged backwards by the API's cursor. The live channel
 * invalidates the key, which refetches every loaded page in order, so a new
 * entry never leaves a gap between pages.
 */
export function TaskStory({
	project,
	taskId,
}: {
	project: string;
	taskId: string;
}) {
	const trpc = useTRPC();
	const client = useTRPCClient();
	const story = useInfiniteQuery({
		queryKey: storyKey(trpc, project, taskId),
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) =>
			fetchStoryPage(client as never, {
				project,
				taskId,
				...(pageParam ? { before: pageParam } : {}),
			}),
		getNextPageParam: (last) => last.cursor ?? undefined,
	});

	if (story.isLoading) {
		return (
			<div className="p-3">
				<LoadingRows rows={6} />
			</div>
		);
	}
	if (story.error) {
		return (
			<div className="p-3">
				<ErrorState
					title="Could not load this task's story"
					error={story.error}
					onRetry={() => void story.refetch()}
				/>
			</div>
		);
	}

	const entries = newestFirst(story.data?.pages ?? []);
	if (entries.length === 0) {
		return (
			<Empty
				title="Nothing has happened yet"
				description="Runs, decisions and status moves for this task appear here as they happen."
			/>
		);
	}

	return (
		<section
			className="flex min-w-0 flex-col gap-3 p-3"
			aria-label="Task story"
		>
			{groupByDay(entries).map((group) => (
				<section key={group.day} className="flex min-w-0 flex-col">
					<h3
						className="mfw-num"
						style={{
							color: "var(--mfw-fg-faint)",
							fontSize: "var(--mfw-text-2xs)",
							letterSpacing: "0.06em",
						}}
					>
						{group.day}
					</h3>
					<ul className="flex flex-col gap-1">
						{group.entries.map((entry, i) => (
							<StoryEntryView
								// biome-ignore lint/suspicious/noArrayIndexKey: an entry has no id of its own; kind + time + position is stable within a page
								key={`${entry.kind}:${entry.at.getTime()}:${i}`}
								entry={entry}
								project={project}
							/>
						))}
					</ul>
				</section>
			))}
			{story.hasNextPage ? (
				<Button
					size="sm"
					variant="outline"
					className="self-start"
					disabled={story.isFetchingNextPage}
					onClick={() => void story.fetchNextPage()}
				>
					{story.isFetchingNextPage ? "Loading…" : "Load older"}
				</Button>
			) : null}
		</section>
	);
}
