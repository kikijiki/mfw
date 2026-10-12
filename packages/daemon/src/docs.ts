import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import {
	type BoardConfig,
	type BoardDocument,
	BoardStore,
	loadBoardConfig,
	ownsPath,
	validateOwnsPattern,
} from "@mfw/board-core";
import { parse as parseYaml } from "yaml";
import type { DocSourceConfig } from "./config.ts";
import { ensureBoardConfig } from "./default-board-config.ts";
import type { Logger } from "./log.ts";
import { runProc } from "./proc.ts";
import { NotFoundError, PathEscapeError } from "./workspace.ts";

/**
 * The Docs surface: every document a project has, in one index.
 *
 *  1. Board-fed sources: each non-task document type declared in `board.yaml`
 *     (ADRs, specs, journals, anything config-defined), read through
 *     `BoardStore`. Their ids are the type names.
 *  2. Directory sources: configured per project (`docs:` in the project's
 *     config entry), relative to the repository or the board folder.
 *  3. Suggestions: conventional documentation directories found on disk and
 *     NOT yet configured. They are never enabled silently.
 *
 * Containment is the same security property `WorkspaceService` guards: every
 * read goes through `realpath` against the physical base, symlinks are never
 * followed when listing, and a source's `path` cannot leave its base.
 * Directory listings use `git ls-files` (so `.gitignore` is honoured and
 * `node_modules`/`.git` are never walked); outside a work tree the walk skips
 * the same names. Everything is capped: entries per source, bytes per file,
 * total cached text.
 */

export const DEFAULT_DOC_INCLUDE: readonly string[] = [
	"**/*.md",
	"**/*.mdx",
	"**/*.txt",
	"**/*.adoc",
	"**/*.mmd",
	"**/*.puml",
	"**/*.svg",
	"**/*.png",
	"**/*.jpg",
	"**/*.jpeg",
	"**/*.gif",
	"**/*.webp",
];

export const DEFAULT_DOC_EXCLUDE: readonly string[] = [
	"**/node_modules/**",
	"**/.git/**",
	"**/.mfw/**",
];

/** Documents of this type are the board's work items, not documentation. */
const WORK_TYPE = "task";
const MAX_SOURCES = 40;
const MAX_ENTRIES = 3000;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_INDEX_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const CACHE_BYTES = 32 * 1024 * 1024;
const LISTING_TTL_MS = 1500;
const SNIFF = 8000;
const RESERVED_IDS = new Set(["_", "search", "new"]);

export type DocFileType =
	| "markdown"
	| "mermaid"
	| "plantuml"
	| "svg"
	| "image"
	| "text";

const TYPE_BY_EXT: Record<string, DocFileType> = {
	".md": "markdown",
	".mdx": "markdown",
	".markdown": "markdown",
	".mmd": "mermaid",
	".mermaid": "mermaid",
	".puml": "plantuml",
	".plantuml": "plantuml",
	".svg": "svg",
	".png": "image",
	".jpg": "image",
	".jpeg": "image",
	".gif": "image",
	".webp": "image",
	".txt": "text",
	".adoc": "text",
	".rst": "text",
};

export const fileTypeOf = (path: string): DocFileType | null =>
	TYPE_BY_EXT[extname(path).toLowerCase()] ?? null;

const IMAGE_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
};

/** The mime a served byte stream is given; null for anything not an image. */
export const imageMime = (path: string): string | null =>
	IMAGE_MIME[extname(path).toLowerCase()] ?? null;

/** A source configuration the caller must fix; mapped to BAD_REQUEST. */
export class DocSourceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DocSourceError";
	}
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

export interface DocEntry {
	sourceId: string;
	/** Board documents: the id. Directory documents: the path inside the source. */
	key: string;
	title: string;
	fileType: DocFileType;
	size: number;
	modifiedAt: number;
	/** Display path: relative to the repository (or board folder), `/`-separated. */
	path: string;
	/** Board documents only. */
	type?: string;
	status?: string;
	date?: string;
	links?: { field: string; ids: string[]; role?: "parent" | "children" }[];
}

export interface DocSourceView {
	id: string;
	kind: "board" | "dir";
	label: string;
	/** Display grouping: the board type name, or the configured hint. */
	group: string;
	count: number;
	/** Directory sources only. */
	path?: string;
	base?: "repo" | "board";
	include?: string[];
	exclude?: string[];
	missing?: boolean;
	truncated?: boolean;
	/** Board sources: the status values the type declares, in order. */
	statuses?: string[];
}

export interface DocSuggestion {
	id: string;
	label: string;
	path: string;
	base: "repo" | "board";
	include?: string[];
	kind?: string;
	fileCount: number;
	reason: string;
}

