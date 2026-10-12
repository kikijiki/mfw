import type { ComponentPropsWithoutRef, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { TipSpan } from "~/components/ui/tooltip";
import { AppLink } from "../../components/AppLink";
import { isAdrId, md, remarkTaskIds, TASK_HREF } from "../../lib/markdown";
import { href } from "../../routes";
import { DiagramPre, textOf } from "./DiagramPre";
import {
	docAssetUrl,
	type LinkContext,
	resolveDocLink,
	resolveImageSrc,
} from "./docLinks";
import { createSlugger } from "./markdownBlocks";

/**
 * A document rendered for reading: GFM, heading anchors, mermaid fences as
 * diagrams, task and ADR ids as links, relative links resolved inside the app
 * and relative images served through the safe asset route.
 */

/** Same derivation as the attachment URL: `BASE_URL` keeps a sub-path mount working. */
export const DOC_ASSET_BASE = () =>
	`${import.meta.env?.BASE_URL ?? "/"}api/docs`.replace(/\/{2,}/g, "/");

export function DocMarkdown({
	project,
	text,
	link,
	knownIds,
	targets,
}: {
	project: string;
	text: string;
	link: LinkContext;
	/** Task and ADR ids that become links when they appear in prose. */
	knownIds: ReadonlySet<string>;
	/**
	 * Where resolved targets go when the text is not a doc-source document (a
	 * markdown file in the file viewer): `image` is an `<img src>` for a
	 * resolved key, `link` an in-app href. Omitted, the docs routes are used.
	 */
	targets?: {
		image: (key: string) => string;
		link: (key: string, fragment?: string) => string;
	};
}) {
	const slug = createSlugger();
	const heading =
		(Tag: "h1" | "h2" | "h3" | "h4") =>
		(props: ComponentPropsWithoutRef<"h1">) => {
			const id = slug(textOf(props.children as ReactNode));
			const H = md[Tag === "h4" ? "h3" : Tag];
			return <H id={id} {...props} />;
		};

	return (
		<ReactMarkdown
			remarkPlugins={[remarkGfm, remarkTaskIds(new Set(knownIds))]}
			// Our own link resolution decides what is safe; the default
			// transform would drop the `#mfw-task-` anchors it added.
			components={{
				...md,
				h1: heading("h1"),
				h2: heading("h2"),
				h3: heading("h3"),
				h4: heading("h4"),
				pre: DiagramPre,
				a: ({ href: target, children }) => {
					if (!target) return <span>{children}</span>;
					if (target.startsWith(TASK_HREF)) {
						const id = target.slice(TASK_HREF.length);
						return (
							<AppLink
								to={
									isAdrId(id) ? href.adr(project, id) : href.task(project, id)
								}
								className="text-sky-400 underline"
							>
								{children}
							</AppLink>
						);
					}
					const resolved = resolveDocLink(target, link);
					switch (resolved.kind) {
						case "anchor":
							return (
								<a
									className="text-sky-400 underline"
									href={`#${resolved.fragment}`}
								>
									{children}
								</a>
							);
						case "external":
							return (
								<a
									className="text-sky-400 underline"
									href={resolved.href}
									target="_blank"
									rel="noopener noreferrer"
								>
									{children}
								</a>
							);
						case "doc":
							if (targets) {
								return (
									<AppLink
										className="text-sky-400 underline"
										to={targets.link(resolved.key, resolved.fragment)}
									>
										{children}
									</AppLink>
								);
							}
							return resolved.asset ? (
								<a
									className="text-sky-400 underline"
									href={docAssetUrl(
										DOC_ASSET_BASE(),
										project,
										resolved.sourceId,
										resolved.key,
									)}
									target="_blank"
									rel="noopener noreferrer"
								>
									{children}
								</a>
							) : (
								<AppLink
									className="text-sky-400 underline"
									to={`${href.docs(project, { source: resolved.sourceId, key: resolved.key })}${
										resolved.fragment ? `#${resolved.fragment}` : ""
									}`}
								>
									{children}
								</AppLink>
							);
						default:
							return (
								<TipSpan
									className="underline decoration-dotted"
									tip={`${resolved.href} is not in the docs index`}
								>
									{children}
								</TipSpan>
							);
					}
				},
				img: ({ src, alt }) => (
					<img
						src={
							typeof src === "string"
								? resolveImageSrc(src, link, (sourceId, key) =>
										targets
											? targets.image(key)
											: docAssetUrl(DOC_ASSET_BASE(), project, sourceId, key),
									)
								: undefined
						}
						alt={alt ?? ""}
						loading="lazy"
						className="my-2 max-h-[32rem] max-w-full"
					/>
				),
			}}
		>
			{text}
		</ReactMarkdown>
	);
}
