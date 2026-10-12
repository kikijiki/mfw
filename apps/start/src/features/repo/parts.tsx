import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, GitBranch, Tag } from "lucide-react";
import { createContext, type ReactNode, useContext, useState } from "react";
import { TipSpan } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { AppLink } from "../../components/AppLink";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { Chip } from "../../components/Page";
import { RelativeTime } from "../../components/RelativeTime";
import type { RouterOutputs } from "../../lib/trpc";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import { DiffView } from "../review/DiffView";
import {
	type Badge,
	describeXY,
	formatStat,
	type RefChipInput,
	refChips,
	shortRef,
	shortSha,
} from "./repoModel";

/** Pieces shared by every repo section: links, chips, the changed-file list. */

export type RepoFile = RouterOutputs["repo"]["commit"]["diff"]["files"][number];

const MUTED = { color: "var(--mfw-fg-muted)" } as const;
const FAINT = {
	color: "var(--mfw-fg-faint)",
	fontSize: "var(--mfw-text-xs)",
} as const;

/** Task ids that exist on this board, so a commit message only links real tasks. */
const KnownTasks = createContext<ReadonlySet<string>>(new Set());
export const KnownTasksProvider = KnownTasks.Provider;

export function TaskLinks({
	project,
	ids,
}: {
	project: string;
	ids: readonly string[];
}) {
	const known = useContext(KnownTasks);
	if (ids.length === 0) return null;
	return (
		<>
			{ids.map((id) =>
				known.has(id) ? (
					<AppLink
						key={id}
						to={href.task(project, id)}
						className="mfw-num"
						style={{ fontSize: "var(--mfw-text-xs)" }}
					>
						{id}
					</AppLink>
				) : (
					<span key={id} className="mfw-num" style={FAINT}>
						{id}
					</span>
				),
			)}
		</>
	);
}

export function ShaLink({
	project,
	sha,
	className,
}: {
	project: string;
	sha: string;
	className?: string;
}) {
	return (
		<AppLink
			to={href.repoCommit(project, sha)}
			className={cn("mfw-num", className)}
			title={sha}
			style={{ fontSize: "var(--mfw-text-xs)" }}
		>
			{shortSha(sha)}
		</AppLink>
	);
}

export function BranchLink({
	project,
	name,
	className,
}: {
	project: string;
	name: string;
	className?: string;
}) {
	return (
		<AppLink
			to={href.repoBranch(project, name)}
			className={cn(
				"mfw-num inline-flex min-w-0 items-center gap-1",
				className,
			)}
			title={name}
		>
			<GitBranch aria-hidden className="size-3.5 shrink-0" />
			<span className="truncate">{shortRef(name)}</span>
		</AppLink>
	);
}

export function Badges({ badges }: { badges: Badge[] }) {
	return (
		<>
			{badges.map((b) => (
				<Chip key={b.key} tone={b.tone} title={b.title}>
					{b.label}
				</Chip>
			))}
		</>
	);
}

/** Branch and tag decorations on a commit, each one a link. */
export function RefChips({
	project,
	refs,
	integrationBranch,
}: {
	project: string;
	refs: readonly RefChipInput[];
	integrationBranch: string;
}) {
	return (
		<>
			{refChips(refs, integrationBranch).map((chip) => {
				const body = (
					<>
						{chip.kind === "tag" ? (
							<Tag aria-hidden className="size-3" />
						) : (
							<GitBranch aria-hidden className="size-3" />
						)}
						{chip.label}
					</>
				);
				return (
					<Chip key={chip.key} tone={chip.tone} title={chip.title}>
						{chip.linkable ? (
							<AppLink
								to={
									chip.kind === "tag"
										? href.repoCommits(project, { ref: chip.title })
										: href.repoBranch(project, chip.title)
								}
								className="inline-flex items-center gap-1"
							>
								{body}
							</AppLink>
						) : (
							body
						)}
					</Chip>
				);
			})}
		</>
	);
}

