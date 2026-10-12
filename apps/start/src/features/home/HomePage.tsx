import { useQuery } from "@tanstack/react-query";

import { ErrorState, StaleWhenOffline } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { Page, PageHeader, Scroller } from "../../components/Page";
import { useTRPC } from "../../lib/trpc";
import { EscalationsPanel } from "../sessions/SessionCard";
import { LiveSection } from "./LiveSection";
import { NeedsQueue } from "./NeedsQueue";
import { SinceYouLeft } from "./SinceYouLeft";

/**
 * Home (`/`): three sections in one scroll, in this order. What needs you,
 * answerable in place; what is running, grouped project → task; and what
 * happened since you last marked it read.
 *
 * The needs list is `inbox.list` whole: the same number as the shell badge,
 * the tab title and the presence bar's popover.
 */
export function HomePage() {
	const trpc = useTRPC();
	const inbox = useQuery(trpc.inbox.list.queryOptions());
	const active = useQuery(trpc.runs.active.queryOptions());
	const sessions = useQuery(trpc.sessions.open.queryOptions());

	const items = inbox.data?.items ?? [];
	const runs = active.data ?? [];
	const escalations = sessions.data?.length ?? 0;

	return (
		<Page className="h-full">
			<PageHeader
				title="Home"
				meta={
					<span>
						<StaleWhenOffline>
							{items.length + escalations === 0
								? "nothing needs you"
								: `${items.length + escalations} need${items.length + escalations === 1 ? "s" : ""} you`}
							{" · "}
							{runs.length === 0
								? "nothing running"
								: `${runs.length} agent${runs.length === 1 ? "" : "s"} live`}
						</StaleWhenOffline>
					</span>
				}
			/>
			<Scroller className="flex flex-col gap-6 p-3">
				<section aria-label="Needs you" className="flex flex-col gap-2">
					<SectionHeading
						tone="warn"
						count={items.length > 0 ? items.length : undefined}
					>
						Needs you
					</SectionHeading>
					{inbox.isLoading ? (
						<LoadingRows rows={3} />
					) : inbox.error ? (
						<ErrorState
							title="Could not load what needs you"
							error={inbox.error}
							onRetry={() => void inbox.refetch()}
						/>
					) : (
						<NeedsQueue
							items={items}
							runs={active.data}
							// An escalation is also something that needs you.
							empty={escalations === 0}
						/>
					)}
					<EscalationsPanel />
				</section>

				<section aria-label="Live" className="flex flex-col gap-2">
					<SectionHeading count={runs.length > 0 ? runs.length : undefined}>
						Live
					</SectionHeading>
					{active.isLoading ? (
						<LoadingRows rows={2} />
					) : active.error ? (
						<ErrorState
							title="Could not load active runs"
							error={active.error}
							onRetry={() => void active.refetch()}
						/>
					) : (
						<LiveSection runs={runs} />
					)}
				</section>

				<SinceYouLeft />
			</Scroller>
		</Page>
	);
}

function SectionHeading({
	children,
	count,
	tone,
}: {
	children: string;
	count?: number;
	tone?: "warn";
}) {
	return (
		<h2
			className="flex items-center gap-2 uppercase"
			style={{
				color: tone === "warn" ? "var(--mfw-warn)" : "var(--mfw-fg-faint)",
				fontSize: "var(--mfw-text-2xs)",
				letterSpacing: "0.06em",
			}}
		>
			{children}
			{count !== undefined ? (
				<span style={{ color: "var(--mfw-fg-faint)" }}>{count}</span>
			) : null}
		</h2>
	);
}
