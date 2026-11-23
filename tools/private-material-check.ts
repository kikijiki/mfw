/**
 * Fails when a committed file names private material: the owner's home path,
 * the private knowledge repository, or the private downstream project.
 *
 *   bun run tools/private-material-check.ts
 *
 * Reads `git ls-files`, so only the committed tree is scanned. Fixtures use
 * placeholder homes (`/home/me`, `/home/user`, `/home/agent`) and temp dirs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Rule {
	name: string;
	pattern: RegExp;
}

export const RULES: readonly Rule[] = [
	{ name: "private knowledge repository", pattern: /backstage/i },
	{ name: "private project name", pattern: /\bpoot\b/ },
	{
		name: "a real home path",
		pattern: /\/home\/(?!me\b|user\b|agent\b|example\b|runner\b)[a-z][\w.-]*\//,
	},
	{
		name: "a real home path",
		pattern: /\/Users\/(?!me\b|user\b)[A-Za-z][\w.-]*\//,
	},
];

/** Files allowed to match, each with the reason. */
export const ALLOWED: Readonly<Record<string, string>> = {
	"tools/private-material-check.ts": "defines the patterns",
	"packages/daemon/test/tools-private-material-check.test.ts":
		"tests the patterns",
	"AGENTS.md": "the owner's own agent-instruction import; the owner decides",
};

export function scan(path: string, text: string): string[] {
	if (ALLOWED[path]) return [];
	const found: string[] = [];
	text.split("\n").forEach((line, i) => {
		for (const r of RULES) {
			if (r.pattern.test(line)) found.push(`${path}:${i + 1}: ${r.name}`);
		}
	});
	return found;
}

if (import.meta.main) {
	const root = join(import.meta.dir, "..");
	const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
	if (listed.exitCode !== 0) {
		console.error("private-material-check: git ls-files failed");
		process.exit(2);
	}
	const problems: string[] = [];
	for (const path of listed.stdout.toString().split("\0").filter(Boolean)) {
		let text: string;
		try {
			const buf = readFileSync(join(root, path));
			if (buf.includes(0)) continue; // binary
			text = buf.toString("utf8");
		} catch {
			continue; // listed but absent in this checkout
		}
		problems.push(...scan(path, text));
	}
	if (problems.length > 0) {
		console.error(
			`private material in the committed tree:\n${problems.join("\n")}`,
		);
		process.exit(1);
	}
	console.log("private-material-check: clean");
}
