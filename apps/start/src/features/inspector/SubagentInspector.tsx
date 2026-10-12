import type { AgentEvent } from "@mfw/daemon/agents/events";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { TipSpan } from "~/components/ui/tooltip";
import { AppLink } from "../../components/AppLink";
import { SUB_LOOK } from "../../components/agent/look";
import { StateGlyph } from "../../components/agent/StateGlyph";
import { Empty } from "../../components/Empty";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { formatDuration } from "../../lib/format";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import { buildItems, TranscriptEntry } from "../transcript/entries";
import {
	ancestry,
	depthOf,
	isSubagentOpen,
	subagentGroups,
	subagentSlice,
	visibleItems,
} from "../transcript/subagents";
import { useRunStream } from "../transcript/useRunStream";

/**
 * The subagent inspector (U7-03): one subagent of a run, as the slice of the
 * run's transcript that is its own. There is no second transcript file: the
 * parent's `events.jsonl` carries every subagent entry with its `parent`, and
 * the slice is those entries (plus the `Agent` call that started it, whose
 * input is the prompt, and its result). Subagents it started nest inside.
 */

export interface SubagentHeaderInfo {
	runId: string;
	agentType: string;
	description: string;
	status: "running" | "ok" | "error";
	startedAt: Date;
	endedAt: Date | null;
	tools: Record<string, number>;
	/** The subagent that started this one, when nested. */
	parentRef: string | null;
}

/** The view: header, then the slice's entries. Renders without a router or queries. */
export function SubagentView({
	project,
	info,
	entries,
	now,
	toolUseId,
	onSelectNode,
}: {
	project: string;
	info: SubagentHeaderInfo;
	/** The run's whole transcript; the slice is cut here. */
	entries: readonly AgentEvent[];
	now: number;
	/** The subagent's key: its starting `Agent` call's id. */
	toolUseId: string;
	onSelectNode?: (ref: string) => void;
}) {
	return (
		<div data-subagent-inspector="" className="flex min-h-0 flex-1 flex-col">
			<Header
				project={project}
				info={info}
				now={now}
				toolUseId={toolUseId}
				{...(onSelectNode ? { onSelectNode } : {})}
			/>
			<SliceList entries={entries} toolUseId={toolUseId} />
		</div>
	);
}

function Header({
	project,
	info,
	now,
	toolUseId,
	onSelectNode,
}: {
	project: string;
	info: SubagentHeaderInfo;
	now: number;
	toolUseId: string;
	onSelectNode?: (ref: string) => void;
}) {
	const look = SUB_LOOK[info.status];
	const end = info.endedAt?.getTime() ?? now;
	const tools = Object.entries(info.tools).sort((a, b) => b[1] - a[1]);
	const total = tools.reduce((n, [, c]) => n + c, 0);
	const link = (ref: string, label: string) =>
		onSelectNode ? (
			<button
				type="button"
				onClick={() => onSelectNode(ref)}
				className="mfw-focus min-w-0 truncate text-left"
				style={{ color: "var(--mfw-accent)" }}
			>
				{label}
			</button>
		) : (
			<AppLink
				to={href.node(project, ref)}
				className="min-w-0 truncate"
				style={{ color: "var(--mfw-accent)" }}
			>
				{label}
			</AppLink>
		);
	return (
		<div
			className="flex shrink-0 flex-col gap-1 border-b px-3 py-1.5"
			style={{
				borderColor: "var(--mfw-border)",
				fontSize: "var(--mfw-text-xs)",
				color: "var(--mfw-fg-muted)",
			}}
		>
			<nav
				aria-label="Lineage"
				className="flex min-w-0 flex-wrap items-center gap-1"
			>
				{link(`run:${info.runId}`, "run")}
				<span aria-hidden>›</span>
				{info.parentRef ? (
					<>
						{link(info.parentRef, "subagent")}
						<span aria-hidden>›</span>
					</>
				) : null}
				<TipSpan
					aria-current="page"
					className="min-w-0 truncate"
					style={{ color: "var(--mfw-fg)" }}
					tip={info.description}
				>
					{info.description}
				</TipSpan>
			</nav>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
				<StateGlyph look={look} showLabel />
				<TipSpan className="mfw-num" tip="subagent type">
					{info.agentType}
				</TipSpan>
				<span className="mfw-num">
					{formatDuration(end - info.startedAt.getTime())}
				</span>
				{total > 0 ? (
					<TipSpan
						className="mfw-num"
						tip={tools.map(([name, n]) => `${name} ×${n}`).join(" · ")}
					>
						{total} tool call{total === 1 ? "" : "s"}
					</TipSpan>
				) : null}
				<span className="mfw-num" style={{ color: "var(--mfw-fg-faint)" }}>
					{toolUseId}
				</span>
			</div>
		</div>
	);
}

