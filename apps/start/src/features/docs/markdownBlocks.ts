/**
 * Markdown structure the reader needs, pure: fenced code blocks (mermaid
 * among them) and heading slugs for `#fragment` links.
 */

export interface Fence {
	/** The info string's first word, lower-cased; `""` for a bare fence. */
	lang: string;
	code: string;
	/** 0-based line of the opening fence. */
	line: number;
}

/**
 * Fenced blocks of a document. A fence closes on a line of the same marker at
 * least as long as the opener; an unterminated fence runs to the end of the
 * document, as CommonMark has it. Indented code and inline code are not fences.
 */
export function extractFences(markdown: string): Fence[] {
	const lines = markdown.split(/\r?\n/);
	const out: Fence[] = [];
	for (let i = 0; i < lines.length; i++) {
		const open = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/.exec(
			lines[i] as string,
		);
		if (!open) continue;
		const marker = open[1] as string;
		const body: string[] = [];
		let j = i + 1;
		for (; j < lines.length; j++) {
			const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[j] as string);
			if (
				close &&
				(close[1] as string)[0] === marker[0] &&
				(close[1] as string).length >= marker.length
			) {
				break;
			}
			body.push(lines[j] as string);
		}
		out.push({
			lang: (open[2] as string).toLowerCase(),
			code: body.join("\n"),
			line: i,
		});
		i = j;
	}
	return out;
}

export const isMermaidLang = (lang: string | undefined): boolean =>
	lang === "mermaid" || lang === "mmd";

export const mermaidFences = (markdown: string): Fence[] =>
	extractFences(markdown).filter((f) => isMermaidLang(f.lang));

/** GitHub-style heading slug: lower-case, punctuation dropped, spaces to `-`. */
export function slugify(text: string): string {
	return text
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.replace(/\s+/g, "-");
}

/** A slug generator for one document render: repeats get GitHub's `-1`, `-2` suffix. */
export function createSlugger(): (text: string) => string {
	const seen = new Map<string, number>();
	return (text) => {
		const base = slugify(text);
		const n = seen.get(base) ?? 0;
		seen.set(base, n + 1);
		return n === 0 ? base : `${base}-${n}`;
	};
}
