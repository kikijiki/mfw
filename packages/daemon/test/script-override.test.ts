import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveScript } from "../src/agents/adapter.ts";

/**
 * Wave 2 exit review, m6: `MFW_*_SCRIPT` picks what runs on the host. The
 * production bundle ignores it, loudly; running from source keeps it.
 */

const VAR = "MFW_TEST_OVERRIDE_SCRIPT";
const dirs: string[] = [];
afterEach(async () => {
	delete process.env[VAR];
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function layout() {
	const base = await mkdtemp(join(tmpdir(), "mfw-override-"));
	dirs.push(base);
	const planted = join(base, "planted.ts");
	await writeFile(planted, "// not ours\n");
	const real = join(base, "real.ts");
	await writeFile(real, "// ours\n");
	return { base, planted, real };
}

describe("a script override", () => {
	test("is ignored and reported in a production bundle", async () => {
		const { base, planted } = await layout();
		const bundled = join(base, "apps/start/.output/server/real.ts");
		await Bun.write(bundled, "// built\n");
		process.env[VAR] = planted;
		const err = spyOn(console, "error").mockImplementation(() => {});
		try {
			const got = resolveScript(pathToFileURL(bundled).href, "real.ts", VAR);
			expect(got).toBe(bundled);
			expect(err.mock.calls.flat().join(" ")).toContain(VAR);
		} finally {
			err.mockRestore();
		}
	});

	test("still applies when running from source", async () => {
		const { planted, real } = await layout();
		process.env[VAR] = planted;
		expect(resolveScript(pathToFileURL(real).href, "real.ts", VAR)).toBe(
			planted,
		);
	});
});
