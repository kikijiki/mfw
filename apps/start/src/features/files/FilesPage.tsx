import { useQuery } from "@tanstack/react-query";
import {
	Binary,
	CornerLeftUp,
	FileText,
	Folder,
	GitBranch,
	Link2,
	Lock,
	RefreshCw,
	SearchX,
} from "lucide-react";
import type { ComponentType } from "react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { AppLink } from "../../components/AppLink";
import { Empty } from "../../components/Empty";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { Chip, Page, Panel } from "../../components/Page";
import { RelativeTime } from "../../components/RelativeTime";
import { useGo, useWideViewport } from "../../lib/nav";
import type { RouterOutputs } from "../../lib/trpc";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import type { CodeViewProps } from "./CodeView";
import type { Changes, ChangeTone, GitFile, GitStatus } from "./changes";
import { columnTone, describe, indexChanges, toneOf } from "./changes";
import { FileDiffView } from "./FileDiffView";

/**
 * FILES: the read-only workspace browser. Everything shown is the daemon's answer.
 *
 *  - The base is the project root or ONE run's worktree (`files.worktrees`);
 *    cleaned-up worktrees are not offered.
 *  - `WorkspaceService` reports FORBIDDEN (path resolved outside the tree) and
 *    NOT_FOUND separately; merging them would make a refusal look like a deletion.
 *  - Truncated and binary files show the server's marker text, not partial content.
 *
 * Location lives in the URL (`run`, `path`, `file`), so listings are linkable.
 *
 * Layout: two panes under one control row, sized to the window. `Page` is
 * `h-full` and every wrapper down to the scroll boxes carries `min-h-0`/`flex-1`;
 * only the listing and the file scroll, never the page.
 */

export interface FilesLocation {
	/** Run whose worktree is being browsed; absent means the project root. */
	run?: string;
	/** Open directory, base-relative. Absent means the base itself. */
	path?: string;
	/** Open file, base-relative. */
	file?: string;
}

type Entry = RouterOutputs["files"]["listDir"]["entries"][number];
type Bases = RouterOutputs["files"]["worktrees"];

