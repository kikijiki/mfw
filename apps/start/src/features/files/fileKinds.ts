import type { DirSourceRef, LinkContext } from "../docs/docLinks";

/**
 * How the file viewer presents a file, by name alone (what the daemon will
 * serve is decided server-side again; this only chooses the presentation).
 */

export type FileKind = "markdown" | "image" | "text";

/** Matches `viewerImageMime` in the daemon. */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|ico|avif)$/i;
const MARKDOWN_EXT = /\.(md|markdown)$/i;

/** The most the daemon serves as image bytes (`MAX_IMAGE_BYTES`). */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export function fileKind(path: string): FileKind {
	if (MARKDOWN_EXT.test(path)) return "markdown";
	if (IMAGE_EXT.test(path)) return "image";
	return "text";
}

export const isSvg = (path: string) => /\.svg$/i.test(path);

/** Where a file's bytes are served from: the working tree, a run's worktree, or a ref. */
export interface FileSource {
	project: string;
	ref?: string;
	run?: string;
}

/** Same derivation as the other asset routes: `BASE_URL` keeps a sub-path mount working. */
export const FILE_ASSET_BASE = () =>
	`${import.meta.env?.BASE_URL ?? "/"}api/files`.replace(/\/{2,}/g, "/");

/** URL of the read-only image route (`routes/api/files.$project.$.ts`). */
export function fileAssetUrl(
	base: string,
	source: FileSource,
	path: string,
): string {
	const route = [source.project, ...path.split("/")]
		.map(encodeURIComponent)
		.join("/");
	const query = new URLSearchParams();
	if (source.ref) query.set("ref", source.ref);
	else if (source.run) query.set("run", source.run);
	const qs = query.toString();
	return `${base}/${route}${qs ? `?${qs}` : ""}`;
}

/** The only "source" is the browsed tree itself, so every in-tree link resolves to a key = tree path. */
const TREE_SOURCE: DirSourceRef = {
	id: "tree",
	kind: "dir",
	path: ".",
	base: "repo",
};

/** Link resolution for a markdown file at `path`: relative to its own directory. */
export function markdownContext(path: string): LinkContext {
	const cut = path.lastIndexOf("/");
	return {
		from: { base: "repo", dir: cut < 0 ? "" : path.slice(0, cut) },
		sources: [TREE_SOURCE],
	};
}

export function parentDir(path: string): string | undefined {
	const cut = path.lastIndexOf("/");
	return cut < 0 ? undefined : path.slice(0, cut);
}
