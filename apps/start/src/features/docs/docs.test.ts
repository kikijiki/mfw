import { describe, expect, test } from "bun:test";

import {
	type DirSourceRef,
	docAssetUrl,
	fromBoardPath,
	fromDirSource,
	joinBasePath,
	locateInSources,
	resolveDocLink,
	resolveImageSrc,
} from "./docLinks";
import {
	ancestorDirs,
	buildTree,
	editHint,
	filesTarget,
	flattenTree,
	groupSources,
	parseDocsSplat,
	propertyText,
	statusTone,
} from "./docsModel";
import {
	createSlugger,
	extractFences,
	isMermaidLang,
	mermaidFences,
	slugify,
} from "./markdownBlocks";
import {
	deriveSourceId,
	describeSource,
	sourceProblem,
	splitGlobs,
} from "./sourceDraft";

describe("parseDocsSplat", () => {
	test("source then key, with the key keeping its slashes", () => {
		expect(parseDocsSplat("adr/MFW-ADR-7")).toEqual({
			source: "adr",
			key: "MFW-ADR-7",
		});
		expect(parseDocsSplat("docs/guide/setup.md")).toEqual({
			source: "docs",
			key: "guide/setup.md",
		});
		expect(parseDocsSplat("docs")).toEqual({ source: "docs" });
		expect(parseDocsSplat("")).toEqual({});
		expect(parseDocsSplat(undefined)).toEqual({});
	});

	test("segments are decoded and dot segments dropped", () => {
		expect(parseDocsSplat("docs/a%20b/c.md")).toEqual({
			source: "docs",
			key: "a b/c.md",
		});
		expect(parseDocsSplat("docs/../../etc/x.md")).toEqual({
			source: "docs",
			key: "etc/x.md",
		});
		expect(parseDocsSplat("docs/%E0%A4%A")).toEqual({
			source: "docs",
			key: "%E0%A4%A",
		});
	});
});

describe("tree building", () => {
	const entries = [
		{ key: "intro.md" },
		{ key: "guide/setup.md" },
		{ key: "guide/deep/flow.mmd" },
		{ key: "guide/arch.puml" },
		{ key: "img/logo.png" },
		{ key: "a10.md" },
		{ key: "a2.md" },
	];
	const tree = buildTree(entries);

	test("directories first, then files, numerically ordered; counts roll up", () => {
		expect(tree.map((n) => `${n.kind}:${n.name}`)).toEqual([
			"dir:guide",
			"dir:img",
			"file:a2.md",
			"file:a10.md",
			"file:intro.md",
		]);
		const guide = tree[0];
		expect(guide?.kind === "dir" && guide.count).toBe(3);
		expect(guide?.kind === "dir" && guide.children.map((c) => c.name)).toEqual([
			"deep",
			"arch.puml",
			"setup.md",
		]);
	});

	test("a collapsed directory hides its children; expanding shows them at depth", () => {
		expect(flattenTree(tree, new Set()).map((r) => r.node.name)).toEqual([
			"guide",
			"img",
			"a2.md",
			"a10.md",
			"intro.md",
		]);
		const open = flattenTree(tree, new Set(["guide", "guide/deep"]));
		expect(open.map((r) => `${r.depth}:${r.node.name}`)).toEqual([
			"0:guide",
			"1:deep",
			"2:flow.mmd",
			"1:arch.puml",
			"1:setup.md",
			"0:img",
			"0:a2.md",
			"0:a10.md",
			"0:intro.md",
		]);
		expect(open[0]?.expanded).toBe(true);
	});

	test("ancestors of a key are what to open to reveal it", () => {
		expect(ancestorDirs("guide/deep/flow.mmd")).toEqual([
			"guide",
			"guide/deep",
		]);
		expect(ancestorDirs("intro.md")).toEqual([]);
	});
});

describe("source grouping and hints", () => {
	test("board types first with ADRs leading, then directories", () => {
		const groups = groupSources([
			{ id: "docs", kind: "dir" as const, label: "Docs" },
			{ id: "spec", kind: "board" as const, label: "Specs" },
			{ id: "adr", kind: "board" as const, label: "Decisions" },
		]);
		expect(groups.map((g) => g.title)).toEqual(["Board", "Directories"]);
		expect(groups[0]?.sources.map((s) => s.id)).toEqual(["adr", "spec"]);
		expect(
			groupSources([{ id: "docs", kind: "dir" as const, label: "Docs" }]).map(
				(g) => g.title,
			),
		).toEqual(["Directories"]);
	});

	test("directory documents say where to edit; ADRs say nothing (they have a form)", () => {
		expect(editHint({ path: "docs/a.md" }, "dir")).toContain("docs/a.md");
		expect(editHint({ type: "adr", path: "adrs/x.md" }, "board")).toBe("");
		expect(editHint({ type: "spec", path: "specs/x.md" }, "board")).toContain(
			"mfwb",
		);
	});

	test("Open in Files is withheld for a document in a separate board folder", () => {
		expect(filesTarget({ path: "docs/guide/a.md" })).toEqual({
			path: "docs/guide",
			file: "docs/guide/a.md",
		});
		expect(filesTarget({ path: "README.md" })).toEqual({
			path: "",
			file: "README.md",
		});
		expect(filesTarget({ path: "board:adrs/a.md" })).toBeNull();
	});

	test("status tone and property text", () => {
		expect(statusTone("accepted")).toBe("ok");
		expect(statusTone("proposed")).toBe("info");
		expect(statusTone("rejected")).toBe("critical");
		expect(statusTone("superseded")).toBe("warn");
		expect(statusTone("whatever")).toBe("neutral");
		expect(propertyText(["a", 2])).toBe("a, 2");
		expect(propertyText(null)).toBe("");
		expect(propertyText({ a: 1 })).toBe('{"a":1}');
		expect(propertyText({ s: "x".repeat(200) }).length).toBe(118);
	});
});

