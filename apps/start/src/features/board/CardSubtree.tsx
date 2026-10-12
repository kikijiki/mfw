import { useQuery } from "@tanstack/react-query";
import { Send, Square } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { TipP } from "~/components/ui/tooltip";
import { AppLink } from "../../components/AppLink";
import { HarnessBadge } from "../../components/agent/HarnessBadge";
import { lookForRun, shortModel } from "../../components/agent/look";
import { StateGlyph } from "../../components/agent/StateGlyph";
import { Glyph } from "../../components/icons";
import {
	formatCost,
	formatDuration,
	formatRelative,
	humanizeToken,
} from "../../lib/format";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import { StopRunDialog, useRunControls } from "../agents/useRunControls";
import {
	isLiveRun,
	type StoryEntry,
	type StoryRunEntry,
} from "../inspector/story";

/**
 * A card expanded in place (design §6.3): the task's runs nested by lineage
 * (a repair/resume/answer run sits under the run whose worktree it
 * continues), each live one with steer and stop through `useRunControls`.
 *
 * Data is `node.story` for ONE task, read only while the card is expanded, so
 * a board of collapsed cards adds no observers. No transcript stream is ever
 * opened from here: the "last" line is the story's own `lastLine`, and the
 * run's console is one link away.
 */

/** How many top-level story entries the card asks for. */
export const SUBTREE_LIMIT = 20;

/** What the card's outcome line shows about the last settled run. */
export interface OutcomeDetail {
	/** When it ended (or started, if it never recorded an end). */
	at: Date;
	model: string | null;
	costUsd: number | null;
	state: string;
}

type DecisionEntry = Extract<StoryEntry, { kind: "decision" }>;

/**
 * The task's top-level runs: plain run entries plus the attempts of each
 * competing group (a group nests its attempts, so a card that read only
 * `kind === "run"` would lose them).
 */
export function topRuns(entries: readonly StoryEntry[]): StoryRunEntry[] {
	return entries.flatMap((e) =>
		e.kind === "run" ? [e] : e.kind === "group" ? e.attempts : [],
	);
}

/** Every run in the lineage, parents before their children. */
export function flattenRuns(runs: readonly StoryRunEntry[]): StoryRunEntry[] {
	return runs.flatMap((r) => [r, ...flattenRuns(r.children)]);
}

/** The most recently started run that has settled, or null. */
export function lastSettled(
	entries: readonly StoryEntry[],
): OutcomeDetail | null {
	const runs = flattenRuns(topRuns(entries)).filter(
		(r) => !isLiveRun(r.summary.state),
	);
	let best: StoryRunEntry | null = null;
	for (const r of runs) {
		if (!best || r.summary.startedAt > best.summary.startedAt) best = r;
	}
	if (!best) return null;
	return {
		at: best.summary.finishedAt ?? best.summary.startedAt,
		model: best.summary.model || null,
		costUsd: best.summary.costUsd,
		state: best.summary.state,
	};
}

/**
 * The brain's standing intent for this task: the newest decision about it,
 * but only when it is newer than the newest run (otherwise the run already
 * acted on it and the decision is history).
 */
export function pendingIntent(
	entries: readonly StoryEntry[],
): DecisionEntry | null {
	let decision: DecisionEntry | null = null;
	for (const e of entries) {
		if (e.kind === "decision" && (!decision || e.at > decision.at))
			decision = e;
	}
	if (!decision) return null;
	const runs = flattenRuns(topRuns(entries));
	const latestRun = runs.reduce<number>(
		(max, r) => Math.max(max, r.summary.startedAt.getTime()),
		Number.NEGATIVE_INFINITY,
	);
	return decision.at.getTime() > latestRun ? decision : null;
}

/** The "last outcome" tail: `2h ago · opus · $0.62`, only the parts that exist. */
export function outcomeTail(detail: OutcomeDetail, now?: number): string {
	const parts = [formatRelative(detail.at, now)];
	if (detail.model) parts.push(shortModel(detail.model));
	if (detail.costUsd != null) parts.push(formatCost(detail.costUsd));
	return parts.join(" · ");
}

/** Space on the focused card itself (not on a control inside it) toggles it. */
export function isCardToggleKey(event: {
	key: string;
	target: unknown;
	currentTarget: unknown;
	repeat?: boolean;
	altKey?: boolean;
	ctrlKey?: boolean;
	metaKey?: boolean;
}): boolean {
	return (
		(event.key === " " || event.key === "Spacebar") &&
		event.target === event.currentTarget &&
		!event.repeat &&
		!event.altKey &&
		!event.ctrlKey &&
		!event.metaKey
	);
}

const muted = { color: "var(--mfw-fg-muted)" } as const;
const small = { fontSize: "var(--mfw-text-xs)" } as const;

