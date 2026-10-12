import { Check, Copy, FolderOpen, Link2 } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { AppLink } from "../../components/AppLink";
import { Chip } from "../../components/Page";
import { RelativeTime } from "../../components/RelativeTime";
import type { RouterOutputs } from "../../lib/trpc";
import { href } from "../../routes";
import { DOC_ASSET_BASE, DocMarkdown } from "./DocMarkdown";
import { docAssetUrl, type LinkContext } from "./docLinks";
import { editHint, filesTarget, propertyText, statusTone } from "./docsModel";
import { Mermaid } from "./Mermaid";
import { mermaidFences } from "./markdownBlocks";

export type DocContent = RouterOutputs["docs"]["read"];

/** Front matter keys that repeat what the header already says. */
const HIDDEN_PROPERTIES = new Set(["title", "mfw", "rev", "id"]);

const muted = { color: "var(--mfw-fg-muted)" } as const;
const small = { fontSize: "var(--mfw-text-xs)" } as const;

/**
 * One document, read-only: header (title, type, status, path and the
 * per-document actions), a compact property header from the front matter or
 * the board fields, then the body rendered for its kind. Editing a board ADR
 * is `AdrEditor`'s; everything else says where to edit it.
 */
export function DocReader({
	project,
	content,
	sourceKind,
	link,
	knownIds,
	idSources,
}: {
	project: string;
	content: DocContent;
	sourceKind: "board" | "dir";
	link: LinkContext;
	knownIds: ReadonlySet<string>;
	/** Board document id → the source (type) it lives in, for the links in the property header. */
	idSources: ReadonlyMap<string, string>;
}) {
	const { entry } = content;
	const files = filesTarget(entry);
	const props = Object.entries(content.properties).filter(
		([k, v]) =>
			!HIDDEN_PROPERTIES.has(k) &&
			v !== null &&
			v !== undefined &&
			propertyText(v) !== "",
	);
	const diagrams =
		entry.fileType === "markdown" ? mermaidFences(content.body).length : 0;
	const hint = editHint(entry, sourceKind);

	return (
		<article className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
			<header
				className="flex flex-col gap-2 border-b px-4 py-3"
				style={{ borderColor: "var(--mfw-border)" }}
			>
				<div className="flex flex-wrap items-center gap-2">
					<h1
						className="min-w-[12rem] flex-1 font-semibold"
						style={{ fontSize: "var(--mfw-text-lg)" }}
					>
						{entry.title}
					</h1>
					<div className="flex shrink-0 items-center gap-1">
						{files ? (
							<Button asChild size="sm" variant="outline">
								<AppLink
									to={href.files(project, {
										path: files.path,
										file: files.file,
									})}
									title="Open this file in the Files browser"
								>
									<FolderOpen aria-hidden /> Files
								</AppLink>
							</Button>
						) : null}
						<CopyButton
							label="Copy path"
							text={entry.path.replace(/^board:/, "")}
						/>
						<CopyButton
							label="Copy link"
							icon={<Link2 aria-hidden />}
							text={() => window.location.href}
						/>
					</div>
				</div>
				<div className="flex flex-wrap items-center gap-2" style={small}>
					{entry.type ? <Chip>{entry.type}</Chip> : null}
					{entry.status ? (
						<Chip tone={statusTone(entry.status)}>{entry.status}</Chip>
					) : null}
					{entry.type ? (
						<span className="mfw-num" style={muted}>
							{entry.key}
						</span>
					) : null}
					<span className="mfw-num" style={muted}>
						{entry.path}
					</span>
					{entry.date ? <span style={muted}>{entry.date}</span> : null}
					{entry.modifiedAt > 0 ? (
						<span style={muted}>
							changed <RelativeTime value={entry.modifiedAt} />
						</span>
					) : null}
					{diagrams > 0 ? (
						<Chip>
							{diagrams} diagram{diagrams === 1 ? "" : "s"}
						</Chip>
					) : null}
				</div>
				{props.length > 0 || (entry.links?.length ?? 0) > 0 ? (
					<dl
						className="flex flex-wrap gap-x-4 gap-y-1"
						style={small}
						aria-label="Properties"
					>
						{props.map(([key, value]) => (
							<div key={key} className="flex min-w-0 gap-1.5">
								<dt style={{ color: "var(--mfw-fg-faint)" }}>{key}</dt>
								<dd className="min-w-0 break-words">{propertyText(value)}</dd>
							</div>
						))}
						{(entry.links ?? []).map((l) => (
							<div key={`link-${l.field}`} className="flex min-w-0 gap-1.5">
								<dt style={{ color: "var(--mfw-fg-faint)" }}>{l.field}</dt>
								<dd className="flex min-w-0 flex-wrap gap-x-2">
									{l.ids.map((id) => {
										const source = idSources.get(id);
										return source ? (
											<AppLink
												key={id}
												to={href.docs(project, { source, key: id })}
												className="mfw-num text-sky-400"
											>
												{id}
											</AppLink>
										) : knownIds.has(id) ? (
											<AppLink
												key={id}
												to={href.task(project, id)}
												className="mfw-num text-sky-400"
											>
												{id}
											</AppLink>
										) : (
											<span key={id} className="mfw-num">
												{id}
											</span>
										);
									})}
								</dd>
							</div>
						))}
					</dl>
				) : null}
				{hint ? <p style={{ ...muted, ...small }}>{hint}</p> : null}
			</header>
			<div className="min-w-0 px-4 py-3">
				{content.truncated ? (
					<p className="mb-2" style={{ color: "var(--mfw-warn)", ...small }}>
						Only the first part of this file is shown ({entry.size} bytes).
					</p>
				) : null}
				<DocBody
					project={project}
					content={content}
					link={link}
					knownIds={knownIds}
				/>
			</div>
		</article>
	);
}