describe("link resolution", () => {
	const sources: DirSourceRef[] = [
		{ id: "docs", kind: "dir", path: "docs", base: "repo" },
		{ id: "guide", kind: "dir", path: "docs/guide", base: "repo" },
		{ id: "root", kind: "dir", path: ".", base: "repo" },
		{ id: "bnotes", kind: "dir", path: "notes", base: "board" },
	];
	const boardPaths = new Map([
		["adrs/DOC-ADR-1-x.md", { sourceId: "adr", key: "DOC-ADR-1" }],
	]);
	const ctx = (from: ReturnType<typeof fromDirSource>) => ({
		from,
		sources,
		boardPaths,
	});
	const inGuide = fromDirSource(
		{ path: "docs/guide", base: "repo" },
		"setup/install.md",
	);

	test("path joining stays inside the root", () => {
		expect(joinBasePath("docs/guide", "../intro.md")).toBe("docs/intro.md");
		expect(joinBasePath("docs", "./a/./b.md")).toBe("docs/a/b.md");
		expect(joinBasePath("docs", "../../x")).toBeNull();
	});

	test("where a document lives, for both document kinds", () => {
		expect(inGuide).toEqual({ base: "repo", dir: "docs/guide/setup" });
		expect(fromDirSource({ path: ".", base: "repo" }, "README.md")).toEqual({
			base: "repo",
			dir: "",
		});
		expect(fromBoardPath("adrs/DOC-ADR-1-x.md")).toEqual({
			base: "repo",
			dir: "adrs",
		});
		expect(fromBoardPath("board:adrs/x.md")).toEqual({
			base: "board",
			dir: "adrs",
		});
	});

	test("a relative link resolves to the deepest source holding the target", () => {
		expect(resolveDocLink("../deep.md#top", ctx(inGuide))).toEqual({
			kind: "doc",
			sourceId: "guide",
			key: "deep.md",
			fragment: "top",
		});
		// Leaves `guide` but stays in `docs`.
		expect(resolveDocLink("../../intro.md", ctx(inGuide))).toEqual({
			kind: "doc",
			sourceId: "docs",
			key: "intro.md",
			fragment: undefined,
		});
		// Leaves `docs` too: the root source takes it.
		expect(resolveDocLink("../../../README.md", ctx(inGuide))).toEqual({
			kind: "doc",
			sourceId: "root",
			key: "README.md",
			fragment: undefined,
		});
	});

	test("a root-absolute link is repository-relative", () => {
		expect(resolveDocLink("/docs/intro.md", ctx(inGuide))).toMatchObject({
			kind: "doc",
			sourceId: "docs",
			key: "intro.md",
		});
	});

	test("a link to a board document's file lands on the board document", () => {
		const from = fromDirSource({ path: "docs", base: "repo" }, "a.md");
		expect(resolveDocLink("../adrs/DOC-ADR-1-x.md", ctx(from))).toMatchObject({
			kind: "doc",
			sourceId: "adr",
			key: "DOC-ADR-1",
		});
	});

	test("anchors, external links and escapes", () => {
		expect(resolveDocLink("#install", ctx(inGuide))).toEqual({
			kind: "anchor",
			fragment: "install",
		});
		expect(resolveDocLink("https://example.com/a", ctx(inGuide))).toEqual({
			kind: "external",
			href: "https://example.com/a",
		});
		expect(resolveDocLink("mailto:a@b.c", ctx(inGuide)).kind).toBe("external");
		expect(resolveDocLink("//cdn.example/x.js", ctx(inGuide)).kind).toBe(
			"external",
		);
		// Climbs above the repository: nothing to open.
		const top = fromDirSource({ path: "docs", base: "repo" }, "a.md");
		expect(resolveDocLink("../../../etc/passwd", ctx(top)).kind).toBe(
			"unresolved",
		);
		// Inside no source.
		expect(
			resolveDocLink("src/main.ts", {
				from: { base: "repo", dir: "" },
				sources: [sources[0] as DirSourceRef],
			}).kind,
		).toBe("unresolved");
	});

	test("a non-document target is flagged as an asset", () => {
		expect(resolveDocLink("img/logo.png", ctx(inGuide))).toMatchObject({
			kind: "doc",
			sourceId: "guide",
			asset: true,
		});
	});

	test("sources of the other base never match", () => {
		expect(locateInSources("repo", "notes/a.md", sources.slice(3))).toBeNull();
		expect(locateInSources("board", "notes/a.md", sources.slice(3))).toEqual({
			sourceId: "bnotes",
			key: "a.md",
		});
		// The source directory itself is not a document.
		expect(locateInSources("repo", "docs", sources)).toMatchObject({
			sourceId: "root",
		});
	});

	test("images resolve through the asset route; external ones stay", () => {
		const url = (s: string, k: string) => docAssetUrl("/api/docs", "p", s, k);
		expect(resolveImageSrc("../img/a b.png", ctx(inGuide), url)).toBe(
			"/api/docs/p/guide/img/a%20b.png",
		);
		expect(
			resolveImageSrc("https://example.com/x.png", ctx(inGuide), url),
		).toBe("https://example.com/x.png");
		expect(resolveImageSrc("../../../../x.png", ctx(inGuide), url)).toBe(
			"../../../../x.png",
		);
	});

	test("asset URLs encode each segment", () => {
		expect(docAssetUrl("/mfw/api/docs", "my proj", "docs", "a/b c.png")).toBe(
			"/mfw/api/docs/my%20proj/docs/a/b%20c.png",
		);
	});
});

