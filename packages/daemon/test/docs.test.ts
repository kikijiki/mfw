import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocSourceConfig } from "../src/config.ts";
import { defaultBoardYaml } from "../src/default-board-config.ts";
import {
	DocSourceError,
	DocsService,
	docIncluded,
	docTitle,
	fileTypeOf,
	normalizeDocPath,
	parseFrontMatter,
	validateDocSources,
} from "../src/docs.ts";
import { silentLogger } from "../src/log.ts";
import { PathEscapeError } from "../src/workspace.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const SPEC_AND_JOURNAL = `
  spec:
    layout: flat
    dir: specs
    id: { strategy: own-sequence, key: DOC, suffix: SPEC }
    slugFrom: title
    fields:
      title: {}
      status:
        values: [draft, final]
        default: draft
      related: { ref: any, list: true, optional: true }
  journal:
    layout: flat
    dir: journal
    id: { strategy: own-sequence, key: DOC, suffix: LOG }
    slugFrom: title
    fields:
      title: {}
`;

async function write(path: string, text: string) {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, text);
}

/** A repository with a board (adr + spec + journal), a docs/ tree and some noise. */
async function setup(opts: { configured?: DocSourceConfig[] } = {}) {
	const root = await mkdtemp(join(tmpdir(), "mfw-docs-"));
	const outside = await mkdtemp(join(tmpdir(), "mfw-docs-out-"));
	dirs.push(root, outside);
	await write(
		join(root, "board.yaml"),
		defaultBoardYaml("DOC") + SPEC_AND_JOURNAL,
	);
	await write(
		join(root, "adrs", "DOC-ADR-1-use-sqlite.md"),
		"---\nmfw: 1\nid: DOC-ADR-1\ntitle: Use SQLite\nstatus: accepted\ndate: '2026-01-02'\n---\nWe chose sqlite for the index because zebra.\n",
	);
	await write(
		join(root, "adrs", "DOC-ADR-2-use-wal.md"),
		"---\nmfw: 1\nid: DOC-ADR-2\ntitle: Use WAL\nstatus: proposed\nsupersedes: DOC-ADR-1\n---\nWAL mode.\n",
	);
	await write(
		join(root, "specs", "DOC-SPEC-1-sync.md"),
		"---\nmfw: 1\nid: DOC-SPEC-1\ntitle: Sync protocol\nstatus: draft\nrelated: [DOC-ADR-1]\n---\n# Sync\nDetails.\n",
	);
	await write(
		join(root, "docs", "intro.md"),
		"---\ntitle: Introduction\ntags: [a]\n---\n# Heading\nWelcome to the project.\n",
	);
	await write(
		join(root, "docs", "guide", "setup.md"),
		"# Setup guide\nInstall the zebra tool.\n",
	);
	await write(join(root, "docs", "guide", "flow.mmd"), "graph TD; A-->B;\n");
	await write(
		join(root, "docs", "guide", "arch.puml"),
		"@startuml\nA -> B\n@enduml\n",
	);
	await write(join(root, "docs", "img", "logo.png"), "\x89PNG fake");
	await write(
		join(root, "docs", "img", "logo.svg"),
		"<svg xmlns='http://www.w3.org/2000/svg'/>",
	);
	await write(join(root, "docs", "notes.bin"), "x");
	await write(
		join(root, "docs", "node_modules", "pkg", "README.md"),
		"# vendored\n",
	);
	await write(join(root, "README.md"), "# Project\nHello.\n");
	await write(join(root, "ARCHITECTURE.md"), "# Architecture\n");
	await write(
		join(outside, "secret.md"),
		"# secret\nthe password is hunter2\n",
	);
	let configured: DocSourceConfig[] = opts.configured ?? [
		{ id: "docs", label: "Docs", path: "docs" },
	];
	let saves = 0;
	const svc = new DocsService({
		repoRoot: root,
		boardDir: root,
		stateDir: join(root, ".mfw"),
		taskKey: "DOC",
		log: silentLogger(),
		configured: async () => configured,
		save: async (next) => {
			saves++;
			configured = next;
		},
	});
	return {
		root,
		outside,
		svc,
		configured: () => configured,
		setConfigured: (c: DocSourceConfig[]) => {
			configured = c;
			svc.invalidate();
		},
		saves: () => saves,
	};
}

describe("pure helpers", () => {
	test("front matter is split from the body; a non-mapping or broken header is left whole", () => {
		expect(parseFrontMatter("---\ntitle: A\nn: 2\n---\nbody\n")).toEqual({
			properties: { title: "A", n: 2 },
			body: "body\n",
		});
		const plain = "no front matter\n";
		expect(parseFrontMatter(plain)).toEqual({ properties: {}, body: plain });
		const bad = "---\n- a\n- b\n---\nx\n";
		expect(parseFrontMatter(bad).body).toBe(bad);
		const broken = "---\n: : :\n  [\n---\nx\n";
		expect(parseFrontMatter(broken).properties).toEqual({});
	});

	test("title: front matter, then first heading outside a code fence, then the file name", () => {
		expect(docTitle("a.md", { title: "FM" }, "# H")).toBe("FM");
		expect(docTitle("a.md", {}, "intro\n# Real\n")).toBe("Real");
		expect(docTitle("a.md", {}, "```\n# not a heading\n```\n## Second\n")).toBe(
			"Second",
		);
		expect(docTitle("dir/setup-notes.md", {}, "no headings")).toBe(
			"setup-notes",
		);
	});

	test("paths: normalized, never absolute and never leaving the base", () => {
		expect(normalizeDocPath("./docs//a\\b/")).toBe("docs/a/b");
		expect(normalizeDocPath(".")).toBe("");
		expect(() => normalizeDocPath("../x")).toThrow(DocSourceError);
		expect(() => normalizeDocPath("a/../../x")).toThrow(DocSourceError);
		expect(() => normalizeDocPath("/etc")).toThrow(DocSourceError);
		expect(() => normalizeDocPath("C:/x")).toThrow(DocSourceError);
		expect(() => normalizeDocPath("a\0b")).toThrow(DocSourceError);
	});

	test("include/exclude globs, with the vendored directories always out", () => {
		expect(docIncluded({}, "a/b.md")).toBe(true);
		expect(docIncluded({}, "a/b.rs")).toBe(false);
		expect(docIncluded({}, "node_modules/x/README.md")).toBe(false);
		expect(docIncluded({ include: ["*.md"] }, "a/b.md")).toBe(false);
		expect(docIncluded({ include: ["*.md"] }, "b.md")).toBe(true);
		expect(docIncluded({ exclude: ["drafts/**"] }, "drafts/x.md")).toBe(false);
	});

	test("file types", () => {
		expect(fileTypeOf("a.MD")).toBe("markdown");
		expect(fileTypeOf("a.mmd")).toBe("mermaid");
		expect(fileTypeOf("a.puml")).toBe("plantuml");
		expect(fileTypeOf("a.svg")).toBe("svg");
		expect(fileTypeOf("a.png")).toBe("image");
		expect(fileTypeOf("a.exe")).toBeNull();
	});
});