function flip(set: ReadonlySet<string>, key: string): Set<string> {
	const next = new Set(set);
	if (next.has(key)) next.delete(key);
	else next.add(key);
	return next;
}

/** The slice's blocks. Finished subagents nested inside collapse as in the full transcript. */
function SliceList({
	entries,
	toolUseId,
}: {
	entries: readonly AgentEvent[];
	toolUseId: string;
}) {
	const [toggled, setToggled] = useState<Set<string>>(() => new Set());
	const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
	const { items, groups } = useMemo(() => {
		const built = buildItems(subagentSlice(entries, toolUseId));
		return { items: built, groups: subagentGroups(built) };
	}, [entries, toolUseId]);
	// The subagent being inspected is always open, finished or not.
	const shown = useMemo(() => {
		const own = groups.get(toolUseId);
		const open =
			own && !isSubagentOpen(own, toggled) ? flip(toggled, toolUseId) : toggled;
		return visibleItems(items, open, groups);
	}, [items, toggled, groups, toolUseId]);
	// Entries sit one level below the subagent's own call: depth is relative to it.
	const base = ancestry(
		groups.get(toolUseId)?.parentKey ?? undefined,
		groups,
	).length;
	if (items.length === 0) {
		return (
			<Empty
				title="No entries yet"
				description="This subagent has not written anything to the run's transcript."
			/>
		);
	}
	return (
		<div className="min-h-0 flex-1 overflow-auto px-2 py-1" data-slice="">
			{shown.map((item) => {
				const own = item.kind === "tool" && item.id === toolUseId;
				const sub =
					item.kind === "tool" && !own && groups.get(item.id)?.entries
						? groups.get(item.id)
						: undefined;
				return (
					<TranscriptEntry
						key={item.seq}
						item={item}
						depth={own ? 0 : Math.max(0, depthOf(item, groups) - base - 1)}
						{...(sub
							? {
									subagent: {
										entries: sub.entries,
										tools: sub.tools,
										finished: sub.finished,
										open: isSubagentOpen(sub, toggled),
										onToggle: () => setToggled((p) => flip(p, sub.key)),
									},
								}
							: {})}
						expanded={own || expanded.has(item.seq)}
						onToggle={() =>
							setExpanded((prev) => {
								const next = new Set(prev);
								if (next.has(item.seq)) next.delete(item.seq);
								else next.add(item.seq);
								return next;
							})
						}
					/>
				);
			})}
		</div>
	);
}

/** Connected: the subagent's row from `node.get`, the run's stream, the slice. */
export function SubagentInspector({
	project,
	runId,
	toolUseId,
	onSelectNode,
}: {
	project: string;
	runId: string;
	toolUseId: string;
	onSelectNode?: (ref: string) => void;
}) {
	const trpc = useTRPC();
	const ref = `sub:${runId}/${toolUseId}`;
	const node = useQuery(trpc.node.get.queryOptions({ project, ref }));
	const run = useQuery(trpc.runs.get.queryOptions({ project, runId }));
	const stream = useRunStream(project, runId, {
		runState: run.data?.state ?? null,
	});
	const sub = node.data?.sub;

	if (node.error) {
		return (
			<ErrorState
				title="Could not load the subagent"
				error={node.error}
				onRetry={() => void node.refetch()}
			/>
		);
	}
	if (node.isLoading || !sub) return <LoadingRows rows={6} />;
	return (
		<SubagentView
			project={project}
			info={{
				runId,
				agentType: sub.agentType,
				description: sub.description,
				status: sub.status,
				startedAt: sub.startedAt,
				endedAt: sub.endedAt,
				tools: sub.tools,
				parentRef: node.data?.parent?.startsWith("sub:")
					? node.data.parent
					: null,
			}}
			entries={stream.entries}
			now={Date.now()}
			toolUseId={toolUseId}
			{...(onSelectNode ? { onSelectNode } : {})}
		/>
	);
}