describe("markdown blocks", () => {
	const md = [
		"# Title",
		"",
		"```mermaid",
		"graph TD",
		"  A --> B",
		"```",
		"",
		"text",
		"",
		"~~~js",
		"const x = 1;",
		"~~~",
		"",
		"````md",
		"```mermaid",
		"not a diagram, an example",
		"```",
		"````",
		"",
		"    indented ```mermaid",
		"",
		"```",
		"unterminated",
	].join("\n");

	test("fences carry their language, code and line", () => {
		const fences = extractFences(md);
		expect(fences.map((f) => f.lang)).toEqual(["mermaid", "js", "md", ""]);
		expect(fences[0]).toEqual({
			lang: "mermaid",
			code: "graph TD\n  A --> B",
			line: 2,
		});
		expect(fences[2]?.code).toBe("```mermaid\nnot a diagram, an example\n```");
		// An unterminated fence runs to the end.
		expect(fences[3]?.code).toBe("unterminated");
	});

	test("only real mermaid fences count; a fence nested in a longer one does not", () => {
		const found = mermaidFences(md);
		expect(found).toHaveLength(1);
		expect(found[0]?.code).toContain("A --> B");
		expect(isMermaidLang("mermaid")).toBe(true);
		expect(isMermaidLang("mmd")).toBe(true);
		expect(isMermaidLang("js")).toBe(false);
		expect(isMermaidLang(undefined)).toBe(false);
	});

	test("heading slugs follow GitHub, with repeats numbered", () => {
		expect(slugify("Setup & Install: Step 1")).toBe("setup-install-step-1");
		expect(slugify("  Über Café ")).toBe("über-café");
		const slug = createSlugger();
		expect([slug("Notes"), slug("Notes"), slug("Notes")]).toEqual([
			"notes",
			"notes-1",
			"notes-2",
		]);
	});
});

describe("source form rules", () => {
	test("ids come from the label and stay unique and non-reserved", () => {
		expect(deriveSourceId("Design Notes!", [])).toBe("design-notes");
		expect(deriveSourceId("Docs", ["docs"])).toBe("docs-2");
		expect(deriveSourceId("Docs", ["docs", "docs-2"])).toBe("docs-3");
		expect(deriveSourceId("???", [])).toBe("docs");
		expect(deriveSourceId("Search", [])).toBe("search-2");
	});

	test("globs split on commas and lines", () => {
		expect(splitGlobs("**/*.md, notes/**\n  drafts/** ,")).toEqual([
			"**/*.md",
			"notes/**",
			"drafts/**",
		]);
		expect(splitGlobs("  ")).toEqual([]);
	});

	test("the form refuses what the daemon would", () => {
		expect(sourceProblem({ label: "", path: "docs" })).toMatch(/name/);
		expect(sourceProblem({ label: "D", path: "" })).toMatch(/directory/i);
		expect(sourceProblem({ label: "D", path: "/etc" })).toMatch(/relative/);
		expect(sourceProblem({ label: "D", path: "C:\\x" })).toMatch(/relative/);
		expect(sourceProblem({ label: "D", path: "a/../../b" })).toMatch(/leave/);
		expect(sourceProblem({ label: "D", path: "docs/design" })).toBeNull();
		expect(sourceProblem({ label: "D", path: "." })).toBeNull();
	});

	test("a source reads as one line", () => {
		expect(
			describeSource({
				path: "docs",
				include: ["**/*.md"],
				exclude: ["drafts/**"],
			}),
		).toBe("docs/ · only **/*.md · not drafts/**");
		expect(describeSource({ path: "notes", base: "board" })).toBe(
			"board:notes/",
		);
		expect(describeSource({ path: "." })).toBe(".");
	});
});
