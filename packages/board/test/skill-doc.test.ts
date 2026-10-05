import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commands } from "../src/commands/index.ts";

const SKILL = readFileSync(
	join(import.meta.dir, "..", "skill", "SKILL.md"),
	"utf8",
);

/** Verb alternatives that start a line of a usage/example block, e.g.
 * `mfwb append|prepend <id> ...` or a bare `list [--type ...]` in the command
 * listing: first token after an optional `mfwb` (and global flags). */
function documentedVerbs(doc: string): Set<string> {
	const verbs = new Set<string>();
	for (const raw of doc.split("\n")) {
		let tokens = raw.trim().replace(/^#\s*/, "").split(/\s+/);
		if (tokens[0] === "mfwb") tokens = tokens.slice(1);
		while (tokens[0]?.startsWith("--")) tokens = tokens.slice(2);
		for (const v of (tokens[0] ?? "").split("|")) verbs.add(v);
	}
	return verbs;
}

describe("the mfwb skill document stays in step with the CLI", () => {
	test("every registered command is documented", () => {
		const documented = documentedVerbs(SKILL);
		const missing = commands
			.map((c) => c.name)
			.filter((name) => !documented.has(name));
		expect(missing).toEqual([]);
	});

	test("frontmatter is valid Agent Skills metadata", () => {
		const m = /^---\nname: (\S+)\ndescription: "([^"]+)"\n---\n/.exec(SKILL);
		expect(m).not.toBeNull();
		expect(m?.[1]).toBe("mfwb");
		// The Agent Skills format caps the description at 1024 characters.
		expect((m?.[2] ?? "").length).toBeLessThanOrEqual(1024);
	});

	test("no stale references to the removed board-core binary or split ids", () => {
		expect(SKILL).not.toMatch(
			/board-core --config|board-core list|bin\/board-core/,
		);
		expect(SKILL).not.toMatch(/nextSplitId|--split-of/);
	});
});
