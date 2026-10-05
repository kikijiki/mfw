import { useInfiniteQuery } from "@tanstack/react-query";

import { Button } from "~/components/ui/button";
import { AppLink } from "../../components/AppLink";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { RelativeTime } from "../../components/RelativeTime";
import { summarizePayload } from "../../lib/format";
import { useTRPCClient } from "../../lib/trpc";
import { href } from "../../routes";

/**
 * The raw audit trail under one project's digest. Mounted only when the
 * disclosure is open, so History does not fetch a page per project on render.
 *
 * Paging goes backwards (`beforeSeq`): new rows take higher seqs, so walking
 * down from a fixed cursor never skips or repeats. `cursor.nextBeforeSeq` is
 * null at the end of the log.
 *
 * `events.list` takes `beforeSeq`, not `cursor`, so the tRPC proxy's
 * `infiniteQueryOptions` does not apply; pages come from the vanilla client.
 */

const PAGE_SIZE = 50;

export function ProjectEventFeed({
	project,
	sinceSeq,
}: {
	project: string;
	/** The read-marker this digest was built from; rows above it are new. */
	sinceSeq: number;
}) {
	const client = useTRPCClient();

	const feed = useInfiniteQuery({
		// Not a tRPC proxy key, so it cannot collide with plain `events.list`.
		queryKey: ["history", "eventFeed", project],
		queryFn: ({ pageParam }) =>
			client.events.list.query({
				project,
				limit: PAGE_SIZE,
				...(pageParam === undefined ? {} : { beforeSeq: pageParam }),
			}),
		initialPageParam: undefined as number | undefined,
		getNextPageParam: (last) => last.cursor.nextBeforeSeq ?? undefined,
	});

	if (feed.isPending) return <LoadingRows rows={5} />;
	if (feed.error) {
		return (
			<ErrorState
				title="Could not load the event feed"
				error={feed.error}
				onRetry={() => void feed.refetch()}
			/>
		);
	}

	const events = feed.data.pages.flatMap((p) => p.events);
	if (events.length === 0) {
		return (
			<p style={{ color: "var(--mfw-fg-faint)" }}>
				This project has not recorded an event yet.
			</p>
		);
	}

	// Newest first: the read-marker goes after the last newer row, but only once
	// an older row is loaded; otherwise the boundary is further down the log.
	const lastNew = events.findLastIndex((e) => e.seq > sinceSeq);
	const marker = lastNew >= 0 && lastNew < events.length - 1 ? lastNew : -1;

	return (
		<div className="flex flex-col gap-2">
			<ul className="flex flex-col gap-1">
				{events.map((event, i) => {
					// Not every union member has `taskId` (e.g. quarantined files).
					const taskId = "taskId" in event ? event.taskId : undefined;
					return (
						<li key={event.seq} className="flex flex-col">
							<span className="flex min-w-0 items-baseline gap-2">
								<span
									className="mfw-num shrink-0"
									style={{
										color: "var(--mfw-fg-faint)",
										fontSize: "var(--mfw-text-2xs)",
									}}
								>
									<RelativeTime value={event.ts} />
								</span>
								<span className="mfw-num min-w-0 flex-1 break-words">
									{event.type}
									{taskId ? (
										<>
											{" "}
											<AppLink
												to={href.task(project, taskId)}
												style={{ color: "var(--mfw-accent)" }}
											>
												{taskId}
											</AppLink>
										</>
									) : null}
									{summarizePayload(event.payload)}
								</span>
							</span>
							{i === marker ? (
								<span
									className="mt-1 mb-0.5 flex items-center gap-2"
									style={{
										color: "var(--mfw-fg-faint)",
										fontSize: "var(--mfw-text-2xs)",
									}}
								>
									<span
										className="h-px flex-1"
										style={{ background: "var(--mfw-border)" }}
									/>
									<span className="mfw-num">read up to seq {sinceSeq}</span>
									<span
										className="h-px flex-1"
										style={{ background: "var(--mfw-border)" }}
									/>
								</span>
							) : null}
						</li>
					);
				})}
			</ul>

			<div className="flex items-center gap-2">
				{feed.hasNextPage ? (
					<Button
						size="xs"
						variant="outline"
						disabled={feed.isFetchingNextPage}
						onClick={() => void feed.fetchNextPage()}
					>
						{feed.isFetchingNextPage ? "Loading…" : "Older events"}
					</Button>
				) : (
					<span
						style={{
							color: "var(--mfw-fg-faint)",
							fontSize: "var(--mfw-text-2xs)",
						}}
					>
						Beginning of the log.
					</span>
				)}
				<span
					className="mfw-num"
					style={{
						color: "var(--mfw-fg-faint)",
						fontSize: "var(--mfw-text-2xs)",
					}}
				>
					{events.length} shown
				</span>
			</div>
		</div>
	);
}