describe("sources and entries", () => {
	test("board types other than task become sources; directories follow with counts", async () => {
		const { svc } = await setup();
		const sources = await svc.sources();
		expect(sources.map((s) => [s.id, s.kind, s.count])).toEqual([
			["adr", "board", 2],
			["spec", "board", 1],
			["journal", "board", 0],
			["docs", "dir", 6],
		]);
		expect(sources[0]).toMatchObject({
			label: "Decisions (ADRs)",
			statuses: ["proposed", "accepted", "superseded", "rejected"],
		});
		expect(sources.find((s) => s.id === "task")).toBeUndefined();
	});

	test("board documents carry title, status, date and ref links", async () => {
		const { svc } = await setup();
		const { entries } = await svc.entries("adr");
		expect(entries.map((e) => e.key)).toEqual(["DOC-ADR-1", "DOC-ADR-2"]);
		expect(entries[0]).toMatchObject({
			title: "Use SQLite",
			status: "accepted",
			date: "2026-01-02",
			type: "adr",
			fileType: "markdown",
		});
		expect(entries[1]?.links).toEqual([
			{ field: "supersedes", ids: ["DOC-ADR-1"] },
		]);
		const spec = (await svc.entries("spec")).entries[0];
		expect(spec?.links).toEqual([{ field: "related", ids: ["DOC-ADR-1"] }]);
	});

	test("directory entries honour the include globs and skip node_modules and unknown types", async () => {
		const { svc } = await setup();
		const { entries } = await svc.entries("docs");
		expect(entries.map((e) => e.key)).toEqual([
			"guide/arch.puml",
			"guide/flow.mmd",
			"guide/setup.md",
			"img/logo.png",
			"img/logo.svg",
			"intro.md",
		]);
		expect(entries.find((e) => e.key === "intro.md")?.title).toBe(
			"Introduction",
		);
		expect(entries.find((e) => e.key === "guide/setup.md")?.title).toBe(
			"Setup guide",
		);
		expect(entries.find((e) => e.key === "guide/arch.puml")?.fileType).toBe(
			"plantuml",
		);
		expect(entries.some((e) => e.key.includes("node_modules"))).toBe(false);
		expect(entries.some((e) => e.key.endsWith(".bin"))).toBe(false);

		const narrow = await setup({
			configured: [
				{
					id: "docs",
					label: "Docs",
					path: "docs",
					include: ["**/*.md"],
					exclude: ["guide/**"],
				},
			],
		});
		expect(
			(await narrow.svc.entries("docs")).entries.map((e) => e.key),
		).toEqual(["intro.md"]);
	});

	test("a missing directory is reported, not an error", async () => {
		const { svc } = await setup({
			configured: [{ id: "gone", label: "Gone", path: "nope" }],
		});
		const gone = (await svc.sources()).find((s) => s.id === "gone");
		expect(gone).toMatchObject({ missing: true, count: 0 });
		expect((await svc.entries("gone")).entries).toEqual([]);
	});

	test("a directory source cannot shadow a board type id", async () => {
		const { svc } = await setup({
			configured: [{ id: "adr", label: "Fake", path: "docs" }],
		});
		const adr = (await svc.sources()).filter((s) => s.id === "adr");
		expect(adr).toHaveLength(1);
		expect(adr[0]?.kind).toBe("board");
	});

	test("gitignored files are not listed", async () => {
		const { svc, root } = await setup();
		const proc = Bun.spawnSync(["git", "init", "-q"], { cwd: root });
		expect(proc.exitCode).toBe(0);
		await write(join(root, ".gitignore"), "docs/guide/setup.md\n");
		svc.invalidate();
		const keys = (await svc.entries("docs")).entries.map((e) => e.key);
		expect(keys).not.toContain("guide/setup.md");
		expect(keys).toContain("intro.md");
	});
});

