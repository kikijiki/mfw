import { useQuery } from "@tanstack/react-query";

import { ErrorState, StaleWhenOffline } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { Page, PageHeader, Scroller } from "../../components/Page";
import { useTRPC } from "../../lib/trpc";
import { EscalationsPanel } from "../sessions/SessionCard";
import { Headlines } from "./Headlines";
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
	const headlines = useQuery(trpc.inbox.headlines.queryOptions());

	const items = inbox.data?.items ?? [];
	const runs = active.data ?? [];
	const escalations = sessions.data?.length ?? 0;
	// Only `act` items need you; the rest is worth knowing or already handled.
	const act = items.filter((i) => i.attention === "act").length;
	const know = items.filter((i) => i.attention === "know").length;
	const needs = act + escalations;

	return (
		<Page className="h-full">
			<PageHeader
				title="Home"
				meta={
					<span>
						<StaleWhenOffline>
							{needs === 0
								? "nothing needs you"
								: `${needs} need${needs === 1 ? "s" : ""} you`}
							{know > 0 ? ` · ${know} to read` : ""}
							{" · "}
							{runs.length === 0
								? "nothing running"
								: `${runs.length} agent${runs.length === 1 ? "" : "s"} live`}
						</StaleWhenOffline>
					</span>
				}
			/>
			<Scroller data-ui="home-grid" className="flex flex-col gap-6 p-3">
				{headlines.data && headlines.data.length > 0 ? (
					<section
						data-ui="home-projects"
						aria-label="Projects"
						className="flex flex-col gap-2"
					>
						<SectionHeading>Projects</SectionHeading>
						<Headlines headlines={headlines.data} />
					</section>
				) : null}

				<section
					id="needs-you"
					data-ui="home-needs"
					aria-label="Needs you"
					className="flex flex-col gap-2"
				>
					<SectionHeading tone="warn" count={act > 0 ? act : undefined}>
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
							grouped
						/>
					)}
					<EscalationsPanel />
				</section>

				<section
					data-ui="home-live"
					aria-label="Live"
					className="flex flex-col gap-2"
				>
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
