/**
 * Link and image resolution for rendered documents, pure.
 *
 * A relative link in a document means a path next to that document. The app
 * has to turn it into either another document (an in-app route), an asset the
 * safe image route can serve, or leave it alone. Resolution is done in
 * "base space": the repository (or board folder) as the root, so a README's
 * `docs/guide/setup.md` finds the `docs` source holding it, and a guide's
 * `../img/a.png` stays inside whichever source contains it.
 */

export interface DirSourceRef {
	id: string;
	kind: "dir";
	/** Relative to its base; `"."` is the base itself. */
	path: string;
	base: "repo" | "board";
}

export interface DocFrom {
	base: "repo" | "board";
	/** The document's directory in base space (`""` is the base root). */
	dir: string;
}

export type ResolvedLink =
	| { kind: "anchor"; fragment: string }
	| { kind: "external"; href: string }
	| {
			kind: "doc";
			sourceId: string;
			key: string;
			fragment?: string;
			/** The target exists in the index but is not a document (an image, say). */
			asset?: boolean;
	  }
	| { kind: "unresolved"; href: string };

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** `a/b/../c` → `a/c`; null when it climbs above the root. */
export function joinBasePath(dir: string, rel: string): string | null {
	const out: string[] = dir.split("/").filter((s) => s.length > 0);
	for (const part of rel.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (out.length === 0) return null;
			out.pop();
		} else out.push(part);
	}
	return out.join("/");
}

/** Where a document with `key` in `source` lives, for resolving its relative links. */
export function fromDirSource(
	source: Pick<DirSourceRef, "path" | "base">,
	key: string,
): DocFrom {
	const cut = key.lastIndexOf("/");
	const inner = cut < 0 ? "" : key.slice(0, cut);
	const root = source.path === "." ? "" : source.path;
	return {
		base: source.base,
		dir: [root, inner].filter((s) => s.length > 0).join("/"),
	};
}

/** A board document's display path (`adrs/X.md`, `board:adrs/X.md`) as where it lives. */
export function fromBoardPath(path: string): DocFrom {
	const board = path.startsWith("board:");
	const rel = board ? path.slice("board:".length) : path;
	const cut = rel.lastIndexOf("/");
	return {
		base: board ? "board" : "repo",
		dir: cut < 0 ? "" : rel.slice(0, cut),
	};
}

/** The directory source holding `path` in `base`, deepest first; the key is the path inside it. */
export function locateInSources(
	base: "repo" | "board",
	path: string,
	sources: readonly DirSourceRef[],
): { sourceId: string; key: string } | null {
	let best: { source: DirSourceRef; root: string } | null = null;
	for (const source of sources) {
		if (source.base !== base) continue;
		const root = source.path === "." ? "" : source.path;
		const inside = root === "" || path === root || path.startsWith(`${root}/`);
		if (!inside || path === root) continue;
		if (!best || root.length > best.root.length) best = { source, root };
	}
	if (!best) return null;
	const key = best.root === "" ? path : path.slice(best.root.length + 1);
	return key ? { sourceId: best.source.id, key } : null;
}

export interface LinkContext {
	from: DocFrom;
	sources: readonly DirSourceRef[];
	/** Board documents by their display path (`adrs/DOC-ADR-1-x.md`), so a link to a board file lands on the board document. */
	boardPaths?: ReadonlyMap<string, { sourceId: string; key: string }>;
}

const DOC_EXT = /\.(md|mdx|markdown|txt|adoc|mmd|mermaid|puml|plantuml)$/i;

function splitHref(href: string): { path: string; fragment?: string } {
	const hash = href.indexOf("#");
	const noHash = hash < 0 ? href : href.slice(0, hash);
	const q = noHash.indexOf("?");
	const path = q < 0 ? noHash : noHash.slice(0, q);
	const fragment = hash < 0 ? undefined : href.slice(hash + 1);
	return { path, fragment: fragment || undefined };
}

function decodePath(path: string): string {
	try {
		return path
			.split("/")
			.map((s) => decodeURIComponent(s))
			.join("/");
	} catch {
		return path;
	}
}

/** What a markdown link points at. */
export function resolveDocLink(href: string, ctx: LinkContext): ResolvedLink {
	const raw = href.trim();
	if (raw.startsWith("#")) return { kind: "anchor", fragment: raw.slice(1) };
	if (SCHEME.test(raw) || raw.startsWith("//")) {
		return { kind: "external", href: raw };
	}
	const { path, fragment } = splitHref(raw);
	if (path === "") return { kind: "unresolved", href: raw };
	const rooted = path.startsWith("/");
	const target = joinBasePath(
		rooted ? "" : ctx.from.dir,
		decodePath(rooted ? path.replace(/^\/+/, "") : path),
	);
	if (target === null || target === "") {
		return { kind: "unresolved", href: raw };
	}
	const asBoard = ctx.boardPaths?.get(
		ctx.from.base === "board" ? `board:${target}` : target,
	);
	if (asBoard) {
		return {
			kind: "doc",
			sourceId: asBoard.sourceId,
			key: asBoard.key,
			fragment,
		};
	}
	const hit = locateInSources(ctx.from.base, target, ctx.sources);
	if (!hit) return { kind: "unresolved", href: raw };
	return {
		kind: "doc",
		sourceId: hit.sourceId,
		key: hit.key,
		fragment,
		...(DOC_EXT.test(hit.key) ? {} : { asset: true }),
	};
}

/** The server route that streams an image or SVG from a source, under `apiBase` (`/api/docs`). */
export function docAssetUrl(
	apiBase: string,
	project: string,
	sourceId: string,
	key: string,
): string {
	return `${apiBase}/${[project, sourceId, ...key.split("/")]
		.map(encodeURIComponent)
		.join("/")}`;
}

/** An `<img src>` as an asset URL: relative to the document, inside a source; anything else is returned as is. */
export function resolveImageSrc(
	src: string,
	ctx: LinkContext,
	toUrl: (sourceId: string, key: string) => string,
): string {
	const link = resolveDocLink(src, ctx);
	if (link.kind === "doc") return toUrl(link.sourceId, link.key);
	if (link.kind === "external") return link.href;
	return src;
}