/** `+2 −5` against the integration branch; both zero reads as "even". */
export function AheadBehind({
	ahead,
	behind,
}: {
	ahead: number | null;
	behind: number | null;
}) {
	if (ahead === null || behind === null) {
		return <span style={FAINT}>-</span>;
	}
	if (ahead === 0 && behind === 0) {
		return <span style={FAINT}>even</span>;
	}
	return (
		<TipSpan
			className="mfw-num inline-flex gap-2 whitespace-nowrap"
			style={{ fontSize: "var(--mfw-text-xs)" }}
			tip={`${ahead} commit${ahead === 1 ? "" : "s"} ahead of, ${behind} behind the integration branch`}
		>
			<span style={{ color: ahead ? "var(--mfw-ok)" : "var(--mfw-fg-faint)" }}>
				{ahead} ahead
			</span>
			<span
				style={{
					color: behind && ahead ? "var(--mfw-warn)" : "var(--mfw-fg-faint)",
				}}
			>
				{behind} behind
			</span>
		</TipSpan>
	);
}

export function WhenBy({ author, time }: { author: string; time: number }) {
	return (
		<span style={FAINT}>
			{author} <RelativeTime value={time * 1000} />
		</span>
	);
}

const STATUS_LETTER: Record<RepoFile["status"], string> = {
	added: "A",
	modified: "M",
	deleted: "D",
	renamed: "R",
	copied: "C",
	typechange: "T",
};

const STATUS_TONE: Record<RepoFile["status"], string> = {
	added: "var(--mfw-ok)",
	modified: "var(--mfw-warn)",
	deleted: "var(--mfw-critical)",
	renamed: "var(--mfw-info)",
	copied: "var(--mfw-info)",
	typechange: "var(--mfw-warn)",
};

export interface ChangedRow {
	path: string;
	oldPath: string | null;
	/** Words for the status, when the screen has its own (porcelain XY). */
	label: string;
	letter: string;
	tone: string;
	similarity: number | null;
	added: number | null;
	deleted: number | null;
	binary: boolean;
}

export function rowsOfFiles(files: readonly RepoFile[]): ChangedRow[] {
	return files.map((f) => ({
		path: f.path,
		oldPath: f.oldPath !== f.path ? f.oldPath : null,
		label: f.status,
		letter: STATUS_LETTER[f.status],
		tone: STATUS_TONE[f.status],
		similarity: f.similarity,
		added: f.added,
		deleted: f.deleted,
		binary: f.binary,
	}));
}

export function rowsOfWorktree(
	files: RouterOutputs["repo"]["worktreeChanges"]["files"],
): ChangedRow[] {
	return files.map((f) => {
		const letter = f.untracked
			? "?"
			: f.index !== " " && f.index !== "?"
				? f.index
				: f.worktree;
		return {
			path: f.path,
			oldPath: f.from,
			label: describeXY(f.index, f.worktree, f.untracked),
			letter,
			tone:
				letter === "A" || letter === "?"
					? "var(--mfw-ok)"
					: letter === "D"
						? "var(--mfw-critical)"
						: letter === "U"
							? "var(--mfw-critical)"
							: "var(--mfw-warn)",
			similarity: null,
			added: f.added,
			deleted: f.deleted,
			binary: f.added === null && f.deleted === null && !f.untracked,
		};
	});
}

/**
 * The changed-file list with a lazily loaded diff under each file. Rows open
 * independently; the most recent open file is the one the URL names (`f`), so
 * a link lands on the file it meant.
 */
