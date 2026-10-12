import { useQuery } from "@tanstack/react-query";

import { Empty } from "../../components/Empty";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { Chip, Panel } from "../../components/Page";
import type { RouterOutputs } from "../../lib/trpc";
import { useTRPC } from "../../lib/trpc";

/**
 * Reviewer verdicts on one task: the closed vocabulary (merge, fix, reject),
 * which reviewer gave each and in which round, and the findings a `fix`
 * handed to the repair run. Shared by the review page and the task page.
 */

type Verdict = RouterOutputs["review"]["verdicts"]["verdicts"][number];

const VERDICT_TONE: Record<Verdict["verdict"], "ok" | "warn" | "critical"> = {
	merge: "ok",
	fix: "warn",
	reject: "critical",
};

const VERDICT_HINT: Record<Verdict["verdict"], string> = {
	merge: "The reviewer found the change ready to land",
	fix: "The reviewer asked for changes; a repair run received the findings",
	reject: "The reviewer found the approach wrong or the work faked",
};

/** A verdict as a chip, with its round when known. */
export function VerdictChip({
	verdict,
	round,
}: {
	verdict: Verdict["verdict"];
	round?: number | null;
}) {
	return (
		<Chip tone={VERDICT_TONE[verdict]} title={VERDICT_HINT[verdict]}>
			{verdict}
			{round ? ` · r${round}` : ""}
		</Chip>
	);
}

/** The latest verdict per task in a project; one shared query for every card. */
export function useLatestVerdicts(project: string) {
	const trpc = useTRPC();
	return useQuery({
		...trpc.review.latestVerdicts.queryOptions({ project }),
		staleTime: 15_000,
	});
}

export function VerdictHistory({
	project,
	taskId,
}: {
	project: string;
	taskId: string;
}) {
	const trpc = useTRPC();
	const q = useQuery(trpc.review.verdicts.queryOptions({ project, taskId }));
	const title = q.data
		? `Review verdicts · round ${q.data.round} of ${q.data.maxRounds}`
		: "Review verdicts";
	return (
		<Panel title={title}>
			{q.isLoading ? (
				<LoadingRows rows={2} />
			) : q.error ? (
				<ErrorState
					title="Could not load the review verdicts"
					error={q.error}
					onRetry={() => void q.refetch()}
				/>
			) : !q.data || q.data.verdicts.length === 0 ? (
				<Empty title="No reviewer verdicts yet" />
			) : (
				<ol className="flex flex-col gap-2">
					{[...q.data.verdicts].reverse().map((v) => (
						<li key={v.id} className="flex flex-col gap-0.5">
							<span className="flex flex-wrap items-center gap-1.5">
								<VerdictChip verdict={v.verdict} round={v.round} />
								<Chip>{v.mode}</Chip>
								<span className="mfw-num min-w-0 truncate">
									{v.reviewerModel ?? "unknown reviewer"}
								</span>
								{v.independent === false ? (
									<Chip
										tone="warn"
										title="Same model and harness as the worker"
									>
										not independent
									</Chip>
								) : null}
								<span
									className="flex-1 text-right"
									style={{ color: "var(--mfw-fg-faint)" }}
								>
									{new Date(v.createdAt).toLocaleString()}
								</span>
							</span>
							{v.findings.length > 0 ? (
								<ul className="flex flex-col gap-0.5 pl-2">
									{v.findings.map((f) => (
										<li
											key={`${f.file}:${f.line ?? ""}:${f.severity}:${f.change}`}
											className="flex items-start gap-1.5"
										>
											<Chip
												tone={
													f.severity === "blocker"
														? "critical"
														: f.severity === "major"
															? "warn"
															: "neutral"
												}
											>
												{f.severity}
											</Chip>
											<span className="min-w-0 flex-1">
												{f.file ? (
													<span className="mfw-num">
														{f.file}
														{f.line ? `:${f.line}` : ""}{" "}
													</span>
												) : null}
												<span style={{ color: "var(--mfw-fg-muted)" }}>
													{f.change}
												</span>
											</span>
										</li>
									))}
								</ul>
							) : null}
						</li>
					))}
				</ol>
			)}
		</Panel>
	);
}
