import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost, type LaunchSpec } from "../src/agent-host.ts";
import { loadConfig } from "../src/config.ts";
import { SandboxUnavailableError } from "../src/sandbox.ts";
import { runShTmux } from "./support/run-sh-tmux.ts";

/** Every run is sandboxed: there is no setting to turn that off, and no path around it. */

describe("agentIsolation was removed", () => {
	for (const value of ["none", "bwrap"]) {
		test(`a config that still sets agentIsolation: "${value}" fails at load, naming the change`, async () => {
			const home = await mkdtemp(join(tmpdir(), "mfw-isolation-"));
			try {
				await writeFile(
					join(home, "config.json"),
					JSON.stringify({
						projects: [
							{ name: "ok", root: "/srv/ok" },
							{ name: "old", root: "/srv/old", agentIsolation: value },
						],
					}),
				);
				await expect(loadConfig(home)).rejects.toThrow(
					"agentIsolation was removed: runs are always sandboxed",
				);
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		});
	}

	test("a config without it loads", async () => {
		const home = await mkdtemp(join(tmpdir(), "mfw-isolation-"));
		try {
			await writeFile(
				join(home, "config.json"),
				JSON.stringify({ projects: [{ name: "ok", root: "/srv/ok" }] }),
			);
			expect((await loadConfig(home)).projects).toHaveLength(1);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("AgentHost.launch refuses any run without its sandbox", () => {
	for (const approvalMode of [
		"autonomous",
		"interactive",
		undefined,
	] as const) {
		test(`approvalMode ${approvalMode ?? "unset"} with no isolation never reaches tmux`, async () => {
			const base = await mkdtemp(join(tmpdir(), "mfw-g5-"));
			try {
				const runDir = join(base, "run");
				await mkdir(runDir);
				const calls: string[][] = [];
				const { runner } = runShTmux();
				const host = new AgentHost(undefined, {
					tmuxRunner: async (args) => {
						calls.push(args);
						return runner(args);
					},
				});
				const spec = {
					runId: "g5",
					runDir,
					cwd: base,
					projectRoot: base,
					driverScript: join(base, "d.ts"),
					agentArgv: ["true"],
					steer: false,
					approvalMode,
				} as unknown as LaunchSpec;
				await expect(host.launch(spec)).rejects.toBeInstanceOf(
					SandboxUnavailableError,
				);
				expect(calls).toEqual([]);
			} finally {
				await rm(base, { recursive: true, force: true });
			}
		});
	}
});
