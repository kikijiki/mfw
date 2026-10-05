import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost } from "../src/agent-host.ts";
import { silentLogger } from "../src/log.ts";

/**
 * MFW-33 item 3: the degrade path uses AgentHost's narrow sandbox seam.
 * `mock.module` is process-global in Bun, including across test files, so a
 * module mock here would poison `sandbox.test.ts`'s real helper assertions.
 *
 * `wrapWithBwrap` throwing on any call is the real assertion here: if
 * `agent-host.ts` called it despite `bwrapAvailable` reporting false, the run
 * would fail loudly instead of degrading, this proves it does not.
 */
async function waitForExit(host: AgentHost, runDir: string, timeoutMs = 5000) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		const exit = await host.readExit(runDir);
		if (exit.kind === "exit") return exit;
		await Bun.sleep(50);
	}
	throw new Error("waitForExit timed out");
}

describe("AgentHost degrades when bwrap is unavailable", () => {
	test("isolation requested, bwrap missing → runs unsandboxed and warns once, never fails the run", async () => {
		const base = await mkdtemp(join(tmpdir(), "mfw-degrade-"));
		const runDir = join(base, "run");
		const cwd = join(base, "wt");
		await mkdir(runDir, { recursive: true });
		await mkdir(cwd, { recursive: true });
		const driverScript = join(base, "driver.ts");
		await writeFile(driverScript, 'console.log("ran"); process.exit(0);');

		const log = silentLogger();
		const warnSpy = spyOn(log, "warn");
		const host = new AgentHost(log, {
			sandbox: {
				bwrapAvailable: async () => false,
				wrapWithBwrap: () => {
					throw new Error(
						"wrapWithBwrap must not be called when bwrap is unavailable",
					);
				},
			},
		});
		const runId = `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
		await host.launch({
			runId,
			runDir,
			cwd,
			projectRoot: base,
			driverScript,
			agentArgv: ["true"],
			env: {},
			model: "test-model",
			initialMessage: "",
			steer: false,
			isolation: { mode: "bwrap", hidePaths: ["/nonexistent-on-purpose"] },
		});

		const exit = await waitForExit(host, runDir);
		expect(exit).toEqual({ kind: "exit", code: 0 });
		expect(warnSpy).toHaveBeenCalled();
		await rm(base, { recursive: true, force: true });
	});
});