export function FilesPage({
	project,
	at,
}: {
	project: string;
	at: FilesLocation;
}) {
	const trpc = useTRPC();
	const go = useGo();
	const wide = useWideViewport();
	const [wrap, setWrap] = useState(false);
	const [diffView, setDiffView] = useState(false);

	const worktrees = useQuery(trpc.files.worktrees.queryOptions({ project }));
	const listing = useQuery({
		...trpc.files.listDir.queryOptions({
			project,
			path: at.path,
			runId: at.run,
		}),
		// FORBIDDEN and NOT_FOUND are answers, not outages: no retry.
		retry: false,
	});
	const status = useQuery({
		...trpc.files.gitStatus.queryOptions({ project, runId: at.run }),
		retry: false,
	});
	const contents = useQuery({
		...trpc.files.readFile.queryOptions({
			project,
			path: at.file ?? "",
			runId: at.run,
		}),
		enabled: Boolean(at.file),
		retry: false,
	});

	const changes = useMemo(
		() => indexChanges(status.data?.files ?? []),
		[status.data],
	);

	// Known before `readFile` resolves, so the diff toggle needs no content fetch.
	const openGit = at.file ? changes.file.get(at.file) : undefined;
	const diff = useQuery({
		...trpc.files.diffFile.queryOptions({
			project,
			path: at.file ?? "",
			runId: at.run,
			fromPath: openGit?.from,
		}),
		// Fetched only on request.
		enabled: Boolean(at.file) && diffView && Boolean(openGit),
		retry: false,
	});

	const bases = worktrees.data ?? [];
	const here = at.path ?? "";
	const entries = listing.data?.entries ?? [];

	const linkTo = (next: Partial<FilesLocation>) =>
		href.files(project, { run: at.run, path: at.path, file: at.file, ...next });

	return (
		<Page className="h-full">
			{/* One row: checkout, location, and what differs from HEAD. */}
			<div
				className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-1.5"
				style={{
					borderColor: "var(--mfw-border)",
					background: "var(--mfw-bg-subtle)",
				}}
			>
				<BaseControl
					bases={bases}
					value={at.run}
					branch={status.data?.branch ?? null}
					onChange={(run) => go(href.files(project, { run }))}
				/>
				<Breadcrumbs path={here} linkTo={linkTo} />
				<StatusSummary status={status.data} counts={changes.counts} />
				<Button
					size="icon-sm"
					variant="ghost"
					aria-label="Refresh"
					title="Re-read the workspace"
					onClick={() => {
						void worktrees.refetch();
						void listing.refetch();
						void status.refetch();
						if (at.file) void contents.refetch();
					}}
				>
					<RefreshCw
						aria-hidden
						className={cn(listing.isFetching && "animate-spin")}
					/>
				</Button>
			</div>

			<div className="flex min-h-0 flex-1 flex-col gap-3 p-3 lg:flex-row">
				{/* Stacked on a phone the listing is capped so the file keeps some height. */}
				<Panel
					pad={false}
					title={
						listing.data
							? `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`
							: "Directory"
					}
					className="max-h-[45vh] lg:max-h-none lg:w-96 lg:shrink-0"
				>
					{listing.isLoading ? (
						<div className="p-3">
							<LoadingRows rows={8} />
						</div>
					) : listing.error ? (
						<div className="p-3">
							<WorkspaceError
								error={listing.error}
								what="directory"
								project={project}
								run={at.run}
								onRetry={() => void listing.refetch()}
							/>
						</div>
					) : (
						<>
							<ul className="min-h-0 flex-1 overflow-auto py-0.5">
								{here ? (
									<li>
										<AppLink
											to={linkTo({ path: parentOf(here) })}
											className="flex items-center gap-2 border-l-2 border-transparent py-1 pr-2 pl-1.5"
											style={{ color: "var(--mfw-fg-muted)" }}
										>
											<span aria-hidden className="mfw-num shrink-0 w-[2ch]" />
											<CornerLeftUp aria-hidden className="size-3.5 shrink-0" />
											<span className="mfw-num">..</span>
										</AppLink>
									</li>
								) : null}
								{entries.map((entry) => (
									<EntryRow
										key={entry.path}
										entry={entry}
										active={entry.path === at.file}
										changes={changes}
										linkTo={linkTo}
									/>
								))}
							</ul>
							{entries.length === 0 ? (
								<Empty
									icon={Folder}
									title="This directory is empty."
									className="py-6"
								/>
							) : null}
							{listing.data?.truncated ? (
								<p
									className="shrink-0 border-t px-2 py-1"
									style={{
										borderColor: "var(--mfw-border)",
										color: "var(--mfw-warn)",
										fontSize: "var(--mfw-text-xs)",
									}}
								>
									Only the first {entries.length} entries are listed; this
									directory holds more.
								</p>
							) : null}
						</>
					)}
				</Panel>

				<div className="flex min-h-0 min-w-0 flex-1 flex-col justify-center">
					{!at.file ? (
						<Empty
							icon={FileText}
							title="No file open."
							description="Choose a file to view it."
						/>
					) : contents.isLoading ? (
						<LoadingRows rows={12} />
					) : contents.error ? (
						<WorkspaceError
							error={contents.error}
							what="file"
							project={project}
							run={at.run}
							onRetry={() => void contents.refetch()}
						/>
					) : contents.data ? (
						<FileViewer
							data={contents.data}
							git={changes.file.get(contents.data.path)}
							wrap={wrap}
							onWrap={() => setWrap((v) => !v)}
							diffView={diffView}
							onToggleDiff={() => setDiffView((v) => !v)}
							diffData={diff.data}
							diffLoading={diff.isLoading}
							diffError={diff.error}
							onRetryDiff={() => void diff.refetch()}
							unified={!wide}
						/>
					) : null}
				</div>
			</div>
		</Page>
	);
}

const BASE_HELP =
	"Choose the project files or the files from an active run. This view is read-only.";

/**
 * Which checkout you are reading, named by its branch. Options are only the
 * existing trees (it cannot check out branches; the daemon never touches the
 * user's working tree), and with just the project root there is no dropdown.
 */
