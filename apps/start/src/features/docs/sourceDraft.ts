/**
 * The add-a-directory form's pure rules: the source id derived from a label
 * and the glob list typed as text. The daemon validates everything again
 * (paths stay inside the repository or board folder); this only keeps the form
 * from sending obviously unusable input.
 */

export interface DocSourceInput {
	id: string;
	label: string;
	path: string;
	base?: "repo" | "board";
	include?: string[];
	exclude?: string[];
	kind?: string;
}

const RESERVED = new Set(["_", "search", "new"]);

/** A URL-safe id from a label, made unique against `taken` (`docs`, `docs-2`, ...). */
export function deriveSourceId(label: string, taken: Iterable<string>): string {
	const used = new Set(taken);
	const base =
		label
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 36) || "docs";
	let id = base;
	for (let n = 2; used.has(id) || RESERVED.has(id); n++) id = `${base}-${n}`;
	return id;
}

/** `**\/*.md, notes/**` or one per line → trimmed, non-empty globs. */
export function splitGlobs(text: string): string[] {
	return text
		.split(/[\n,]/)
		.map((g) => g.trim())
		.filter((g) => g.length > 0);
}

/** Why the form cannot be submitted yet, or null. */
export function sourceProblem(input: {
	label: string;
	path: string;
}): string | null {
	if (input.label.trim() === "") return "Give the source a name.";
	const path = input.path.trim();
	if (path === "") return "Choose a directory.";
	if (/^([/\\]|[A-Za-z]:)/.test(path)) {
		return "Use a path relative to the repository (or board folder).";
	}
	if (path.split(/[/\\]/).includes("..")) {
		return "A path cannot leave the repository.";
	}
	return null;
}

/** A stored source as one line for the list: `docs/ · **\/*.md`. */
export function describeSource(s: {
	path: string;
	base?: "repo" | "board";
	include?: readonly string[];
	exclude?: readonly string[];
}): string {
	const where = `${s.base === "board" ? "board:" : ""}${s.path === "." ? "." : `${s.path}/`}`;
	const parts = [where];
	if (s.include?.length) parts.push(`only ${s.include.join(", ")}`);
	if (s.exclude?.length) parts.push(`not ${s.exclude.join(", ")}`);
	return parts.join(" · ");
}
