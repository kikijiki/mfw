import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, X } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Button } from "~/components/ui/button";
import { TipSpan } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { AppLink } from "../../components/AppLink";
import { Empty } from "../../components/Empty";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { useKeyBindings } from "../../lib/keyboard";
import {
	formatNodeRef,
	type NodeKind,
	type ParsedNodeRef,
	parseNodeRef,
} from "../../lib/nodeRef";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import type { BrainDecision } from "../brain/brain";
import { ScrubBanner, scrubbedAt } from "../flow/TimeCursor";
import { TaskPage, type TaskTab } from "../tasks/TaskPage";
import { BrainInspector, type BrainTab } from "./BrainInspector";
import { DecisionRow } from "./DecisionRow";
import {
	type DockSide,
	dockLayout,
	type InspectorPresentation,
	inspectorBindings,
} from "./dock";
import { GroupCompare } from "./GroupCompare";
import { RunInspector } from "./RunInspector";
import { SubagentInspector } from "./SubagentInspector";
import { TaskActions } from "./TaskActions";

/**
 * The inspector: one frame for any node (design §7). A header (what it is,
 * actions), tabs that vary by node kind, and a body. It is docked beside a
 * lens (`?node=`), shown in the task overlay's sheet, or the whole page
 * (`/p/:project/n/:ref`); the frame is identical, only `presentation` differs.
 *
 * The bodies are the screens that already exist (the task editor, the run
 * transcript). Kinds with no inspector yet say so rather than render nothing.
 */

export interface InspectorTab {
	id: string;
	label: string;
}

/** Tabs per node kind. The first is the default; later items add Story, Changes and the rest. */
export const INSPECTOR_TABS: Record<NodeKind, readonly InspectorTab[]> = {
	task: [
		{ id: "story", label: "Story" },
		{ id: "definition", label: "Definition" },
		{ id: "changes", label: "Changes" },
	],
	run: [{ id: "transcript", label: "Transcript" }],
	brain: [
		{ id: "decisions", label: "Decisions" },
		{ id: "turns", label: "Turns" },
		{ id: "plan", label: "Plan" },
		{ id: "session", label: "Session" },
	],
	group: [],
	// A brain turn is a run: its inspector is the run's transcript.
	turn: [{ id: "transcript", label: "Transcript" }],
	sub: [],
	decision: [],
	merge: [],
};

/** The tab to show: the requested one if this kind has it, else the kind's first. */
export function resolveTab(kind: NodeKind, requested?: string): string | null {
	const tabs = INSPECTOR_TABS[kind];
	return tabs.find((t) => t.id === requested)?.id ?? tabs[0]?.id ?? null;
}

const KIND_LABEL: Record<NodeKind, string> = {
	brain: "Brain",
	task: "Task",
	group: "Group",
	run: "Run",
	turn: "Brain turn",
	sub: "Subagent",
	decision: "Decision",
	merge: "Merge",
};

/** The id part of a ref, as shown in the header. */
function refId(ref: ParsedNodeRef): string {
	switch (ref.kind) {
		case "brain":
			return "";
		case "sub":
			return `${ref.runId}/${ref.callId}`;
		default:
			return String(ref.id);
	}
}

