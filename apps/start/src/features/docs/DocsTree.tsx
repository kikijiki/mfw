import { useQuery } from "@tanstack/react-query";
import {
	ChevronDown,
	ChevronRight,
	FileImage,
	FileText,
	Folder,
	FolderOpen,
	Network,
	Shapes,
} from "lucide-react";
import { useMemo, useState } from "react";

import { AppLink } from "../../components/AppLink";
import { LoadingRows } from "../../components/Loading";
import { Chip } from "../../components/Page";
import type { RouterOutputs } from "../../lib/trpc";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";
import {
	ancestorDirs,
	buildTree,
	flattenTree,
	groupSources,
	statusTone,
} from "./docsModel";

export type DocSource = RouterOutputs["docs"]["sources"][number];
export type DocEntry = RouterOutputs["docs"]["entries"]["entries"][number];

const muted = { color: "var(--mfw-fg-muted)" } as const;

/** The left pane: sources grouped Board / Directories, each a collapsible list of its documents. */
export function DocsTree({
	project,
	sources,
	selected,
}: {
	project: string;
	sources: readonly DocSource[];
	selected: { source?: string; key?: string };
}) {
	const [open, setOpen] = useState<Set<string>>(
		() => new Set([selected.source ?? "adr"]),
	);
	const toggle = (id: string) =>
		setOpen((cur) => {
			const next = new Set(cur);
			if (!next.delete(id)) next.add(id);
			return next;
		});

	return (
		<nav aria-label="Documents" className="flex flex-col py-1">
			{groupSources(sources).map((group) => (
				<section key={group.title} className="mb-1">
					<h2
						className="px-3 pt-2 pb-1 uppercase"
						style={{
							color: "var(--mfw-fg-faint)",
							fontSize: "var(--mfw-text-2xs)",
							letterSpacing: "0.06em",
						}}
					>
						{group.title}
					</h2>
					{group.sources.map((source) => (
						<SourceGroup
							key={source.id}
							project={project}
							source={source}
							open={open.has(source.id) || selected.source === source.id}
							onToggle={() => toggle(source.id)}
							selectedKey={
								selected.source === source.id ? selected.key : undefined
							}
						/>
					))}
				</section>
			))}
		</nav>
	);
}

function SourceGroup({
	project,
	source,
	open,
	onToggle,
	selectedKey,
}: {
	project: string;
	source: DocSource;
	open: boolean;
	onToggle: () => void;
	selectedKey?: string;
}) {
	const trpc = useTRPC();
	const entries = useQuery({
		...trpc.docs.entries.queryOptions({ project, sourceId: source.id }),
		enabled: open && !source.missing,
	});
	const Chevron = open ? ChevronDown : ChevronRight;
	return (
		<div>
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={open}
				className="mfw-focus flex w-full items-center gap-1.5 px-3 py-1 text-left hover:bg-[var(--mfw-bg-subtle)]"
			>
				<Chevron aria-hidden className="size-3.5 shrink-0" style={muted} />
				<span className="min-w-0 flex-1 truncate font-medium">
					{source.label}
				</span>
				{source.missing ? (
					<Chip tone="warn" title={`${source.path} does not exist`}>
						missing
					</Chip>
				) : (
					<span className="mfw-num" style={muted}>
						{source.count}
						{source.truncated ? "+" : ""}
					</span>
				)}
			</button>
			{open ? (
				entries.isLoading ? (
					<div className="px-3 py-1">
						<LoadingRows rows={3} />
					</div>
				) : entries.isError ? (
					<p className="px-6 py-1" style={{ color: "var(--mfw-warn)" }}>
						Could not list this source.
					</p>
				) : source.kind === "board" ? (
					<BoardList
						project={project}
						source={source}
						entries={entries.data?.entries ?? []}
						selectedKey={selectedKey}
					/>
				) : (
					<DirTree
						project={project}
						source={source}
						entries={entries.data?.entries ?? []}
						selectedKey={selectedKey}
					/>
				)
			) : null}
		</div>
	);
}