describe("read and path safety", () => {
	test("a markdown file comes back with front matter split out", async () => {
		const { svc } = await setup();
		const doc = await svc.read("docs", "intro.md");
		expect(doc.properties).toEqual({ title: "Introduction", tags: ["a"] });
		expect(doc.body).toStartWith("# Heading");
		expect(doc.entry.title).toBe("Introduction");
		expect(doc.binary).toBe(false);
	});

	test("a board document reads with its fields as properties", async () => {
		const { svc } = await setup();
		const doc = await svc.read("adr", "DOC-ADR-1");
		expect(doc.body).toContain("zebra");
		expect(doc.properties).toMatchObject({
			status: "accepted",
			title: "Use SQLite",
		});
		await expect(svc.read("adr", "DOC-ADR-99")).rejects.toThrow(/not in adr/);
	});

	test("'..', absolute keys and symlinks out of the tree are refused", async () => {
		const { svc, root, outside } = await setup();
		await expect(svc.read("docs", "../README.md")).rejects.toBeInstanceOf(
			PathEscapeError,
		);
		await expect(svc.read("docs", "/etc/passwd")).rejects.toBeInstanceOf(
			PathEscapeError,
		);
		await symlink(join(outside, "secret.md"), join(root, "docs", "leak.md"));
		await symlink(outside, join(root, "docs", "linked"));
		await expect(svc.read("docs", "leak.md")).rejects.toBeInstanceOf(
			PathEscapeError,
		);
		await expect(svc.read("docs", "linked/secret.md")).rejects.toBeInstanceOf(
			PathEscapeError,
		);
		await expect(
			svc.readImage("docs", "linked/secret.md"),
		).rejects.toBeDefined();
		svc.invalidate();
		const keys = (await svc.entries("docs")).entries.map((e) => e.key);
		expect(keys).not.toContain("leak.md");
		expect(keys.some((k) => k.startsWith("linked/"))).toBe(false);
	});

	test("a source whose own path is a symlink out is refused", async () => {
		const { svc, root, outside } = await setup({
			configured: [{ id: "evil", label: "Evil", path: "evil" }],
		});
		await symlink(outside, join(root, "evil"));
		await expect(svc.entries("evil")).rejects.toBeInstanceOf(PathEscapeError);
		expect((await svc.sources()).find((s) => s.id === "evil")?.missing).toBe(
			true,
		);
		expect(await svc.search("hunter2")).toEqual([]);
	});

	test("images are served with a mime; text documents are not served as bytes", async () => {
		const { svc } = await setup();
		const png = await svc.readImage("docs", "img/logo.png");
		expect(png.mime).toBe("image/png");
		expect(png.data.byteLength).toBeGreaterThan(0);
		expect((await svc.readImage("docs", "img/logo.svg")).mime).toBe(
			"image/svg+xml",
		);
		await expect(svc.readImage("docs", "intro.md")).rejects.toThrow(
			/not an image/,
		);
		// An image read as a document is a binary marker, not text.
		expect((await svc.read("docs", "img/logo.png")).binary).toBe(true);
		// Diagrams are text: the source comes back for the client to render.
		expect((await svc.read("docs", "guide/flow.mmd")).body).toContain("A-->B");
	});

	test("a file outside the include globs but inside the source can still be read (images linked from a page)", async () => {
		const { svc } = await setup({
			configured: [
				{ id: "docs", label: "Docs", path: "docs", include: ["**/*.md"] },
			],
		});
		expect((await svc.readImage("docs", "img/logo.png")).mime).toBe(
			"image/png",
		);
	});
});

