import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import { AppLink } from "../../components/AppLink";
import { AgentChip } from "../../components/agent/AgentChip";
import { HistoryPips, type Pip } from "../../components/agent/HistoryPips";
import { lookForRun, PIP_LOOK } from "../../components/agent/look";
import { StateGlyph } from "../../components/agent/StateGlyph";
import type { GlyphName } from "../../components/icons";
import type { RunState } from "../../components/StatusPill";
import {
	activityExplanation,
	asActivityDetail,
	shownActivity,
} from "../agents/activity";
import type { CardRun } from "./boardAgents";
import { type OutcomeDetail, outcomeTail } from "./CardSubtree";

/**
 * The agent strip of a board card (design §6.2): one chip per live run
 * (activity, harness, short model, age; a compete mark when attempts compete), else the
 * last outcome line; then the history pips. A task that never ran has no
 * strip at all, so its card stays two lines.
 */

/** The last settled run, as a line: `verified · 3 runs` (the icon is the pip's). Null when nothing ever settled. */
export function lastOutcome(
	pips: readonly Pip[],
	detail?: OutcomeDetail | null,
	now?: number,
): { glyph: GlyphName; label: string; token: string; line: string } | null {
	const last = pips[pips.length - 1];
	if (!last) return null;
	const look = PIP_LOOK[last.glyph] ?? PIP_LOOK.stopped;
	const n = pips.length;
	return {
		glyph: look.glyph,
		label: look.label,
		token: look.token,
		line: `${look.label} · ${n} ${n === 1 ? "run" : "runs"}${detail ? ` · ${outcomeTail(detail, now)}` : ""}`,
	};
}

export function CardAgentStrip({
	runs,
	pips,
	isDraft,
	runHref,
	onSelectPip,
	scope,
	outcomeDetail,
	compact = false,
}: {
	runs: readonly CardRun[];
	pips: readonly Pip[];
	/** A draft's live run is its expansion. */
	isDraft: boolean;
	runHref: (runId: string) => string;
	onSelectPip?: (ref: string) => void;
	scope?: ReactNode;
	/** When, which model and what cost of the last settled run, where known (the expanded card reads them from its story). */
	outcomeDetail?: OutcomeDetail | null;
	/** One line that never wraps (the lanes layout's fixed-height tile): chips, then pips, clipped at the edge. */
	compact?: boolean;
}) {
	if (runs.length === 0 && pips.length === 0) return null;
	const outcome = runs.length === 0 ? lastOutcome(pips, outcomeDetail) : null;
	const competing = runs.length > 1;
	return (
		<div
			data-testid="card-agent-strip"
			className={
				compact
					? "flex min-w-0 flex-nowrap items-center gap-x-2 overflow-hidden whitespace-nowrap"
					: "flex flex-col gap-1"
			}
			style={{ fontSize: "var(--mfw-text-xs)" }}
		>
			{runs.length > 0 ? (
				<div
					className={cn(
						"flex items-center gap-x-2",
						compact ? "flex-nowrap" : "flex-wrap gap-y-1",
					)}
				>
					{runs.map((run) => {
						const activity = shownActivity(run);
						const look = lookForRun({
							state: run.state as RunState,
							activity,
						});
						return (
							<AppLink
								key={run.runId}
								to={runHref(run.runId)}
								draggable={false}
								title={
									activity
										? `${activityExplanation(activity, asActivityDetail(run.activityDetail))} Open the agent.`
										: "Open the agent working on this task"
								}
								className={cn(
									"inline-flex items-center gap-1 no-underline",
									look.ring && "font-medium",
								)}
							>
								<AgentChip
									look={look}
									harness={run.providerId ?? "agent"}
									model={run.model}
									startedAt={run.startedAt}
									competing={competing}
									costUsd={run.liveCostUsd ?? null}
								/>
								{isDraft ? (
									<span style={{ color: "var(--mfw-fg-muted)" }}>
										expanding
									</span>
								) : null}
							</AppLink>
						);
					})}
					{scope}
				</div>
			) : outcome ? (
				<span
					className="inline-flex items-center gap-1"
					style={{ color: "var(--mfw-fg-muted)" }}
				>
					<StateGlyph
						subject={{
							kind: "pip",
							value: pips[pips.length - 1]?.glyph ?? "stopped",
						}}
					/>
					{outcome.line}
				</span>
			) : null}
			{pips.length > 0 ? (
				<HistoryPips pips={pips} onSelect={onSelectPip} />
			) : null}
		</div>
	);
}
