import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { GitMerge, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { AppLink } from "../../components/AppLink";
import { Empty } from "../../components/Empty";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { Chip, Panel } from "../../components/Page";
import { RelativeTime } from "../../components/RelativeTime";
import { useGo } from "../../lib/nav";
import type { RouterOutputs } from "../../lib/trpc";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import {
	AheadBehind,
	BranchLink,
	ChangedFiles,
	RefChips,
	RevisionDiff,
	rowsOfFiles,
	ShaLink,
	TaskLinks,
} from "./parts";
import { RefPicker } from "./RefPicker";
import { assignLanes, type GraphRow, graphWidth } from "./repoModel";

type Commit = RouterOutputs["repo"]["commits"]["commits"][number];

const LANE = 14;
const ROW = 34;
const LANE_COLORS = [
	"var(--mfw-accent)",
	"var(--mfw-ok)",
	"var(--mfw-info)",
	"var(--mfw-warn)",
	"var(--mfw-critical)",
	"var(--mfw-fg-muted)",
];
const colorOf = (lane: number) =>
	LANE_COLORS[lane % LANE_COLORS.length] as string;
const xOf = (lane: number) => lane * LANE + LANE / 2 + 2;

/** One row's slice of the graph. Rows are flush, so the lines meet. */
function GraphCell({
	row,
	lanes,
	merge,
}: {
	row: GraphRow;
	lanes: number;
	merge: boolean;
}) {
	const mid = ROW / 2;
	const w = lanes * LANE + 4;
	const curve = (from: number, to: number, y0: number, y1: number) =>
		`M ${xOf(from)} ${y0} C ${xOf(from)} ${(y0 + y1) / 2}, ${xOf(to)} ${(y0 + y1) / 2}, ${xOf(to)} ${y1}`;
	return (
		<svg
			role="img"
			aria-label={merge ? "merge commit" : "commit"}
			width={w}
			height={ROW}
			viewBox={`0 0 ${w} ${ROW}`}
			className="shrink-0"
		>
			{row.through.map((l) => (
				<line
					key={`t${l}`}
					x1={xOf(l)}
					x2={xOf(l)}
					y1={0}
					y2={ROW}
					stroke={colorOf(l)}
					strokeWidth={1.5}
				/>
			))}
			{row.hasChildAbove ? (
				<line
					x1={xOf(row.lane)}
					x2={xOf(row.lane)}
					y1={0}
					y2={mid}
					stroke={colorOf(row.lane)}
					strokeWidth={1.5}
				/>
			) : null}
			{row.mergesIn.map((l) => (
				<path
					key={`m${l}`}
					d={curve(l, row.lane, 0, mid)}
					fill="none"
					stroke={colorOf(l)}
					strokeWidth={1.5}
				/>
			))}
			{row.parentLanes.map((p, i) =>
				p === row.lane ? (
					<line
						// biome-ignore lint/suspicious/noArrayIndexKey: parents are positional
						key={`p${i}`}
						x1={xOf(row.lane)}
						x2={xOf(row.lane)}
						y1={mid}
						y2={ROW}
						stroke={colorOf(p)}
						strokeWidth={1.5}
					/>
				) : (
					<path
						// biome-ignore lint/suspicious/noArrayIndexKey: parents are positional
						key={`p${i}`}
						d={curve(row.lane, p, mid, ROW)}
						fill="none"
						stroke={colorOf(p)}
						strokeWidth={1.5}
					/>
				),
			)}
			<circle
				cx={xOf(row.lane)}
				cy={mid}
				r={merge ? 4.5 : 4}
				fill={merge ? "var(--mfw-bg-raised)" : colorOf(row.lane)}
				stroke={colorOf(row.lane)}
				strokeWidth={2}
			/>
		</svg>
	);
}

/** A log with its graph. Pass one or several pages concatenated. */
export function CommitList({
	project,
	commits,
	integrationBranch,
	graph = true,
	activeSha,
}: {
	project: string;
	commits: readonly Commit[];
	integrationBranch: string;
	graph?: boolean;
	activeSha?: string;
}) {
	const rows = useMemo(() => assignLanes(commits), [commits]);
	const lanes = useMemo(() => graphWidth(rows), [rows]);
	return (
		<ul>
			{commits.map((c, i) => {
				const row = rows[i] as GraphRow;
				return (
					<li
						key={c.sha}
						className="flex items-center gap-2 border-b pr-2"
						style={{
							borderColor: "var(--mfw-border)",
							minHeight: ROW,
							background:
								c.sha === activeSha ? "var(--mfw-bg-hover)" : undefined,
						}}
					>
						{graph ? (
							<GraphCell row={row} lanes={lanes} merge={c.parents.length > 1} />
						) : null}
						<div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 py-1">
							<AppLink
								to={href.repoCommit(project, c.sha)}
								className="min-w-0 max-w-full truncate"
								title={c.subject}
								clipped
							>
								{c.subject || "(no message)"}
							</AppLink>
							<RefChips
								project={project}
								refs={c.refs}
								integrationBranch={integrationBranch}
							/>
							<TaskLinks project={project} ids={c.taskIds} />
						</div>
						<span
							className="hidden shrink-0 sm:inline"
							style={{
								color: "var(--mfw-fg-faint)",
								fontSize: "var(--mfw-text-xs)",
							}}
						>
							{c.author}
						</span>
						<span
							className="hidden shrink-0 md:inline"
							style={{
								color: "var(--mfw-fg-faint)",
								fontSize: "var(--mfw-text-xs)",
							}}
						>
							<RelativeTime value={c.time * 1000} />
						</span>
						<ShaLink project={project} sha={c.sha} className="shrink-0" />
					</li>
				);
			})}
		</ul>
	);
}

export function CommitsPage({
	project,
	refName,
	q,
	path,
}: {
	project: string;
	refName: string | undefined;
	q: string | undefined;
	path: string | undefined;
}) {
	const trpc = useTRPC();
	const go = useGo();
	const refs = useQuery(trpc.repo.refs.queryOptions({ project }));
	const integration = refs.data?.integrationBranch;
	const effective = refName ?? refs.data?.head.branch ?? integration;
	const [draft, setDraft] = useState(q ?? "");
	const [firstParent, setFirstParent] = useState(false);

	const log = useInfiniteQuery({
		...trpc.repo.commits.infiniteQueryOptions(
			{
				project,
				ref: effective ?? "HEAD",
				search: q,
				path,
				limit: 50,
				firstParent,
			},
			{ getNextPageParam: (last) => last.nextCursor ?? undefined },
		),
		enabled: Boolean(effective),
		retry: false,
	});
	const commits = useMemo(
		() => log.data?.pages.flatMap((p) => p.commits) ?? [],
		[log.data],
	);

	const to = (next: { ref?: string; q?: string; path?: string }) =>
		href.repoCommits(project, {
			ref: effective,
			q,
			path,
			...next,
		});

	return (
		<div className="flex min-h-0 flex-col gap-3 p-3">
			<div className="flex flex-wrap items-center gap-2">
				<RefPicker
					label="History of"
					value={effective}
					refs={refs.data}
					onChange={(next) => go(to({ ref: next }))}
				/>
				<form
					className="flex items-center gap-1"
					onSubmit={(e) => {
						e.preventDefault();
						go(to({ q: draft.trim() || undefined }));
					}}
				>
					<Search
						aria-hidden
						className="size-3.5"
						style={{ color: "var(--mfw-fg-faint)" }}
					/>
					<input
						aria-label="Search commit messages"
						placeholder="Search messages"
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						className="mfw-focus min-h-7 w-56 border px-2"
						style={{
							background: "var(--mfw-bg-raised)",
							borderColor: "var(--mfw-border)",
							borderRadius: "var(--mfw-radius-sm)",
							fontSize: "var(--mfw-text-xs)",
						}}
					/>
				</form>
				{path ? (
					<Chip title="History limited to this path">
						{path}{" "}
						<AppLink to={to({ path: undefined })} aria-label="Clear path">
							clear
						</AppLink>
					</Chip>
				) : null}
				<Button
					size="xs"
					variant="ghost"
					aria-pressed={firstParent}
					title="Follow only the first parent of merges: the integration branch's own line."
					onClick={() => setFirstParent((v) => !v)}
				>
					First parent
				</Button>
			</div>
			<Panel pad={false} title={`History of ${effective ?? "..."}`}>
				{log.isLoading ? (
					<div className="p-3">
						<LoadingRows rows={10} />
					</div>
				) : log.error ? (
					<div className="p-3">
						<ErrorState
							title="Could not read the history"
							error={log.error}
							onRetry={() => void log.refetch()}
						/>
					</div>
				) : commits.length === 0 ? (
					<Empty
						title="No commits"
						reason={q || path ? "filtered" : "none"}
						description={q || path ? "Nothing matches this search." : undefined}
					/>
				) : (
					<>
						<CommitList
							project={project}
							commits={commits}
							integrationBranch={integration ?? ""}
						/>
						{log.hasNextPage ? (
							<div className="p-2">
								<Button
									size="sm"
									variant="outline"
									disabled={log.isFetchingNextPage}
									onClick={() => void log.fetchNextPage()}
								>
									{log.isFetchingNextPage ? "Loading..." : "Load more"}
								</Button>
							</div>
						) : null}
					</>
				)}
			</Panel>
		</div>
	);
}

export function CommitPage({
	project,
	sha,
	f,
}: {
	project: string;
	sha: string;
	f: string | undefined;
}) {
	const trpc = useTRPC();
	const go = useGo();
	const commit = useQuery({
		...trpc.repo.commit.queryOptions({ project, sha }),
		retry: false,
	});
	const refs = useQuery(trpc.repo.refs.queryOptions({ project }));
	const integration = refs.data?.integrationBranch ?? "";

	if (commit.isLoading) {
		return (
			<div className="p-3">
				<LoadingRows rows={8} />
			</div>
		);
	}
	if (commit.error || !commit.data) {
		const code = (commit.error as { data?: { code?: string } } | null)?.data
			?.code;
		return (
			<div className="p-3">
				{code === "NOT_FOUND" || code === "BAD_REQUEST" ? (
					<Empty
						title="No such commit."
						description={`${sha} is not a commit in this repository.`}
						action={
							<Button size="sm" variant="outline" asChild>
								<AppLink to={href.repoCommits(project)}>
									Back to history
								</AppLink>
							</Button>
						}
					/>
				) : (
					<ErrorState
						title="Could not read this commit"
						error={commit.error}
						onRetry={() => void commit.refetch()}
					/>
				)}
			</div>
		);
	}
	const c = commit.data;
	const [head, ...body] = c.message.split("\n");
	return (
		<div className="flex min-h-0 flex-col gap-3 p-3">
			<Panel pad>
				<div className="flex flex-col gap-2">
					<div className="flex flex-wrap items-center gap-2">
						{c.isMerge ? (
							<Chip tone="info">
								<GitMerge aria-hidden className="size-3" />
								merge
							</Chip>
						) : null}
						<h2 className="min-w-0 break-words font-semibold">{head}</h2>
					</div>
					{body.join("\n").trim() ? (
						<pre
							className="whitespace-pre-wrap break-words"
							style={{
								color: "var(--mfw-fg-muted)",
								fontFamily: "var(--mfw-font-ui)",
								fontSize: "var(--mfw-text-xs)",
							}}
						>
							{body.join("\n").trim()}
						</pre>
					) : null}
					<div
						className="flex flex-wrap items-center gap-x-3 gap-y-1"
						style={{
							color: "var(--mfw-fg-muted)",
							fontSize: "var(--mfw-text-xs)",
						}}
					>
						<span>{c.author}</span>
						<RelativeTime value={c.time * 1000} />
						<span className="mfw-num">{c.sha}</span>
						{c.parents.length > 0 ? (
							<span className="flex items-center gap-1">
								parent{c.parents.length > 1 ? "s" : ""}
								{c.parents.map((p) => (
									<ShaLink key={p} project={project} sha={p} />
								))}
							</span>
						) : (
							<span>root commit</span>
						)}
						<TaskLinks project={project} ids={c.taskIds} />
						<RefChips
							project={project}
							refs={c.refs}
							integrationBranch={integration}
						/>
						<AppLink to={href.files(project, { ref: c.sha })}>
							Browse files at this commit
						</AppLink>
					</div>
				</div>
			</Panel>

			<Panel
				pad={false}
				title={`${c.diff.files.length} file${c.diff.files.length === 1 ? "" : "s"} changed${c.isMerge ? " (against the first parent)" : ""}`}
				actions={
					<span
						className="mfw-num flex gap-2"
						style={{ fontSize: "var(--mfw-text-xs)" }}
					>
						<span style={{ color: "var(--mfw-ok)" }}>+{c.diff.added}</span>
						<span style={{ color: "var(--mfw-critical)" }}>
							−{c.diff.deleted}
						</span>
					</span>
				}
			>
				{c.diff.files.length === 0 ? (
					<Empty title="No file changes in this commit." />
				) : (
					<ChangedFiles
						rows={rowsOfFiles(c.diff.files)}
						truncated={c.diff.truncated}
						initialOpen={f}
						onFocus={(path) =>
							go(href.repoCommit(project, c.sha, { f: path }), {
								replace: true,
							})
						}
						renderDiff={(row) => (
							<RevisionDiff
								project={project}
								from={c.base}
								to={c.sha}
								path={row.path}
								oldPath={row.oldPath}
							/>
						)}
					/>
				)}
			</Panel>
		</div>
	);
}

/** "3 ahead, 1 behind" with the branch link; shared by compare and branch pages. */
export function CompareSummary({
	project,
	a,
	b,
	ahead,
	behind,
	mergeBase,
	mode,
}: {
	project: string;
	a: string;
	b: string;
	ahead: number;
	behind: number;
	mergeBase: string | null;
	mode: "three-dot" | "two-dot";
}) {
	return (
		<div
			className="flex flex-wrap items-center gap-x-3 gap-y-1"
			style={{ fontSize: "var(--mfw-text-xs)", color: "var(--mfw-fg-muted)" }}
		>
			<BranchLink project={project} name={b} />
			<AheadBehind ahead={ahead} behind={behind} />
			<span>
				{mode === "three-dot" ? "since it left" : "compared with"}{" "}
				<BranchLink project={project} name={a} />
			</span>
			{mergeBase ? (
				<span>
					merge base <ShaLink project={project} sha={mergeBase} />
				</span>
			) : (
				<span>no common ancestor</span>
			)}
		</div>
	);
}
