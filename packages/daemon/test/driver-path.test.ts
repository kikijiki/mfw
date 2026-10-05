import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FROM_ROOT } from "../src/agents/adapter.ts";

/**
 * `FROM_ROOT` is unused from source (the colocated lookup in `resolveScript`
 * wins) and only matters in the bundled server, where `import.meta.url` points
 * into `.output/server/`. Tests never exercise it, so it can rot silently and
 * strand a claimed task in `in-progress`. Each path must name an existing file.
 */
describe("driver path resolution", () => {
	const repoRoot = resolve(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"..",
	);

	test("the repo root is where we think it is", () => {
		// Guards the test itself against a moved root.
		expect(existsSync(join(repoRoot, "package.json"))).toBe(true);
		expect(existsSync(join(repoRoot, "packages", "daemon"))).toBe(true);
	});

	test("every FROM_ROOT path resolves against the real tree", () => {
		for (const [id, rel] of Object.entries(FROM_ROOT)) {
			const abs = join(repoRoot, rel);
			expect(
				existsSync(abs),
				`FROM_ROOT.${id} points at ${rel}, which does not exist. The bundled ` +
					`server resolves the driver through this path and will fail to ` +
					`launch every run.`,
			).toBe(true);
		}
	});
});
