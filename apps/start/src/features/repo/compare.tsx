import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight } from "lucide-react";

import { Button } from "~/components/ui/button";
import { AppLink } from "../../components/AppLink";
import { Empty } from "../../components/Empty";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { Chip, Panel } from "../../components/Page";
import { useGo } from "../../lib/nav";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import { CommitList, CompareSummary } from "./commits";
import { ChangedFiles, errorMessage, RevisionDiff, rowsOfFiles } from "./parts";
import { RefPicker } from "./RefPicker";

/**
 * What `b` has that `a` lacks, the way a pull request reads: commits, then
 * files. Three-dot (the default) diffs from the merge base, so changes that
 * landed on `a` after `b` left do not show up as `b` deleting them.
 */
export function CompareResult({
	project,
	a,
	b,
	mode,
	f,
	onFocus,
}: {
	project: string;
	a: string;
	b: string;
	mode: "three-dot" | "two-dot";
	f: string | undefined;
	onFocus: (path: string | undefined) => void;
}) {
	const trpc = useTRPC();
	const refs = useQuery(trpc.repo.refs.queryOptions({ project }));
	const cmp = useQuery({
		...trpc.repo.compare.queryOptions({ project, a, b, mode }),
		retry: false,
	});
	if (cmp.isLoading) return <LoadingRows rows={8} />;
	if (cmp.error || !cmp.data) {
		const code = (cmp.error as { data?: { code?: string } } | null)?.data?.code;
		if (code === "NOT_FOUND" || code === "BAD_REQUEST") {
			return (
				<Empty
					title="One of those refs does not exist."
					description={errorMessage(cmp.error)}
				/>
			);
		}
		return (
			<ErrorState
				title="Could not compare these"
				error={cmp.error}
				onRetry={() => void cmp.refetch()}
			/>
		);
	}
	const c = cmp.data;
	const integration = refs.data?.integrationBranch ?? "";
	return (
		<div className="flex min-w-0 flex-col gap-3">
			<CompareSummary
				project={project}
				a={a}
				b={b}
				ahead={c.ahead}
				behind={c.behind}
				mergeBase={c.mergeBase}
				mode={c.mode}
			/>
			{mode === "three-dot" && c.mode === "two-dot" ? (
				<Chip tone="warn">
					No common ancestor, so this is a plain two-dot comparison.
				</Chip>
			) : null}
			<Panel
				pad={false}
				title={`${c.commits.length}${c.commitsTruncated ? "+" : ""} commit${c.commits.length === 1 ? "" : "s"} on ${b} not on ${a}`}
			>
				{c.commits.length === 0 ? (
					<Empty
						title="Nothing to merge."
						description={`Every commit of ${b} is already on ${a}.`}
					/>
				) : (
					<CommitList
						project={project}
						commits={c.commits}
						integrationBranch={integration}
					/>
				)}
			</Panel>
			<Panel
				pad={false}
				title={`${c.diff.files.length} file${c.diff.files.length === 1 ? "" : "s"} changed`}
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
					<Empty title="No file differences." />
				) : (
					<ChangedFiles
						rows={rowsOfFiles(c.diff.files)}
						truncated={c.diff.truncated}
						initialOpen={f}
						onFocus={onFocus}
						renderDiff={(row) => (
							<RevisionDiff
								project={project}
								from={c.base}
								to={c.b}
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

export function ComparePage({
	project,
	a,
	b,
	mode,
	f,
}: {
	project: string;
	a: string | null;
	b: string | null;
	mode: "three-dot" | "two-dot";
	f: string | undefined;
}) {
	const trpc = useTRPC();
	const go = useGo();
	const refs = useQuery(trpc.repo.refs.queryOptions({ project }));
	const integration = refs.data?.integrationBranch;
	const base = a ?? integration ?? null;

	const to = (next: {
		a?: string | null;
		b?: string | null;
		mode?: "two-dot";
	}) =>
		href.repoCompare(
			project,
			next.a === undefined ? (base ?? undefined) : (next.a ?? undefined),
			next.b === undefined ? (b ?? undefined) : (next.b ?? undefined),
			{
				mode: (next.mode ?? (mode === "two-dot" ? "two-dot" : undefined)) as
					| "two-dot"
					| undefined,
			},
		);

	return (
		<div className="flex min-h-0 flex-col gap-3 p-3">
			<div className="flex flex-wrap items-center gap-2">
				<span
					style={{
						color: "var(--mfw-fg-muted)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					base
				</span>
				<RefPicker
					label="Base ref"
					value={base ?? undefined}
					refs={refs.data}
					onChange={(next) => go(to({ a: next ?? null }))}
				/>
				<Button
					size="icon-sm"
					variant="ghost"
					aria-label="Swap sides"
					title="Swap base and compare"
					disabled={!base || !b}
					onClick={() => go(to({ a: b, b: base }))}
				>
					<ArrowLeftRight aria-hidden />
				</Button>
				<span
					style={{
						color: "var(--mfw-fg-muted)",
						fontSize: "var(--mfw-text-xs)",
					}}
				>
					compare
				</span>
				<RefPicker
					label="Compare ref"
					emptyLabel="choose a ref"
					value={b ?? undefined}
					refs={refs.data}
					onChange={(next) => go(to({ b: next ?? null }))}
				/>
				<Button
					size="xs"
					variant="ghost"
					aria-pressed={mode === "two-dot"}
					title="Two-dot compares the tips directly; three-dot (the default) compares from the merge base, like a pull request."
					onClick={() =>
						go(to({ mode: mode === "two-dot" ? undefined : "two-dot" }))
					}
				>
					{mode === "two-dot" ? "Two-dot a..b" : "Three-dot a...b"}
				</Button>
			</div>
			{base && b ? (
				<CompareResult
					project={project}
					a={base}
					b={b}
					mode={mode}
					f={f}
					onFocus={(path) =>
						go(
							href.repoCompare(project, base, b, {
								mode: mode === "two-dot" ? "two-dot" : undefined,
								f: path,
							}),
							{ replace: true },
						)
					}
				/>
			) : (
				<Empty
					title="Pick a ref to compare."
					description={
						<>
							Choose the branch, tag or commit to compare against{" "}
							{base ?? "the base"}. You can also start from a branch page or a
							worktree.{" "}
							<AppLink to={href.repoBranches(project)}>Browse branches</AppLink>
						</>
					}
				/>
			)}
		</div>
	);
}
