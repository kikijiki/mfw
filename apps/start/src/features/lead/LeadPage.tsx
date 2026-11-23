import { useQuery } from "@tanstack/react-query";
import { Fragment } from "react";

import { AppLink } from "../../components/AppLink";
import { ErrorState, StaleWhenOffline } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { Chip, Page, PageHeader, Scroller } from "../../components/Page";
import { nodeRef } from "../../lib/nodeRef";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import { useBrainStates } from "../brain/BrainBadge";
import { BRAIN_OFF_HINT, brainLine } from "../brain/brain";
import { LiveSection } from "../home/LiveSection";
import { NeedsQueue } from "../home/NeedsQueue";
import { useInbox } from "../inbox/useInbox";
import { GiveDirection } from "./GiveDirection";
import {
	brainParagraph,
	drillLinks,
	headlineFor,
	intentSentence,
	leadTarget,
} from "./lead";

/**
 * Lead (`/p/$project/`): where you land in a project. In reading order: the
 * mechanical headline (one sentence, each number a link), then the brain's
 * paragraph and current intent (labelled as the brain's words), what needs
 * you, and what is running. Board, Flow, docs and the rest are one click
 * away and never required.
 *
 * Everything shares a query with the screen it points at: the headline is
 * `inbox.headlines`, the needs are `inbox.list` through `useInbox`, so a
 * number here cannot disagree with its list. The layout is one column that
 * grows to two on a wide screen.
 */
export function LeadPage({ project }: { project: string }) {
	const trpc = useTRPC();
	const headlines = useQuery(trpc.inbox.headlines.queryOptions());
	const inbox = useInbox(project);
	const active = useQuery(trpc.runs.active.queryOptions());
	const brains = useBrainStates();
	const plan = useQuery(
		trpc.brain.decisions.queryOptions({ project, kind: "plan", limit: 1 }),
	);
	const intents = useQuery(trpc.brain.intents.queryOptions({ project }));

	const headline = headlineFor(headlines.data, project);
	const runs = (active.data ?? []).filter((r) => r.project === project);
	const items = inbox.items;
	const act = items.filter((i) => i.attention === "act").length;
	const brain = brains.get(project);
	const paragraph = brainParagraph(plan.data?.[0]?.reason);
	const intent = intentSentence(intents.data);

	return (
		<Page className="h-full">
			<PageHeader
				title="Lead"
				meta={
					<StaleWhenOffline>
						{act === 0
							? "nothing needs you"
							: `${act} need${act === 1 ? "s" : ""} you`}
						{" · "}
						{runs.length === 0
							? "nothing running"
							: `${runs.length} agent${runs.length === 1 ? "" : "s"} live`}
					</StaleWhenOffline>
				}
			/>
			<Scroller className="flex flex-col gap-6 p-3">
				<section
					aria-label="Headline"
					data-lead-headline={project}
					style={{ fontSize: "var(--mfw-text-md)" }}
				>
					{headlines.isLoading ? (
						<LoadingRows rows={1} />
					) : headline ? (
						<p className="m-0">
							{headline.parts.map((p, i) => (
								<Fragment key={p.key}>
									{i === 0 ? "" : i === 1 ? ", " : "; "}
									<AppLink to={leadTarget(project, p.link)}>{p.text}</AppLink>
								</Fragment>
							))}
						</p>
					) : (
						<p className="m-0" style={{ color: "var(--mfw-fg-muted)" }}>
							No headline yet.
						</p>
					)}
				</section>

				<div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
					<section
						aria-label="The brain"
						className="flex min-w-0 flex-col gap-2"
					>
						<SectionHeading>Tech lead</SectionHeading>
						{plan.isLoading ? (
							<LoadingRows rows={2} />
						) : plan.error ? (
							<ErrorState
								title="Could not load the brain's plan"
								error={plan.error}
								onRetry={() => void plan.refetch()}
							/>
						) : paragraph ? (
							<div className="flex flex-col gap-1">
								<p
									data-testid="brain-paragraph"
									className="m-0 whitespace-pre-wrap"
								>
									{paragraph.text}
								</p>
								<span
									className="flex flex-wrap items-center gap-2"
									style={{
										color: "var(--mfw-fg-faint)",
										fontSize: "var(--mfw-text-xs)",
									}}
								>
									<Chip
										tone="accent"
										title="The brain's own interpretation, not a host-observed fact"
									>
										brain's words
									</Chip>
									{paragraph.clipped ? (
										<AppLink to={href.flow(project, { node: nodeRef.brain() })}>
											Read the full plan
										</AppLink>
									) : null}
								</span>
							</div>
						) : (
							<p className="m-0" style={{ color: "var(--mfw-fg-muted)" }}>
								{brain && !brain.enabled
									? BRAIN_OFF_HINT
									: "The brain has not written a plan yet."}
							</p>
						)}
						{intent ? (
							<p
								data-testid="brain-intent-line"
								className="m-0"
								style={{ color: "var(--mfw-accent)" }}
							>
								<AppLink
									to={href.board(project, {
										node: nodeRef.task(intent.taskId),
									})}
								>
									{intent.text}
								</AppLink>
								{intent.proposed ? " (proposed: the pipeline acts)" : ""}
								{intent.more > 0 ? ` · +${intent.more} more` : ""}
							</p>
						) : null}
						{brain?.enabled ? (
							<p
								className="m-0"
								style={{
									color: "var(--mfw-fg-faint)",
									fontSize: "var(--mfw-text-xs)",
								}}
							>
								{brainLine(brain)}
							</p>
						) : null}
						<GiveDirection
							project={project}
							brainOff={brain ? !brain.enabled : false}
						/>
					</section>

					<section
						id="needs-you"
						aria-label="Needs you"
						className="flex min-w-0 flex-col gap-2"
					>
						<SectionHeading tone="warn" count={act > 0 ? act : undefined}>
							Needs you
						</SectionHeading>
						{inbox.query.isLoading ? (
							<LoadingRows rows={3} />
						) : inbox.query.error ? (
							<ErrorState
								title="Could not load what needs you"
								error={inbox.query.error}
								onRetry={() => void inbox.query.refetch()}
							/>
						) : (
							<NeedsQueue items={items} runs={active.data} grouped />
						)}
					</section>
				</div>

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

				<nav
					aria-label="Drill down"
					className="flex flex-wrap items-center gap-x-4 gap-y-2"
				>
					<SectionHeading>Drill down</SectionHeading>
					{drillLinks(project).map((l) => (
						<AppLink
							key={l.label}
							to={l.to}
							className="min-h-8 inline-flex items-center"
						>
							{l.label}
						</AppLink>
					))}
				</nav>
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
			className="m-0 flex items-center gap-2 uppercase"
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
