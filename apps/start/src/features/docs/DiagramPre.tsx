import {
	Children,
	type ComponentPropsWithoutRef,
	isValidElement,
	type ReactNode,
} from "react";

import { md } from "../../lib/markdown";
import { Mermaid } from "./Mermaid";
import { isMermaidLang } from "./markdownBlocks";

/** The plain text under a React node (what a code block holds). */
export function textOf(node: ReactNode): string {
	if (node === null || node === undefined || typeof node === "boolean") {
		return "";
	}
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (isValidElement(node)) {
		return textOf((node.props as { children?: ReactNode }).children);
	}
	return "";
}

/**
 * The `pre` component for react-markdown: a fenced ```mermaid block becomes a
 * rendered diagram (falling back to its source), everything else the shared
 * code block. Used by Docs and by `MarkdownField`, so a diagram in a spec or an
 * ADR draws wherever markdown is previewed.
 */
export function DiagramPre(props: ComponentPropsWithoutRef<"pre">) {
	const child = Children.toArray(props.children)[0];
	if (isValidElement(child)) {
		const p = child.props as { className?: string; children?: ReactNode };
		const lang = /language-(\S+)/.exec(p.className ?? "")?.[1]?.toLowerCase();
		if (isMermaidLang(lang)) {
			return <Mermaid code={textOf(p.children).replace(/\n$/, "")} />;
		}
	}
	return <md.pre {...props} />;
}