function BaseControl({
	bases,
	value,
	branch,
	onChange,
}: {
	bases: Bases;
	value?: string;
	/** Branch of the open base; gitStatus reports only that one. */
	branch: string | null;
	onChange: (run: string | undefined) => void;
}) {
	// A run whose worktree is gone can still be in the URL; keep it selectable.
	const missing = value != null && !bases.some((b) => b.runId === value);

	const icon = (
		<GitBranch
			aria-hidden
			className="size-3.5 shrink-0"
			style={{ color: "var(--mfw-fg-faint)" }}
		/>
	);

	if (bases.length === 0 && !missing) {
		return (
			<span
				className="flex shrink-0 items-center gap-1.5"
				title={`${branch ? `On ${branch}. ` : ""}${BASE_HELP}`}
			>
				{icon}
				<span className="mfw-num" style={{ fontSize: "var(--mfw-text-xs)" }}>
					{branch ?? "project root"}
				</span>
			</span>
		);
	}

	return (
		<span className="flex shrink-0 items-center gap-1.5">
			{icon}
			<select
				aria-label="Checkout"
				title={BASE_HELP}
				className="mfw-focus mfw-num min-h-7 max-w-64 border px-1.5"
				style={{
					background: "var(--mfw-bg-raised)",
					borderColor: "var(--mfw-border)",
					borderRadius: "var(--mfw-radius-sm)",
					color: "var(--mfw-fg)",
					fontSize: "var(--mfw-text-xs)",
				}}
				value={value ?? ""}
				onChange={(e) => onChange(e.target.value || undefined)}
			>
				{/* The root's branch is known only while the root is open (gitStatus answers per base). */}
				<option value="">
					{value == null && branch ? `${branch}: project root` : "project root"}
				</option>
				{bases.map((base) => (
					<option key={base.runId} value={base.runId}>
						{base.branch
							? `${base.branch}: ${base.label} (${base.state})`
							: `${base.label} (${base.state})`}
					</option>
				))}
				{missing ? (
					<option value={value}>{value}: run files unavailable</option>
				) : null}
			</select>
		</span>
	);
}

/** What differs from HEAD, in the listing's row tones. */
function StatusSummary({
	status,
	counts,
}: {
	status: GitStatus | undefined;
	counts: Changes["counts"];
}) {
	if (!status) return null;
	if (status.clean) {
		return (
			<span
				className="shrink-0"
				style={{
					color: "var(--mfw-fg-faint)",
					fontSize: "var(--mfw-text-xs)",
				}}
			>
				clean
			</span>
		);
	}
	// Most urgent first.
	const parts: [number, string, ChangeTone][] = [
		[counts.conflicted, "conflicted", "critical"],
		[counts.unstaged, "unstaged", "warn"],
		[counts.staged, "staged", "ok"],
		[counts.untracked, "untracked", "info"],
	];
	return (
		<span className="flex shrink-0 items-center gap-1">
			{parts.map(([count, label, tone]) =>
				count > 0 ? (
					<Chip key={label} tone={tone}>
						{count} {label}
					</Chip>
				) : null,
			)}
		</span>
	);
}

/** The path, one separator between segments; the root link IS the first separator. */
function Breadcrumbs({
	path,
	linkTo,
}: {
	path: string;
	linkTo: (next: Partial<FilesLocation>) => string;
}) {
	const segments = path ? path.split("/") : [];
	return (
		<nav
			aria-label="Path"
			className="mfw-num flex min-w-0 flex-1 flex-wrap items-center"
			style={{ fontSize: "var(--mfw-text-xs)" }}
		>
			<AppLink
				to={linkTo({ path: undefined })}
				title="Top of this checkout"
				style={{
					color: segments.length === 0 ? "var(--mfw-fg)" : undefined,
				}}
			>
				/
			</AppLink>
			{segments.map((segment, i) => {
				const upto = segments.slice(0, i + 1).join("/");
				const last = i === segments.length - 1;
				return (
					<span key={upto} className="flex items-center">
						{i > 0 ? (
							<span aria-hidden style={{ color: "var(--mfw-fg-faint)" }}>
								/
							</span>
						) : null}
						{last ? (
							<span aria-current="page" style={{ color: "var(--mfw-fg)" }}>
								{segment}
							</span>
						) : (
							<AppLink to={linkTo({ path: upto })}>{segment}</AppLink>
						)}
					</span>
				);
			})}
		</nav>
	);
}

/**
 * The two porcelain columns, coloured separately: `M ` (staged) and ` M`
 * (unstaged) differ. A blank column prints a middle dot, and the cell is always
 * two characters wide so filenames stay aligned.
 */
function StatusCell({ git }: { git: GitFile | undefined }) {
	if (!git) {
		return <span aria-hidden className="mfw-num w-[2ch] shrink-0" />;
	}
	const words = describe(git);
	return (
		<span
			role="img"
			aria-label={words}
			title={words}
			className="mfw-num w-[2ch] shrink-0"
		>
			<StatusChar git={git} column="index" />
			<StatusChar git={git} column="worktree" />
		</span>
	);
}

function StatusChar({
	git,
	column,
}: {
	git: GitFile;
	column: "index" | "worktree";
}) {
	const tone = columnTone(git, column);
	const code = git[column];
	return (
		<span
			style={{ color: tone ? `var(--mfw-${tone})` : "var(--mfw-fg-faint)" }}
		>
			{tone ? code : "·"}
		</span>
	);
}

