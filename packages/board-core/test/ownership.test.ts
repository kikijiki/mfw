import { describe, expect, test } from "bun:test";
import {
	filesOutsideOwns,
	findOwnershipConflicts,
	normalizeOwnsPattern,
	ownsPath,
	patternsOverlap,
	patternWithin,
	validateOwnsPattern,
} from "../src/ownership.ts";

describe("ownsPath", () => {
	test("a literal owns itself and everything below it", () => {
		expect(ownsPath("src/api", "src/api")).toBe(true);
		expect(ownsPath("src/api", "src/api/router.ts")).toBe(true);
		expect(ownsPath("src/api", "src/apis/x.ts")).toBe(false);
		expect(ownsPath("src/api/router.ts", "src/api")).toBe(false);
	});

	test("globs match within a segment, ** across segments", () => {
		expect(ownsPath("src/*.ts", "src/a.ts")).toBe(true);
		expect(ownsPath("src/*.ts", "src/a/b.ts")).toBe(false);
		expect(ownsPath("src/**/*.ts", "src/a/b/c.ts")).toBe(true);
		expect(ownsPath("src/**/*.ts", "src/c.ts")).toBe(true);
		expect(ownsPath("src/**/*.ts", "src/c.md")).toBe(false);
		expect(ownsPath("src/{a,b}/**", "src/b/x")).toBe(true);
		expect(ownsPath("src/{a,b}/**", "src/c/x")).toBe(false);
		expect(ownsPath("docs/?.md", "docs/a.md")).toBe(true);
		expect(ownsPath("docs/[ab].md", "docs/c.md")).toBe(false);
	});

	test("a glob that matches a directory owns its contents", () => {
		expect(ownsPath("packages/*", "packages/core/src/x.ts")).toBe(true);
	});

	test("negated classes agree with glob matching, including exclusions and ranges", () => {
		for (const pattern of ["src/[!a].ts", "src/[!a-c].ts", "src/[ab].ts"]) {
			for (const path of ["src/a.ts", "src/b.ts", "src/d.ts", "src/!.ts"]) {
				const expected = new Bun.Glob(pattern).match(path);
				expect(ownsPath(pattern, path)).toBe(expected);
				expect(patternsOverlap(pattern, path)).toBe(expected);
				expect(patternsOverlap(path, pattern)).toBe(expected);
			}
		}
	});

	test("malformed legacy patterns fail closed without throwing", () => {
		expect(ownsPath("src/[z-a].ts", "src/b.ts")).toBe(false);
		expect(patternsOverlap("src/[z-a].ts", "src/b.ts")).toBe(true);
		expect(filesOutsideOwns(["src/[z-a].ts"], ["src/b.ts"])).toEqual([
			"src/b.ts",
		]);
	});

	test("regex metacharacters in literal segments are literal", () => {
		expect(ownsPath("a.b", "axb")).toBe(false);
		expect(ownsPath("a+b/c", "a+b/c")).toBe(true);
	});

	test("actual filenames preserve whitespace, newlines and literal backslashes", () => {
		expect(ownsPath("src/a.ts", "src/a.ts ")).toBe(false);
		expect(ownsPath("src/*.ts", "src/a.ts\n")).toBe(false);
		expect(ownsPath("src/*.ts", "src/a\nb.ts")).toBe(true);
		expect(ownsPath("src/**", "src\\a.ts")).toBe(false);
		expect(ownsPath("src/*", "src/a\\b.ts")).toBe(true);
		expect(
			filesOutsideOwns(
				["src/*.ts"],
				["src/a.ts ", "src/a.ts\n", "src/a\nb.ts"],
			),
		).toEqual(["src/a.ts ", "src/a.ts\n"]);
	});
});

describe("patternsOverlap", () => {
	test("literals overlap when equal or nested, not when siblings", () => {
		expect(patternsOverlap("src/a.ts", "src/a.ts")).toBe(true);
		expect(patternsOverlap("src", "src/a.ts")).toBe(true);
		expect(patternsOverlap("src/a.ts", "src/b.ts")).toBe(false);
		expect(patternsOverlap("src/api", "src/apis")).toBe(false);
	});

	test("a glob is compared segment by segment against a literal", () => {
		expect(patternsOverlap("src/*.ts", "src/a.ts")).toBe(true);
		expect(patternsOverlap("src/*.ts", "src/a.md")).toBe(false);
		expect(patternsOverlap("src/*/x.ts", "src/a/y.ts")).toBe(false);
		expect(patternsOverlap("docs/**", "src/a.ts")).toBe(false);
		expect(patternsOverlap("src/**", "src/deep/a.ts")).toBe(true);
	});

	test("two globs in the same segment are conservatively overlapping", () => {
		expect(patternsOverlap("src/*.ts", "src/*.md")).toBe(true);
		expect(patternsOverlap("a/*/x", "b/*/x")).toBe(false);
	});

	test("normalization: ./ prefix and trailing slash", () => {
		expect(normalizeOwnsPattern("./src/api/")).toBe("src/api");
		expect(patternsOverlap("./src/api/", "src/api/x.ts")).toBe(true);
	});
});

