import { useQuery } from "@tanstack/react-query";
import { FolderGit2, RefreshCw } from "lucide-react";

import { Button } from "~/components/ui/button";
import { AppLink } from "../../components/AppLink";
import { Empty } from "../../components/Empty";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { Chip, Field, Panel } from "../../components/Page";
import { useGo } from "../../lib/nav";
import type { RouterOutputs } from "../../lib/trpc";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import {
	AheadBehind,
	BranchLink,
	ChangedFiles,
	rowsOfWorktree,
	ShaLink,
	TaskLinks,
	WorktreeDiff,
} from "./parts";

type Worktree = RouterOutputs["repo"]["worktrees"]["worktrees"][number];

const FAINT = {
	color: "var(--mfw-fg-faint)",
	fontSize: "var(--mfw-text-xs)",
} as const;

function DirtyChip({ wt }: { wt: Worktree }) {
	if (!wt.exists) return <Chip tone="critical">missing on disk</Chip>;
	if (!wt.dirty) return <span style={FAINT}>status unavailable</span>;
	if (wt.dirty.changed === 0) return <Chip tone="ok">clean</Chip>;
	return (
		<Chip
			tone="warn"
			title="Uncommitted changes: modified, staged or untracked files"
		>
			{wt.dirty.changed}
			{wt.dirty.truncated ? "+" : ""} uncommitted
		</Chip>
	);
}

/** The run, merge job and wip archive a worktree is tied to. */
function Ownership({ project, wt }: { project: string; wt: Worktree }) {
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
			{wt.run ? (
				<>
					{wt.run.taskId ? (
						<TaskLinks project={project} ids={[wt.run.taskId]} />
					) : null}
					<AppLink
						to={href.run(project, wt.run.runId)}
						style={FAINT}
						title={`run ${wt.run.runId}`}
					>
						run {wt.run.live ? "live" : `ended (${wt.run.state})`}
					</AppLink>
				</>
			) : wt.primary ? (
				<span style={FAINT}>the project checkout</span>
			) : (
				<span style={FAINT}>not owned by an mfw run</span>
			)}
			{wt.mergeJob ? (
				<Chip
					tone={
						wt.mergeJob.state === "parked"
							? "critical"
							: wt.mergeJob.state === "merged"
								? "ok"
								: "info"
					}
					title={wt.mergeJob.error ?? undefined}
				>
					merge {wt.mergeJob.state}
				</Chip>
			) : null}
			{wt.wipBranches.map((w) => (
				<BranchLink key={w} project={project} name={w} />
			))}
			{wt.locked ? <Chip tone="neutral">locked</Chip> : null}
			{wt.prunable ? (
				<Chip tone="warn" title={wt.prunable}>
					prunable
				</Chip>
			) : null}
		</div>
	);
}

export function WorktreesPage({ project }: { project: string }) {
	const trpc = useTRPC();
	const data = useQuery({
		...trpc.repo.worktrees.queryOptions({ project }),
		refetchInterval: 15_000,
	});
	return (
		<div className="flex min-h-0 flex-col gap-3 p-3">
			<Panel
				pad={false}
				title={`${data.data?.worktrees.length ?? 0} worktrees, against ${data.data?.integrationBranch ?? "the integration branch"}`}
				actions={
					<Button
						size="icon-sm"
						variant="ghost"
						aria-label="Refresh"
						onClick={() => void data.refetch()}
					>
						<RefreshCw aria-hidden />
					</Button>
				}
			>
				{data.isLoading ? (
					<div className="p-3">
						<LoadingRows rows={5} />
					</div>
				) : data.error ? (
					<div className="p-3">
						<ErrorState
							title="Could not list worktrees"
							error={data.error}
							onRetry={() => void data.refetch()}
						/>
					</div>
				) : (data.data?.worktrees.length ?? 0) === 0 ? (
					<Empty icon={FolderGit2} title="No worktrees." />
				) : (
					<ul>
						{data.data?.worktrees.map((wt) => (
							<li
								key={wt.path}
								className="flex flex-col gap-1 border-b px-3 py-2"
								style={{ borderColor: "var(--mfw-border)" }}
							>
								<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
									<AppLink
										to={href.repoWorktree(project, wt.id)}
										className="mfw-num font-medium"
										title={wt.path}
									>
										{wt.displayPath}
									</AppLink>
									{wt.branch ? (
										<BranchLink project={project} name={wt.branch} />
									) : (
										<Chip>{wt.detached ? "detached HEAD" : "no branch"}</Chip>
									)}
									{wt.head ? <ShaLink project={project} sha={wt.head} /> : null}
									<span className="flex-1" />
									<AheadBehind ahead={wt.ahead} behind={wt.behind} />
									<DirtyChip wt={wt} />
								</div>
								<Ownership project={project} wt={wt} />
							</li>
						))}
					</ul>
				)}
			</Panel>
		</div>
	);
}