function BoardList({
	project,
	source,
	entries,
	selectedKey,
}: {
	project: string;
	source: DocSource;
	entries: readonly DocEntry[];
	selectedKey?: string;
}) {
	if (entries.length === 0) {
		return (
			<p className="px-8 py-1" style={muted}>
				No {source.label.toLowerCase()} yet.
			</p>
		);
	}
	return (
		<ul>
			{entries.map((entry) => (
				<li key={entry.key}>
					<AppLink
						to={href.docs(project, { source: source.id, key: entry.key })}
						aria-current={selectedKey === entry.key ? "page" : undefined}
						className="flex min-w-0 flex-col gap-0.5 py-1 pr-3 pl-8"
						style={{
							background:
								selectedKey === entry.key ? "var(--mfw-bg-subtle)" : undefined,
						}}
					>
						<span className="truncate">{entry.title}</span>
						<span className="flex items-center gap-2">
							<span className="mfw-num" style={muted}>
								{entry.key}
							</span>
							{entry.status ? (
								<Chip tone={statusTone(entry.status)}>{entry.status}</Chip>
							) : null}
						</span>
					</AppLink>
				</li>
			))}
		</ul>
	);
}

function DirTree({
	project,
	source,
	entries,
	selectedKey,
}: {
	project: string;
	source: DocSource;
	entries: readonly DocEntry[];
	selectedKey?: string;
}) {
	const tree = useMemo(() => buildTree(entries), [entries]);
	const [expanded, setExpanded] = useState<Set<string>>(
		() => new Set(selectedKey ? ancestorDirs(selectedKey) : []),
	);
	const rows = flattenTree(tree, expanded);
	if (entries.length === 0) {
		return (
			<p className="px-8 py-1" style={muted}>
				{source.missing ? "Directory not found." : "No documents match."}
			</p>
		);
	}
	return (
		<ul>
			{rows.map(({ node, depth, expanded: isOpen }) => {
				const pad = { paddingLeft: `${2 + depth * 0.9}rem` };
				if (node.kind === "dir") {
					const Icon = isOpen ? FolderOpen : Folder;
					return (
						<li key={`d:${node.path}`}>
							<button
								type="button"
								aria-expanded={isOpen}
								onClick={() =>
									setExpanded((cur) => {
										const next = new Set(cur);
										if (!next.delete(node.path)) next.add(node.path);
										return next;
									})
								}
								className="mfw-focus flex w-full items-center gap-1.5 py-0.5 pr-3 text-left hover:bg-[var(--mfw-bg-subtle)]"
								style={pad}
							>
								<Icon aria-hidden className="size-3.5 shrink-0" style={muted} />
								<span className="min-w-0 flex-1 truncate">{node.name}</span>
								<span className="mfw-num" style={muted}>
									{node.count}
								</span>
							</button>
						</li>
					);
				}
				const Icon = fileIcon(node.entry.fileType);
				const active = selectedKey === node.key;
				return (
					<li key={`f:${node.key}`}>
						<AppLink
							to={href.docs(project, { source: source.id, key: node.key })}
							aria-current={active ? "page" : undefined}
							title={node.entry.path}
							clipped
							className="flex min-w-0 items-center gap-1.5 py-0.5 pr-3"
							style={{
								...pad,
								background: active ? "var(--mfw-bg-subtle)" : undefined,
							}}
						>
							<Icon aria-hidden className="size-3.5 shrink-0" style={muted} />
							<span className="min-w-0 flex-1 truncate">
								{node.entry.title}
							</span>
							{node.entry.title !== node.name ? (
								<span
									className="max-w-28 truncate"
									style={{ ...muted, fontSize: "var(--mfw-text-2xs)" }}
								>
									{node.name}
								</span>
							) : null}
						</AppLink>
					</li>
				);
			})}
		</ul>
	);
}

function fileIcon(type: DocEntry["fileType"]) {
	switch (type) {
		case "image":
		case "svg":
			return FileImage;
		case "mermaid":
			return Network;
		case "plantuml":
			return Shapes;
		default:
			return FileText;
	}
}
