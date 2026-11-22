import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost } from "../src/agent-host.ts";
import { loadConfig } from "../src/config.ts";
import { SandboxUnavailableError } from "../src/sandbox.ts";
import { runShTmux } from "./support/run-sh-tmux.ts";

/** Security review G5: autonomy without isolation is refused at the launch choke point and in config. */

async function configWith(project: Record<string, unknown>) {
	const home = await mkdtemp(join(tmpdir(), "mfw-iso-config-"));
	await writeFile(
		join(home, "config.json"),
		JSON.stringify({ projects: [{ name: "p", root: "/x/p", ...project }] }),
	);
	return home;
}

describe("config: agentIsolation none needs interactive approvals", () => {
	test.each([
		[{ agentIsolation: "none" }, false],
		[{ agentIsolation: "none", approvalMode: "autonomous" }, false],
		[{ agentIsolation: "none", approvalMode: "interactive" }, true],
		[{ agentIsolation: "bwrap" }, true],
		[{}, true],
	] as const)("%j loads: %p", async (project, ok) => {
		const home = await configWith(project);
		try {
			const load = loadConfig(home);
			if (ok) await expect(load).resolves.toBeTruthy();
			else await expect(load).rejects.toThrow(/interactive/);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("AgentHost.launch refuses autonomous runs without isolation", () => {
	for (const approvalMode of ["autonomous", undefined] as const) {
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
				await expect(
					host.launch({
						runId: "g5",
						runDir,
						cwd: base,
						projectRoot: base,
						driverScript: join(base, "d.ts"),
						agentArgv: ["true"],
						steer: false,
						approvalMode,
					}),
				).rejects.toBeInstanceOf(SandboxUnavailableError);
				expect(calls).toEqual([]);
			} finally {
				await rm(base, { recursive: true, force: true });
			}
		});
	}
});
