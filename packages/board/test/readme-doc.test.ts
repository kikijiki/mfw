import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commands } from "../src/commands/index.ts";

// Markdown tables escape `|` as `\|`; compare against the unescaped text.
const README = readFileSync(
	join(import.meta.dir, "..", "README.md"),
	"utf8",
).replace(/\\\|/g, "|");

describe("the mfwb README explains every command", () => {
	test("each registered command appears as `mfwb <name>`", () => {
		const missing = commands
			.map((c) => c.name)
			.filter((name) => {
				const re = new RegExp(`\`mfwb (?:[a-z|]+\\|)?${name}(?:\\||\\b)`);
				return !re.test(README);
			});
		expect(missing).toEqual([]);
	});

	test("each usage flag of the registry shows up in the README", () => {
		const flags = new Set<string>();
		for (const c of commands) {
			for (const u of c.usage) {
				for (const m of u.matchAll(/--[a-z][a-z-]*/g)) flags.add(m[0]);
			}
		}
		const missing = [...flags].filter((f) => !README.includes(f));
		expect(missing).toEqual([]);
	});
});
