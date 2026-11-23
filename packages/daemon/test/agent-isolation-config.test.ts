import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost } from "../src/agent-host.ts";
import { boot } from "../src/boot.ts";
import {
	isolationConfigProblem,
	loadConfig,
	toBootProjects,
} from "../src/config.ts";
import { agentSandboxRefusal } from "../src/containment/agent-preflight.ts";
import { git } from "../src/git.ts";
import { silentLogger } from "../src/log.ts";
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

describe("config: agentIsolation none needs interactive approvals (X5)", () => {
	test.each([
		[{ agentIsolation: "none" }, "refused"],
		[{ agentIsolation: "none", approvalMode: "autonomous" }, "refused"],
		[{ agentIsolation: "none", approvalMode: "interactive" }, null],
		[{ agentIsolation: "bwrap" }, null],
		[{}, null],
	] as const)("%j: %p", async (project, verdict) => {
		// An existing entry always loads; the rule is checked per project.
		const home = await configWith(project);
		try {
			const cfg = await loadConfig(home);
			expect(cfg.projects).toHaveLength(1);
			const problem = isolationConfigProblem(cfg.projects[0] ?? {});
			if (verdict) expect(problem).toMatch(/interactive/);
			else expect(problem).toBeNull();
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("a mixed config boots: the bad project is attached but fails closed, the others run", async () => {
		const home = await mkdtemp(join(tmpdir(), "mfw-iso-mixed-"));
		const roots: string[] = [];
		try {
			const mk = async (name: string) => {
				const root = await mkdtemp(join(tmpdir(), `mfw-iso-${name}-`));
				roots.push(root);
				await git(["init", "-q", "-b", "main", "."], root);
				await git(["config", "user.email", "t@test"], root);
				await git(["config", "user.name", "t"], root);
				await writeFile(join(root, "a.txt"), "x\n");
				await git(["add", "-A"], root);
				await git(["commit", "-qm", "init"], root);
				return root;
			};
			await writeFile(
				join(home, "config.json"),
				JSON.stringify({
					projects: [
						{ name: "good", root: await mk("good") },
						{
							name: "unsafe",
							root: await mk("unsafe"),
							agentIsolation: "none",
							approvalMode: "autonomous",
						},
					],
				}),
			);
			const cfg = await loadConfig(home);
			const orch = await boot({
				projects: toBootProjects(cfg),
				mfwHome: home,
				autostart: false,
				log: silentLogger(),
			});
			try {
				expect(orch.list().map((p) => p.name)).toEqual(["good", "unsafe"]);
				const byName = new Map(orch.list().map((p) => [p.name, p]));
				const unsafe = await byName.get("unsafe")?.inbox.list();
				const item = unsafe?.find((i) => i.id === "admission:isolation");
				expect(item?.fix).toMatch(/bwrap|interactive/);
				const good = await byName.get("good")?.inbox.list();
				expect(good?.some((i) => i.id === "admission:isolation")).toBe(false);
			} finally {
				await orch.shutdown();
			}
		} finally {
			await rm(home, { recursive: true, force: true });
			for (const r of roots) await rm(r, { recursive: true, force: true });
		}
	}, 30_000);

	test("autonomous dispatch of such a project is refused with sandbox_unavailable", async () => {
		const refusal = await agentSandboxRefusal({
			approvalMode: "autonomous",
			isolation: undefined,
			runWorkspace: "worktree",
			projectRoot: "/nonexistent",
			mfwHome: "/nonexistent",
		});
		expect(refusal?.code).toBe("sandbox_unavailable");
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
