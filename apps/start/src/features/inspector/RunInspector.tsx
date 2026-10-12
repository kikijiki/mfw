import type { FlowNode } from "@mfw/daemon/flow";
import { useQuery } from "@tanstack/react-query";
import { Fragment, type ReactNode, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { AppLink } from "../../components/AppLink";
import { lookForRun, RELATION_LOOK } from "../../components/agent/look";
import { StateGlyph } from "../../components/agent/StateGlyph";
import { Glyph } from "../../components/icons";
import { useNow } from "../../components/RelativeTime";
import type { RunState } from "../../components/StatusPill";
import { formatAbsolute } from "../../lib/format";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import { type FlowNodeIn, lineageOf } from "../flow/flowModel";
import { refId } from "../flow/NodeRow";
import { RunPage } from "../transcript/RunPage";
import { StateBand } from "./StateBand";

/**
 * The run inspector (design §7.2): the transcript page under a lineage
 * header (where this run sits and which runs are its siblings) and a state
 * band (what it was doing, when; scrub it to move the transcript).
 *
 * Lineage comes from `flow.tree`, the same cache the Flow lens fills, so the
 * header costs no request when a lens is already open. A run folded out of
 * the tree falls back to its task from `runs.get`.
 */

/** What a run was spawned by when it has no parent run. */
export function originLabel(
	originRef: string | null | undefined,
): string | null {
	if (!originRef) return null;
	const [kind, ...rest] = originRef.split(":");
	const id = rest.join(":");
	switch (kind) {
		case "session":
			return `escalation ${id.slice(-8)}`;
		case "trigger":
			return `trigger ${id.slice(-8)}`;
		case "clarify":
			return `answer to ${id.slice(-8)}`;
		case "human":
			return `you (${id})`;
		default:
			return originRef;
	}
}

interface PrunedSummary {
	lastAssistant?: string | null;
	toolCalls?: Record<string, number>;
	filesTouched?: string[];
	firstError?: string | null;
	events?: number;
	prunedAt?: number;
}

/** The kept summary of a pruned transcript, or `null` while the transcript exists. */
export function prunedSummary(
	summary: Record<string, unknown> | null | undefined,
): PrunedSummary | null {
	if (!summary) return null;
	return summary as PrunedSummary;
}

export function RunInspector({
	project,
	runId,
	query,
	onQueryChange,
	onSelectNode,
}: {
	project: string;
	runId: string;
	query: string;
	onQueryChange: (q: string) => void;
	/** Select another node in the surrounding lens; absent, links open the node as a page. */
	onSelectNode?: (ref: string) => void;
}) {
	const trpc = useTRPC();
	const now = useNow();
	const runQuery = useQuery(trpc.runs.get.queryOptions({ project, runId }));
	const run = runQuery.data ?? null;
	const tree = useQuery(trpc.flow.tree.queryOptions({ project }));
	const ref = `run:${runId}`;
	const lineage = useMemo(
		() => (tree.data ? lineageOf(tree.data.nodes, ref) : null),
		[tree.data, ref],
	);

	const start = run?.startedAt.getTime() ?? now;
	const end = run?.finishedAt?.getTime() ?? now;
	// A stable upper bound while live, so the key does not move with the clock.
	const bucket = 10 * 60_000;
	const stepsQuery = useQuery(trpc.runs.steps.queryOptions({ project, runId }));
	const spans = useQuery({
		...trpc.flow.spans.queryOptions({
			project,
			from: new Date(Math.floor(start / bucket) * bucket - bucket),
			to: new Date(
				run?.finishedAt
					? run.finishedAt.getTime() + bucket
					: Math.floor(now / bucket) * bucket + 2 * bucket,
			),
			subjects: [ref],
		}),
		enabled: run !== null,
	});

	const [cursor, setCursor] = useState<number | null>(null);
	const pruned = prunedSummary(run?.transcriptSummary);

	// Crumbs: the tree's ancestors, or the task alone when the run is folded away.
	const crumbs: Crumb[] = lineage
		? lineage.crumbs
				.slice(0, -1)
				.map((n) => ({ ref: n.ref, label: crumbLabel(n) }))
		: run?.taskId
			? [
					{
						ref: `task:${run.taskId}`,
						label: `${run.taskId}${run.taskTitle ? ` ${run.taskTitle}` : ""}`,
					},
				]
			: [];

	return (
		<div className="flex h-full min-h-0 flex-col" data-run-inspector="">
			<LineageHeader
				project={project}
				runRef={ref}
				label={run?.label ?? runId.slice(-8)}
				crumbs={crumbs}
				family={lineage?.family ?? []}
				continues={lineage?.continues ?? null}
				spawnedByDecisionId={run?.spawnedByDecisionId ?? null}
				originRef={run?.originRef ?? null}
				{...(onSelectNode ? { onSelectNode } : {})}
			/>
			{run ? (
				<StateBand
					spans={spans.data?.spans ?? []}
					start={start}
					end={Math.max(end, start + 1000)}
					now={now}
					cursor={cursor}
					onScrub={setCursor}
				/>
			) : null}
			<div className="flex min-h-0 flex-1 flex-col">
				{pruned && run ? (
					<PrunedBody
						summary={pruned}
						steps={stepsQuery.data ?? []}
						state={run.state}
						model={run.model}
					/>
				) : (
					<RunPage
						project={project}
						runId={runId}
						query={query}
						onQueryChange={onQueryChange}
						scrollToTs={cursor}
					/>
				)}
			</div>
		</div>
	);
}

export interface Crumb {
	ref: string;
	label: string;
}

/**
 * Breadcrumb from the tree's parents, the sibling switcher across the run's
 * chain, and what it was spawned by or continues. Links select the node in
 * the surrounding lens when `onSelectNode` is given, else open it as a page.
 */
export function LineageHeader({
	project,
	runRef,
	label,
	crumbs,
	family,
	continues,
	spawnedByDecisionId,
	originRef,
	onSelectNode,
}: {
	project: string;
	runRef: string;
	label: string;
	crumbs: readonly Crumb[];
	family: readonly FlowNode[];
	continues: FlowNode | null;
	spawnedByDecisionId: number | null;
	originRef: string | null;
	onSelectNode?: (ref: string) => void;
}) {
	const link = (nodeRef: string, children: ReactNode, className?: string) =>
		onSelectNode ? (
			<button
				type="button"
				onClick={() => onSelectNode(nodeRef)}
				className={cn("mfw-focus min-w-0 truncate text-left", className)}
				style={{ color: "var(--mfw-accent)" }}
			>
				{children}
			</button>
		) : (
			<AppLink
				to={href.node(project, nodeRef)}
				className={cn("min-w-0 truncate", className)}
				style={{ color: "var(--mfw-accent)" }}
			>
				{children}
			</AppLink>
		);
	const origin = originLabel(originRef);
	const continuesIndex = continues
		? family.findIndex((n) => n.ref === continues.ref) + 1
		: 0;
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
				{crumbs.map((c) => (
					<Fragment key={c.ref}>
						{link(c.ref, c.label, "max-w-[14rem]")}
						<span aria-hidden>›</span>
					</Fragment>
				))}
				<span
					aria-current="page"
					className="mfw-num"
					style={{ color: "var(--mfw-fg)" }}
				>
					{label}
				</span>
			</nav>
			{family.length > 1 ? (
				<fieldset
					aria-label="Runs in this chain"
					className="m-0 flex min-w-0 flex-wrap items-center gap-1 border-0 p-0"
				>
					<span style={{ color: "var(--mfw-fg-faint)" }}>siblings</span>
					{family.map((n, i) => (
						<SiblingChip
							key={n.ref}
							node={n}
							index={i + 1}
							current={n.ref === runRef}
							link={link}
						/>
					))}
				</fieldset>
			) : null}
			{spawnedByDecisionId !== null || continues || origin ? (
				<div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
					{spawnedByDecisionId !== null
						? link(
								`decision:${spawnedByDecisionId}`,
								`spawned by brain decision ${spawnedByDecisionId}`,
							)
						: null}
					{continues ? (
						<span className="flex items-center gap-1">
							continues
							{link(
								continues.ref,
								`#${continuesIndex || "?"} ${continues.title}`,
							)}
						</span>
					) : null}
					{origin && spawnedByDecisionId === null && !continues ? (
						<span>from {origin}</span>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function crumbLabel(n: FlowNodeIn): string {
	if (n.kind === "run" || n.kind === "judge") return n.title;
	return `${refId(n.ref)} ${n.title}`.trim();
}

function SiblingChip({
	node,
	index,
	current,
	link,
}: {
	node: FlowNode;
	index: number;
	current: boolean;
	link: (ref: string, children: ReactNode, className?: string) => ReactNode;
}) {
	const run = node.run;
	const look = lookForRun({
		state: (run?.state ?? "completed") as RunState,
		activity: run?.activity ?? undefined,
	});
	const body = (
		<span className="inline-flex items-center gap-1">
			<StateGlyph look={look} />
			<span className="mfw-num">#{index}</span>
			{run && RELATION_LOOK[run.relation] ? (
				<Glyph
					name={RELATION_LOOK[run.relation]?.glyph ?? "dot"}
					label={RELATION_LOOK[run.relation]?.label}
					className="size-3"
				/>
			) : null}
			<span>{look.label}</span>
		</span>
	);
	return current ? (
		<span
			aria-current="true"
			className="inline-flex items-center border px-1.5 py-0.5"
			style={{
				color: "var(--mfw-fg)",
				borderColor: "var(--mfw-accent)",
				background: "var(--mfw-accent-subtle)",
				borderRadius: "var(--mfw-radius-sm)",
			}}
		>
			{body}
		</span>
	) : (
		<span
			className="inline-flex items-center border px-1.5 py-0.5"
			style={{
				borderColor: "var(--mfw-border)",
				borderRadius: "var(--mfw-radius-sm)",
			}}
		>
			{link(node.ref, body)}
		</span>
	);
}

/**
 * A run whose transcript directory was garbage collected: the summary written
 * first by gc, plus the completion steps and verdicts that live in the
 * database. Says so plainly rather than rendering an empty transcript.
 */
export function PrunedBody({
	summary,
	steps,
	state,
	model,
}: {
	summary: PrunedSummary;
	steps: readonly { step: string; status: string; error: string | null }[];
	state: string;
	model: string;
}) {
	const tools = Object.entries(summary.toolCalls ?? {}).sort(
		(a, b) => b[1] - a[1],
	);
	const files = summary.filesTouched ?? [];
	return (
		<div
			data-pruned=""
			className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3"
			style={{ fontSize: "var(--mfw-font-data)" }}
		>
			<p className="m-0" style={{ color: "var(--mfw-fg-muted)" }}>
				Transcript pruned
				{summary.prunedAt ? ` on ${formatAbsolute(summary.prunedAt)}` : ""}
				{": summary, steps, verdicts and diff stat kept."}
			</p>
			<dl className="m-0 flex flex-wrap gap-x-6 gap-y-1">
				<div>
					<dt style={{ color: "var(--mfw-fg-faint)" }}>outcome</dt>
					<dd className="m-0">{state.replace(/_/g, " ")}</dd>
				</div>
				<div>
					<dt style={{ color: "var(--mfw-fg-faint)" }}>model</dt>
					<dd className="m-0">{model}</dd>
				</div>
				{summary.events !== undefined ? (
					<div>
						<dt style={{ color: "var(--mfw-fg-faint)" }}>events</dt>
						<dd className="m-0 mfw-num">{summary.events}</dd>
					</div>
				) : null}
			</dl>
			{summary.firstError ? (
				<section aria-label="First error">
					<h3 className="m-0" style={{ color: "var(--mfw-critical)" }}>
						First error
					</h3>
					<pre className="m-0 whitespace-pre-wrap">{summary.firstError}</pre>
				</section>
			) : null}
			{summary.lastAssistant ? (
				<section aria-label="Last message">
					<h3 className="m-0" style={{ color: "var(--mfw-fg-faint)" }}>
						Last message
					</h3>
					<pre className="m-0 whitespace-pre-wrap">{summary.lastAssistant}</pre>
				</section>
			) : null}
			{tools.length > 0 ? (
				<section aria-label="Tool calls">
					<h3 className="m-0" style={{ color: "var(--mfw-fg-faint)" }}>
						Tool calls
					</h3>
					<p className="m-0 mfw-num">
						{tools.map(([name, n]) => `${name} ×${n}`).join(" · ")}
					</p>
				</section>
			) : null}
			{files.length > 0 ? (
				<section aria-label="Files touched">
					<h3 className="m-0" style={{ color: "var(--mfw-fg-faint)" }}>
						Files touched ({files.length})
					</h3>
					<ul className="m-0 list-none p-0 mfw-num">
						{files.map((f) => (
							<li key={f}>{f}</li>
						))}
					</ul>
				</section>
			) : null}
			{steps.length > 0 ? (
				<section aria-label="Completion steps">
					<h3 className="m-0" style={{ color: "var(--mfw-fg-faint)" }}>
						Completion
					</h3>
					<ul className="m-0 list-none p-0">
						{steps.map((s) => (
							<li key={s.step} className="mfw-num">
								{s.step}: {s.status}
								{s.error ? ` (${s.error})` : ""}
							</li>
						))}
					</ul>
				</section>
			) : null}
		</div>
	);
}
