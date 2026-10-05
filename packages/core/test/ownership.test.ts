import { describe, expect, test } from "bun:test";
import {
	filesOutsideOwns,
	findOwnershipConflicts,
	normalizeOwnsPattern,
	ownsPath,
	patternsOverlap,
	validateOwnsPattern,
} from "../src/ownership.ts";
import { OwnsSchema } from "../src/taskfile.ts";

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

	test("rejects invalid and unsupported classes at the canonical schema boundary", () => {
		for (const pattern of [
			"src/[z-a].ts",
			"src/[].ts",
			"src/[!].ts",
			"src/[[:alpha:]].ts",
		]) {
			expect(validateOwnsPattern(pattern)).not.toBeNull();
			expect(OwnsSchema.safeParse([pattern]).success).toBe(false);
		}
		expect(OwnsSchema.safeParse(["src/[!a-c].ts"]).success).toBe(true);
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
			{
				a: "T-1",
				b: "T-2",
				patterns: [["src/api/**", "src/api/router.ts"]],
			},
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