describe("search", () => {
	test("title hits outrank body hits; terms are ANDed; snippets show the match", async () => {
		const { svc } = await setup();
		const hits = await svc.search("zebra");
		expect(hits.map((h) => h.key).sort()).toEqual([
			"DOC-ADR-1",
			"guide/setup.md",
		]);
		const first = hits[0];
		expect(first?.snippet.toLowerCase()).toContain("zebra");
		const m = first?.match;
		expect(first?.snippet.slice(m?.[0], m?.[1]).toLowerCase()).toBe("zebra");

		const byTitle = await svc.search("sqlite");
		expect(byTitle[0]).toMatchObject({
			key: "DOC-ADR-1",
			sourceId: "adr",
			type: "adr",
		});

		expect(await svc.search("zebra welcome")).toEqual([]);
		expect((await svc.search("setup zebra")).map((h) => h.key)).toEqual([
			"guide/setup.md",
		]);
		expect(await svc.search("   ")).toEqual([]);
	});

	test("a source filter narrows; matches are case-insensitive; the limit caps", async () => {
		const { svc } = await setup();
		expect(
			(await svc.search("ZEBRA", { sourceId: "docs" })).map((h) => h.key),
		).toEqual(["guide/setup.md"]);
		expect(await svc.search("project", { limit: 1 })).toHaveLength(1);
	});

	test("an edit is visible after the cache window (mtime-keyed text cache)", async () => {
		const { svc, root } = await setup();
		expect(await svc.search("quokka")).toEqual([]);
		await new Promise((r) => setTimeout(r, 5));
		await writeFile(join(root, "docs", "intro.md"), "# Intro\nquokka here\n");
		svc.invalidate();
		expect((await svc.search("quokka")).map((h) => h.key)).toEqual([
			"intro.md",
		]);
	});
});

describe("recent", () => {
	test("newest first across sources", async () => {
		const { svc, root } = await setup();
		await new Promise((r) => setTimeout(r, 20));
		await writeFile(
			join(root, "docs", "guide", "setup.md"),
			"# Setup guide\nchanged\n",
		);
		svc.invalidate();
		const recent = await svc.recent(3);
		expect(recent[0]?.key).toBe("guide/setup.md");
		expect(recent).toHaveLength(3);
	});
});

