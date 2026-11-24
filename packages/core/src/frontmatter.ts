import { parse as parseYaml } from "yaml";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/** A markdown file's YAML frontmatter (parsed) and body. Throws when there is none. */
export function splitFrontmatter(raw: string): {
	data: unknown;
	body: string;
} {
	const m = FRONTMATTER_RE.exec(raw);
	if (!m) throw new Error("missing or malformed YAML frontmatter");
	return { data: parseYaml(m[1] as string), body: m[2] ?? "" };
}
