import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { TipSpan } from "~/components/ui/tooltip";
import { AppLink } from "../../components/AppLink";
import { Empty } from "../../components/Empty";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { Chip, Field, Panel } from "../../components/Page";
import { useNow } from "../../components/RelativeTime";
import { useGo } from "../../lib/nav";
import type { RouterOutputs } from "../../lib/trpc";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import { CommitList } from "./commits";
import { CompareResult } from "./compare";
import {
	AheadBehind,
	Badges,
	BranchLink,
	errorMessage,
	ShaLink,
	TaskLinks,
	WhenBy,
} from "./parts";
import {
	BRANCH_KINDS,
	type BranchKind,
	branchBadges,
	filterBranches,
	kindCounts,
	parseBranchKind,
} from "./repoModel";

type Branch = RouterOutputs["repo"]["branches"]["branches"][number];

const FAINT = {
	color: "var(--mfw-fg-faint)",
	fontSize: "var(--mfw-text-xs)",
} as const;

/** Where this branch came from in mfw's terms: task, run, merge job, worktree. */
function Owner({ project, branch }: { project: string; branch: Branch }) {
	const { run, mergeJob } = branch;
	if (!run && !branch.worktreeId) return null;
	return (
		<span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
			{run?.taskId ? <TaskLinks project={project} ids={[run.taskId]} /> : null}
			{run ? (
				<AppLink
					to={href.run(project, run.runId)}
					style={FAINT}
					title={`run ${run.runId}`}
				>
					run {run.live ? "live" : run.state}
				</AppLink>
			) : null}
			{mergeJob ? (
				<TipSpan style={FAINT} tip={mergeJob.error ?? undefined}>
					merge {mergeJob.state}
				</TipSpan>
			) : null}
			{branch.worktreeId ? (
				<AppLink
					to={href.repoWorktree(project, branch.worktreeId)}
					style={FAINT}
				>
					worktree
				</AppLink>
			) : null}
		</span>
	);
}