describe("suggestions", () => {
	test("conventional directories and root documents are suggested, never applied", async () => {
		const { svc, saves, root } = await setup({ configured: [] });
		await write(join(root, "architecture", "overview.md"), "# Overview\n");
		await mkdir(join(root, "notes"), { recursive: true }); // empty: not suggested
		const s = await svc.suggestions();
		const byId = Object.fromEntries(s.map((x) => [x.id, x]));
		expect(Object.keys(byId).sort()).toEqual(["architecture", "docs", "root"]);
		expect(byId.docs).toMatchObject({
			path: "docs",
			base: "repo",
			fileCount: 6,
		});
		expect(byId.root).toMatchObject({
			path: ".",
			include: ["README.md", "ARCHITECTURE.md"],
		});
		// The board's own directories are board-fed, not suggested.
		expect(s.some((x) => x.path === "adrs" || x.path === "specs")).toBe(false);
		expect(saves()).toBe(0);
		expect((await svc.sources()).some((x) => x.kind === "dir")).toBe(false);
	});

	test("adopt records the chosen suggestions and they stop being suggested", async () => {
		const { svc, configured, saves } = await setup({ configured: [] });
		const added = await svc.adopt(["docs", "root", "not-a-suggestion"]);
		expect(added.map((a) => a.id).sort()).toEqual(["docs", "root"]);
		expect(saves()).toBe(1);
		expect(configured().map((c) => c.id)).toEqual(["docs", "root"]);
		expect(configured().find((c) => c.id === "root")).toMatchObject({
			path: ".",
			include: ["README.md", "ARCHITECTURE.md"],
		});
		expect(await svc.suggestions()).toEqual([]);
		const root = await svc.entries("root");
		expect(root.entries.map((e) => e.key)).toEqual([
			"ARCHITECTURE.md",
			"README.md",
		]);
	});

	test("adopt cannot invent a path: only current suggestions are recorded", async () => {
		const { svc, saves } = await setup({ configured: [] });
		expect(await svc.adopt(["../../etc"])).toEqual([]);
		expect(saves()).toBe(0);
	});

	test("the import prompt hint names the documentation directories", async () => {
		const { svc } = await setup({ configured: [] });
		const hint = await svc.promptHint();
		expect(hint).toContain("docs/");
		expect(hint).toContain("README.md");
		expect(hint).toContain("Do not propose tasks");
	});
});

describe("validateDocSources", () => {
	const ctx = (root: string) => ({ repoRoot: root, boardDir: root });

	test("accepts nested and not-yet-existing paths; trims and normalizes", async () => {
		const { root } = await setup();
		const out = await validateDocSources(
			[
				{ id: "a", label: " A ", path: "./docs/guide/", include: ["**/*.md"] },
				{ id: "future", label: "Later", path: "docs/not/yet", kind: "notes" },
				{ id: "all", label: "All", path: ".", include: ["README.md"] },
			],
			ctx(root),
		);
		expect(out[0]).toEqual({
			id: "a",
			label: "A",
			path: "docs/guide",
			include: ["**/*.md"],
		});
		expect(out[1]).toMatchObject({ path: "docs/not/yet", kind: "notes" });
		expect(out[2]?.path).toBe(".");
	});

	test("refuses '..', absolute paths and a symlink out of the repository", async () => {
		const { root, outside } = await setup();
		await symlink(outside, join(root, "docs", "linked"));
		const bad = (path: string) =>
			validateDocSources([{ id: "x", label: "X", path }], ctx(root));
		await expect(bad("../elsewhere")).rejects.toThrow(DocSourceError);
		await expect(bad("/etc")).rejects.toThrow(/absolute/);
		await expect(bad("docs/linked")).rejects.toThrow(/outside the repository/);
		await expect(bad("docs/linked/sub/dir")).rejects.toThrow(
			/outside the repository/,
		);
	});

	test("board-relative sources are held to the board folder", async () => {
		const root = await mkdtemp(join(tmpdir(), "mfw-docs-repo-"));
		const board = await mkdtemp(join(tmpdir(), "mfw-docs-board-"));
		dirs.push(root, board);
		await mkdir(join(board, "notes"));
		const out = await validateDocSources(
			[{ id: "n", label: "Notes", path: "notes", base: "board" }],
			{ repoRoot: root, boardDir: board },
		);
		expect(out[0]?.base).toBe("board");
		await symlink(root, join(board, "back"));
		await expect(
			validateDocSources(
				[{ id: "b", label: "B", path: "back", base: "board" }],
				{
					repoRoot: root,
					boardDir: board,
				},
			),
		).rejects.toThrow(/outside the board folder/);
	});

	test("duplicate ids, reserved ids and bad globs are refused", async () => {
		const { root } = await setup();
		const one = { id: "a", label: "A", path: "docs" };
		await expect(validateDocSources([one, one], ctx(root))).rejects.toThrow(
			/duplicate/,
		);
		await expect(
			validateDocSources([{ ...one, id: "adr" }], {
				...ctx(root),
				reservedIds: ["adr"],
			}),
		).rejects.toThrow(/reserved/);
		await expect(
			validateDocSources([{ ...one, id: "search" }], ctx(root)),
		).rejects.toThrow(/reserved/);
		await expect(
			validateDocSources([{ ...one, include: ["../x/*.md"] }], ctx(root)),
		).rejects.toThrow(/glob/);
	});
});
