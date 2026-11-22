import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The XSS review, as checks. The UI shows agent-authored text (markdown,
 * mermaid, file contents) in a session that can approve widening a sandbox, so
 * the places where text could become markup are listed here and pinned: a new
 * one fails this test until it is reviewed and added with its reason.
 */

const SRC = import.meta.dir;
const files: string[] = [];
const walk = (dir: string) => {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p);
		else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$|\.gen\.ts$/.test(name))
			files.push(p);
	}
};
walk(SRC);

const hits = (pattern: RegExp) =>
	files
		.filter((f) => pattern.test(readFileSync(f, "utf8")))
		.map((f) => relative(SRC, f))
		.sort();

describe("xss review: sinks that turn text into markup", () => {
	test("dangerouslySetInnerHTML: the theme bootstrap and mermaid's sanitised SVG only", () => {
		// __root: a constant script, no interpolation, carries the CSP nonce.
		// Mermaid: `securityLevel: "strict"` output (DOMPurify), and the CSP
		// blocks inline handlers and script elements even if it slipped.
		expect(hits(/dangerouslySetInnerHTML/)).toEqual([
			"features/docs/Mermaid.tsx",
			"routes/__root.tsx",
		]);
	});
	test("no innerHTML, outerHTML, insertAdjacentHTML, document.write, eval or Function()", () => {
		expect(
			hits(
				/\.(inner|outer)HTML\s*=|insertAdjacentHTML|document\.write|\beval\(|new Function\(/,
			),
		).toEqual([]);
	});
	test("markdown never admits raw HTML (no rehype-raw, no allowDangerousHtml)", () => {
		expect(
			hits(/rehype-raw|allowDangerousHtml|skipHtml\s*=\s*\{?false/),
		).toEqual([]);
	});
	test("mermaid runs at securityLevel strict, and only there", () => {
		const src = readFileSync(join(SRC, "features/docs/Mermaid.tsx"), "utf8");
		expect(src).toContain('securityLevel: "strict"');
		expect(src).not.toMatch(/securityLevel:\s*"(loose|antiscript|sandbox)"/);
	});
	test("the root inline script carries the CSP nonce", () => {
		const root = readFileSync(join(SRC, "routes/__root.tsx"), "utf8");
		expect(root).toMatch(/<script\s+nonce=\{nonce\}/);
	});
	test("every external anchor with target=_blank has rel=noopener", () => {
		for (const f of files) {
			const src = readFileSync(f, "utf8");
			for (const m of src.matchAll(/target="_blank"([\s\S]{0,120})/g))
				expect(`${f}: ${m[1]}`).toMatch(/rel="no(opener|referrer)/);
		}
	});
});
