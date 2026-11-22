import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost } from "../src/agent-host.ts";
import { silentLogger } from "../src/log.ts";
import { SandboxUnavailableError } from "../src/sandbox.ts";

/**
 * MFW-33 item 3 (G2a): a missing bwrap is a refusal, not a degrade; it uses AgentHost's narrow sandbox seam.
 * `mock.module` is process-global in Bun, including across test files, so a
 * module mock here would poison `sandbox.test.ts`'s real helper assertions.
 *
 * The tmux runner records every call: a refused launch must start no session.
 */
describe("AgentHost fails closed when bwrap is unavailable", () => {
	test("isolation requested, bwrap missing → launch throws SandboxUnavailableError and starts nothing", async () => {
		const base = await mkdtemp(join(tmpdir(), "mfw-degrade-"));
		const runDir = join(base, "run");
		const cwd = join(base, "wt");
		await mkdir(runDir, { recursive: true });
		await mkdir(cwd, { recursive: true });
		const driverScript = join(base, "driver.ts");
		await writeFile(driverScript, 'console.log("ran"); process.exit(0);');

		const tmuxCalls: string[][] = [];
		const host = new AgentHost(silentLogger(), {
			tmuxRunner: async (args) => {
				tmuxCalls.push(args);
				return {
					exitCode: 0,
					stdout: "",
					stderr: "",
					timedOut: false,
					truncated: false,
					signalCode: null,
				};
			},
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
		await expect(
			host.launch({
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
			}),
		).rejects.toBeInstanceOf(SandboxUnavailableError);
		expect(tmuxCalls).toEqual([]);
		await rm(base, { recursive: true, force: true });
	});
});