export function CardSubtree({
	project,
	taskId,
	onOutcome,
}: {
	project: string;
	taskId: string;
	/** Reports the last settled run so the card's outcome line can say when, which model and what it cost. */
	onOutcome?: (detail: OutcomeDetail | null) => void;
}) {
	const trpc = useTRPC();
	const story = useQuery(
		trpc.node.story.queryOptions({
			project,
			ref: `task:${taskId}`,
			limit: SUBTREE_LIMIT,
			filter: { kinds: ["run", "group", "decision"] },
		}),
	);
	const entries = story.data?.entries;
	useEffect(() => {
		if (entries) onOutcome?.(lastSettled(entries));
	}, [entries, onOutcome]);

	if (story.isLoading) {
		return (
			<p style={{ ...muted, ...small }} data-testid="card-subtree">
				Loading runs…
			</p>
		);
	}
	if (story.error || !entries) {
		return (
			<p
				role="alert"
				style={{ color: "var(--mfw-critical)", ...small }}
				data-testid="card-subtree"
			>
				Could not load this task's runs.
			</p>
		);
	}
	const runs = topRuns(entries).sort((a, b) => b.at.getTime() - a.at.getTime());
	const intent = pendingIntent(entries);
	return (
		<div
			data-testid="card-subtree"
			className="flex flex-col gap-1.5 border-t pt-1.5"
			style={{ borderColor: "var(--mfw-border)" }}
		>
			{intent ? (
				<TipP
					data-testid="brain-intent"
					className="min-w-0 truncate"
					style={{ ...small, color: "var(--mfw-accent)" }}
					tip={intent.rationale}
					clipped
				>
					<Glyph
						name="diamond"
						label="brain"
						className="mr-1 inline size-3 align-[-2px]"
					/>
					brain: {humanizeToken(intent.tool)}
					{intent.rationale ? ` · "${intent.rationale}"` : ""}
				</TipP>
			) : null}
			{runs.length === 0 ? (
				<p style={{ ...muted, ...small }}>No runs yet.</p>
			) : (
				<ul className="flex flex-col gap-1.5">
					{runs.map((run) => (
						<SubtreeRun key={run.ref} entry={run} project={project} depth={0} />
					))}
				</ul>
			)}
			<div className="flex gap-2" style={small}>
				<AppLink to={href.board(project, { node: `task:${taskId}` })}>
					inspect
				</AppLink>
			</div>
		</div>
	);
}

function SubtreeRun({
	entry,
	project,
	depth,
}: {
	entry: StoryRunEntry;
	project: string;
	depth: number;
}) {
	const { summary } = entry;
	const runId = entry.ref.replace(/^run:/, "");
	const live = isLiveRun(summary.state);
	const look = lookForRun({
		state: summary.state as never,
		activity: summary.activity,
	});
	const ms =
		(summary.finishedAt ?? new Date()).getTime() - summary.startedAt.getTime();
	return (
		<li
			data-run={runId}
			data-depth={depth}
			className="flex min-w-0 flex-col gap-0.5 border-l pl-2"
			style={{ borderColor: live ? "var(--mfw-accent)" : "var(--mfw-border)" }}
		>
			<div
				className="flex min-w-0 flex-wrap items-center gap-x-1.5"
				style={small}
			>
				<StateGlyph look={look} showLabel />
				{summary.harness ? <HarnessBadge harness={summary.harness} /> : null}
				<span className="mfw-num">{shortModel(summary.model)}</span>
				{summary.relation !== "fresh" ? (
					<span style={muted}>{summary.relation}</span>
				) : null}
				<span className="mfw-num" style={muted}>
					{formatDuration(ms)}
					{summary.costUsd != null ? ` · ${formatCost(summary.costUsd)}` : ""}
				</span>
				<AppLink to={href.run(project, runId)} draggable={false}>
					open
				</AppLink>
			</div>
			{entry.lastLine ? (
				<TipP
					className="min-w-0 truncate"
					tip={entry.lastLine}
					clipped
					style={{ ...muted, ...small }}
				>
					last: {entry.lastLine}
				</TipP>
			) : null}
			{live ? (
				<SubtreeRunControls
					project={project}
					runId={runId}
					label={summary.label}
					state={summary.state}
				/>
			) : null}
			{entry.children.length > 0 ? (
				<ul className="flex flex-col gap-1 pt-0.5">
					{entry.children.map((child) => (
						<SubtreeRun
							key={child.ref}
							entry={child}
							project={project}
							depth={depth + 1}
						/>
					))}
				</ul>
			) : null}
		</li>
	);
}

/** Steer and stop for one live run. Capabilities come from the shared `runs.active` cache. */
function SubtreeRunControls({
	project,
	runId,
	label,
	state,
}: {
	project: string;
	runId: string;
	label: string;
	state: string;
}) {
	const trpc = useTRPC();
	const active = useQuery(trpc.runs.active.queryOptions());
	const run = active.data?.find(
		(r) => r.project === project && r.runId === runId,
	);
	const target = {
		project,
		runId,
		label,
		state: run?.state ?? state,
		capabilities: run?.capabilities,
	};
	const controls = useRunControls(target);
	const [message, setMessage] = useState("");
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			{controls.steerable ? (
				<form
					className="flex min-w-0 flex-1 items-center gap-1"
					onSubmit={(e) => {
						e.preventDefault();
						controls.steer.send(message, { onSent: () => setMessage("") });
					}}
				>
					<Input
						value={message}
						aria-label={`Steer ${label}`}
						placeholder="Steer…"
						className="min-h-7 min-w-0 flex-1"
						onChange={(e) => setMessage(e.target.value)}
					/>
					<Button
						type="submit"
						size="xs"
						variant="outline"
						disabled={controls.steer.pending || message.trim() === ""}
					>
						<Send aria-hidden /> Steer
					</Button>
				</form>
			) : null}
			{controls.stoppable || controls.stop.pending ? (
				<Button
					size="xs"
					variant="outline"
					disabled={controls.stop.pending}
					onClick={controls.stop.request}
				>
					<Square aria-hidden />
					{controls.stop.pending ? "Stopping…" : "Stop"}
				</Button>
			) : null}
			<StopRunDialog controls={controls} target={target} />
		</div>
	);
}