export interface DocContent {
	entry: DocEntry;
	/** Markdown/diagram/text source without front matter. Empty for images. */
	body: string;
	/** Front matter (files) or fields (board documents), for the property header. */
	properties: Record<string, unknown>;
	truncated: boolean;
	binary: boolean;
}

export interface DocSearchHit {
	sourceId: string;
	key: string;
	title: string;
	path: string;
	fileType: DocFileType;
	type?: string;
	status?: string;
	score: number;
	snippet: string;
	/** Offsets into `snippet` of the first matched term, for highlighting. */
	match: [number, number] | null;
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/** `---\n<yaml>\n---\n<body>`: the properties and the body. Not a front matter, or YAML that is not a mapping, leaves the text whole. */
export function parseFrontMatter(text: string): {
	properties: Record<string, unknown>;
	body: string;
} {
	const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
	if (!m) return { properties: {}, body: text };
	try {
		const parsed = parseYaml(m[1] as string);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return {
				properties: parsed as Record<string, unknown>,
				body: text.slice(m[0].length),
			};
		}
	} catch {
		// not YAML: show the file as written
	}
	return { properties: {}, body: text };
}

/** A document's title: front matter `title`, else the first `#` heading (outside a code fence), else the file name. */
export function docTitle(
	path: string,
	properties: Record<string, unknown>,
	body: string,
): string {
	const fm = properties.title;
	if (typeof fm === "string" && fm.trim()) return fm.trim();
	let fence = false;
	for (const line of body.split("\n", 400)) {
		if (/^\s*(```|~~~)/.test(line)) fence = !fence;
		if (fence) continue;
		const h = /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line);
		if (h) return (h[1] as string).trim();
	}
	return basename(path).replace(/\.[^.]+$/, "");
}

/** `docs/a/../b` → `docs/b`; refuses absolute, `..`, NUL and empty. `"."`/`""` is the base itself. */
export function normalizeDocPath(raw: string): string {
	if (raw.includes("\0")) throw new DocSourceError("a path cannot hold NUL");
	const cleaned = raw.trim().replace(/\\/g, "/");
	if (cleaned.startsWith("/") || /^[A-Za-z]:/.test(cleaned)) {
		throw new DocSourceError(
			`'${raw}' is absolute: use a path relative to the repository or the board folder`,
		);
	}
	const out: string[] = [];
	for (const part of cleaned.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			throw new DocSourceError(`'${raw}' leaves the repository (..)`);
		}
		out.push(part);
	}
	return out.join("/");
}

const slug = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40) || "docs";

const matchesAny = (globs: readonly string[], path: string) =>
	globs.some((g) => ownsPath(g, path));

/** Whether a source-relative path is listed under a source's globs. */
export function docIncluded(
	source: Pick<DocSourceConfig, "include" | "exclude">,
	rel: string,
): boolean {
	const include = source.include?.length ? source.include : DEFAULT_DOC_INCLUDE;
	if (!matchesAny(include, rel)) return false;
	if (matchesAny(DEFAULT_DOC_EXCLUDE, rel)) return false;
	return !(source.exclude && matchesAny(source.exclude, rel));
}

// ---------------------------------------------------------------------------
// containment + listing
// ---------------------------------------------------------------------------

const within = (base: string, real: string) =>
	real === base || real.startsWith(base + sep);

async function realOrNull(path: string): Promise<string | null> {
	try {
		return await realpath(path);
	} catch {
		return null;
	}
}

/** The deepest existing ancestor of `target`, resolved. Used to vet a path that does not exist yet. */
async function realAncestor(target: string): Promise<string | null> {
	let cur = target;
	for (;;) {
		const real = await realOrNull(cur);
		if (real) return real;
		const up = dirname(cur);
		if (up === cur) return null;
		cur = up;
	}
}

const WALK_SKIP = new Set([".git", "node_modules", ".mfw", "target"]);

async function walk(
	root: string,
	dir = "",
	out: string[] = [],
): Promise<string[]> {
	if (out.length > MAX_ENTRIES * 4) return out;
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(join(root, dir), { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const rel = dir ? `${dir}/${e.name}` : e.name;
		if (e.isDirectory()) {
			if (!WALK_SKIP.has(e.name)) await walk(root, rel, out);
		} else if (e.isFile()) {
			out.push(rel);
		}
	}
	return out;
}

/** Tracked and untracked-but-not-ignored files under `dir`, relative to it. Falls back to a walk outside a work tree. */
async function listFilesUnder(dir: string): Promise<string[]> {
	const r = await runProc(
		["git", "ls-files", "-co", "--exclude-standard", "-z"],
		{
			cwd: dir,
			timeoutMs: 15_000,
			maxOutputBytes: 16 * 1024 * 1024,
		},
	);
	if (r.exitCode === 0) {
		return [...new Set(r.stdout.split("\0").filter((p) => p.length > 0))];
	}
	return walk(dir);
}

interface FileStat {
	/** Source-relative. */
	rel: string;
	size: number;
	mtimeMs: number;
}

interface CachedText {
	mtimeMs: number;
	size: number;
	title: string;
	text: string;
	properties: Record<string, unknown>;
}

interface Resolved {
	source: DocSourceConfig;
	/** Physical base (repo root or board folder). */
	base: string;
	/** Physical source directory, or null when it does not exist. */
	dir: string | null;
}

export interface DocsDeps {
	repoRoot: string;
	boardDir: string;
	/** The daemon's directory (the board store's locks and counters). */
	stateDir: string;
	taskKey: string;
	log: Logger;
	/** The configured directory sources (the project's `docs:` setting). */
	configured: () => Promise<DocSourceConfig[]>;
	/** Persist a new list of directory sources (validated by the caller of `adopt`). */
	save: (next: DocSourceConfig[]) => Promise<void>;
	now?: () => number;
}

/** Candidates for auto-discovery, in the order they are suggested. */
const DISCOVERY_DIRS: readonly [name: string, label: string, kind: string][] = [
	["docs", "Docs", "reference"],
	["doc", "Doc", "reference"],
	["documentation", "Documentation", "reference"],
	["architecture", "Architecture", "reference"],
	["adr", "ADRs (files)", "adr"],
	["adrs", "ADRs (files)", "adr"],
	["rfcs", "RFCs", "spec"],
	["rfc", "RFCs", "spec"],
	["design", "Design", "spec"],
	["specs", "Specs (files)", "spec"],
	["notes", "Notes", "notes"],
	["journal", "Journal", "journal"],
	["wiki", "Wiki", "reference"],
];

const ROOT_DOCS = [
	"README.md",
	"ARCHITECTURE.md",
	"AGENTS.md",
	"CLAUDE.md",
	"CONTRIBUTING.md",
	"DESIGN.md",
	"CHANGELOG.md",
	"SECURITY.md",
];

export class DocsService {
	private storePromise: Promise<{
		store: BoardStore;
		config: BoardConfig;
	}> | null = null;
	private readonly texts = new Map<string, CachedText>();
	private textBytes = 0;
	private readonly listings = new Map<
		string,
		{ at: number; files: FileStat[]; truncated: boolean }
	>();
	private boardSnapshot: { at: number; docs: BoardDocument[] } | null = null;

	constructor(private readonly deps: DocsDeps) {}

	private now() {
		return this.deps.now?.() ?? Date.now();
	}

	/** Drop every cache; the next read lists the disk again. */
	invalidate(): void {
		this.listings.clear();
		this.boardSnapshot = null;
	}

	// ---- board ----------------------------------------------------------

	private board() {
		if (!this.storePromise) {
			this.storePromise = ensureBoardConfig(
				this.deps.boardDir,
				this.deps.taskKey,
			)
				.then(() => loadBoardConfig(join(this.deps.boardDir, "board.yaml")))
				.then((config) => ({
					config,
					store: new BoardStore(this.deps.boardDir, config, {
						stateDir: join(this.deps.stateDir, ".board"),
					}),
				}));
			this.storePromise.catch(() => {
				this.storePromise = null;
			});
		}
		return this.storePromise;
	}

	/** Non-task document types the board declares. */
	async boardTypes(): Promise<string[]> {
		try {
			const { config } = await this.board();
			return Object.keys(config.types).filter((t) => t !== WORK_TYPE);
		} catch (error) {
			this.deps.log.warn(
				{ err: String(error) },
				"docs: board config unreadable",
			);
			return [];
		}
	}

	private async boardDocs(): Promise<BoardDocument[]> {
		const snap = this.boardSnapshot;
		if (snap && this.now() - snap.at < LISTING_TTL_MS) return snap.docs;
		const { store, config } = await this.board();
		const docs: BoardDocument[] = [];
		for (const type of Object.keys(config.types)) {
			if (type === WORK_TYPE) continue;
			docs.push(...(await store.listDocuments(type)));
		}
		this.boardSnapshot = { at: this.now(), docs };
		return docs;
	}

	private async boardEntries(type: string): Promise<DocEntry[]> {
		const { config } = await this.board();
		const spec = config.types[type];
		const out: DocEntry[] = [];
		for (const doc of (await this.boardDocs()).filter((d) => d.type === type)) {
			let mtime = 0;
			let size = 0;
			try {
				const st = await lstat(doc.path);
				mtime = st.mtimeMs;
				size = st.size;
			} catch {
				// vanished between list and stat
			}
			const links: NonNullable<DocEntry["links"]> = [];
			for (const [field, fs] of Object.entries(spec?.fields ?? {})) {
				if (fs.kind !== "ref") continue;
				const v = doc.fields[field];
				const ids = (Array.isArray(v) ? v : v ? [v] : [])
					.map(String)
					.filter(Boolean);
				if (ids.length === 0) continue;
				links.push({
					field,
					ids,
					...(config.hierarchy?.parent === field
						? { role: "parent" as const }
						: config.hierarchy?.children === field
							? { role: "children" as const }
							: {}),
				});
			}
			const status = doc.fields.status;
			const date = doc.fields.date ?? doc.fields.created;
			out.push({
				sourceId: type,
				key: doc.id,
				title: docTitle(doc.path, doc.fields, doc.body) || doc.id,
				fileType: "markdown",
				size,
				modifiedAt: mtime,
				path: this.displayPath(doc.path, this.deps.boardDir, "board"),
				type,
				...(typeof status === "string" ? { status } : {}),
				...(date !== undefined && date !== null ? { date: String(date) } : {}),
				...(links.length ? { links } : {}),
			});
		}
		return out.sort(compareIds);
	}

	private displayPath(
		abs: string,
		base: string,
		which: "repo" | "board",
	): string {
		const rel = abs.startsWith(base + sep) ? abs.slice(base.length + 1) : abs;
		const posix = rel.split(sep).join("/");
		return which === "board" && this.deps.boardDir !== this.deps.repoRoot
			? `board:${posix}`
			: posix;
	}

	// ---- directory sources -----------------------------------------------

	private async resolve(source: DocSourceConfig): Promise<Resolved> {
		const baseRaw =
			source.base === "board" ? this.deps.boardDir : this.deps.repoRoot;
		const base = (await realOrNull(baseRaw)) ?? baseRaw;
		const path = normalizeDocPath(source.path);
		const abs = resolve(base, path);
		const real = await realOrNull(abs);
		if (real && !within(base, real)) throw new PathEscapeError(source.path);
		let dir: string | null = null;
		if (real) {
			const st = await lstat(real).catch(() => null);
			dir = st?.isDirectory() ? real : null;
		}
		return { source, base, dir };
	}

	private async listSource(
		r: Resolved,
	): Promise<{ files: FileStat[]; truncated: boolean }> {
		if (!r.dir) return { files: [], truncated: false };
		const cacheKey = `${r.source.id}\0${JSON.stringify(r.source)}`;
		const hit = this.listings.get(cacheKey);
		if (hit && this.now() - hit.at < LISTING_TTL_MS) return hit;
		const listed = (await listFilesUnder(r.dir))
			.filter((rel) => fileTypeOf(rel) !== null && docIncluded(r.source, rel))
			.sort();
		const files: FileStat[] = [];
		let truncated = false;
		for (const rel of listed) {
			if (files.length >= MAX_ENTRIES) {
				truncated = true;
				break;
			}
			const st = await lstat(join(r.dir, rel)).catch(() => null);
			// A symlink is never followed: it could point out of the tree.
			if (!st?.isFile()) continue;
			files.push({ rel, size: st.size, mtimeMs: st.mtimeMs });
		}
		const value = { at: this.now(), files, truncated };
		this.listings.set(cacheKey, value);
		return value;
	}

	private async cachedText(
		abs: string,
		st: { size: number; mtimeMs: number },
		rel: string,
	): Promise<CachedText> {
		const hit = this.texts.get(abs);
		if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
		const want = Math.min(st.size, MAX_INDEX_BYTES);
		const buf = new Uint8Array(want);
		const fh = await open(abs, "r");
		try {
			if (want > 0) await fh.read(buf, 0, want, 0);
		} finally {
			await fh.close();
		}
		const text = buf.subarray(0, SNIFF).includes(0)
			? ""
			: new TextDecoder().decode(buf);
		const { properties, body } = parseFrontMatter(text);
		const value: CachedText = {
			mtimeMs: st.mtimeMs,
			size: st.size,
			title: docTitle(rel, properties, body),
			text,
			properties,
		};
		if (this.textBytes + text.length > CACHE_BYTES) {
			this.texts.clear();
			this.textBytes = 0;
		}
		const old = this.texts.get(abs);
		if (old) this.textBytes -= old.text.length;
		this.texts.set(abs, value);
		this.textBytes += text.length;
		return value;
	}

	private async dirEntries(
		r: Resolved,
	): Promise<{ entries: DocEntry[]; truncated: boolean }> {
		const { files, truncated } = await this.listSource(r);
		const entries: DocEntry[] = [];
		for (const f of files) {
			const fileType = fileTypeOf(f.rel) as DocFileType;
			const abs = join(r.dir as string, f.rel);
			let title = basename(f.rel).replace(/\.[^.]+$/, "");
			if (fileType === "markdown" || fileType === "text") {
				try {
					title = (await this.cachedText(abs, f, f.rel)).title;
				} catch {
					// unreadable: keep the file name
				}
			}
			const sub = normalizeDocPath(r.source.path);
			entries.push({
				sourceId: r.source.id,
				key: f.rel,
				title,
				fileType,
				size: f.size,
				modifiedAt: f.mtimeMs,
				path: this.displayPath(
					join(r.base, sub, f.rel),
					r.base,
					r.source.base === "board" ? "board" : "repo",
				),
			});
		}
		return { entries, truncated };
	}

	// ---- public ------------------------------------------------------------

	private async configuredDirs(): Promise<DocSourceConfig[]> {
		const types = new Set(await this.boardTypes());
		// A directory source may not shadow a board type's id: the type wins.
		return (await this.deps.configured()).filter((s) => !types.has(s.id));
	}

	async sources(): Promise<DocSourceView[]> {
		const out: DocSourceView[] = [];
		let config: BoardConfig | null = null;
		try {
			config = (await this.board()).config;
		} catch {
			config = null;
		}
		if (config) {
			const docs = await this.boardDocs();
			for (const [type, spec] of Object.entries(config.types)) {
				if (type === WORK_TYPE) continue;
				const status = spec.fields.status;
				out.push({
					id: type,
					kind: "board",
					label: boardTypeLabel(type),
					group: type,
					count: docs.filter((d) => d.type === type).length,
					...(status?.kind === "enum" ? { statuses: [...status.values] } : {}),
				});
			}
		}
		for (const source of await this.configuredDirs()) {
			const view: DocSourceView = {
				id: source.id,
				kind: "dir",
				label: source.label,
				group: source.kind ?? "dir",
				count: 0,
				path: normalizeDocPath(source.path) || ".",
				base: source.base ?? "repo",
				...(source.include ? { include: source.include } : {}),
				...(source.exclude ? { exclude: source.exclude } : {}),
			};
			try {
				const r = await this.resolve(source);
				if (!r.dir) view.missing = true;
				else {
					const l = await this.listSource(r);
					view.count = l.files.length;
					if (l.truncated) view.truncated = true;
				}
			} catch (error) {
				this.deps.log.warn(
					{ source: source.id, err: String(error) },
					"docs: source unreadable",
				);
				view.missing = true;
			}
			out.push(view);
		}
		return out;
	}

	async entries(
		sourceId: string,
	): Promise<{ entries: DocEntry[]; truncated: boolean }> {
		if ((await this.boardTypes()).includes(sourceId)) {
			return { entries: await this.boardEntries(sourceId), truncated: false };
		}
		const source = (await this.configuredDirs()).find((s) => s.id === sourceId);
		if (!source) throw new NotFoundError(`no doc source '${sourceId}'`);
		const r = await this.resolve(source);
		return this.dirEntries(r);
	}

	/** One document with its text. Directory documents must sit inside the source, whatever the include globs say. */
	async read(sourceId: string, key: string): Promise<DocContent> {
		if ((await this.boardTypes()).includes(sourceId)) {
			const entry = (await this.boardEntries(sourceId)).find(
				(e) => e.key === key,
			);
			const doc = (await this.boardDocs()).find(
				(d) => d.type === sourceId && d.id === key,
			);
			if (!entry || !doc)
				throw new NotFoundError(`${key} is not in ${sourceId}`);
			const { title: _t, ...properties } = doc.fields;
			return {
				entry,
				body: doc.body,
				properties: { title: doc.fields.title, ...properties },
				truncated: false,
				binary: false,
			};
		}
		const { r, abs, rel, st } = await this.locate(sourceId, key);
		const fileType = fileTypeOf(rel);
		if (!fileType) throw new NotFoundError(`${rel} is not a document type`);
		const entry = (await this.dirEntries(r)).entries.find(
			(e) => e.key === rel,
		) ?? {
			sourceId,
			key: rel,
			title: basename(rel),
			fileType,
			size: st.size,
			modifiedAt: st.mtimeMs,
			path: rel,
		};
		if (fileType === "image") {
			return {
				entry,
				body: "",
				properties: {},
				truncated: false,
				binary: true,
			};
		}
		const want = Math.min(st.size, MAX_TEXT_BYTES);
		const buf = new Uint8Array(want);
		const fh = await open(abs, "r");
		try {
			if (want > 0) await fh.read(buf, 0, want, 0);
		} finally {
			await fh.close();
		}
		if (buf.subarray(0, SNIFF).includes(0)) {
			return {
				entry,
				body: "",
				properties: {},
				truncated: false,
				binary: true,
			};
		}
		const text = new TextDecoder().decode(buf);
		const { properties, body } =
			fileType === "markdown"
				? parseFrontMatter(text)
				: { properties: {}, body: text };
		return {
			entry,
			body,
			properties,
			truncated: st.size > want,
			binary: false,
		};
	}

	/** Raw bytes of an image or SVG inside a source (for `<img>`). Text documents are not served this way. */
	async readImage(
		sourceId: string,
		key: string,
	): Promise<{ data: Buffer; mime: string }> {
		const { abs, rel, st } = await this.locate(sourceId, key);
		const mime = imageMime(rel);
		if (!mime) throw new NotFoundError(`${rel} is not an image`);
		if (st.size > MAX_IMAGE_BYTES)
			throw new NotFoundError(`${rel} is too large to serve`);
		const fh = await open(abs, "r");
		try {
			const data = Buffer.alloc(st.size);
			if (st.size > 0) await fh.read(data, 0, st.size, 0);
			return { data, mime };
		} finally {
			await fh.close();
		}
	}

	private async locate(sourceId: string, key: string) {
		const source = (await this.configuredDirs()).find((s) => s.id === sourceId);
		if (!source) throw new NotFoundError(`no doc source '${sourceId}'`);
		const r = await this.resolve(source);
		if (!r.dir) throw new NotFoundError(`${source.path} does not exist`);
		const rel = normalizeDocPathInside(key);
		const abs = resolve(r.dir, rel);
		const real = await realOrNull(abs);
		if (!real) throw new NotFoundError(`no such document: ${key}`);
		if (!within(r.dir, real)) throw new PathEscapeError(key);
		const st = await lstat(real);
		if (!st.isFile()) throw new NotFoundError(`${key} is not a file`);
		return { r, abs: real, rel, st };
	}

	async search(
		q: string,
		opts: { limit?: number; sourceId?: string } = {},
	): Promise<DocSearchHit[]> {
		const terms = q
			.toLowerCase()
			.split(/\s+/)
			.filter((t) => t.length > 0)
			.slice(0, 8);
		if (terms.length === 0) return [];
		const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
		const hits: DocSearchHit[] = [];
		const consider = (c: { entry: DocEntry; body: string }) => {
			const title = c.entry.title.toLowerCase();
			const path = `${c.entry.path} ${c.entry.key}`.toLowerCase();
			const body = c.body.toLowerCase();
			let score = 0;
			for (const t of terms) {
				const inTitle = title.includes(t);
				const inPath = path.includes(t);
				const count = body.split(t).length - 1;
				if (!inTitle && !inPath && count === 0) return;
				score += (inTitle ? 10 : 0) + (inPath ? 3 : 0) + Math.min(count, 5);
			}
			const at = body.indexOf(terms[0] as string);
			let snippet: string;
			let match: [number, number] | null = null;
			if (at >= 0) {
				const from = Math.max(0, at - 60);
				const raw = c.body.slice(from, at + 120).replace(/\s+/g, " ");
				const lead = from > 0 ? "…" : "";
				snippet = `${lead}${raw}`;
				const idx = snippet.toLowerCase().indexOf(terms[0] as string);
				if (idx >= 0) match = [idx, idx + (terms[0] as string).length];
			} else {
				snippet = c.body.trim().replace(/\s+/g, " ").slice(0, 140);
			}
			hits.push({
				sourceId: c.entry.sourceId,
				key: c.entry.key,
				title: c.entry.title,
				path: c.entry.path,
				fileType: c.entry.fileType,
				...(c.entry.type ? { type: c.entry.type } : {}),
				...(c.entry.status ? { status: c.entry.status } : {}),
				score,
				snippet,
				match,
			});
		};
		const only = opts.sourceId;
		for (const type of await this.boardTypes()) {
			if (only && only !== type) continue;
			const entries = await this.boardEntries(type);
			const docs = new Map(
				(await this.boardDocs())
					.filter((d) => d.type === type)
					.map((d) => [d.id, d]),
			);
			for (const entry of entries) {
				const doc = docs.get(entry.key);
				consider({ entry, body: `${entry.key} ${doc?.body ?? ""}` });
			}
		}
		for (const source of await this.configuredDirs()) {
			if (only && only !== source.id) continue;
			let r: Resolved;
			try {
				r = await this.resolve(source);
			} catch {
				continue;
			}
			const { entries } = await this.dirEntries(r);
			for (const entry of entries) {
				let body = "";
				if (entry.fileType !== "image" && entry.fileType !== "svg" && r.dir) {
					try {
						const abs = join(r.dir, entry.key);
						body = (
							await this.cachedText(
								abs,
								{ size: entry.size, mtimeMs: entry.modifiedAt },
								entry.key,
							)
						).text;
						body = parseFrontMatter(body).body;
					} catch {
						body = "";
					}
				}
				consider({ entry, body });
			}
		}
		return hits
			.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
			.slice(0, limit);
	}

	/** The most recently changed documents across every source. */
	async recent(limit = 12): Promise<DocEntry[]> {
		const all: DocEntry[] = [];
		for (const s of await this.sources()) {
			if (s.missing) continue;
			try {
				all.push(...(await this.entries(s.id)).entries);
			} catch {
				// a source that vanished mid-call is simply absent
			}
		}
		return all
			.filter((e) => e.modifiedAt > 0)
			.sort((a, b) => b.modifiedAt - a.modifiedAt)
			.slice(0, Math.min(Math.max(limit, 1), 50));
	}

	/** Conventional documentation locations that exist and are not configured yet. */
	async suggestions(): Promise<DocSuggestion[]> {
		const configured = await this.deps.configured();
		const taken = new Set(
			configured.map((s) => `${s.base ?? "repo"}:${normalizeDocPath(s.path)}`),
		);
		const ids = new Set(configured.map((s) => s.id));
		for (const t of await this.boardTypes()) ids.add(t);
		// Directories the board's own types occupy are already board-fed.
		const boardDirs = new Set<string>();
		try {
			for (const spec of Object.values((await this.board()).config.types)) {
				boardDirs.add(normalizeDocPath(spec.dir));
			}
		} catch {
			// no readable board: nothing to exclude
		}
		const out: DocSuggestion[] = [];
		const bases: ("repo" | "board")[] =
			this.deps.boardDir === this.deps.repoRoot ? ["repo"] : ["repo", "board"];
		const uniqueId = (want: string) => {
			let id = want;
			for (let i = 2; ids.has(id) || RESERVED_IDS.has(id); i++)
				id = `${want}-${i}`;
			ids.add(id);
			return id;
		};
		for (const base of bases) {
			const baseDir = base === "repo" ? this.deps.repoRoot : this.deps.boardDir;
			const realBase = await realOrNull(baseDir);
			if (!realBase) continue;
			let names: string[] = [];
			try {
				names = await readdir(realBase);
			} catch {
				continue;
			}
			const present = new Set(names);
			for (const [name, label, kind] of DISCOVERY_DIRS) {
				if (!present.has(name)) continue;
				if (taken.has(`${base}:${name}`)) continue;
				if (
					base === "repo" &&
					this.deps.boardDir === this.deps.repoRoot &&
					boardDirs.has(name)
				)
					continue;
				if (base === "board" && boardDirs.has(name)) continue;
				const abs = join(realBase, name);
				const st = await lstat(abs).catch(() => null);
				if (!st?.isDirectory()) continue;
				const real = await realOrNull(abs);
				if (!real || !within(realBase, real)) continue;
				const files = (await listFilesUnder(real)).filter(
					(rel) => fileTypeOf(rel) !== null && docIncluded({}, rel),
				);
				if (files.length === 0) continue;
				out.push({
					id: uniqueId(base === "board" ? `board-${slug(name)}` : slug(name)),
					label: base === "board" ? `${label} (board)` : label,
					path: name,
					base,
					kind,
					fileCount: files.length,
					reason: `${name}/ holds ${files.length} document${files.length === 1 ? "" : "s"}`,
				});
			}
			if (base === "repo") {
				const roots = ROOT_DOCS.filter((f) => present.has(f));
				if (roots.length > 0 && !taken.has("repo:")) {
					out.push({
						id: uniqueId("root"),
						label: "Root documents",
						path: ".",
						base: "repo",
						include: roots,
						kind: "reference",
						fileCount: roots.length,
						reason: roots.join(", "),
					});
				}
			}
		}
		return out;
	}

	/**
	 * Add suggested directories as sources. Each id must be a current suggestion
	 * (so a caller cannot invent a path); already-configured ones are skipped.
	 */
	async adopt(suggestionIds: string[]): Promise<DocSourceView[]> {
		if (suggestionIds.length === 0) return [];
		const found = (await this.suggestions()).filter((s) =>
			suggestionIds.includes(s.id),
		);
		if (found.length === 0) return [];
		const current = await this.deps.configured();
		const next: DocSourceConfig[] = [...current];
		for (const s of found) {
			next.push({
				id: s.id,
				label: s.label,
				path: s.path,
				...(s.base === "board" ? { base: "board" as const } : {}),
				...(s.include ? { include: s.include } : {}),
				...(s.kind ? { kind: s.kind } : {}),
			});
		}
		await this.deps.save(next);
		this.invalidate();
		const added = new Set(found.map((s) => s.id));
		return (await this.sources()).filter((s) => added.has(s.id));
	}

	/** One paragraph for the import prompt: where the repository keeps its own documentation. */
	async promptHint(): Promise<string | null> {
		try {
			const dirs = [
				...(await this.deps.configured()).map((s) => `${s.path}/ (${s.label})`),
				...(await this.suggestions()).map(
					(s) => `${s.path === "." ? s.reason : `${s.path}/`}`,
				),
			];
			if (dirs.length === 0) return null;
			return [
				`The repository keeps documentation in: ${dirs.join(", ")}.`,
				"Read it for intent and history. Do not propose tasks to write documents that already exist.",
			].join("\n");
		} catch {
			return null;
		}
	}
}

/** A key inside a source: refuses `..` and absolute paths (the realpath check follows). */
function normalizeDocPathInside(key: string): string {
	let rel: string;
	try {
		rel = normalizeDocPath(key);
	} catch {
		throw new PathEscapeError(key);
	}
	if (!rel) throw new NotFoundError("no document named");
	return rel;
}

function boardTypeLabel(type: string): string {
	if (type === "adr") return "Decisions (ADRs)";
	const words = type.replace(/_/g, " ");
	const title = words.charAt(0).toUpperCase() + words.slice(1);
	return title.endsWith("s") ? title : `${title}s`;
}

const idNum = (id: string) => {
	const m = /(\d+)$/.exec(id);
	return m ? Number(m[1]) : Number.NaN;
};

function compareIds(a: DocEntry, b: DocEntry): number {
	const x = idNum(a.key);
	const y = idNum(b.key);
	if (!Number.isNaN(x) && !Number.isNaN(y) && x !== y) return x - y;
	return a.key.localeCompare(b.key);
}

/**
 * Vet a replacement list of directory sources against the repository and
 * board folder. Returns it normalized (paths cleaned, globs checked); throws
 * `DocSourceError` naming the first problem. A path that does not exist yet
 * is allowed when its nearest existing ancestor stays inside the base.
 */
export async function validateDocSources(
	sources: DocSourceConfig[],
	ctx: { repoRoot: string; boardDir: string; reservedIds?: readonly string[] },
): Promise<DocSourceConfig[]> {
	if (sources.length > MAX_SOURCES) {
		throw new DocSourceError(`at most ${MAX_SOURCES} doc sources`);
	}
	const reserved = new Set([...RESERVED_IDS, ...(ctx.reservedIds ?? [])]);
	const seen = new Set<string>();
	const out: DocSourceConfig[] = [];
	for (const s of sources) {
		if (seen.has(s.id))
			throw new DocSourceError(`duplicate doc source id '${s.id}'`);
		if (reserved.has(s.id)) {
			throw new DocSourceError(
				`'${s.id}' is reserved (a board document type or a route name)`,
			);
		}
		seen.add(s.id);
		const path = normalizeDocPath(s.path);
		const baseRaw = s.base === "board" ? ctx.boardDir : ctx.repoRoot;
		const base = (await realOrNull(baseRaw)) ?? baseRaw;
		const anc = await realAncestor(resolve(base, path));
		if (!anc || !within(base, anc)) {
			throw new DocSourceError(
				`'${s.path}' resolves outside the ${s.base === "board" ? "board folder" : "repository"}`,
			);
		}
		for (const g of [...(s.include ?? []), ...(s.exclude ?? [])]) {
			const problem = validateOwnsPattern(g);
			if (problem) throw new DocSourceError(`glob '${g}': ${problem}`);
		}
		out.push({
			id: s.id,
			label: s.label.trim() || s.id,
			path: path || ".",
			...(s.base === "board" ? { base: "board" as const } : {}),
			...(s.include?.length ? { include: s.include } : {}),
			...(s.exclude?.length ? { exclude: s.exclude } : {}),
			...(s.kind ? { kind: s.kind } : {}),
		});
	}
	return out;
}