/** Header, tab strip and body slot; no data of its own, so it renders in a test without a router. */
export function InspectorFrame({
	parsed,
	presentation,
	tab,
	onTab,
	actions,
	leading,
	scrub,
	children,
}: {
	parsed: ParsedNodeRef;
	presentation: InspectorPresentation;
	tab: string | null;
	onTab?: (tab: string) => void;
	actions?: ReactNode;
	/** Before the kind label: the page presentation's way back. */
	leading?: ReactNode;
	/** Set while the view is scrubbed to a past instant: a banner, and the body is read-only. */
	scrub?: { at: number; now: number; onLive: () => void } | null;
	children: ReactNode;
}) {
	const tabs = INSPECTOR_TABS[parsed.kind];
	const id = refId(parsed);
	return (
		<section
			aria-label={`${KIND_LABEL[parsed.kind]} inspector`}
			data-presentation={presentation}
			className="flex min-h-0 min-w-0 flex-1 flex-col"
			style={{ color: "var(--mfw-fg)" }}
		>
			<header
				className={cn(
					"flex shrink-0 items-center gap-2 border-b px-3 py-1.5",
					// The sheet draws its own close button in this corner.
					presentation === "sheet" && "pr-12",
				)}
				style={{ borderColor: "var(--mfw-border)" }}
			>
				{leading}
				<span
					className="uppercase"
					style={{
						color: "var(--mfw-fg-faint)",
						fontSize: "var(--mfw-text-2xs)",
						letterSpacing: "0.06em",
					}}
				>
					{KIND_LABEL[parsed.kind]}
				</span>
				{id ? (
					<TipSpan className="mfw-num min-w-0 truncate" tip={id} clipped>
						{id}
					</TipSpan>
				) : null}
				<span className="ml-auto flex shrink-0 items-center gap-1">
					{actions}
				</span>
			</header>
			{tabs.length > 1 ? (
				<div
					role="tablist"
					className="flex shrink-0 gap-1 border-b px-2"
					style={{ borderColor: "var(--mfw-border)" }}
				>
					{tabs.map((t) => (
						<button
							key={t.id}
							type="button"
							role="tab"
							aria-selected={t.id === tab}
							onClick={() => onTab?.(t.id)}
							className="mfw-focus px-2 py-1"
							style={{
								fontSize: "var(--mfw-text-xs)",
								color: t.id === tab ? "var(--mfw-fg)" : "var(--mfw-fg-muted)",
								borderBottom:
									t.id === tab
										? "2px solid var(--mfw-accent)"
										: "2px solid transparent",
							}}
						>
							{t.label}
						</button>
					))}
				</div>
			) : null}
			{scrub ? (
				<ScrubBanner
					at={scrub.at}
					now={scrub.now}
					onLive={scrub.onLive}
					note="The tree is as of then; the details below are current."
				/>
			) : null}
			<div className="flex min-h-0 flex-1 flex-col overflow-auto">
				{scrub ? (
					// A disabled fieldset disables every control inside it: you cannot steer the past.
					<fieldset
						disabled
						data-read-only=""
						className="m-0 flex min-h-0 min-w-0 flex-1 flex-col border-0 p-0"
					>
						{children}
					</fieldset>
				) : (
					children
				)}
			</div>
		</section>
	);
}

/** An inspector pane beside (or under) a lens, per the dock side. */
export function InspectorDockLayout({
	side,
	inspector,
	children,
}: {
	side: DockSide;
	/** The inspector, or `null` when nothing is selected. */
	inspector: ReactNode;
	/** The lens. */
	children: ReactNode;
}) {
	const layout = dockLayout(side);
	return (
		<div className={layout.container} data-dock={inspector ? side : "none"}>
			<div className="min-h-0 min-w-0 flex-1">{children}</div>
			{inspector ? (
				<aside
					className={layout.pane}
					style={{ borderColor: "var(--mfw-border)" }}
				>
					{inspector}
				</aside>
			) : null}
		</div>
	);
}

export function Inspector({
	project,
	nodeRef,
	presentation,
	tab,
	onTab,
	onClose,
	onSelectNode,
	at,
	onLive,
}: {
	project: string;
	/** A node ref string (`task:MFW-41`). An invalid one renders a not-found state. */
	nodeRef: string;
	presentation: InspectorPresentation;
	tab?: string;
	onTab?: (tab: string) => void;
	onClose: () => void;
	/** Select another node in the lens beside the inspector (breadcrumb, sibling switcher). Absent, those links open the node as a page. */
	onSelectNode?: (ref: string) => void;
	/** The `t` search value. A past instant makes the inspector read-only with a banner; absent or future is live. */
	at?: string | undefined;
	/** Clear `t` (the banner's "Back to live"). */
	onLive?: () => void;
}) {
	useKeyBindings(inspectorBindings({ presentation, onClose }));
	const now = Date.now();
	const scrubAt = scrubbedAt(at, now);
	const scrub =
		scrubAt === null
			? null
			: { at: scrubAt, now, onLive: onLive ?? (() => {}) };
	const parsed = parseNodeRef(nodeRef);
	// The sheet has no URL to keep the tab in, so it holds it here.
	const [localTab, setLocalTab] = useState<string | undefined>();
	const requested = tab ?? localTab;

	if (!parsed) {
		return (
			<Empty
				title="Not a node"
				description={`"${nodeRef}" is not a valid node reference. Refs look like task:MFW-41 or run:01J…`}
			/>
		);
	}

	const actions = (
		<>
			{parsed.kind === "task" ? (
				<TaskActions project={project} taskId={parsed.id} />
			) : null}
			{presentation !== "page" ? (
				<AppLink
					to={href.node(project, formatNodeRef(parsed), { tab })}
					title="Open as a page"
					aria-label="Open as a page"
					className="inline-flex size-6 items-center justify-center"
				>
					<ExternalLink aria-hidden className="size-3.5" />
				</AppLink>
			) : null}
			{presentation === "dock" ? (
				<Button
					variant="ghost"
					size="icon-sm"
					onClick={onClose}
					aria-label="Close inspector"
				>
					<X aria-hidden />
				</Button>
			) : null}
		</>
	);

	return (
		<InspectorFrame
			parsed={parsed}
			presentation={presentation}
			tab={resolveTab(parsed.kind, requested)}
			onTab={onTab ?? setLocalTab}
			actions={actions}
			leading={
				presentation === "page" ? (
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={onClose}
						aria-label="Back"
					>
						<ArrowLeft aria-hidden />
					</Button>
				) : null
			}
			scrub={scrub}
		>
			<InspectorBody
				project={project}
				parsed={parsed}
				tab={resolveTab(parsed.kind, requested)}
				{...(onSelectNode ? { onSelectNode } : {})}
			/>
		</InspectorFrame>
	);
}