function DocBody({
	project,
	content,
	link,
	knownIds,
}: {
	project: string;
	content: DocContent;
	link: LinkContext;
	knownIds: ReadonlySet<string>;
}) {
	const { entry } = content;
	switch (entry.fileType) {
		case "image":
		case "svg":
			return (
				<img
					src={docAssetUrl(
						DOC_ASSET_BASE(),
						project,
						entry.sourceId,
						entry.key,
					)}
					alt={entry.title}
					className="max-w-full rounded border p-2"
					style={{ borderColor: "var(--mfw-border)" }}
				/>
			);
		case "mermaid":
			return (
				<>
					<Mermaid code={content.body} />
					<SourceBlock label="Source" text={content.body} />
				</>
			);
		case "plantuml":
			return (
				<>
					<p className="mb-2" style={{ ...muted, ...small }}>
						PlantUML is shown as source; there is no renderer in the app.
					</p>
					<SourceBlock label="PlantUML source" text={content.body} open />
				</>
			);
		case "text":
			return <SourceBlock label="Text" text={content.body} open />;
		default:
			if (content.binary) {
				return (
					<p style={muted}>This file is binary and is not shown as text.</p>
				);
			}
			return content.body.trim() === "" ? (
				<p style={muted}>This document is empty.</p>
			) : (
				<div className="max-w-3xl">
					<DocMarkdown
						project={project}
						text={content.body}
						link={link}
						knownIds={knownIds}
					/>
				</div>
			);
	}
}

function SourceBlock({
	label,
	text,
	open,
}: {
	label: string;
	text: string;
	open?: boolean;
}) {
	return (
		<details open={open} className="my-2">
			<summary style={{ ...muted, ...small }} className="cursor-pointer">
				{label}
			</summary>
			<pre
				className="mt-1 overflow-x-auto rounded border p-2.5 text-xs"
				style={{
					borderColor: "var(--mfw-border)",
					background: "var(--mfw-bg-subtle)",
				}}
			>
				<code>{text}</code>
			</pre>
		</details>
	);
}

function CopyButton({
	label,
	text,
	icon,
}: {
	label: string;
	text: string | (() => string);
	icon?: React.ReactNode;
}) {
	const [done, setDone] = useState(false);
	return (
		<Button
			size="sm"
			variant="ghost"
			onClick={() => {
				const value = typeof text === "function" ? text() : text;
				void navigator.clipboard?.writeText(value).then(() => {
					setDone(true);
					setTimeout(() => setDone(false), 1500);
				});
			}}
		>
			{done ? <Check aria-hidden /> : (icon ?? <Copy aria-hidden />)}
			{done ? "Copied" : label}
		</Button>
	);
}
