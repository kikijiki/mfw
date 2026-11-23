import { describe, expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";

/** Security review P5b, m7: the required gate must fail, not skip, without bwrap. */

describe("m7: the conformance suite in a required gate", () => {
	test("fails loudly when bwrap is missing", async () => {
		const repo = resolve(import.meta.dir, "../../..");
		const child = Bun.spawn(
			[
				process.execPath,
				"test",
				join(import.meta.dir, "agent-bridge-conformance.test.ts"),
				"-t",
				"no-test-has-this-name",
			],
			{
				cwd: repo,
				env: {
					PATH: dirname(process.execPath),
					HOME: process.env.HOME ?? "/nonexistent",
					MFW_REQUIRE_LIVE_SANDBOX: "1",
				},
				stdout: "pipe",
				stderr: "pipe",
				stdin: "ignore",
			},
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code).not.toBe(0);
		expect(`${stdout}${stderr}`).toContain(
			"MFW_REQUIRE_LIVE_SANDBOX is set, but",
		);
	}, 30_000);

	test("uses no fixed run id and never the real control root", async () => {
		const text = await Bun.file(
			join(import.meta.dir, "agent-bridge-conformance.test.ts"),
		).text();
		expect(text).not.toContain("controlRootPath");
		expect(text).not.toMatch(/runId: "r1"|mfw_r1|run_id = 'r1'/);
	});
});
