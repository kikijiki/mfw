import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { EXPERIMENTAL_REMOTE_ENV } from "../src/remote-experimental.ts";

const root = resolve(import.meta.dir, "../../..");

const REQUIRED = [
	"README.md",
	"SECURITY.md",
	"docs/architecture-overview.md",
	"docs/experimental.md",
	"docs/threat-model.md",
];

const publicDocs = () => [
	...new Set([
		...REQUIRED.filter((f) => existsSync(join(root, f))),
		...readdirSync(join(root, "docs"))
			.filter((f) => f.endsWith(".md"))
			.map((f) => `docs/${f}`),
	]),
];

const read = (file: string) => readFileSync(join(root, file), "utf8");

/** The text outside fenced code blocks. */
const prose = (text: string) => text.replace(/^```[\s\S]*?^```$/gm, "");

/** GitHub's heading anchor. */
const slug = (heading: string) =>
	heading
		.replace(/`/g, "")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N} _-]/gu, "")
		.replace(/ /g, "-");

const anchors = (text: string) =>
	new Set(
		[...prose(text).matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1] ?? "")),
	);

function brokenLinks(file: string): string[] {
	const text = prose(read(file));
	const broken: string[] = [];
	const targets = [
		...[...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? ""),
		...[...text.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1] ?? ""),
	];
	for (const target of targets) {
		if (/^[a-z]+:/i.test(target)) continue;
		const [path = "", anchor] = target.split("#");
		const resolved = path
			? relative(root, normalize(join(root, dirname(file), path)))
			: file;
		if (!existsSync(join(root, resolved))) {
			broken.push(`${file}: ${target}`);
		} else if (anchor && resolved.endsWith(".md")) {
			if (!anchors(read(resolved)).has(anchor)) {
				broken.push(`${file}: ${target} (no such heading)`);
			}
		}
	}
	return broken;
}

const CITED_PATH =
	/`((?:packages|apps|tools|packaging|docs)\/[A-Za-z0-9_./$-]+?)(?::\d+)?`/g;

describe("the public docs", () => {
	test("the required documents exist", () => {
		expect(REQUIRED.filter((f) => !existsSync(join(root, f)))).toEqual([]);
	});

	test("every relative link and heading anchor resolves", () => {
		expect(publicDocs().flatMap(brokenLinks)).toEqual([]);
	});

	test("every code path they cite exists", () => {
		const missing = publicDocs().flatMap((file) =>
			[...read(file).matchAll(CITED_PATH)]
				.map((m) => (m[1] ?? "").replace(/\/$/, ""))
				.filter((p) => !existsSync(join(root, p)))
				.map((p) => `${file}: ${p}`),
		);
		expect(missing).toEqual([]);
	});

	test("no retired name or superseded sandbox claim survives", () => {
		const stale = [
			/\bmfwb\b/,
			/\bmfw-mcp\b/,
			/writable HOME/i,
			/no network namespace/i,
			/\bbwrapCore\b/,
			/run with your user's permissions by default/i,
		];
		const found = publicDocs().flatMap((file) =>
			stale.filter((re) => re.test(read(file))).map((re) => `${file}: ${re}`),
		);
		expect(found).toEqual([]);
	});

	test("the README leads to the security and architecture docs", () => {
		const readme = read("README.md");
		for (const doc of [
			"SECURITY.md",
			"docs/threat-model.md",
			"docs/experimental.md",
			"docs/architecture-overview.md",
		]) {
			expect(readme).toContain(`](${doc})`);
		}
	});

	test("the experimental list names the real switch", () => {
		expect(read("docs/experimental.md")).toContain(EXPERIMENTAL_REMOTE_ENV);
	});

	test("the quick start states the setting a sandboxed run needs", () => {
		expect(read("README.md")).toContain('"runWorkspace": "clone"');
	});

	test("the security policy keeps a placeholder until the owner sets a contact", () => {
		const policy = read("SECURITY.md");
		expect(policy).toMatch(/<[^>]*security contact[^>]*>/i);
		expect(policy).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
	});
});