export function BranchesPage({
	project,
	q,
	kind,
}: {
	project: string;
	q: string | undefined;
	kind: string | undefined;
}) {
	const trpc = useTRPC();
	const go = useGo();
	const now = useNow();
	const data = useQuery({
		...trpc.repo.branches.queryOptions({ project }),
		refetchInterval: 20_000,
	});
	const [draft, setDraft] = useState(q ?? "");
	const active = parseBranchKind(kind);
	const all = data.data?.branches ?? [];
	const counts = useMemo(() => kindCounts(all, now), [all, now]);
	const shown = useMemo(
		() => filterBranches(all, { q, kind: active, nowMs: now }),
		[all, q, active, now],
	);
	const to = (next: { q?: string; kind?: BranchKind }) =>
		href.repoBranches(project, {
			q: next.q === undefined ? q : next.q || undefined,
			kind: (next.kind ?? active) === "all" ? undefined : (next.kind ?? active),
		});

	return (
		<div className="flex min-h-0 flex-col gap-3 p-3">
			<div className="flex flex-wrap items-center gap-2">
				<form
					className="flex items-center gap-1"
					onSubmit={(e) => {
						e.preventDefault();
						go(to({ q: draft.trim() }), { replace: true });
					}}
				>
					<Search
						aria-hidden
						className="size-3.5"
						style={{ color: "var(--mfw-fg-faint)" }}
					/>
					<input
						aria-label="Filter branches"
						placeholder="Filter by name, task or message"
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onBlur={() => go(to({ q: draft.trim() }), { replace: true })}
						className="mfw-focus min-h-7 w-64 border px-2"
						style={{
							background: "var(--mfw-bg-raised)",
							borderColor: "var(--mfw-border)",
							borderRadius: "var(--mfw-radius-sm)",
							fontSize: "var(--mfw-text-xs)",
						}}
					/>
				</form>
				<fieldset
					className="m-0 flex min-w-0 flex-wrap items-center gap-1 border-0 p-0"
					aria-label="Branch kind"
				>
					{BRANCH_KINDS.map((k) => (
						<Button
							key={k.id}
							size="xs"
							variant={active === k.id ? "secondary" : "ghost"}
							aria-pressed={active === k.id}
							onClick={() => go(to({ kind: k.id }), { replace: true })}
						>
							{k.label} {counts[k.id]}
						</Button>
					))}
				</fieldset>
			</div>

			<Panel
				pad={false}
				title={`${shown.length} of ${all.length} branches, against ${data.data?.integrationBranch ?? "the integration branch"}`}
			>
				{data.isLoading ? (
					<div className="p-3">
						<LoadingRows rows={8} />
					</div>
				) : data.error ? (
					<div className="p-3">
						<ErrorState
							title="Could not list branches"
							error={data.error}
							onRetry={() => void data.refetch()}
						/>
					</div>
				) : shown.length === 0 ? (
					<Empty
						title="No branches match."
						reason="filtered"
						action={
							<Button size="sm" variant="outline" asChild>
								<AppLink to={href.repoBranches(project)}>Clear filters</AppLink>
							</Button>
						}
					/>
				) : (
					<ul>
						{shown.map((b) => (
							<li
								key={`${b.kind}:${b.name}`}
								className="flex flex-col gap-1 border-b px-3 py-2"
								style={{ borderColor: "var(--mfw-border)" }}
							>
								<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
									<BranchLink
										project={project}
										name={b.name}
										className="font-medium"
									/>
									<Badges badges={branchBadges(b, now)} />
									<span className="flex-1" />
									<AheadBehind ahead={b.ahead} behind={b.behind} />
								</div>
								<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
									<AppLink
										to={href.repoCommit(project, b.sha)}
										className="min-w-0 max-w-full truncate"
										title={b.lastCommit.subject}
										clipped
										style={{ fontSize: "var(--mfw-text-xs)" }}
									>
										{b.lastCommit.subject || "(no message)"}
									</AppLink>
									<WhenBy
										author={b.lastCommit.author}
										time={b.lastCommit.time}
									/>
									<Owner project={project} branch={b} />
								</div>
							</li>
						))}
					</ul>
				)}
				{data.data?.truncated ? (
					<p
						className="px-3 py-1"
						style={{ color: "var(--mfw-warn)", fontSize: "var(--mfw-text-xs)" }}
					>
						Only the most recently committed branches are listed.
					</p>
				) : null}
			</Panel>
		</div>
	);
}