function EntryRow({
	entry,
	active,
	changes,
	linkTo,
}: {
	entry: Entry;
	active: boolean;
	changes: Changes;
	linkTo: (next: Partial<FilesLocation>) => string;
}) {
	const git = changes.file.get(entry.path);
	const inside =
		entry.kind === "dir" ? changes.under.get(entry.path) : undefined;
	const tone = git ? toneOf(git) : (inside?.tone ?? null);

	const Icon =
		entry.kind === "dir" ? Folder : entry.kind === "symlink" ? Link2 : FileText;
	const body = (
		<>
			<StatusCell git={git} />
			<Icon
				aria-hidden
				className="size-3.5 shrink-0"
				style={{
					color:
						entry.kind === "dir" ? "var(--mfw-accent)" : "var(--mfw-fg-faint)",
				}}
			/>
			<span className="mfw-num min-w-0 flex-1 truncate">{entry.name}</span>
			{inside ? (
				<Chip
					tone={inside.tone}
					title={`${inside.count} changed file${inside.count === 1 ? "" : "s"} in here`}
				>
					{inside.count}
				</Chip>
			) : null}
			{entry.size != null ? (
				<span
					className="mfw-num shrink-0"
					style={{
						color: "var(--mfw-fg-faint)",
						fontSize: "var(--mfw-text-2xs)",
					}}
				>
					{formatBytes(entry.size)}
				</span>
			) : null}
			<span
				className="hidden shrink-0 sm:inline"
				style={{
					color: "var(--mfw-fg-faint)",
					fontSize: "var(--mfw-text-2xs)",
				}}
			>
				<RelativeTime value={entry.modifiedAt} />
			</span>
		</>
	);

	// The left rule makes changes findable at a glance.
	const rule = tone ? `var(--mfw-${tone})` : "transparent";

	// Symlinks are never followed (the daemon does not stat through them), so their
	// kind is unknown here; one leaving the tree would be refused, so say so upfront.
	if (entry.kind === "symlink" || entry.kind === "other") {
		return (
			<li
				className="flex min-h-8 items-center gap-2 border-l-2 py-1 pr-2 pl-1.5"
				style={{ borderLeftColor: rule, color: "var(--mfw-fg-muted)" }}
				title={
					entry.kind === "symlink"
						? "symlink: shown, never followed"
						: "not a regular file or directory"
				}
			>
				{body}
				{entry.escapes ? (
					<Chip tone="critical" title="its target is outside the workspace">
						leaves the tree
					</Chip>
				) : (
					<Chip>{entry.kind}</Chip>
				)}
			</li>
		);
	}

	return (
		<li>
			<AppLink
				to={
					entry.kind === "dir"
						? linkTo({ path: entry.path })
						: linkTo({ file: entry.path })
				}
				aria-current={active ? "true" : undefined}
				className="flex min-h-8 items-center gap-2 border-l-2 py-1 pr-2 pl-1.5"
				style={{
					borderLeftColor: rule,
					background: active ? "var(--mfw-bg-hover)" : undefined,
					// Changed files get full-strength text.
					color: active || tone ? "var(--mfw-fg)" : "var(--mfw-fg-muted)",
				}}
			>
				{body}
			</AppLink>
		</li>
	);
}

/**
 * Lazy-load the highlighter. CodeMirror needs a DOM and this route is
 * server-rendered, so the import runs in an effect; until it resolves (or if it
 * fails) the plain `<pre>` renders. `wanted` is false for binary or empty files.
 */
