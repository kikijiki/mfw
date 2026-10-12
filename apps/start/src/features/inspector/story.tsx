import { useQuery } from "@tanstack/react-query";
import {
	ChevronDown,
	ChevronRight,
	CircleHelp,
	GitMerge,
	Hand,
	Pause,
	Pencil,
	Plus,
	Scale,
	ScrollText,
	Square,
	Undo2,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { Button } from "~/components/ui/button";
import { TipLi, TipP, TipSpan } from "~/components/ui/tooltip";
import { AppLink } from "../../components/AppLink";
import { HarnessBadge } from "../../components/agent/HarnessBadge";
import { lookForRun, SUB_LOOK, shortModel } from "../../components/agent/look";
import { StateGlyph } from "../../components/agent/StateGlyph";
import { Glyph } from "../../components/icons";
import { Chip } from "../../components/Page";
import { StatusPill, type TaskStatus } from "../../components/StatusPill";
import { formatCost, formatDuration, humanizeToken } from "../../lib/format";
import { parseNodeRef } from "../../lib/nodeRef";
import type { RouterOutputs } from "../../lib/trpc";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import { RunConsole } from "../agents/RunConsole";
import { StopRunDialog, useRunControls } from "../agents/useRunControls";
import { outcomeChip } from "../brain/brain";
import { canOverride, outcomeSummary } from "../brain/steering";
import { AnswerBox } from "../clarify/AnswerBox";
import { runBranchName } from "../repo/repoModel";
import { SHADOW_TITLE } from "./DecisionRow";
import { OverrideDialog } from "./OverrideDialog";

/**
 * Entry renderers for a task's Story (`node.story`): one chronological spine
 * where runs nest by lineage and carry their own verify results, verdicts and
 * (while live) steer, stop and answer controls. Every `StoryEntry` kind has a
 * row here; `TaskStory` owns the paging.
 */

export type StoryPage = RouterOutputs["node"]["story"];
export type StoryEntry = StoryPage["entries"][number];
export type StoryRunEntry = Extract<StoryEntry, { kind: "run" }>;
export type StoryGroupEntry = Extract<StoryEntry, { kind: "group" }>;

const LIVE_STATES = new Set(["starting", "running", "finalizing", "merging"]);

/** A run still has a process (or a merge in flight); its console is worth opening. */
export function isLiveRun(state: string): boolean {
	return LIVE_STATES.has(state);
}

/**
 * Loaded pages (newest page first, each oldest-first as the API returns it)
 * as one newest-first list, the way the spine reads.
 */
export function newestFirst(pages: readonly StoryPage[]): StoryEntry[] {
	return pages.flatMap((page) => [...page.entries].reverse());
}

/** `2026-10-12` in local time, the day-separator key. */
export function dayKey(at: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** Consecutive same-day runs of entries, in the order given. */
export function groupByDay(
	entries: readonly StoryEntry[],
): { day: string; entries: StoryEntry[] }[] {
	const groups: { day: string; entries: StoryEntry[] }[] = [];
	for (const entry of entries) {
		const day = dayKey(entry.at);
		const last = groups[groups.length - 1];
		if (last && last.day === day) last.entries.push(entry);
		else groups.push({ day, entries: [entry] });
	}
	return groups;
}

const RELATION_LABEL: Record<string, string> = {
	fresh: "",
	repair: "repair",
	resume: "resume",
	answer: "answer",
	unblock: "unblock",
};

const faint = { color: "var(--mfw-fg-faint)" } as const;
const muted = { color: "var(--mfw-fg-muted)" } as const;

function clock(at: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** One spine row: time gutter, a mark, content. */
function Row({
	at,
	mark,
	children,
	kind,
}: {
	at: Date;
	mark: ReactNode;
	children: ReactNode;
	kind: string;
}) {
	return (
		<li data-kind={kind} className="flex min-w-0 items-start gap-2 py-1">
			<span
				className="mfw-num w-10 shrink-0 pt-0.5"
				style={{ ...faint, fontSize: "var(--mfw-text-2xs)" }}
			>
				{clock(at)}
			</span>
			<span className="flex w-4 shrink-0 justify-center pt-0.5" aria-hidden>
				{mark}
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
		</li>
	);
}

const MARK = "size-3.5";

function VerdictChip({
	verdict,
}: {
	verdict: StoryRunEntry["verdicts"][number];
}) {
	const ok = verdict.verdict === "accept" || verdict.verdict === "approve";
	return (
		<TipSpan
			className="inline-flex items-center gap-1 border px-1"
			style={{
				borderColor: "var(--mfw-border)",
				borderRadius: "var(--mfw-radius-sm)",
				fontSize: "var(--mfw-text-2xs)",
				color: ok ? "var(--mfw-ok)" : "var(--mfw-warn)",
			}}
			tip={`${verdict.mode} review, round ${verdict.round}`}
		>
			<Scale aria-hidden className="size-3" />
			{humanizeToken(verdict.verdict)}
			{verdict.reviewerModel ? (
				<span style={muted}>· {shortModel(verdict.reviewerModel)}</span>
			) : null}
		</TipSpan>
	);
}

/**
 * A run and, nested under it, the runs that continue its worktree (repair,
 * resume, answer, unblock). A live run embeds `RunConsole` collapsed: the
 * block shows the last line plus answer/stop, and the tail (and its
 * `live.runOutput` stream) exists only once expanded.
 */
export function RunBlock({
	entry,
	project,
	defaultOpen = false,
	depth = 0,
}: {
	entry: StoryRunEntry;
	project: string;
	/** Start with the console expanded (tests; the page starts collapsed). */
	defaultOpen?: boolean;
	depth?: number;
}) {
	const { summary } = entry;
	const live = isLiveRun(summary.state);
	const runId = entry.ref.replace(/^run:/, "");
	const relation = RELATION_LABEL[summary.relation] ?? summary.relation;
	const look = lookForRun({
		state: summary.state as never,
		activity: summary.activity,
	});
	const harness = summary.harness ?? "";
	const ms =
		(summary.finishedAt ?? new Date()).getTime() - summary.startedAt.getTime();

	return (
		<li
			data-kind="run"
			data-run={runId}
			data-depth={depth}
			className="flex min-w-0 flex-col gap-1 border-l pl-2"
			style={{ borderColor: live ? "var(--mfw-accent)" : "var(--mfw-border)" }}
		>
			<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
				<span
					className="mfw-num"
					style={{ ...faint, fontSize: "var(--mfw-text-2xs)" }}
				>
					{clock(entry.at)}
				</span>
				<StateGlyph look={look} showLabel />
				{harness ? <HarnessBadge harness={harness} /> : null}
				<span className="mfw-num" style={{ fontSize: "var(--mfw-text-xs)" }}>
					{shortModel(summary.model)}
				</span>
				<span style={{ ...muted, fontSize: "var(--mfw-text-xs)" }}>
					{humanizeToken(summary.role)}
					{relation ? ` · ${relation}` : ""} · attempt {summary.attempt}
				</span>
				{entry.attempt?.winner ? (
					<TipSpan
						data-testid="winner-star"
						tip="Selected winner of its attempt group"
						style={{ color: "var(--mfw-warn)", fontSize: "var(--mfw-text-xs)" }}
					>
						<Glyph name="star" className="mr-1 inline size-3 align-[-2px]" />
						winner
					</TipSpan>
				) : null}
				{summary.host ? (
					<span style={{ ...muted, fontSize: "var(--mfw-text-xs)" }}>
						{summary.host}
					</span>
				) : null}
				<span
					className="mfw-num"
					style={{ ...muted, fontSize: "var(--mfw-text-xs)" }}
				>
					{formatDuration(ms)}
					{summary.costUsd != null ? ` · ${formatCost(summary.costUsd)}` : ""}
				</span>
				{entry.transcriptAvailable ? (
					<AppLink
						to={href.run(project, runId)}
						className="inline-flex items-center gap-1"
						style={{ fontSize: "var(--mfw-text-xs)" }}
					>
						<ScrollText aria-hidden className="size-3" /> transcript
					</AppLink>
				) : null}
			</div>

			{entry.lastLine ? (
				<TipP
					className="min-w-0 truncate"
					tip={entry.lastLine}
					clipped
					style={{ ...muted, fontSize: "var(--mfw-text-xs)" }}
				>
					{entry.lastLine}
				</TipP>
			) : null}

			{entry.verify.length > 0 ? (
				<ul
					className="flex flex-wrap gap-x-3 gap-y-0.5"
					style={{ fontSize: "var(--mfw-text-xs)" }}
				>
					{entry.verify.map((c) => (
						<TipLi
							key={c.check}
							tip={c.detail}
							style={{
								color: c.passed ? "var(--mfw-ok)" : "var(--mfw-critical)",
							}}
						>
							<Glyph
								name={c.passed ? "check" : "cross"}
								label={c.passed ? "passed" : "failed"}
								className="mr-1 inline size-3 align-[-2px]"
							/>
							{c.check}
							{!c.passed && c.classification ? (
								<span style={muted}> ({c.classification})</span>
							) : null}
						</TipLi>
					))}
				</ul>
			) : null}

			{entry.verdicts.length > 0 ? (
				<div className="flex flex-wrap gap-1">
					{entry.verdicts.map((v) => (
						<VerdictChip key={v.id} verdict={v} />
					))}
				</div>
			) : null}

			{entry.subagents && entry.subagents.length > 0 ? (
				<SubagentList project={project} subagents={entry.subagents} />
			) : null}

			{live ? (
				<LiveRunControls
					project={project}
					runId={runId}
					label={summary.label}
					state={summary.state}
					defaultOpen={defaultOpen}
				/>
			) : null}

			{entry.children.length > 0 ? (
				<ul className="flex flex-col gap-2 pt-1">
					{entry.children.map((child) => (
						<RunBlock
							key={child.ref}
							entry={child}
							project={project}
							defaultOpen={defaultOpen}
							depth={depth + 1}
						/>
					))}
				</ul>
			) : null}
		</li>
	);
}

type StorySubagent = NonNullable<StoryRunEntry["subagents"]>[number];

/** a fork count for a run's subagents, open while one is still running (and so is its run's block). */
export function SubagentList({
	project,
	subagents,
	defaultOpen,
}: {
	project: string;
	subagents: readonly StorySubagent[];
	/** Overrides the default (open only while one is running). */
	defaultOpen?: boolean;
}) {
	const running = subagents.filter((s) => s.status === "running").length;
	const [open, setOpen] = useState(defaultOpen ?? running > 0);
	return (
		<div data-subagents="" className="flex min-w-0 flex-col gap-0.5">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				className="mfw-focus mfw-num flex w-fit items-center gap-1 text-left"
				style={{
					fontSize: "var(--mfw-text-xs)",
					color: running > 0 ? "var(--mfw-accent)" : "var(--mfw-fg-muted)",
				}}
			>
				{open ? (
					<ChevronDown aria-hidden className="size-3" />
				) : (
					<ChevronRight aria-hidden className="size-3" />
				)}
				<Glyph name="fork" label="subagents" className="size-3" />+
				{subagents.length}
				{running > 0 ? ` · ${running} running` : ""}
			</button>
			{open ? (
				<ul className="m-0 flex list-none flex-col gap-0.5 p-0 pl-4">
					{subagents.map((s) => (
						<li
							key={s.ref}
							className="flex min-w-0 items-center gap-2"
							style={{
								fontSize: "var(--mfw-text-xs)",
								paddingLeft: s.parentRef ? 12 : 0,
							}}
						>
							<StateGlyph look={SUB_LOOK[s.status]} />
							<span className="mfw-num" style={muted}>
								{s.agentType}
							</span>
							<AppLink
								to={href.node(project, s.ref)}
								className="min-w-0 truncate"
								title={s.description}
								clipped
							>
								{s.description}
							</AppLink>
							{s.toolCalls > 0 ? (
								<span className="mfw-num" style={muted}>
									{s.toolCalls} tool{s.toolCalls === 1 ? "" : "s"}
								</span>
							) : null}
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

/**
 * Answer and stop stay on the collapsed block (neither opens a stream: the
 * question comes from the shared `clarify.open` cache); steer and the tail
 * live in `RunConsole`, which mounts only when expanded. The capabilities
 * come from the shared `runs.active` cache.
 */
function LiveRunControls({
	project,
	runId,
	label,
	state,
	defaultOpen,
}: {
	project: string;
	runId: string;
	label: string;
	state: string;
	defaultOpen: boolean;
}) {
	const trpc = useTRPC();
	const active = useQuery(trpc.runs.active.queryOptions());
	const [open, setOpen] = useState(defaultOpen);
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

	return (
		<div className="flex min-w-0 flex-col gap-1">
			{open ? (
				<RunConsole target={target} lines={24} heightClass="h-48" />
			) : (
				<>
					<AnswerBox project={project} runId={runId} />
					<div className="flex flex-wrap items-center gap-2">
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
				</>
			)}
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className="mfw-focus flex w-fit items-center gap-1 border-0 bg-transparent p-0"
				style={{ ...muted, fontSize: "var(--mfw-text-xs)" }}
			>
				{open ? (
					<ChevronDown aria-hidden className="size-3" />
				) : (
					<ChevronRight aria-hidden className="size-3" />
				)}
				{open ? "Hide console" : "Console, steer"}
			</button>
		</div>
	);
}

/** The run id of a `run:<id>` ref, or null. */
export function runIdOf(ref: string): string | null {
	const parsed = parseNodeRef(ref);
	return parsed?.kind === "run" ? parsed.id : null;
}

/**
 * A brain decision on the task's spine (design §6.4): a brain-decision row (`BRAIN spawn ×2`)
 * with its confidence, what it came to, and the rationale. While the brain is
 * in shadow mode it reads `shadow: proposed` (the pipeline acted); an
 * escalation (`notify_human`) is drawn loud.
 */
export function BrainDecisionRow({
	entry,
	project,
}: {
	entry: Extract<StoryEntry, { kind: "decision" }>;
	project: string;
}) {
	const [overriding, setOverriding] = useState(false);
	const brain = entry.brain;
	if (!brain) return null;
	const overridable = canOverride({
		role: "brain",
		kind: brain.kind as never,
		output: brain.actionState ? { status: brain.actionState } : {},
		overriddenBy: brain.overriddenBy,
	});
	const settled = outcomeSummary(brain.settled);
	const outcome = outcomeChip({
		output: brain.actionState ? { status: brain.actionState } : {},
		outcome: brain.settled,
		overriddenBy: brain.overriddenBy,
		kind: brain.kind as never,
	});
	const escalation = brain.notify && brain.notify.kind !== "fyi";
	return (
		<Row
			kind="decision"
			at={entry.at}
			mark={
				<Glyph
					name="diamond"
					label="brain decision"
					token={escalation ? "--mfw-warn" : "--mfw-accent"}
				/>
			}
		>
			<span
				className="flex flex-wrap items-center gap-1.5"
				style={{ fontSize: "var(--mfw-text-xs)" }}
				data-testid="brain-decision"
			>
				<strong>BRAIN</strong>
				<span>{humanizeToken(entry.tool)}</span>
				{brain.confidence ? (
					<Chip tone={brain.confidence === "low" ? "warn" : "neutral"}>
						{brain.confidence}
					</Chip>
				) : null}
				{brain.actionState === "proposed" ? (
					<Chip tone="info" title={SHADOW_TITLE}>
						shadow: proposed
					</Chip>
				) : null}
				{brain.actionState === "proposed" ? null : (
					<Chip tone={outcome.tone}>{outcome.label}</Chip>
				)}
				{escalation ? <Chip tone="warn">needs you</Chip> : null}
			</span>
			{brain.notify?.title ? (
				<span style={{ fontSize: "var(--mfw-text-xs)" }}>
					<strong>{brain.notify.title}</strong>
				</span>
			) : null}
			{entry.rationale ? (
				<span className="break-words" style={muted}>
					{entry.rationale}
				</span>
			) : null}
			{brain.alternatives.length > 0 ? (
				<details style={{ fontSize: "var(--mfw-text-xs)", ...muted }}>
					<summary>
						{brain.alternatives.length} alternative
						{brain.alternatives.length === 1 ? "" : "s"} considered
					</summary>
					<ul className="m-0 pl-4">
						{brain.alternatives.map((a) => (
							<li key={a.option}>
								<strong>{a.option}</strong> {"\u2014"} {a.why_not}
							</li>
						))}
					</ul>
				</details>
			) : null}
			<span
				className="flex flex-wrap gap-x-2"
				style={{ ...muted, fontSize: "var(--mfw-text-2xs)" }}
			>
				<AppLink to={href.board(project, { node: `decision:${entry.id}` })}>
					decision {entry.id}
				</AppLink>
				{brain.turnRunId ? (
					<AppLink
						to={href.board(project, { node: `turn:${brain.turnRunId}` })}
					>
						turn
					</AppLink>
				) : null}
				{entry.effects.map((ref) => (
					<AppLink key={ref} to={href.board(project, { node: ref })}>
						{ref}
					</AppLink>
				))}
				{brain.overriddenBy != null ? (
					<AppLink
						to={href.board(project, { node: `decision:${brain.overriddenBy}` })}
					>
						overridden by {brain.overriddenBy}
					</AppLink>
				) : null}
			</span>
			{settled ? (
				<span style={{ ...muted, fontSize: "var(--mfw-text-2xs)" }}>
					Outcome: {settled}
				</span>
			) : null}
			{overridable ? (
				<>
					<Button
						size="xs"
						variant="ghost"
						className="self-start"
						onClick={() => setOverriding(true)}
					>
						<Undo2 aria-hidden /> Override
					</Button>
					<OverrideDialog
						project={project}
						decisionId={entry.id}
						open={overriding}
						onOpenChange={setOverriding}
					/>
				</>
			) : null}
		</Row>
	);
}

const GROUP_STATUS_LABEL: Record<string, string> = {
	open: "open",
	selecting: "winner chosen, merging",
	merged: "merged",
	abandoned: "abandoned",
};

/**
 * A competing attempt group (`run_groups`): the compete icon and its status, who made
 * it and who selects, a link to the side-by-side compare, and the attempts as
 * run blocks with the winner starred.
 */
export function GroupBlock({
	entry,
	project,
	defaultOpen = false,
}: {
	entry: StoryGroupEntry;
	project: string;
	defaultOpen?: boolean;
}) {
	const g = entry.group;
	const winner = g.winnerRunId;
	return (
		<li
			data-kind="group"
			data-group={entry.ref}
			className="flex min-w-0 flex-col gap-1 border-l-2 pl-2"
			style={{ borderColor: "var(--mfw-accent)" }}
		>
			<div
				className="flex flex-wrap items-center gap-x-2 gap-y-0.5"
				style={{ fontSize: "var(--mfw-text-xs)" }}
			>
				<Glyph name="compete" label="competing attempts" />
				<strong>
					{g.kind === "competing" ? "Competing attempts" : "Attempt group"}
				</strong>
				<Chip tone={g.status === "abandoned" ? "warn" : "neutral"}>
					{GROUP_STATUS_LABEL[g.status] ?? g.status}
				</Chip>
				<span style={muted}>
					{g.selection === "first_verified"
						? "first verified wins"
						: "the brain selects"}
				</span>
				<span style={muted}>
					{g.createdBy === "human" ? "started by a person" : "spawned by "}
					{g.createdBy === "human" ? null : (
						<AppLink to={href.board(project, { node: g.createdBy })}>
							{g.createdBy}
						</AppLink>
					)}
				</span>
				{winner ? (
					<span style={{ color: "var(--mfw-warn)" }}>
						<Glyph
							name="star"
							label="winner"
							className="mr-1 inline size-3 align-[-2px]"
						/>
						{winner.slice(0, 8)}
					</span>
				) : null}
				<AppLink
					to={href.board(project, { node: entry.ref })}
					className="ml-auto"
				>
					Compare
				</AppLink>
			</div>
			<ul className="m-0 flex list-none flex-col gap-2 p-0">
				{entry.attempts.map((attempt) => (
					<RunBlock
						key={attempt.ref}
						entry={attempt}
						project={project}
						defaultOpen={defaultOpen}
						depth={1}
					/>
				))}
			</ul>
		</li>
	);
}

/** One top-level entry of the spine. */
export function StoryEntryView({
	entry,
	project,
	defaultOpen = false,
}: {
	entry: StoryEntry;
	project: string;
	defaultOpen?: boolean;
}) {
	switch (entry.kind) {
		case "run":
			return (
				<RunBlock entry={entry} project={project} defaultOpen={defaultOpen} />
			);

		case "group":
			return (
				<GroupBlock entry={entry} project={project} defaultOpen={defaultOpen} />
			);

		case "decision":
			return entry.brain ? (
				<BrainDecisionRow entry={entry} project={project} />
			) : (
				<Row
					kind="decision"
					at={entry.at}
					mark={
						<Scale className={MARK} style={{ color: "var(--mfw-accent)" }} />
					}
				>
					<span style={{ fontSize: "var(--mfw-text-xs)" }}>
						<strong>{humanizeToken(entry.role)}</strong>{" "}
						{humanizeToken(entry.tool)}
						<span style={muted}> · {humanizeToken(entry.outcome)}</span>
					</span>
					{entry.rationale ? (
						<span className="break-words" style={muted}>
							{entry.rationale}
						</span>
					) : null}
				</Row>
			);

		case "status":
			return (
				<Row
					kind="status"
					at={entry.at}
					mark={<Hand className={MARK} style={muted} />}
				>
					<span className="flex flex-wrap items-center gap-1.5">
						<span style={{ ...muted, fontSize: "var(--mfw-text-xs)" }}>
							{entry.actor ? `${entry.actor}: moved` : "moved"}
						</span>
						{entry.from ? (
							<>
								<StatusPill
									kind="task"
									value={entry.from as TaskStatus}
									variant="dot"
								/>
								<span aria-hidden>→</span>
							</>
						) : null}
						<StatusPill
							kind="task"
							value={entry.to as TaskStatus}
							variant="dot"
						/>
					</span>
					{entry.reason ? (
						<span className="break-words" style={muted}>
							{entry.reason}
						</span>
					) : null}
				</Row>
			);

		case "edit":
			return (
				<Row
					kind="edit"
					at={entry.at}
					mark={<Pencil className={MARK} style={muted} />}
				>
					<span style={{ ...muted, fontSize: "var(--mfw-text-xs)" }}>
						{entry.actor || "someone"} edited
						{entry.fields.length > 0 ? ` ${entry.fields.join(", ")}` : ""}
					</span>
				</Row>
			);

		case "merge": {
			const runId = runIdOf(entry.runRef);
			return (
				<Row
					kind="merge"
					at={entry.at}
					mark={<GitMerge className={MARK} style={muted} />}
				>
					<span style={{ fontSize: "var(--mfw-text-xs)" }}>
						merge {humanizeToken(entry.state)}
						{entry.sha ? (
							<AppLink
								to={href.repoCommit(project, entry.sha)}
								className="mfw-num ml-1"
								title="Open this commit in the repo view"
							>
								{entry.sha.slice(0, 8)}
							</AppLink>
						) : null}
						{runId ? (
							<AppLink to={href.run(project, runId)} className="ml-2">
								run
							</AppLink>
						) : null}
						{runId ? (
							<AppLink
								to={href.repoBranch(project, runBranchName(runId))}
								className="ml-2"
							>
								branch
							</AppLink>
						) : null}
					</span>
					{entry.detail ? (
						<span className="break-words" style={muted}>
							{entry.detail}
						</span>
					) : null}
				</Row>
			);
		}

		case "question": {
			const runId = runIdOf(entry.runRef);
			return (
				<Row
					kind="question"
					at={entry.at}
					mark={
						<CircleHelp className={MARK} style={{ color: "var(--mfw-warn)" }} />
					}
				>
					<span className="break-words">{entry.question}</span>
					{entry.answer !== undefined ? (
						<span className="break-words" style={muted}>
							{entry.answeredBy ?? "answered"}: {entry.answer}
						</span>
					) : runId ? (
						<AnswerBox project={project} runId={runId} />
					) : null}
				</Row>
			);
		}

		case "hold":
			return (
				<Row
					kind="hold"
					at={entry.at}
					mark={<Pause className={MARK} style={muted} />}
				>
					<span style={{ ...muted, fontSize: "var(--mfw-text-xs)" }}>
						held: {entry.reason}
					</span>
				</Row>
			);

		case "created":
			return (
				<Row
					kind="created"
					at={entry.at}
					mark={<Plus className={MARK} style={muted} />}
				>
					<span style={{ ...muted, fontSize: "var(--mfw-text-xs)" }}>
						created by {entry.by || "human"}
					</span>
				</Row>
			);

		case "verdict": {
			const runId = runIdOf(entry.runRef);
			return (
				<Row
					kind="verdict"
					at={entry.at}
					mark={<Scale className={MARK} style={muted} />}
				>
					<span className="flex flex-wrap items-center gap-2">
						<VerdictChip verdict={entry} />
						{runId ? (
							<AppLink
								to={href.run(project, runId)}
								style={{ fontSize: "var(--mfw-text-xs)" }}
							>
								run
							</AppLink>
						) : null}
					</span>
				</Row>
			);
		}
	}
}
