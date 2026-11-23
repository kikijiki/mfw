import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveScript } from "../src/agents/adapter.ts";
import { CLAUDE_BRIDGE } from "../src/containment/host-script.ts";

/**
 * Wave 2 exit review, m6: `MFW_*_SCRIPT` picks what runs on the host. The
 * production bundle never uses it and says so; running from source keeps it.
 */

const VAR = "MFW_TEST_OVERRIDE_SCRIPT";
const dirs: string[] = [];
afterEach(async () => {
	delete process.env[VAR];
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function planted(): Promise<{ base: string; path: string }> {
	const base = await mkdtemp(join(tmpdir(), "mfw-override-"));
	dirs.push(base);
	const path = join(base, "planted.ts");
	await writeFile(path, "// not ours\n");
	return { base, path };
}

describe("a script override", () => {
	test("is refused and reported in a production bundle", async () => {
		const { base, path } = await planted();
		const chunk = join(base, "apps/start/.output/server/chunk.mjs");
		process.env[VAR] = path;
		const err = spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(() =>
				resolveScript(pathToFileURL(chunk).href, CLAUDE_BRIDGE, VAR),
			).toThrow(`refusing ${VAR}`);
			expect(err.mock.calls.flat().join(" ")).toContain(VAR);
		} finally {
			err.mockRestore();
		}
	});

	test("still applies when running from source", async () => {
		const { base, path } = await planted();
		process.env[VAR] = path;
		const source = pathToFileURL(join(base, "adapter.ts")).href;
		expect(resolveScript(source, CLAUDE_BRIDGE, VAR)).toBe(path);
	});
});