describe("patternWithin (R7)", () => {
	test("an identical pattern is within itself", () => {
		expect(patternWithin("crates/a/b.rs", "crates/a/b.rs")).toBe(true);
	});

	test("a literal is within a ** that covers its prefix, at any depth", () => {
		expect(patternWithin("crates/a/b.rs", "crates/**")).toBe(true);
		expect(patternWithin("crates/a/b/c.rs", "crates/**")).toBe(true);
		expect(patternWithin("crates/a/b.rs", "crates/a/**")).toBe(true);
		expect(patternWithin("other/x.rs", "crates/**")).toBe(false);
	});

	test("a literal is within a glob segment that matches it", () => {
		expect(patternWithin("crates/a.rs", "crates/*.rs")).toBe(true);
		expect(patternWithin("crates/a.rs", "crates/b.rs")).toBe(false);
	});

	test("an inner glob within a ** outer is still provably contained", () => {
		expect(patternWithin("crates/a/*.rs", "crates/**")).toBe(true);
	});

	test("glob-within-glob and **-within-anything are conservatively false, never a false positive", () => {
		// outer glob vs inner glob: containment isn't attempted
		expect(patternWithin("crates/*.rs", "crates/a.rs")).toBe(false);
		// inner ** can match any depth - no non-** outer segment can prove it's covered
		expect(patternWithin("crates/**", "crates/a/**")).toBe(false);
	});

	test("length mismatch with no outer ** is never contained", () => {
		expect(patternWithin("crates/a", "crates/a/b")).toBe(false);
		expect(patternWithin("crates/a/b", "crates/a")).toBe(false);
	});

	test("an invalid pattern on either side is never contained", () => {
		expect(patternWithin("../escape", "crates/**")).toBe(false);
		expect(patternWithin("crates/a.rs", "../escape")).toBe(false);
	});
});

describe("validateOwnsPattern", () => {
	test("rejects paths that escape the repository", () => {
		expect(validateOwnsPattern("/etc/passwd")).not.toBeNull();
		expect(validateOwnsPattern("../other")).not.toBeNull();
		expect(validateOwnsPattern("a/./b")).not.toBeNull();
		expect(validateOwnsPattern("")).not.toBeNull();
	});

	test("rejects ** glued to other characters and unbalanced brackets", () => {
		expect(validateOwnsPattern("src/**.ts")).not.toBeNull();
		expect(validateOwnsPattern("src/{a,b")).not.toBeNull();
	});

	test("accepts ordinary patterns", () => {
		expect(validateOwnsPattern("src/**/*.ts")).toBeNull();
		expect(validateOwnsPattern("src/{a,b}/[xy].ts")).toBeNull();
	});
});

describe("filesOutsideOwns", () => {
	test("lists changed files no pattern covers", () => {
		expect(
			filesOutsideOwns(
				["src/api/**", "README.md"],
				["src/api/x.ts", "README.md", "src/db/y.ts"],
			),
		).toEqual(["src/db/y.ts"]);
	});

	test("a task that declares nothing has no scope to exceed", () => {
		expect(filesOutsideOwns([], ["anything"])).toEqual([]);
	});
});

describe("findOwnershipConflicts", () => {
	test("reports overlapping tasks with no dependency between them", () => {
		const conflicts = findOwnershipConflicts([
			{ id: "T-1", owns: ["src/api/**"], dependsOn: [] },
			{ id: "T-2", owns: ["src/api/router.ts"], dependsOn: [] },
			{ id: "T-3", owns: ["docs"], dependsOn: [] },
		]);
		expect(conflicts).toEqual([
			{ a: "T-1", b: "T-2", patterns: [["src/api/**", "src/api/router.ts"]] },
		]);
	});

	test("a dependency path in either direction orders the pair", () => {
		expect(
			findOwnershipConflicts([
				{ id: "T-1", owns: ["src"], dependsOn: [] },
				{ id: "T-2", owns: [], dependsOn: ["T-1"] },
				{ id: "T-3", owns: ["src/a.ts"], dependsOn: ["T-2"] },
			]),
		).toEqual([]);
	});

	test("a dependency cycle does not hang it", () => {
		expect(
			findOwnershipConflicts([
				{ id: "T-1", owns: ["src"], dependsOn: ["T-2"] },
				{ id: "T-2", owns: ["src"], dependsOn: ["T-1"] },
			]),
		).toEqual([]);
	});
});
