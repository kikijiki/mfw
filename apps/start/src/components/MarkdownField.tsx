import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { attachmentUrl } from "../features/tasks/attachments";
import { isAdrId, md, remarkTaskIds, TASK_HREF } from "../lib/markdown";
import { useGo } from "../lib/nav";
import { useTRPC } from "../lib/trpc";
import { href } from "../routes";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Textarea } from "./ui/textarea";

/**
 * Edit/Preview toggle for a markdown-bearing field (spec body, task Goal).
 * Preview is the default tab, rendering the markdown is the whole point.
 */
export function MarkdownField(props: {
	value: string;
	onChange: (value: string) => void;
	project: string;
	knownTaskIds: Set<string>;
	rows?: number;
	ariaLabel: string;
	placeholder?: string;
	disabled?: boolean;
	/** When set, `files/<name>` links and images resolve to this task's attachments. */
	attachmentTaskId?: string;
}) {
	const go = useGo();
	const trpc = useTRPC();
	// ADR ids link too. The list is small and shared with the ADRs page through
	// the query cache, so this costs one request per project, not per field.
	const adrs = useQuery(
		trpc.adrs.list.queryOptions({ project: props.project }),
	);
	const known = new Set([
		...props.knownTaskIds,
		...(adrs.data ?? []).map((a) => a.id),
	]);
	const resolve = (url: string | undefined) => {
		if (!url || !props.attachmentTaskId) return url;
		const m = /^(?:\.\/)?files\/([^/?#]+)$/.exec(url);
		if (!m) return url;
		let name = m[1] as string;
		try {
			name = decodeURIComponent(name);
		} catch {
			// keep the raw text; the server rejects a bad name
		}
		return attachmentUrl(props.project, props.attachmentTaskId, name);
	};

	return (
		<Tabs defaultValue="preview">
			<TabsList>
				<TabsTrigger value="edit">Edit</TabsTrigger>
				<TabsTrigger value="preview">Preview</TabsTrigger>
			</TabsList>
			<TabsContent value="edit">
				<Textarea
					rows={props.rows}
					value={props.value}
					aria-label={props.ariaLabel}
					placeholder={props.placeholder}
					disabled={props.disabled}
					onChange={(e) => props.onChange(e.target.value)}
				/>
			</TabsContent>
			<TabsContent value="preview">
				{props.value.trim() ? (
					<ReactMarkdown
						remarkPlugins={[remarkGfm, remarkTaskIds(known)]}
						components={{
							...md,
							a: ({ href: linkHref, ...rest }) => {
								if (linkHref?.startsWith(TASK_HREF)) {
									const refId = linkHref.slice(TASK_HREF.length);
									return (
										<a
											href={linkHref}
											{...rest}
											onClick={(e) => {
												e.preventDefault();
												go(
													isAdrId(refId)
														? href.adrs(props.project, refId)
														: href.task(props.project, refId),
												);
											}}
										/>
									);
								}
								return <md.a href={resolve(linkHref)} {...rest} />;
							},
							img: ({ src, alt }) => (
								<img
									src={typeof src === "string" ? resolve(src) : undefined}
									alt={alt ?? ""}
									className="my-2 max-h-96 max-w-full"
								/>
							),
						}}
					>
						{props.value}
					</ReactMarkdown>
				) : (
					<p className="text-sm text-muted-foreground">
						Nothing to preview yet.
					</p>
				)}
			</TabsContent>
		</Tabs>
	);
}
