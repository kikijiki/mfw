import type { Digest, DigestEntry } from "@mfw/daemon/history";
import { useQuery } from "@tanstack/react-query";
import {
	ChevronDown,
	ChevronRight,
	CircleCheck,
	CircleX,
	Eye,
	GitMerge,
	History,
	type LucideIcon,
	MessageCircleQuestion,
	OctagonAlert,
	PauseCircle,
	Plus,
	Timer,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { AppLink } from "../../components/AppLink";
import { Empty } from "../../components/Empty";
import { ErrorState } from "../../components/ErrorState";
import { LoadingCards } from "../../components/Loading";
import { Chip, Page, PageHeader, Panel, Scroller } from "../../components/Page";
import { readSeenMap, writeSeenSeq } from "../../lib/seen";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import { ProjectEventFeed } from "./ProjectEventFeed";

/**
 * HISTORY: "what happened while I was away", prose first, breakdown second.
 *
 * Folding is server-side (`system.digest`) so a phone never pages thousands of
 * audit rows. The raw feed stays available per project (`ProjectEventFeed`) as
 * a disclosure, unfetched until opened. A project with nothing to report
 * renders nothing; a single zero-state covers the all-quiet case.
 */

const ENTRY_LOOK: Record<
	DigestEntry["kind"],
	{ icon: LucideIcon; token: string }
> = {
	done: { icon: CircleCheck, token: "--mfw-ok" },
	merged: { icon: GitMerge, token: "--mfw-ok" },
	blocked: { icon: PauseCircle, token: "--mfw-warn" },
	review: { icon: Eye, token: "--mfw-status-review" },
	failed: { icon: CircleX, token: "--mfw-critical" },
	created: { icon: Plus, token: "--mfw-info" },
	clarify: { icon: MessageCircleQuestion, token: "--mfw-warn" },
	main_red: { icon: OctagonAlert, token: "--mfw-critical" },
	rate_limited: { icon: Timer, token: "--mfw-warn" },
};

const ENTRY_LABEL: Record<DigestEntry["kind"], string> = {
	done: "completed",
	merged: "merged",
	blocked: "blocked",
	review: "waiting for review",
	failed: "runs failed",
	created: "tasks created",
	clarify: "questions raised",
	main_red: "main went red",
	rate_limited: "dispatch rate-limited",
};

export function HistoryPage() {
	const trpc = useTRPC();
	const projects = useQuery({
		...trpc.system.projects.queryOptions(),
		staleTime: 5 * 60_000,
	});
	// Stable key for the project set (query objects change identity more often).
	const nameKey = (projects.data ?? []).map((p) => p.name).join(",");

	// localStorage is client-only: start null so server and client match on first render.
	const [sinceSeq, setSinceSeq] = useState<Record<string, number> | null>(null);
	useEffect(() => {
		if (!nameKey) return;
		setSinceSeq(readSeenMap(nameKey.split(",")));
	}, [nameKey]);

	const digest = useQuery({
		...trpc.system.digest.queryOptions({ sinceSeq: sinceSeq ?? {} }),
		enabled: sinceSeq !== null,
	});

	const digests = digest.data?.digests ?? [];
	// Only projects that moved get a panel; the rest collapse to one line.
	const active = digests.filter((d) => d.entries.length > 0);
	const quiet = digests.length - active.length;
	const anything = active.length > 0;

	const catchUp = () => {
		const next: Record<string, number> = {};
		for (const d of digests) {
			writeSeenSeq(d.project, d.latestSeq);
			next[d.project] = d.latestSeq;
		}
		setSinceSeq((prev) => ({ ...(prev ?? {}), ...next }));
	};

	return (
		<Page className="h-full">
			<PageHeader
				title="History"
				meta={
					<span>
						Everything since you last marked this read, per project. The marker
						lives on this device.
					</span>
				}
				actions={
					<Button
						size="sm"
						variant="outline"
						disabled={!anything}
						onClick={catchUp}
						title="Advance the since-marker to now"
					>
						<CircleCheck aria-hidden /> Caught up
					</Button>
				}
			/>

			<Scroller className="flex flex-col gap-3 p-3">
				{projects.error ? (
					<ErrorState
						title="Could not list projects"
						error={projects.error}
						onRetry={() => void projects.refetch()}
					/>
				) : null}

				{digest.isLoading || sinceSeq === null ? (
					<LoadingCards cards={2} />
				) : digest.error ? (
					<ErrorState
						title="Could not build the digest"
						error={digest.error}
						onRetry={() => void digest.refetch()}
					/>
				) : digests.length === 0 ? (
					<Empty
						icon={History}
						title="No projects attached."
						description="Add a project to see its activity here."
					/>
				) : !anything ? (
					<Empty
						icon={CircleCheck}
						tone="success"
						title="Nothing happened since you were last here."
					/>
				) : (
					<>
						{active.map((d) => (
							<ProjectDigestPanel key={d.project} digest={d} />
						))}
						{quiet > 0 ? (
							<p
								className="px-1"
								style={{
									color: "var(--mfw-fg-faint)",
									fontSize: "var(--mfw-text-xs)",
								}}
							>
								{quiet === 1
									? "1 other project was quiet."
									: `${quiet} other projects were quiet.`}
							</p>
						) : null}
					</>
				)}
			</Scroller>
		</Page>
	);
}

/** One project's fold, with its audit trail behind a disclosure. */
function ProjectDigestPanel({ digest: d }: { digest: Digest }) {
	const [feedOpen, setFeedOpen] = useState(false);

	return (
		<Panel
			title={
				<span className="flex items-center gap-2">
					{d.project}
					{d.needsAttention ? <Chip tone="warn">needs attention</Chip> : null}
				</span>
			}
			actions={
				<span
					className="mfw-num"
					style={{
						color: "var(--mfw-fg-faint)",
						fontSize: "var(--mfw-text-2xs)",
					}}
				>
					seq {d.sinceSeq} → {d.latestSeq}
				</span>
			}
		>
			<p className="mb-2" style={{ lineHeight: "var(--mfw-leading-prose)" }}>
				{d.summary}
			</p>

			<ul className="flex flex-col gap-1">
				{d.entries.map((entry) => {
					const look = ENTRY_LOOK[entry.kind];
					const Icon = look.icon;
					return (
						<li
							key={entry.kind}
							className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1"
						>
							<Icon
								aria-hidden
								className="size-3.5 shrink-0 self-center"
								style={{ color: `var(${look.token})` }}
							/>
							<span className="mfw-num">{entry.count}</span>
							<span>{ENTRY_LABEL[entry.kind]}</span>
							{entry.detail ? (
								<span style={{ color: "var(--mfw-fg-muted)" }}>
									{entry.detail}
								</span>
							) : null}
							{entry.taskIds.length > 0 ? (
								<span className="flex min-w-0 flex-wrap gap-1">
									{entry.taskIds.slice(0, 8).map((id) => (
										<AppLink
											key={id}
											to={href.task(d.project, id)}
											className="mfw-num"
											style={{ color: "var(--mfw-accent)" }}
										>
											{id}
										</AppLink>
									))}
									{entry.taskIds.length > 8 ? (
										<span style={{ color: "var(--mfw-fg-faint)" }}>
											+{entry.taskIds.length - 8} more
										</span>
									) : null}
								</span>
							) : null}
						</li>
					);
				})}
			</ul>

			<div
				className="mt-3 flex flex-wrap items-center gap-2 border-t pt-2"
				style={{
					borderColor: "var(--mfw-border)",
					fontSize: "var(--mfw-text-xs)",
				}}
			>
				<Button size="xs" variant="ghost" asChild>
					<AppLink to={href.board(d.project)}>Board</AppLink>
				</Button>
				<Button size="xs" variant="ghost" asChild>
					<AppLink to={href.runs(d.project)}>Runs</AppLink>
				</Button>
				<Button size="xs" variant="ghost" asChild>
					<AppLink to={href.review(d.project)}>Review queue</AppLink>
				</Button>
				<Button
					size="xs"
					variant="ghost"
					aria-expanded={feedOpen}
					onClick={() => setFeedOpen((v) => !v)}
					title="The unfolded audit trail this digest was built from"
				>
					{feedOpen ? (
						<ChevronDown aria-hidden />
					) : (
						<ChevronRight aria-hidden />
					)}
					Raw events
				</Button>
			</div>

			{/* Unmounted while shut so the query starts with the disclosure. */}
			{feedOpen ? (
				<div className="mt-2">
					<ProjectEventFeed project={d.project} sinceSeq={d.sinceSeq} />
				</div>
			) : null}
		</Panel>
	);
}
