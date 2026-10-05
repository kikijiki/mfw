import type { Link, Parent, Text } from "mdast";
import type { ComponentPropsWithoutRef } from "react";
import { visit } from "unist-util-visit";

/**
 * Href prefix marking an auto-linkified task id (see `remarkTaskIds`). A hash,
 * not a custom scheme: react-markdown's `urlTransform` drops unsafe protocols,
 * which turned `mfw-task:` links into inert anchors.
 */
export const TASK_HREF = "#mfw-task-";

/** True for an ADR id (`MFW-ADR-7`), false for a task id (`MFW-7`). */
export const isAdrId = (id: string) => /-ADR-\d+$/.test(id);

/** `DEMO-3`, `MFW-12`, `MFW-ADR-7`: a project key, an optional kind, a number. */
const TASK_ID_RE = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+\b/g;

/**
 * remark plugin: turn bare task ids in prose (`DEMO-3`) into links.
 *
 * Only ids in `known` are linkified, so `UTF-8` or `HTTP-2` stay plain text.
 * Code spans and fences are not `text` nodes, so `visit` skips them; existing
 * links are skipped via the parent check.
 */
export function remarkTaskIds(known: Set<string>) {
	return () => (tree: Parent) => {
		visit(tree, "text", (node: Text, index, parent) => {
			if (!parent || index === undefined || parent.type === "link") return;

			const out: (Text | Link)[] = [];
			let last = 0;
			TASK_ID_RE.lastIndex = 0;
			for (
				let m = TASK_ID_RE.exec(node.value);
				m;
				m = TASK_ID_RE.exec(node.value)
			) {
				if (!known.has(m[0])) continue;
				if (m.index > last)
					out.push({ type: "text", value: node.value.slice(last, m.index) });
				out.push({
					type: "link",
					url: `${TASK_HREF}${m[0]}`,
					children: [{ type: "text", value: m[0] }],
				} as Link);
				last = m.index + m[0].length;
			}
			if (!out.length) return;
			if (last < node.value.length)
				out.push({ type: "text", value: node.value.slice(last) });

			(parent as Parent).children.splice(index, 1, ...(out as never[]));
			// Skip the nodes we just inserted so visit doesn't re-scan them.
			return index + out.length;
		});
	};
}

/** Shared ReactMarkdown element styling (no tailwind-typography dep). */
export const md = {
	h1: (p: ComponentPropsWithoutRef<"h1">) => (
		<h1 className="text-base font-semibold mt-4 mb-1.5" {...p} />
	),
	h2: (p: ComponentPropsWithoutRef<"h2">) => (
		<h2
			className="text-sm font-semibold mt-4 mb-1 uppercase tracking-wide text-muted-foreground"
			{...p}
		/>
	),
	h3: (p: ComponentPropsWithoutRef<"h3">) => (
		<h3 className="text-sm font-semibold mt-3 mb-1" {...p} />
	),
	p: (p: ComponentPropsWithoutRef<"p">) => (
		<p className="text-sm my-1.5 leading-relaxed" {...p} />
	),
	ul: (p: ComponentPropsWithoutRef<"ul">) => (
		<ul className="list-disc pl-5 my-1.5 text-sm space-y-0.5" {...p} />
	),
	ol: (p: ComponentPropsWithoutRef<"ol">) => (
		<ol className="list-decimal pl-5 my-1.5 text-sm space-y-0.5" {...p} />
	),
	li: (p: ComponentPropsWithoutRef<"li">) => <li className="text-sm" {...p} />,
	a: (p: ComponentPropsWithoutRef<"a">) => (
		<a className="text-sky-400 underline" {...p} />
	),
	code: (p: ComponentPropsWithoutRef<"code">) => (
		<code className="font-mono text-[0.85em] bg-muted/60 px-1 rounded" {...p} />
	),
	pre: (p: ComponentPropsWithoutRef<"pre">) => (
		<pre
			className="bg-muted/50 rounded p-2.5 overflow-x-auto my-2 text-xs [&_code]:bg-transparent [&_code]:p-0"
			{...p}
		/>
	),
	blockquote: (p: ComponentPropsWithoutRef<"blockquote">) => (
		<blockquote
			className="border-l-2 border-muted-foreground/40 pl-3 text-muted-foreground my-1.5"
			{...p}
		/>
	),
	input: (p: ComponentPropsWithoutRef<"input">) => (
		<input className="mr-1.5 align-middle" {...p} disabled />
	),
	table: (p: ComponentPropsWithoutRef<"table">) => (
		<table className="text-xs border-collapse my-2" {...p} />
	),
	th: (p: ComponentPropsWithoutRef<"th">) => (
		<th className="border border-muted px-2 py-1 text-left" {...p} />
	),
	td: (p: ComponentPropsWithoutRef<"td">) => (
		<td className="border border-muted px-2 py-1" {...p} />
	),
};