export function WorktreePage({
	project,
	id,
	f,
}: {
	project: string;
	id: string;
	f: string | undefined;
}) {
	const trpc = useTRPC();
	const go = useGo();
	const list = useQuery({
		...trpc.repo.worktrees.queryOptions({ project }),
		refetchInterval: 15_000,
	});
	const wt = list.data?.worktrees.find((w) => w.id === id);
	const changes = useQuery({
		...trpc.repo.worktreeChanges.queryOptions({ project, id }),
		enabled: wt?.exists === true,
		retry: false,
		refetchInterval: 15_000,
	});

	if (list.isLoading) {
		return (
			<div className="p-3">
				<LoadingRows rows={6} />
			</div>
		);
	}
	if (!wt) {
		return (
			<div className="p-3">
				<Empty
					icon={FolderGit2}
					title="No such worktree."
					description="It may have been cleaned up after its run finished."
					action={
						<Button size="sm" variant="outline" asChild>
							<AppLink to={href.repoWorktrees(project)}>All worktrees</AppLink>
						</Button>
					}
				/>
			</div>
		);
	}

	const rows = changes.data ? rowsOfWorktree(changes.data.files) : [];
	return (
		<div className="flex min-h-0 flex-col gap-3 p-3">
			<Panel pad>
				<div className="flex flex-col gap-2">
					<div className="flex flex-wrap items-center gap-2">
						<h2 className="mfw-num min-w-0 break-all font-semibold">
							{wt.displayPath}
						</h2>
						<DirtyChip wt={wt} />
					</div>
					<Field label="Path">
						<span className="mfw-num break-all">{wt.path}</span>
					</Field>
					<Field label="Branch">
						<span className="flex flex-wrap items-center gap-x-3">
							{wt.branch ? (
								<BranchLink project={project} name={wt.branch} />
							) : (
								<span>{wt.detached ? "detached HEAD" : "none"}</span>
							)}
							{wt.head ? <ShaLink project={project} sha={wt.head} /> : null}
							<AheadBehind ahead={wt.ahead} behind={wt.behind} />
						</span>
					</Field>
					<Field label="Owner">
						<Ownership project={project} wt={wt} />
					</Field>
					<div
						className="flex flex-wrap items-center gap-3"
						style={{ fontSize: "var(--mfw-text-xs)" }}
					>
						{wt.run ? (
							<AppLink to={href.files(project, { run: wt.run.runId })}>
								Browse the working copy
							</AppLink>
						) : wt.primary ? (
							<AppLink to={href.files(project)}>
								Browse the working copy
							</AppLink>
						) : null}
						{wt.branch ? (
							<AppLink to={href.repoBranch(project, wt.branch)}>
								Branch page
							</AppLink>
						) : null}
					</div>
				</div>
			</Panel>

			<Panel
				pad={false}
				title={
					changes.data
						? `Uncommitted changes: ${changes.data.files.length} file${changes.data.files.length === 1 ? "" : "s"} against HEAD`
						: "Uncommitted changes"
				}
				actions={
					changes.data ? (
						<span
							className="mfw-num flex gap-2"
							style={{ fontSize: "var(--mfw-text-xs)" }}
						>
							<span style={{ color: "var(--mfw-ok)" }}>
								+{changes.data.added}
							</span>
							<span style={{ color: "var(--mfw-critical)" }}>
								−{changes.data.deleted}
							</span>
						</span>
					) : null
				}
			>
				{!wt.exists ? (
					<Empty title="This worktree is gone from disk." />
				) : changes.isLoading ? (
					<div className="p-3">
						<LoadingRows rows={5} />
					</div>
				) : changes.error ? (
					<div className="p-3">
						<ErrorState
							title="Could not read this worktree"
							error={changes.error}
							onRetry={() => void changes.refetch()}
						/>
					</div>
				) : rows.length === 0 ? (
					<Empty tone="success" title="Clean: nothing uncommitted." />
				) : (
					<ChangedFiles
						rows={rows}
						truncated={changes.data?.truncated}
						initialOpen={f}
						onFocus={(path) =>
							go(href.repoWorktree(project, id, { f: path }), {
								replace: true,
							})
						}
						renderDiff={(row) => (
							<WorktreeDiff
								project={project}
								id={id}
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