function InspectorBody({
	project,
	parsed,
	tab,
	onSelectNode,
}: {
	project: string;
	parsed: ParsedNodeRef;
	tab: string | null;
	onSelectNode?: (ref: string) => void;
}) {
	switch (parsed.kind) {
		case "task":
			return (
				<TaskPage
					key={`${project}:${parsed.id}`}
					project={project}
					taskId={parsed.id}
					tab={(tab ?? "story") as TaskTab}
				/>
			);
		case "run":
		case "turn":
			return (
				<RunBody
					key={`${project}:${parsed.id}`}
					project={project}
					runId={parsed.id}
					{...(onSelectNode ? { onSelectNode } : {})}
				/>
			);
		case "sub":
			return (
				<SubagentInspector
					key={`${project}:${parsed.runId}/${parsed.callId}`}
					project={project}
					runId={parsed.runId}
					toolUseId={parsed.callId}
					{...(onSelectNode ? { onSelectNode } : {})}
				/>
			);
		case "brain":
			return (
				<BrainInspector
					project={project}
					tab={(tab ?? "decisions") as BrainTab}
				/>
			);
		case "decision":
			return <DecisionBody project={project} id={parsed.id} />;
		case "group":
			// `group:ended:<task>` is the Flow's fold of old runs, not an attempt group.
			if (parsed.id.startsWith("ended:")) {
				return (
					<Empty
						title="Earlier runs"
						description="These are the task's older runs, folded in the Flow. Open the task to see them in its Story."
					/>
				);
			}
			return (
				<GroupCompare
					key={`${project}:${parsed.id}`}
					project={project}
					groupId={parsed.id}
					{...(onSelectNode ? { onSelectNode } : {})}
				/>
			);
		default:
			return (
				<Empty
					title={`${KIND_LABEL[parsed.kind]} inspector`}
					description="This node can be linked and selected; its inspector arrives in a later phase."
				/>
			);
	}
}

/**
 * The run body: lineage header and state band over the transcript. The
 * transcript keeps its search box as local state here; the full run page
 * keeps it in the URL.
 */
function RunBody({
	project,
	runId,
	onSelectNode,
}: {
	project: string;
	runId: string;
	onSelectNode?: (ref: string) => void;
}) {
	const [query, setQuery] = useState("");
	return (
		<RunInspector
			project={project}
			runId={runId}
			query={query}
			onQueryChange={setQuery}
			{...(onSelectNode ? { onSelectNode } : {})}
		/>
	);
}

/** One decision by id (a marker or a Story row links here): the row, expanded. */
function DecisionBody({ project, id }: { project: string; id: number }) {
	const trpc = useTRPC();
	const node = useQuery(
		trpc.node.get.queryOptions({ project, ref: `decision:${id}` }),
	);
	if (node.isPending) return <LoadingRows rows={2} />;
	if (node.isError) {
		return (
			<ErrorState error={node.error} onRetry={() => void node.refetch()} />
		);
	}
	return (
		<ul className="m-0 list-none p-0">
			<DecisionRow
				project={project}
				decision={node.data.detail as unknown as BrainDecision}
				defaultOpen
			/>
		</ul>
	);
}
