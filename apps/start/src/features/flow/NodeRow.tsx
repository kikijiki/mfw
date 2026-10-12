import { ChevronDown, ChevronRight, History } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { TipSpan } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { AppLink } from "../../components/AppLink";
import { HarnessBadge } from "../../components/agent/HarnessBadge";
import {
	lookForRun,
	RELATION_LOOK,
	SUB_LOOK,
	shortModel,
} from "../../components/agent/look";
import { StateGlyph } from "../../components/agent/StateGlyph";
import { Cost } from "../../components/Cost";
import { Glyph, StatusIcon, TaskTypeIcon } from "../../components/icons";
import { Chip } from "../../components/Page";
import { Elapsed } from "../../components/RelativeTime";
import type { RunState } from "../../components/StatusPill";
import { HostChip } from "../agents/RouteBadge";
import type { FlowNodeIn, FlowRow } from "./flowModel";

/**
 * One row of the work tree: the same component in the project's Flow lens
 * (inside the treegrid, with the timeline cell beside it) and in Home's live
 * section (a plain list), so a run reads identically in both.
 *
 * `[twisty] [state + kind glyph] [id / role] [title] [badges] [age] [cost]`
 * (design §5.2). Colour comes from the state table in `components/agent`,
 * never chosen here; every mark is a glyph or an icon with a label.
 */

/** The letter in a run's glyph corner (design §11.3). */
const ROLE_LETTER: Record<string, string> = {
	worker: "I",
	judge: "R",
	recovery: "X",
	planner: "P",
	plan: "P",
	spike: "S",
};

export const roleLetter = (role: string): string =>
	ROLE_LETTER[role] ?? (role.charAt(0).toUpperCase() || "?");

/** The id part of a ref: `task:MFW-41` to `MFW-41`. */
export const refId = (ref: string): string => ref.slice(ref.indexOf(":") + 1);