export function BranchPage({
	project,
	name,
	f,
}: {
	project: string;
	name: string;
	f: string | undefined;
}) {
	const trpc = useTRPC();
	const go = useGo();
	const now = useNow();
	const data = useQuery({
		...trpc.repo.branches.queryOptions({ project }),
		refetchInterval: 20_000,
	});
	const branch = data.data?.branches.find((b) => b.name === name);
	const integration = data.data?.integrationBranch ?? "";
	const isBase = branch?.isIntegration ?? name === integration;

	// A branch with nothing of its own shows its recent history instead.
	const history = useQuery({
		...trpc.repo.commits.queryOptions({ project, ref: name, limit: 30 }),
		enabled: isBase || branch?.ahead === 0,
		retry: false,
	});

	if (data.isLoading) {
		return (
			<div className="p-3">
				<LoadingRows rows={6} />
			</div>
		);
	}
	if (data.error) {
		return (
			<div className="p-3">
				<ErrorState
					title="Could not read this branch"
					error={data.error}
					onRetry={() => void data.refetch()}
				/>
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-col gap-3 p-3">
			<Panel pad>
				<div className="flex flex-col gap-2">
					<div className="flex flex-wrap items-center gap-2">
						<h2 className="mfw-num min-w-0 break-all font-semibold">{name}</h2>
						{branch ? (
							<Badges badges={branchBadges(branch, now)} />
						) : (
							<Chip tone="warn">not a current branch</Chip>
						)}
					</div>
					{branch ? (
						<div className="flex flex-col gap-1">
							<Field label="Last commit">
								<span className="flex flex-wrap items-center gap-x-2">
									<AppLink to={href.repoCommit(project, branch.sha)}>
										{branch.lastCommit.subject || "(no message)"}
									</AppLink>
									<ShaLink project={project} sha={branch.sha} />
									<WhenBy
										author={branch.lastCommit.author}
										time={branch.lastCommit.time}
									/>
								</span>
							</Field>
							{!isBase ? (
								<Field label={`vs ${integration}`}>
									<AheadBehind ahead={branch.ahead} behind={branch.behind} />
								</Field>
							) : null}
							{branch.upstream ? (
								<Field label="Tracks">
									<BranchLink project={project} name={branch.upstream} />
								</Field>
							) : null}
							{branch.run ? (
								<Field label="Run">
									<span className="flex flex-wrap items-center gap-x-2">
										{branch.run.taskId ? (
											<TaskLinks project={project} ids={[branch.run.taskId]} />
										) : null}
										<AppLink to={href.run(project, branch.run.runId)}>
											{branch.run.label} (
											{branch.run.live ? "live" : branch.run.state})
										</AppLink>
										{branch.run.taskId ? (
											<AppLink to={href.changes(project, branch.run.taskId)}>
												Review
											</AppLink>
										) : null}
									</span>
								</Field>
							) : null}
							{branch.mergeJob ? (
								<Field label="Merge job">
									<span className="flex flex-wrap items-center gap-x-2">
										<Chip
											tone={
												branch.mergeJob.state === "parked"
													? "critical"
													: branch.mergeJob.state === "merged"
														? "ok"
														: "info"
											}
										>
											{branch.mergeJob.state}
										</Chip>
										<span style={FAINT}>
											into {branch.mergeJob.targetBranch}
										</span>
										{branch.mergeJob.mergedSha ? (
											<>
												<span style={FAINT}>landed as</span>
												<ShaLink
													project={project}
													sha={branch.mergeJob.mergedSha}
												/>
											</>
										) : null}
										{branch.mergeJob.error ? (
											<span style={{ color: "var(--mfw-critical)" }}>
												{branch.mergeJob.error}
											</span>
										) : null}
									</span>
								</Field>
							) : null}
							{branch.worktreeId ? (
								<Field label="Worktree">
									<AppLink to={href.repoWorktree(project, branch.worktreeId)}>
										{branch.worktreeId}
									</AppLink>
								</Field>
							) : null}
						</div>
					) : null}
					<div
						className="flex flex-wrap items-center gap-3"
						style={{ fontSize: "var(--mfw-text-xs)" }}
					>
						<AppLink to={href.files(project, { ref: name })}>
							Browse files
						</AppLink>
						<AppLink to={href.repoCommits(project, { ref: name })}>
							All commits
						</AppLink>
						{!isBase ? (
							<AppLink to={href.repoCompare(project, integration, name)}>
								Open as a comparison
							</AppLink>
						) : null}
					</div>
				</div>
			</Panel>

			{isBase || branch?.ahead === 0 ? (
				<Panel
					pad={false}
					title={
						isBase
							? "Recent commits"
							: `Fully merged into ${integration}. Recent commits`
					}
				>
					{history.isLoading ? (
						<div className="p-3">
							<LoadingRows rows={6} />
						</div>
					) : history.data ? (
						<CommitList
							project={project}
							commits={history.data.commits}
							integrationBranch={integration}
						/>
					) : history.error ? (
						<Empty
							title="No such branch."
							description={errorMessage(history.error)}
						/>
					) : null}
				</Panel>
			) : (
				<CompareResult
					project={project}
					a={integration}
					b={name}
					mode="three-dot"
					f={f}
					onFocus={(path) =>
						go(
							`${href.repoBranch(project, name)}${path ? `?f=${encodeURIComponent(path)}` : ""}`,
							{ replace: true },
						)
					}
				/>
			)}
		</div>
	);
}
