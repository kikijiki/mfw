/**
 * The Docs screen's pure rules: the URL splat, the file tree of a directory
 * source and the order the sources are listed in. No React, no queries.
 */

/** `adr/MFW-ADR-7` → source `adr`, key `MFW-ADR-7`; `docs/a/b.md` → `docs`, `a/b.md`. Segments are decoded; `.`/`..` are dropped. */
export function parseDocsSplat(splat: string | undefined): {
	source?: string;
	key?: string;
} {
	const parts = (splat ?? "")
		.split("/")
		.filter((s) => s.length > 0)
		.map((s) => {
			try {
				return decodeURIComponent(s);
			} catch {
				return s;
			}
		})
		.filter((s) => s !== "." && s !== "..");
	const [source, ...rest] = parts;
	if (!source) return {};
	return rest.length > 0 ? { source, key: rest.join("/") } : { source };
}

export interface TreeFile<E> {
	kind: "file";
	name: string;
	/** The document key (the path inside the source). */
	key: string;
	entry: E;
}

export interface TreeDir<E> {
	kind: "dir";
	name: string;
	/** Path of the directory inside the source. */
	path: string;
	children: TreeNode<E>[];
	/** Documents under it, at any depth. */
	count: number;
}

export type TreeNode<E> = TreeFile<E> | TreeDir<E>;

/** A source's documents as a tree: directories first, then files, each by name. */
export function buildTree<E extends { key: string }>(
	entries: readonly E[],
): TreeNode<E>[] {
	const root: TreeDir<E> = {
		kind: "dir",
		name: "",
		path: "",
		children: [],
		count: 0,
	};
	const dirs = new Map<string, TreeDir<E>>([["", root]]);
	const ensure = (path: string): TreeDir<E> => {
		const hit = dirs.get(path);
		if (hit) return hit;
		const cut = path.lastIndexOf("/");
		const parent = ensure(cut < 0 ? "" : path.slice(0, cut));
		const dir: TreeDir<E> = {
			kind: "dir",
			name: cut < 0 ? path : path.slice(cut + 1),
			path,
			children: [],
			count: 0,
		};
		parent.children.push(dir);
		dirs.set(path, dir);
		return dir;
	};
	for (const entry of entries) {
		const cut = entry.key.lastIndexOf("/");
		const dir = ensure(cut < 0 ? "" : entry.key.slice(0, cut));
		dir.children.push({
			kind: "file",
			name: cut < 0 ? entry.key : entry.key.slice(cut + 1),
			key: entry.key,
			entry,
		});
	}
	const finish = (dir: TreeDir<E>): number => {
		let count = 0;
		for (const child of dir.children) {
			count += child.kind === "dir" ? finish(child) : 1;
		}
		dir.children.sort((a, b) =>
			a.kind !== b.kind
				? a.kind === "dir"
					? -1
					: 1
				: a.name.localeCompare(b.name, undefined, { numeric: true }),
		);
		dir.count = count;
		return count;
	};
	finish(root);
	return root.children;
}

export interface TreeRow<E> {
	node: TreeNode<E>;
	depth: number;
	expanded: boolean;
}

/** The rows to draw: a directory's children only while its path is in `expanded`. */
export function flattenTree<E>(
	nodes: readonly TreeNode<E>[],
	expanded: ReadonlySet<string>,
	depth = 0,
): TreeRow<E>[] {
	const rows: TreeRow<E>[] = [];
	for (const node of nodes) {
		if (node.kind === "file") {
			rows.push({ node, depth, expanded: false });
			continue;
		}
		const open = expanded.has(node.path);
		rows.push({ node, depth, expanded: open });
		if (open) rows.push(...flattenTree(node.children, expanded, depth + 1));
	}
	return rows;
}

/** Directory paths to open so `key` is visible: `a/b/c.md` → `a`, `a/b`. */
export function ancestorDirs(key: string): string[] {
	const parts = key.split("/");
	const out: string[] = [];
	for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
	return out;
}

export interface SourceLike {
	id: string;
	kind: "board" | "dir";
	label: string;
}

/** Board-fed types first (ADRs, then the rest in board order), then the directories. */
export function groupSources<S extends SourceLike>(
	sources: readonly S[],
): { title: string; sources: S[] }[] {
	const board = sources.filter((s) => s.kind === "board");
	const adr = board.filter((s) => s.id === "adr");
	const otherBoard = board.filter((s) => s.id !== "adr");
	const dirs = sources.filter((s) => s.kind === "dir");
	return [
		{ title: "Board", sources: [...adr, ...otherBoard] },
		{ title: "Directories", sources: dirs },
	].filter((g) => g.sources.length > 0);
}

/** Directory documents are read-only here; board documents are edited through their own surface. */
export function editHint(
	entry: { type?: string; path: string },
	kind: "board" | "dir",
): string {
	if (kind === "dir") {
		return `Read-only here: edit ${entry.path} in your editor.`;
	}
	if (entry.type === "adr") return "";
	return `Read-only here: edit with \`mfwb\` or in your editor (${entry.path}).`;
}

/** The repository-relative file for "Open in Files", or null when the document sits in a separate board folder. */
export function filesTarget(entry: {
	path: string;
}): { path: string; file: string } | null {
	if (entry.path.startsWith("board:")) return null;
	const cut = entry.path.lastIndexOf("/");
	return { path: cut < 0 ? "" : entry.path.slice(0, cut), file: entry.path };
}

/** One front-matter or board field value as the text the property header shows. */
export function propertyText(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (Array.isArray(value)) return value.map(propertyText).join(", ");
	if (typeof value === "object") {
		const json = JSON.stringify(value);
		return json.length > 120 ? `${json.slice(0, 117)}…` : json;
	}
	return String(value);
}

/** The chip tone of a board status; unknown statuses stay neutral. */
export function statusTone(
	status: string,
): "neutral" | "ok" | "warn" | "info" | "critical" {
	switch (status) {
		case "accepted":
		case "final":
		case "approved":
		case "done":
			return "ok";
		case "proposed":
		case "draft":
		case "review":
			return "info";
		case "rejected":
			return "critical";
		case "superseded":
		case "deprecated":
		case "archived":
			return "warn";
		default:
			return "neutral";
	}
}
