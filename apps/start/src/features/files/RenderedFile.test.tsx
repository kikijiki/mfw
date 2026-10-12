import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";

import {
	fileAssetUrl,
	fileKind,
	IMAGE_MAX_BYTES,
	markdownContext,
	parentDir,
} from "./fileKinds";
import { ImageView, MarkdownView } from "./RenderedFile";

describe("file kinds", () => {
	test("markdown and image extensions pick the presentation", () => {
		expect(fileKind("README.md")).toBe("markdown");
		expect(fileKind("docs/Guide.MARKDOWN")).toBe("markdown");
		for (const n of ["a.png", "a.JPG", "a.jpeg", "a.gif", "a.webp", "a.svg"]) {
			expect(fileKind(n)).toBe("image");
		}
		expect(fileKind("favicon.ico")).toBe("image");
		expect(fileKind("a.avif")).toBe("image");
		expect(fileKind("a.ts")).toBe("text");
		expect(fileKind("a.md.bak")).toBe("text");
		expect(fileKind("a.bin")).toBe("text");
	});

	test("asset urls carry the tree and encode each segment", () => {
		const base = "/api/files";
		expect(
			fileAssetUrl(base, { project: "p", ref: "feature/x" }, "a b/c#.png"),
		).toBe("/api/files/p/a%20b/c%23.png?ref=feature%2Fx");
		expect(fileAssetUrl(base, { project: "p", run: "R1" }, "a.png")).toBe(
			"/api/files/p/a.png?run=R1",
		);
		expect(fileAssetUrl(base, { project: "p" }, "a.png")).toBe(
			"/api/files/p/a.png",
		);
		// A ref wins: the daemon route reads one tree.
		expect(
			fileAssetUrl(base, { project: "p", ref: "main", run: "R1" }, "a"),
		).toBe("/api/files/p/a?ref=main");
	});

	test("markdown resolves relative to its own directory", () => {
		expect(markdownContext("docs/guide/a.md").from.dir).toBe("docs/guide");
		expect(markdownContext("README.md").from.dir).toBe("");
		expect(parentDir("a/b/c.md")).toBe("a/b");
		expect(parentDir("c.md")).toBeUndefined();
	});
});

describe("rendered markdown", () => {
	const text = [
		"# Title",
		"",
		"![shot](../img/shot.png)",
		"",
		"[sibling](other.md#part) and [web](https://example.com)",
		"",
		"| a | b |",
		"| - | - |",
		"| 1 | 2 |",
	].join("\n");

	test("images stream from the same ref, links stay in the viewer", () => {
		const html = renderToString(
			<MarkdownView
				source={{ project: "demo", ref: "feature/x" }}
				path="docs/guide/readme.md"
				text={text}
			/>,
		);
		expect(html).toContain("<h1");
		expect(html).toContain("Title");
		expect(html).toContain(
			'src="/api/files/demo/docs/img/shot.png?ref=feature%2Fx"',
		);
		expect(html).toContain("<table");
		expect(html).toContain("https://example.com");
		expect(html).toContain("other.md");
		expect(html).toContain("ref=feature%2Fx");
		expect(html).toContain("#part");
	});

	test("a run's worktree is addressed by run", () => {
		const html = renderToString(
			<MarkdownView
				source={{ project: "demo", run: "R9" }}
				path="a.md"
				text="![x](p.png)"
			/>,
		);
		expect(html).toContain('src="/api/files/demo/p.png?run=R9"');
	});
});

describe("image view", () => {
	test("an image is an <img> from the read-only route, svg included", () => {
		for (const path of ["pics/a.png", "pics/b.svg"]) {
			const html = renderToString(
				<ImageView
					source={{ project: "demo", ref: "main" }}
					path={path}
					size={1234}
				/>,
			);
			expect(html).toContain("<img");
			expect(html).toContain(`/api/files/demo/${path}?ref=main`);
			expect(html).not.toContain("<svg");
		}
	});

	test("an image over the cap is not requested", () => {
		const html = renderToString(
			<ImageView
				source={{ project: "demo" }}
				path="big.png"
				size={IMAGE_MAX_BYTES + 1}
			/>,
		);
		expect(html).not.toContain("<img");
		expect(html).toContain("too large");
	});
});