function useCodeView(wanted: boolean): ComponentType<CodeViewProps> | null {
	const [view, setView] = useState<ComponentType<CodeViewProps> | null>(null);
	useEffect(() => {
		if (!wanted) return;
		let alive = true;
		void import("./CodeView")
			.then((mod) => {
				if (alive) setView(() => mod.CodeView);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [wanted]);
	return wanted ? view : null;
}

function FileViewer({
	data,
	git,
	wrap,
	onWrap,
	diffView,
	onToggleDiff,
	diffData,
	diffLoading,
	diffError,
	onRetryDiff,
	unified,
}: {
	data: RouterOutputs["files"]["readFile"];
	git: GitFile | undefined;
	wrap: boolean;
	onWrap: () => void;
	diffView: boolean;
	onToggleDiff: () => void;
	diffData: RouterOutputs["files"]["diffFile"] | undefined;
	diffLoading: boolean;
	diffError: unknown;
	onRetryDiff: () => void;
	unified: boolean;
}) {
	const CodeView = useCodeView(!data.binary && data.size > 0);
	// A file with no git row has nothing to diff.
	const showingDiff = diffView && Boolean(git);
	return (
		<Panel
			pad={false}
			className="min-h-0 flex-1"
			title={
				<span className="flex items-center gap-2">
					<StatusCell git={git} />
					<span className="mfw-num truncate normal-case">{data.path}</span>
				</span>
			}
			actions={
				<>
					<span
						style={{
							color: "var(--mfw-fg-faint)",
							fontSize: "var(--mfw-text-2xs)",
						}}
					>
						{formatBytes(data.size)}
					</span>
					{git ? (
						<Button
							size="xs"
							variant="ghost"
							aria-pressed={showingDiff}
							onClick={onToggleDiff}
						>
							{showingDiff ? "File" : "Diff"}
						</Button>
					) : null}
					{!showingDiff && !data.binary ? (
						<Button
							size="xs"
							variant="ghost"
							aria-pressed={wrap}
							onClick={onWrap}
						>
							{wrap ? "No wrap" : "Wrap"}
						</Button>
					) : null}
				</>
			}
		>
			{showingDiff ? (
				<div className="min-h-0 flex-1 overflow-auto">
					{diffLoading ? (
						<div className="p-3">
							<LoadingRows rows={12} />
						</div>
					) : diffError ? (
						<div className="p-3">
							<ErrorState
								title="Could not load the diff"
								error={diffError}
								onRetry={onRetryDiff}
							/>
						</div>
					) : diffData ? (
						<FileDiffView diff={diffData} unified={unified} />
					) : null}
				</div>
			) : (
				<>
					{data.marker ? (
						<p
							className="flex shrink-0 items-center gap-2 border-b px-2 py-1"
							style={{
								borderColor: "var(--mfw-border)",
								color: "var(--mfw-warn)",
								fontSize: "var(--mfw-text-xs)",
							}}
						>
							{data.binary ? (
								<Binary aria-hidden className="size-3.5 shrink-0" />
							) : null}
							{data.marker}
						</p>
					) : null}

					{data.binary ? (
						<Empty
							icon={Binary}
							title="Binary file"
							description="This file cannot be displayed as text."
						/>
					) : data.size === 0 ? (
						<Empty title="This file is empty." />
					) : CodeView ? (
						// CodeMirror scrolls itself; no outer scroll box.
						<div className="min-h-0 flex-1">
							<CodeView path={data.path} text={data.text} wrap={wrap} />
						</div>
					) : (
						// Own scroll box so long lines do not widen the page.
						<div className="min-h-0 flex-1 overflow-auto">
							<pre
								className={cn(
									"mfw-num p-2",
									wrap ? "break-words whitespace-pre-wrap" : "whitespace-pre",
								)}
								style={{
									fontSize: "var(--mfw-text-xs)",
									lineHeight: "var(--mfw-leading-data)",
								}}
							>
								{data.text}
							</pre>
						</div>
					)}
				</>
			)}
		</Panel>
	);
}

/**
 * Tells the daemon's two refusals apart (`packages/api/src/trpc.ts` maps
 * `PathEscapeError` to FORBIDDEN, `NotFoundError` to NOT_FOUND); anything else
 * gets the ordinary error panel.
 */
function WorkspaceError({
	error,
	what,
	project,
	run,
	onRetry,
}: {
	error: unknown;
	what: "file" | "directory";
	project: string;
	run: string | undefined;
	onRetry: () => void;
}) {
	const code = (error as { data?: { code?: string } } | null)?.data?.code;
	const backToRoot = (
		<Button size="sm" variant="outline" asChild>
			<AppLink to={href.files(project, { run })}>Back to the top</AppLink>
		</Button>
	);

	if (code === "FORBIDDEN") {
		return (
			<Empty
				icon={Lock}
				title="That path is outside this workspace."
				description="Only files inside the selected workspace can be viewed."
				action={backToRoot}
			/>
		);
	}
	if (code === "NOT_FOUND") {
		return (
			<Empty
				icon={SearchX}
				title={`No such ${what}.`}
				description={
					run
						? "It may have been deleted, or the run may have finished and cleaned up its files."
						: "It may have been deleted or renamed since this link was made."
				}
				action={backToRoot}
			/>
		);
	}
	return (
		<ErrorState
			title={`Could not read this ${what}`}
			error={error}
			onRetry={onRetry}
		/>
	);
}

function parentOf(path: string): string | undefined {
	const cut = path.lastIndexOf("/");
	return cut === -1 ? undefined : path.slice(0, cut);
}

const UNITS = ["B", "KiB", "MiB", "GiB"] as const;

function formatBytes(bytes: number): string {
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${UNITS[unit]}`;
}
