import { useQueries, useQuery } from "@tanstack/react-query";
import { FolderCog, Plus, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { AppLink } from "../../components/AppLink";
import { Empty } from "../../components/Empty";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { Chip, Page, PageHeader, Panel } from "../../components/Page";
import { RelativeTime } from "../../components/RelativeTime";
import { useKeyBindings } from "../../lib/keyboard";
import { useGo } from "../../lib/nav";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import { AdrEditor } from "./AdrEditor";
import { DocReader } from "./DocReader";
import { DocSourcesManager } from "./DocSourcesManager";
import { type DocSource, DocsTree } from "./DocsTree";
import {
	type DirSourceRef,
	fromBoardPath,
	fromDirSource,
	type LinkContext,
} from "./docLinks";
import { statusTone } from "./docsModel";

const muted = { color: "var(--mfw-fg-muted)" } as const;
const small = { fontSize: "var(--mfw-text-xs)" } as const;
const DEBOUNCE_MS = 250;
const MIN_QUERY = 2;

/**
 * Docs: everything the project documents, in one place. Board-fed types
 * (ADRs, specs, journals, ...) and configured directories share a tree on the
 * left and a reader on the right; a search box over titles and bodies replaces
 * the tree while it has text. The location (`<source>/<key>`) and the search
 * text are the URL, so every document and every search is a link.
 */
export function DocsPage({
	project,
	source,
	docKey,
	q,
}: {
	project: string;
	source?: string;
	docKey?: string;
	q?: string;
}) {
	const trpc = useTRPC();
	const sourcesQuery = useQuery(trpc.docs.sources.queryOptions({ project }));
	const sources: DocSource[] = sourcesQuery.data ?? [];
	const boardSources = sources.filter((s) => s.kind === "board");

	// Board documents are few and shared by the tree, the link resolver and the
	// id chips, so they are loaded up front (the tree's own queries dedupe).
	const boardLists = useQueries({
		queries: boardSources.map((s) =>
			trpc.docs.entries.queryOptions({ project, sourceId: s.id }),
		),
	});
	const boardEntries = boardLists.flatMap((r) => r.data?.entries ?? []);

	const selectedSource = sources.find((s) => s.id === source);
	const read = useQuery({
		...trpc.docs.read.queryOptions({
			project,
			sourceId: source ?? "",
			key: docKey ?? "",
		}),
		enabled: Boolean(source && docKey),
		retry: false,
	});

	const [creating, setCreating] = useState<
		{ supersedes: string | null } | false
	>(false);
	const [managing, setManaging] = useState(false);

	const tasksQuery = useQuery(trpc.tasks.list.queryOptions({ project }));
	const knownIds = useMemo(
		() =>
			new Set([
				...(tasksQuery.data ?? []).map((t) => t.id),
				...boardEntries.filter((e) => e.type).map((e) => e.key),
			]),
		[tasksQuery.data, boardEntries],
	);
	const idSources = useMemo(
		() => new Map(boardEntries.map((e) => [e.key, e.sourceId] as const)),
		[boardEntries],
	);
	const dirRefs: DirSourceRef[] = useMemo(
		() =>
			sources
				.filter((s) => s.kind === "dir" && s.path !== undefined)
				.map((s) => ({
					id: s.id,
					kind: "dir" as const,
					path: s.path as string,
					base: s.base ?? "repo",
				})),
		[sources],
	);
	const boardPaths = useMemo(
		() =>
			new Map(
				boardEntries.map(
					(e) => [e.path, { sourceId: e.sourceId, key: e.key }] as const,
				),
			),
		[boardEntries],
	);
	const link: LinkContext | null = useMemo(() => {
		const entry = read.data?.entry;
		if (!entry) return null;
		const dir = dirRefs.find((d) => d.id === entry.sourceId);
		const from = dir
			? fromDirSource(dir, entry.key)
			: fromBoardPath(entry.path);
		return { from, sources: dirRefs, boardPaths };
	}, [read.data, dirRefs, boardPaths]);

	const total = sources.reduce((n, s) => n + s.count, 0);
	const searching = (q ?? "").trim().length >= MIN_QUERY;
	const adrOpen = source === "adr" && Boolean(docKey);

	return (
		<Page className="h-full min-w-0 overflow-hidden">
			<PageHeader
				meta={
					<span>
						{total} document{total === 1 ? "" : "s"} across {sources.length}{" "}
						source{sources.length === 1 ? "" : "s"} · decisions, specs, journals
						and the repository's own docs
					</span>
				}
				actions={
					<>
						<Button
							size="sm"
							variant="outline"
							onClick={() => setManaging(true)}
						>
							<FolderCog aria-hidden /> Sources
						</Button>
						{boardSources.some((s) => s.id === "adr") ? (
							<Button
								size="sm"
								onClick={() => setCreating({ supersedes: null })}
							>
								<Plus aria-hidden /> New ADR
							</Button>
						) : null}
					</>
				}
			/>

			<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3 lg:flex-row">
				<Panel className="max-h-72 w-full lg:max-h-none lg:w-80" pad={false}>
					<SearchBox project={project} source={source} docKey={docKey} q={q} />
					<div className="min-h-0 flex-1 overflow-y-auto">
						{searching ? (
							<SearchResults
								project={project}
								q={(q ?? "").trim()}
								selected={{ source, key: docKey }}
							/>
						) : sourcesQuery.isLoading ? (
							<div className="p-3">
								<LoadingRows rows={6} />
							</div>
						) : sourcesQuery.isError ? (
							<div className="p-3">
								<ErrorState
									title="Could not load the docs"
									error={sourcesQuery.error}
									onRetry={() => void sourcesQuery.refetch()}
								/>
							</div>
						) : (
							<DocsTree
								project={project}
								sources={sources}
								selected={{ source, key: docKey }}
							/>
						)}
					</div>
				</Panel>

				<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
					{!source ? (
						<DocsHome project={project} onManage={() => setManaging(true)} />
					) : !docKey ? (
						<SourceOverview
							project={project}
							source={selectedSource}
							sourceId={source}
						/>
					) : adrOpen ? null : read.isLoading ? (
						<div className="p-4">
							<LoadingRows rows={8} />
						</div>
					) : read.isError || !read.data || !link ? (
						<div className="p-4">
							<ErrorState
								title="Could not open this document"
								error={read.error ?? `${docKey} is not in ${source}.`}
								onRetry={() => void read.refetch()}
							/>
						</div>
					) : (
						<DocReader
							project={project}
							content={read.data}
							sourceKind={selectedSource?.kind ?? "dir"}
							link={link}
							knownIds={knownIds}
							idSources={idSources}
						/>
					)}
					<AdrEditor
						project={project}
						selectedId={adrOpen ? docKey : undefined}
						creating={creating}
						setCreating={setCreating}
					/>
				</div>
			</div>

			<Dialog open={managing} onOpenChange={setManaging}>
				<DialogContent className="sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>Documentation sources</DialogTitle>
						<DialogDescription>
							Board documents are listed automatically. Add directories your
							repository keeps documentation in; they are listed read-only.
						</DialogDescription>
					</DialogHeader>
					<DocSourcesManager project={project} />
				</DialogContent>
			</Dialog>
		</Page>
	);
}

/**
 * Result navigation keys act only while the search box has focus or nothing
 * does; Enter in an ADR's textarea must never leave the page.
 */
function inSearchContext(e: KeyboardEvent): boolean {
	const t = e.target;
	if (!(t instanceof HTMLElement)) return true;
	return (
		t === document.body || t.getAttribute("aria-label") === "Search documents"
	);
}

/** Search input: debounced into the URL's `q`, `/` focuses it, Escape clears it. */
function SearchBox({
	project,
	source,
	docKey,
	q,
}: {
	project: string;
	source?: string;
	docKey?: string;
	q?: string;
}) {
	const go = useGo();
	const input = useRef<HTMLInputElement>(null);
	const [text, setText] = useState(q ?? "");

	// A link or back-navigation changes `q`; follow it.
	useEffect(() => {
		setText((cur) => (cur.trim() === (q ?? "").trim() ? cur : (q ?? "")));
	}, [q]);

	useEffect(() => {
		if (text.trim() === (q ?? "").trim()) return;
		const t = setTimeout(
			() =>
				go(
					href.docs(project, {
						source,
						key: docKey,
						q: text.trim() || undefined,
					}),
					{
						replace: true,
					},
				),
			DEBOUNCE_MS,
		);
		return () => clearTimeout(t);
	}, [text, q, go, project, source, docKey]);

	useKeyBindings([
		{
			key: "/",
			label: "Search the docs",
			group: "Docs",
			run: (e) => {
				e.preventDefault();
				input.current?.focus();
				input.current?.select();
			},
		},
	]);

	return (
		<div
			className="relative shrink-0 border-b p-2"
			style={{ borderColor: "var(--mfw-border)" }}
		>
			<Search
				aria-hidden
				className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2"
				style={muted}
			/>
			<Input
				ref={input}
				value={text}
				aria-label="Search documents"
				placeholder="Search titles and text  /"
				className="pr-8 pl-7"
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						setText("");
						go(href.docs(project, { source, key: docKey }), { replace: true });
						input.current?.blur();
					}
				}}
			/>
			{text !== "" ? (
				<Button
					size="icon-xs"
					variant="ghost"
					aria-label="Clear search"
					className="absolute top-1/2 right-3 -translate-y-1/2"
					onClick={() => {
						setText("");
						go(href.docs(project, { source, key: docKey }), { replace: true });
						input.current?.focus();
					}}
				>
					<X aria-hidden />
				</Button>
			) : null}
		</div>
	);
}

