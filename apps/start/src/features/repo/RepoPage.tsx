import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { TipSpan } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { AppLink } from "../../components/AppLink";
import { Page } from "../../components/Page";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import { FilesPage } from "../files/FilesPage";
import { BranchesPage, BranchPage } from "./branches";
import { CommitPage, CommitsPage } from "./commits";
import { ComparePage } from "./compare";
import { KnownTasksProvider } from "./parts";
import {
	parseRepoPath,
	type RepoSearch,
	type RepoSection,
	SECTIONS,
} from "./repoModel";
import { WorktreePage, WorktreesPage } from "./worktrees";

export type { RepoSearch } from "./repoModel";

/**
 * REPO: the project's repository as a human reads it. Five sections under one
 * header: Files (a checkout or any ref's tree), Branches, Worktrees, Commits
 * and Compare. Everything is read only; the daemon validates every ref and
 * path (`packages/daemon/src/repo-view.ts`).
 *
 * The section and its subject come from the URL splat
 * (`repoModel.parseRepoPath`), so every view has a deep link.
 */
export function RepoPage({
	project,
	splat,
	search,
}: {
	project: string;
	splat: string;
	search: RepoSearch;
}) {
	const trpc = useTRPC();
	const view = parseRepoPath(splat);
	const summary = useQuery({
		...trpc.repo.summary.queryOptions({ project }),
		refetchInterval: 30_000,
	});
	const tasks = useQuery(trpc.tasks.list.queryOptions({ project }));
	const known = useMemo(
		() => new Set((tasks.data ?? []).map((t) => t.id)),
		[tasks.data],
	);
	const counts: Partial<Record<RepoSection, number | undefined>> = {
		branches: summary.data
			? summary.data.branches + summary.data.remoteBranches
			: undefined,
		worktrees: summary.data?.worktrees,
	};
	const to: Record<RepoSection, string> = {
		files: href.files(project),
		branches: href.repoBranches(project),
		worktrees: href.repoWorktrees(project),
		commits: href.repoCommits(project),
		compare: href.repoCompare(project),
	};

	return (
		<KnownTasksProvider value={known}>
			<Page className="h-full">
				<nav
					aria-label="Repository sections"
					className="flex shrink-0 flex-wrap items-center gap-1 border-b px-3 py-1.5"
					style={{
						borderColor: "var(--mfw-border)",
						background: "var(--mfw-bg-subtle)",
					}}
				>
					{SECTIONS.map((s) => {
						const active = view.section === s.id;
						const n = counts[s.id];
						return (
							<AppLink
								key={s.id}
								to={to[s.id]}
								aria-current={active ? "page" : undefined}
								className={cn(
									"flex min-h-7 items-center gap-1.5 px-2.5 no-underline",
								)}
								style={{
									borderRadius: "var(--mfw-radius-sm)",
									background: active ? "var(--mfw-bg-hover)" : undefined,
									color: active ? "var(--mfw-fg)" : "var(--mfw-fg-muted)",
									fontSize: "var(--mfw-text-xs)",
									fontWeight: active ? 600 : 400,
								}}
							>
								{s.label}
								{n !== undefined ? (
									<span
										className="mfw-num"
										style={{ color: "var(--mfw-fg-faint)" }}
									>
										{n}
									</span>
								) : null}
							</AppLink>
						);
					})}
					<span className="flex-1" />
					{summary.data ? (
						<TipSpan
							className="mfw-num hidden sm:inline"
							style={{
								color: "var(--mfw-fg-faint)",
								fontSize: "var(--mfw-text-xs)",
							}}
							tip="The integration branch every comparison is made against."
						>
							integration: {summary.data.integrationBranch}
							{summary.data.head.branch &&
							summary.data.head.branch !== summary.data.integrationBranch
								? `, checked out: ${summary.data.head.branch}`
								: ""}
						</TipSpan>
					) : null}
				</nav>

				{view.section === "files" ? (
					<div className="flex min-h-0 flex-1 flex-col">
						<FilesPage
							project={project}
							at={{
								run: search.run,
								ref: search.ref,
								path: search.path,
								file: search.file,
							}}
						/>
					</div>
				) : (
					<div className="min-h-0 flex-1 overflow-auto">
						{view.section === "branches" && view.branch === null ? (
							<BranchesPage project={project} q={search.q} kind={search.kind} />
						) : null}
						{view.section === "branches" && view.branch !== null ? (
							<BranchPage
								key={view.branch}
								project={project}
								name={view.branch}
								f={search.f}
							/>
						) : null}
						{view.section === "worktrees" && view.worktree === null ? (
							<WorktreesPage project={project} />
						) : null}
						{view.section === "worktrees" && view.worktree !== null ? (
							<WorktreePage
								key={view.worktree}
								project={project}
								id={view.worktree}
								f={search.f}
							/>
						) : null}
						{view.section === "commits" && view.sha === null ? (
							<CommitsPage
								project={project}
								refName={search.ref}
								q={search.q}
								path={search.path}
							/>
						) : null}
						{view.section === "commits" && view.sha !== null ? (
							<CommitPage
								key={view.sha}
								project={project}
								sha={view.sha}
								f={search.f}
							/>
						) : null}
						{view.section === "compare" ? (
							<ComparePage
								key={`${view.a}...${view.b}`}
								project={project}
								a={view.a}
								b={view.b}
								mode={search.mode ?? "three-dot"}
								f={search.f}
							/>
						) : null}
					</div>
				)}
			</Page>
		</KnownTasksProvider>
	);
}