/** "3 minutes", for a screen reader; not the compact "3m" of the visible row. */
export function spokenDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 60_000) return "under a minute";
	const m = Math.floor(ms / 60_000);
	if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h} hour${h === 1 ? "" : "s"}`;
	const d = Math.floor(h / 24);
	return `${d} day${d === 1 ? "" : "s"}`;
}

/**
 * The row's accessible name (design §11.5): what it is, its state and for how
 * long: "A2, codex gpt-5, needs answer for 3 minutes".
 */
export function rowAccessibleName(row: FlowRow, now: number): string {
	if (row.kind === "fold" && row.fold)
		return `${row.fold.count} done tasks, folded`;
	const n = row.node;
	if (!n) return row.key;
	if (n.sub) {
		const end = n.sub.endedAt ?? new Date(now);
		const status =
			n.sub.status === "running"
				? "running"
				: n.sub.status === "error"
					? "failed"
					: "done";
		return `${n.title}, subagent ${n.sub.agentType}, ${status} for ${spokenDuration(end.getTime() - n.sub.startedAt.getTime())}`;
	}
	if (n.run) {
		const look = lookForRun({
			state: n.run.state as RunState,
			activity: n.run.activity ?? undefined,
		});
		const who = [n.run.harness, shortModel(n.run.model)]
			.filter(Boolean)
			.join(" ");
		const since = n.run.finishedAt ?? new Date(now);
		return `${n.title}, ${who}, ${look.label} for ${spokenDuration(since.getTime() - n.run.startedAt.getTime())}`;
	}
	if (n.kind === "group" && n.group) {
		const g = n.group;
		const winner = g.winner ? `, winner ${refId(g.winner).slice(0, 8)}` : "";
		return `Competing group, ${n.title}, ${GROUP_STATUS[g.status] ?? g.status}${winner}`;
	}
	if (n.kind === "group") return n.title;
	if (n.kind === "brain" && n.brain) {
		const state =
			{
				idle: "idle",
				turn: "thinking",
				paused: "paused",
				failed: "stuck, needs you",
			}[n.brain.state] ?? n.brain.state;
		return `Brain, generation ${n.brain.generation}, ${state}`;
	}
	const status = n.status ? `, ${n.status.value.replace(/_/g, " ")}` : "";
	const prog = row.progress
		? `, ${row.progress.done} of ${row.progress.total} done`
		: "";
	return `${refId(n.ref)} ${n.title}${status}${prog}`;
}

/** `run_groups.status`, as the row says it. */
const GROUP_STATUS: Record<string, string> = {
	open: "open",
	selecting: "winner chosen",
	merged: "merged",
	abandoned: "abandoned",
};

const NEEDS_LABEL: Record<string, string> = {
	question: "asks a question",
	approval: "needs approval",
	stalled: "stalled",
	escalated: "escalated",
	inbox: "needs you",
	brain_stuck: "brain stuck",
};

export interface NodeRowProps {
	row: FlowRow;
	now: number;
	/** `grid`: a `row` of a treegrid (levels, expanded, set position). `list`: a plain item. */
	mode?: "grid" | "list";
	selected?: boolean;
	/** The treegrid's active row (its `aria-activedescendant`). */
	active?: boolean;
	/** The id of the row element, for `aria-activedescendant`. */
	id?: string;
	onToggle?: (key: string) => void;
	onSelect?: (key: string) => void;
	/** Makes the title a link (Home); the grid selects on click instead. */
	to?: string;
	/** The timeline cell (or phone sparkline), drawn after the tree cell. */
	timeline?: ReactNode;
	className?: string;
	style?: CSSProperties;
}

export function NodeRow({
	row,
	now,
	mode = "grid",
	selected = false,
	active = false,
	id,
	onToggle,
	onSelect,
	to,
	timeline,
	className,
	style,
}: NodeRowProps) {
	const node = row.node;
	const grid = mode === "grid";
	const name = rowAccessibleName(row, now);
	const needs = node?.needsMe ?? null;
	return (
		// The click is the pointer's route to selection; the keyboard's is the grid
		// (`aria-activedescendant`), which names this row and handles Enter.
		// biome-ignore lint/a11y/noStaticElementInteractions: see above
		// biome-ignore lint/a11y/useKeyWithClickEvents: see above
		// biome-ignore lint/a11y/useAriaPropsSupportedByRole: `row` and `listitem` both take a name
		<div
			id={id}
			role={grid ? "row" : "listitem"}
			aria-label={name}
			{...(grid
				? {
						"aria-level": row.depth + 1,
						"aria-posinset": row.posInSet,
						"aria-setsize": row.setSize,
						"aria-selected": selected,
						...(row.expandable ? { "aria-expanded": row.expanded } : {}),
					}
				: {})}
			data-key={row.key}
			data-dim={row.dim ? "" : undefined}
			data-active-row={active ? "" : undefined}
			data-needs={needs ?? undefined}
			className={cn(
				"flex items-stretch border-b",
				row.dim && "opacity-55",
				className,
			)}
			style={{
				height: "var(--mfw-row-h)",
				borderColor: "var(--mfw-border)",
				background: selected ? "var(--mfw-accent-subtle)" : undefined,
				boxShadow: needs
					? "inset 2px 0 0 var(--mfw-warn)"
					: active
						? "inset 2px 0 0 var(--mfw-accent)"
						: undefined,
				...style,
			}}
			onClick={() => onSelect?.(row.key)}
		>
			<div
				role={grid ? "gridcell" : undefined}
				className="flex min-w-0 flex-1 items-center gap-1.5 pr-2"
				style={{
					paddingLeft: 6 + row.depth * 14,
					fontSize: "var(--mfw-font-data)",
				}}
			>
				<Twisty row={row} onToggle={onToggle} />
				{row.kind === "fold" ? (
					<FoldBody row={row} />
				) : node ? (
					<NodeBody row={row} node={node} now={now} to={to} />
				) : null}
			</div>
			{timeline}
		</div>
	);
}

function Twisty({
	row,
	onToggle,
}: {
	row: FlowRow;
	onToggle?: (key: string) => void;
}) {
	if (!row.expandable) return <span aria-hidden className="inline-block w-4" />;
	const Icon = row.expanded ? ChevronDown : ChevronRight;
	return (
		// Keyboard goes through the grid (`h` / `l`); this is the pointer's handle.
		<span
			aria-hidden
			data-twisty
			className="inline-flex w-4 shrink-0 cursor-pointer items-center justify-center"
			style={{ color: "var(--mfw-fg-muted)" }}
			onClick={(e) => {
				e.stopPropagation();
				onToggle?.(row.key);
			}}
		>
			<Icon className="size-3.5" />
		</span>
	);
}

function FoldBody({ row }: { row: FlowRow }) {
	return (
		<span style={{ color: "var(--mfw-fg-muted)" }}>
			{row.fold?.count} done task{row.fold?.count === 1 ? "" : "s"}
			<span style={{ color: "var(--mfw-fg-faint)" }}>
				{row.expanded ? " (shown)" : " (folded)"}
			</span>
		</span>
	);
}

function Title({
	text,
	to,
	className,
}: {
	text: string;
	to?: string;
	className?: string;
}) {
	return to ? (
		<AppLink
			to={to}
			className={cn("min-w-0 truncate", className)}
			onClick={(e) => e.stopPropagation()}
		>
			{text}
		</AppLink>
	) : (
		<TipSpan className={cn("min-w-0 truncate", className)} tip={text} clipped>
			{text}
		</TipSpan>
	);
}

function NodeBody({
	row,
	node,
	now,
	to,
}: {
	row: FlowRow;
	node: FlowNodeIn;
	now: number;
	to?: string;
}) {
	if (node.run) return <RunBody row={row} node={node} to={to} />;
	if (node.sub) return <SubBody row={row} node={node} to={to} />;
	if (node.kind === "brain") return <BrainBody row={row} node={node} />;
	if (node.kind === "group" && node.group) {
		return <AttemptGroupBody node={node} group={node.group} />;
	}
	if (node.kind === "group") {
		return (
			<>
				<History
					aria-hidden
					className="size-3.5 shrink-0"
					style={{ color: "var(--mfw-fg-faint)" }}
				/>
				<Title text={node.title} className="text-[var(--mfw-fg-muted)]" />
				{node.rollup && node.rollup.costUsdToday > 0 ? (
					<Cost usd={node.rollup.costUsdToday} className="ml-auto" />
				) : null}
			</>
		);
	}
	return <TaskBody row={row} node={node} now={now} to={to} />;
}

/**
 * A competing attempt group (the compete icon): the attempts below it are its runs. The
 * winner is starred once one is chosen; an open group says who selects.
 */
function AttemptGroupBody({
	node,
	group,
}: {
	node: FlowNodeIn;
	group: NonNullable<FlowNodeIn["group"]>;
}) {
	const live = node.rollup?.live ?? 0;
	return (
		<>
			<Glyph name="compete" label="competing attempts" token="--mfw-accent" />
			<Title text={node.title} />
			<span className="ml-auto flex shrink-0 items-center gap-1.5">
				{group.winner ? (
					<TipSpan
						data-testid="group-winner"
						tip={`Winner ${refId(group.winner)}`}
						style={{ color: "var(--mfw-warn)" }}
					>
						<Glyph name="star" label="winner" />
					</TipSpan>
				) : null}
				<Chip tone={group.status === "abandoned" ? "warn" : "neutral"}>
					{GROUP_STATUS[group.status] ?? group.status}
				</Chip>
				{group.status === "open" ? (
					<TipSpan
						style={{
							color: "var(--mfw-fg-muted)",
							fontSize: "var(--mfw-text-xs)",
						}}
						tip="who selects the winner"
					>
						{group.selection === "first_verified" ? "first verified" : "brain"}
					</TipSpan>
				) : null}
				{live > 0 ? <Chip tone="accent">{live} live</Chip> : null}
				{node.rollup && node.rollup.costUsdToday > 0 ? (
					<Cost usd={node.rollup.costUsdToday} title="spent in the last day" />
				) : null}
			</span>
		</>
	);
}

/** The brain's own row: the root of the tree, with its glyph, turns and spend. */
function BrainBody({ row, node }: { row: FlowRow; node: FlowNodeIn }) {
	const brain = node.brain;
	return (
		<>
			{brain ? (
				<StateGlyph subject={{ kind: "brain", value: brain.state }} showLabel />
			) : null}
			<Title text={node.title} />
			<span className="ml-auto flex shrink-0 items-center gap-1.5">
				{node.needsMe ? (
					<Chip tone="critical">
						{NEEDS_LABEL[node.needsMe] ?? node.needsMe}
					</Chip>
				) : null}
				{brain ? (
					<TipSpan
						className="mfw-num"
						tip={`${brain.harness} ${brain.model}`}
						style={{
							color: "var(--mfw-fg-muted)",
							fontSize: "var(--mfw-text-xs)",
						}}
					>
						{brain.turnsLast24h} turns/24h
					</TipSpan>
				) : null}
				{row.progress ? (
					<TipSpan
						className="mfw-num"
						tip={`${row.progress.done} of ${row.progress.total} tasks done`}
						style={{ color: "var(--mfw-fg-muted)" }}
					>
						{row.progress.done}/{row.progress.total}
					</TipSpan>
				) : null}
				{node.rollup && node.rollup.costUsdToday > 0 ? (
					<Cost usd={node.rollup.costUsdToday} title="spent in the last day" />
				) : null}
			</span>
		</>
	);
}

function TaskBody({
	row,
	node,
	to,
}: {
	row: FlowRow;
	node: FlowNodeIn;
	now: number;
	to?: string;
}) {
	const live = node.rollup?.live ?? 0;
	return (
		<>
			{node.kind === "epic" || node.kind === "group_task" ? (
				<TaskTypeIcon type={node.kind === "epic" ? "epic" : "group"} />
			) : null}
			<StatusIcon
				statusRole={node.status?.role}
				value={node.status?.value}
				label={node.status?.value.replace(/_/g, " ")}
			/>
			<span
				className="mfw-num shrink-0"
				style={{ color: "var(--mfw-fg-muted)" }}
			>
				{refId(node.ref)}
			</span>
			<Title text={node.title} to={to} />
			<span className="ml-auto flex shrink-0 items-center gap-1.5">
				{node.needsMe ? (
					<Chip tone="warn">{NEEDS_LABEL[node.needsMe] ?? node.needsMe}</Chip>
				) : null}
				{row.progress ? (
					<TipSpan
						className="mfw-num"
						tip={`${row.progress.done} of ${row.progress.total} tasks done`}
						style={{ color: "var(--mfw-fg-muted)" }}
					>
						{row.progress.done}/{row.progress.total}
					</TipSpan>
				) : null}
				{live > 0 ? <Chip tone="accent">{live} live</Chip> : null}
				{row.chain ? <ChainSummary chain={row.chain} /> : null}
				{node.rollup && node.rollup.costUsdToday > 0 ? (
					<Cost usd={node.rollup.costUsdToday} title="spent in the last day" />
				) : null}
			</span>
		</>
	);
}

function ChainSummary({ chain }: { chain: NonNullable<FlowRow["chain"]> }) {
	return (
		<TipSpan
			className="mfw-num whitespace-nowrap"
			style={{ color: "var(--mfw-fg-muted)" }}
			tip={`${chain.count} run${chain.count === 1 ? "" : "s"}: ${chain.labels.join(", ")}`}
		>
			<Glyph name="repeat" className="size-3" /> {chain.count} run
			{chain.count === 1 ? "" : "s"} ·{" "}
			{chain.glyphs.map((g, i) => (
				<Glyph
					// biome-ignore lint/suspicious/noArrayIndexKey: a fixed-length tail, never reordered
					key={i}
					name={g}
					label={chain.labels[i] ?? g}
					className="inline size-3 align-[-2px]"
				/>
			))}
		</TipSpan>
	);
}

/**
 * A fork count on a closed run (or subagent) row: how many subagents it started,
 * and how many are still going. An open row shows them as its children.
 */
export function SubsSummary({ subs }: { subs: NonNullable<FlowRow["subs"]> }) {
	const live = subs.running > 0 ? ` · ${subs.running} running` : "";
	return (
		<TipSpan
			data-subs=""
			className="mfw-num whitespace-nowrap"
			style={{
				color: subs.running > 0 ? "var(--mfw-accent)" : "var(--mfw-fg-muted)",
			}}
			tip={`${subs.count} subagent${subs.count === 1 ? "" : "s"}${live}`}
		>
			<Glyph name="fork" className="inline size-3 align-[-2px]" /> +{subs.count}
		</TipSpan>
	);
}

/** A subagent: what it was asked, what kind it is, how it is going. */
function SubBody({
	row,
	node,
	to,
}: {
	row: FlowRow;
	node: FlowNodeIn;
	to?: string;
}) {
	const sub = node.sub as NonNullable<FlowNodeIn["sub"]>;
	const look = SUB_LOOK[sub.status];
	const tools = Object.values(sub.tools).reduce((a, b) => a + b, 0);
	return (
		<>
			<Glyph name="fork" label="subagent" token={look.token} />
			<StateGlyph look={look} />
			<TipSpan
				className="mfw-num shrink-0"
				tip={`subagent type: ${sub.agentType}`}
				style={{
					color: "var(--mfw-fg-muted)",
					fontSize: "var(--mfw-text-2xs)",
				}}
			>
				{sub.agentType}
			</TipSpan>
			<Title text={node.title} to={to} />
			<span
				className="ml-auto flex shrink-0 items-center gap-1.5"
				style={{ fontSize: "var(--mfw-text-xs)" }}
			>
				<span style={{ color: `var(${look.token})` }}>{look.label}</span>
				{tools > 0 ? (
					<TipSpan
						className="mfw-num"
						tip={Object.entries(sub.tools)
							.map(([name, n]) => `${name} ×${n}`)
							.join(" · ")}
						style={{ color: "var(--mfw-fg-muted)" }}
					>
						{tools} tool{tools === 1 ? "" : "s"}
					</TipSpan>
				) : null}
				{row.subs && !row.expanded ? <SubsSummary subs={row.subs} /> : null}
				<span style={{ color: "var(--mfw-fg-muted)" }}>
					<Elapsed since={sub.startedAt} until={sub.endedAt} />
				</span>
			</span>
		</>
	);
}

function RunBody({
	row,
	node,
	to,
}: {
	row: FlowRow;
	node: FlowNodeIn;
	to?: string;
}) {
	const run = node.run as NonNullable<FlowNodeIn["run"]>;
	const look = lookForRun({
		state: run.state as RunState,
		activity: run.activity ?? undefined,
	});
	const relation = RELATION_LOOK[run.relation];
	const judge = node.kind === "judge";
	return (
		<>
			<StateGlyph look={look} />
			<TipSpan
				className="mfw-num shrink-0"
				tip={`role: ${run.role}`}
				style={{
					color: "var(--mfw-fg-muted)",
					fontSize: "var(--mfw-text-2xs)",
				}}
			>
				{judge ? (
					<Glyph name="scale" label="judge" className="size-3" />
				) : (
					roleLetter(run.role)
				)}
			</TipSpan>
			{run.harness ? <HarnessBadge harness={run.harness} /> : null}
			<Title text={node.title} to={to} />
			<span
				className="ml-auto flex shrink-0 items-center gap-1.5"
				style={{ fontSize: "var(--mfw-text-xs)" }}
			>
				{run.attempt?.winner ? (
					<TipSpan
						data-testid="run-winner"
						tip="Selected winner"
						style={{ color: "var(--mfw-warn)" }}
					>
						<Glyph name="star" label="winner" />
					</TipSpan>
				) : null}
				{relation ? (
					<span
						className="inline-flex items-center gap-0.5"
						style={{ color: "var(--mfw-fg-faint)" }}
					>
						<Glyph name={relation.glyph} className="size-3" />
						{relation.label}
					</span>
				) : null}
				<span
					style={{
						color: look.ring ? `var(${look.token})` : "var(--mfw-fg-muted)",
					}}
				>
					{look.label}
				</span>
				{run.model ? (
					<TipSpan
						className="mfw-num"
						tip={shortModel(run.model) === run.model ? undefined : run.model}
					>
						{shortModel(run.model)}
					</TipSpan>
				) : null}
				{run.host ? <HostChip hostId={run.host} /> : null}
				{row.chain ? <ChainSummary chain={row.chain} /> : null}
				{row.subs && !row.expanded ? <SubsSummary subs={row.subs} /> : null}
				<span style={{ color: "var(--mfw-fg-muted)" }}>
					<Elapsed since={run.startedAt} until={run.finishedAt} />
				</span>
				{run.costUsd != null || run.liveCostUsd != null ? (
					<Cost usd={run.liveCostUsd ?? run.costUsd} />
				) : null}
			</span>
		</>
	);
}