function SearchResults({
	project,
	q,
	selected,
}: {
	project: string;
	q: string;
	selected: { source?: string; key?: string };
}) {
	const trpc = useTRPC();
	const go = useGo();
	const results = useQuery({
		...trpc.docs.search.queryOptions({ project, q, limit: 40 }),
		placeholderData: (prev) => prev,
	});
	const hits = results.data ?? [];
	// The highlighted row belongs to one query: a new query starts at the top.
	const [cursor, setCursor] = useState({ q, index: 0 });
	const active = cursor.q === q ? cursor.index : 0;
	const setActive = (next: (i: number) => number) =>
		setCursor({ q, index: next(active) });
	useKeyBindings([
		{
			key: "ArrowDown",
			label: "Next result",
			group: "Docs",
			allowInInput: true,
			hidden: true,
			enabled: hits.length > 0,
			run: (e) => {
				if (!inSearchContext(e)) return;
				e.preventDefault();
				setActive((i) => Math.min(i + 1, hits.length - 1));
			},
		},
		{
			key: "ArrowUp",
			label: "Previous result",
			group: "Docs",
			allowInInput: true,
			hidden: true,
			enabled: hits.length > 0,
			run: (e) => {
				if (!inSearchContext(e)) return;
				e.preventDefault();
				setActive((i) => Math.max(i - 1, 0));
			},
		},
		{
			key: "Enter",
			label: "Open the highlighted result",
			group: "Docs",
			allowInInput: true,
			hidden: true,
			enabled: hits.length > 0,
			run: (e) => {
				const hit = hits[active];
				if (!hit || !inSearchContext(e)) return;
				e.preventDefault();
				go(href.docs(project, { source: hit.sourceId, key: hit.key, q }));
			},
		},
	]);

	if (results.isLoading) {
		return (
			<div className="p-3">
				<LoadingRows rows={5} />
			</div>
		);
	}
	if (results.isError) {
		return (
			<div className="p-3">
				<ErrorState
					title="Search failed"
					error={results.error}
					onRetry={() => void results.refetch()}
				/>
			</div>
		);
	}
	if (hits.length === 0) {
		return (
			<Empty
				reason="filtered"
				title="No documents match"
				description={`Nothing in titles or text matches "${q}". Every word must appear.`}
			/>
		);
	}
	return (
		<ul aria-label="Search results">
			{hits.map((hit, i) => {
				const on = selected.source === hit.sourceId && selected.key === hit.key;
				return (
					<li key={`${hit.sourceId}:${hit.key}`}>
						<AppLink
							to={href.docs(project, { source: hit.sourceId, key: hit.key, q })}
							aria-current={on ? "page" : undefined}
							className="flex min-w-0 flex-col gap-0.5 border-b px-3 py-2"
							style={{
								borderColor: "var(--mfw-border)",
								background:
									i === active || on ? "var(--mfw-bg-subtle)" : undefined,
								outline:
									i === active ? "1px solid var(--mfw-accent)" : undefined,
								outlineOffset: -1,
							}}
						>
							<span className="flex items-center gap-2">
								<span className="min-w-0 flex-1 truncate font-medium">
									{hit.title}
								</span>
								{hit.status ? (
									<Chip tone={statusTone(hit.status)}>{hit.status}</Chip>
								) : null}
							</span>
							<span className="truncate mfw-num" style={{ ...muted, ...small }}>
								{hit.type ? `${hit.type} ${hit.key}` : hit.path}
							</span>
							<Snippet text={hit.snippet} match={hit.match} />
						</AppLink>
					</li>
				);
			})}
		</ul>
	);
}