export function ChangedFiles({
	rows,
	truncated,
	initialOpen,
	onFocus,
	renderDiff,
}: {
	rows: readonly ChangedRow[];
	truncated?: boolean;
	initialOpen?: string;
	onFocus?: (path: string | undefined) => void;
	renderDiff: (row: ChangedRow) => ReactNode;
}) {
	const [open, setOpen] = useState<Set<string>>(
		() => new Set(initialOpen ? [initialOpen] : []),
	);
	const toggle = (path: string) => {
		const next = new Set(open);
		if (next.has(path)) {
			next.delete(path);
			onFocus?.([...next].at(-1));
		} else {
			next.add(path);
			onFocus?.(path);
		}
		setOpen(next);
	};
	return (
		<div className="flex min-w-0 flex-col">
			<ul>
				{rows.map((row) => {
					const isOpen = open.has(row.path);
					const stat = formatStat(row.added, row.deleted);
					return (
						<li
							key={row.path}
							className="border-b"
							style={{ borderColor: "var(--mfw-border)" }}
						>
							<button
								type="button"
								aria-expanded={isOpen}
								onClick={() => toggle(row.path)}
								className="mfw-focus flex min-h-8 w-full items-center gap-2 px-2 py-1 text-left"
							>
								{isOpen ? (
									<ChevronDown aria-hidden className="size-3.5 shrink-0" />
								) : (
									<ChevronRight aria-hidden className="size-3.5 shrink-0" />
								)}
								<TipSpan
									role="img"
									aria-label={row.label}
									tip={row.label}
									className="mfw-num w-[2ch] shrink-0 text-center"
									style={{ color: row.tone }}
								>
									{row.letter}
								</TipSpan>
								<TipSpan
									className="mfw-num min-w-0 flex-1 truncate"
									tip={row.path}
									clipped
								>
									{row.oldPath ? (
										<>
											<span style={MUTED}>{row.oldPath}</span>
											{" → "}
										</>
									) : null}
									{row.path}
								</TipSpan>
								{row.similarity !== null && row.similarity < 100 ? (
									<span className="mfw-num shrink-0" style={FAINT}>
										{row.similarity}% similar
									</span>
								) : null}
								{stat.binary ? (
									<span className="shrink-0" style={FAINT}>
										binary
									</span>
								) : (
									<span
										className="mfw-num flex shrink-0 gap-2"
										style={{ fontSize: "var(--mfw-text-xs)" }}
									>
										<span style={{ color: "var(--mfw-ok)" }}>{stat.added}</span>
										<span style={{ color: "var(--mfw-critical)" }}>
											{stat.deleted}
										</span>
									</span>
								)}
							</button>
							{isOpen ? (
								<div className="min-w-0 overflow-x-auto px-2 pb-2">
									{renderDiff(row)}
								</div>
							) : null}
						</li>
					);
				})}
			</ul>
			{truncated ? (
				<p
					className="px-2 py-1"
					style={{ color: "var(--mfw-warn)", fontSize: "var(--mfw-text-xs)" }}
				>
					More files changed than are listed here.
				</p>
			) : null}
		</div>
	);
}

const NO_REVIEW = {
	comments: [] as never[],
	onAdd: () => {},
	onResolve: () => {},
	onRemove: () => {},
};

const BINARY_NOTE = {
	binary: "Binary file: there is no text to compare.",
	oversize: "Too large to render here (over 512 KiB).",
} as const;

/** One file between two revisions, through the shared `DiffView`. */
export function RevisionDiff({
	project,
	from,
	to,
	path,
	oldPath,
}: {
	project: string;
	from: string | null;
	to: string;
	path: string;
	oldPath: string | null;
}) {
	const trpc = useTRPC();
	const q = useQuery({
		...trpc.repo.diffFile.queryOptions({
			project,
			from: from ?? undefined,
			to,
			path,
			oldPath: oldPath ?? undefined,
		}),
		retry: false,
	});
	return <DiffResult q={q} />;
}

/** HEAD against the disk for one file of a worktree. */
export function WorktreeDiff({
	project,
	id,
	path,
	oldPath,
}: {
	project: string;
	id: string;
	path: string;
	oldPath: string | null;
}) {
	const trpc = useTRPC();
	const q = useQuery({
		...trpc.repo.worktreeDiffFile.queryOptions({
			project,
			id,
			path,
			oldPath: oldPath ?? undefined,
		}),
		retry: false,
	});
	return <DiffResult q={q} />;
}

function DiffResult({
	q,
}: {
	q: {
		data?: RouterOutputs["repo"]["diffFile"];
		isLoading: boolean;
		error: unknown;
		refetch: () => unknown;
	};
}) {
	if (q.isLoading) return <LoadingRows rows={6} />;
	if (q.error) {
		return (
			<ErrorState
				title="Could not load this diff"
				error={q.error}
				onRetry={() => void q.refetch()}
			/>
		);
	}
	if (!q.data) return null;
	return (
		<DiffView
			file={q.data}
			unified
			readOnly
			keys={false}
			binaryNote={
				q.data.reason ? BINARY_NOTE[q.data.reason] : "No text to compare."
			}
			{...NO_REVIEW}
		/>
	);
}

/** The message of a thrown value, whatever shape the client wrapped it in. */
export function errorMessage(error: unknown): string {
	return error instanceof Error
		? error.message
		: typeof (error as { message?: unknown } | null)?.message === "string"
			? (error as { message: string }).message
			: String(error);
}