function Snippet({
	text,
	match,
}: {
	text: string;
	match: readonly [number, number] | null;
}) {
	if (!match) {
		return (
			<span className="line-clamp-2" style={{ ...muted, ...small }}>
				{text}
			</span>
		);
	}
	return (
		<span className="line-clamp-2" style={{ ...muted, ...small }}>
			{text.slice(0, match[0])}
			<mark
				style={{
					background: "color-mix(in oklch, var(--mfw-accent) 30%, transparent)",
					color: "inherit",
				}}
			>
				{text.slice(match[0], match[1])}
			</mark>
			{text.slice(match[1])}
		</span>
	);
}

/** No document selected: what changed lately and what could be added. */
function DocsHome({
	project,
	onManage,
}: {
	project: string;
	onManage: () => void;
}) {
	const trpc = useTRPC();
	const recent = useQuery(
		trpc.docs.recent.queryOptions({ project, limit: 12 }),
	);
	const suggestions = useQuery(trpc.docs.suggestions.queryOptions({ project }));
	const items = recent.data ?? [];
	const found = suggestions.data ?? [];
	const refresh = () => {
		void recent.refetch();
		void suggestions.refetch();
	};
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
			<Panel
				title="Recently changed"
				actions={
					<Button
						size="icon-xs"
						variant="ghost"
						aria-label="Refresh"
						onClick={refresh}
					>
						<RefreshCw aria-hidden />
					</Button>
				}
				pad={false}
			>
				{recent.isLoading ? (
					<div className="p-3">
						<LoadingRows rows={5} />
					</div>
				) : items.length === 0 ? (
					<Empty
						title="No documents yet"
						description="Record a decision with New ADR, or add the directories your repository keeps documentation in."
						action={
							<Button size="sm" variant="outline" onClick={onManage}>
								<FolderCog aria-hidden /> Add a directory
							</Button>
						}
					/>
				) : (
					<ul>
						{items.map((e) => (
							<li key={`${e.sourceId}:${e.key}`}>
								<AppLink
									to={href.docs(project, { source: e.sourceId, key: e.key })}
									className="flex min-w-0 items-center gap-2 border-b px-3 py-1.5"
									style={{ borderColor: "var(--mfw-border)" }}
								>
									<span className="min-w-0 flex-1 truncate">{e.title}</span>
									<span
										className="truncate mfw-num"
										style={{ ...muted, ...small }}
									>
										{e.type ? e.key : e.path}
									</span>
									<RelativeTime value={e.modifiedAt} />
								</AppLink>
							</li>
						))}
					</ul>
				)}
			</Panel>

			{found.length > 0 ? (
				<Panel title="Found in the repository">
					<p className="mb-2" style={{ ...muted, ...small }}>
						These look like documentation. Nothing is listed until you add it.
					</p>
					<ul className="flex flex-col gap-1">
						{found.map((s) => (
							<li key={s.id} className="flex items-center gap-2">
								<span className="min-w-0 flex-1 truncate">
									<span className="font-medium">{s.label}</span>{" "}
									<span style={{ ...muted, ...small }}>{s.reason}</span>
								</span>
							</li>
						))}
					</ul>
					<div className="mt-2">
						<Button size="sm" variant="outline" onClick={onManage}>
							<Plus aria-hidden /> Review and add
						</Button>
					</div>
				</Panel>
			) : null}
		</div>
	);
}

function SourceOverview({
	project,
	source,
	sourceId,
}: {
	project: string;
	source?: DocSource;
	sourceId: string;
}) {
	const trpc = useTRPC();
	const entries = useQuery(
		trpc.docs.entries.queryOptions({ project, sourceId }),
	);
	if (!source) {
		return (
			<div className="p-4">
				<ErrorState
					title="No such source"
					error={`${sourceId} is not a document type of this board or a configured directory.`}
				/>
			</div>
		);
	}
	const first = entries.data?.entries[0];
	return (
		<Empty
			title={source.label}
			description={
				source.missing
					? `${source.path} does not exist in this checkout.`
					: `${source.count} document${source.count === 1 ? "" : "s"}. Pick one from the list.`
			}
			action={
				first ? (
					<AppLink
						to={href.docs(project, { source: source.id, key: first.key })}
						className="text-sky-400"
					>
						Open {first.title}
					</AppLink>
				) : undefined
			}
		/>
	);
}
