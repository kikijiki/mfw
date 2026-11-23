import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost, type AgentTmuxRunner } from "../src/agent-host.ts";
import { ensureRunDirLayout } from "../src/containment/run-dir.ts";
import { git } from "../src/git.ts";
import {
	clearRunWorkspace,
	configureRunWorkspace,
} from "../src/run-workspace/factory.ts";
import { removeTree } from "../src/run-workspace/remove-tree.ts";
import {
	createRoleClone,
	sweepRoleClones,
} from "../src/run-workspace/role-clone.ts";

/**
 * Security review P7, m5: `ro-*` role clones were never swept after a crash, or
 * when a launch threw after creating one.
 */

let root: string;
let project: string;
let other: string;
let workspaces: string;

async function repo(path: string): Promise<void> {
	mkdirSync(path, { recursive: true });
	await git(["init", "-q", "-b", "main"], path);
	await git(["config", "user.email", "t@t"], path);
	await git(["config", "user.name", "t"], path);
	writeFileSync(join(path, "a.txt"), "a\n");
	await git(["add", "-A"], path);
	await git(["commit", "-q", "-m", "init"], path);
}

beforeEach(async () => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "mfw-m5-")));
	project = join(root, "project");
	other = join(root, "other");
	workspaces = join(root, "mfw/workspaces");
	await repo(project);
	await repo(other);
	for (const p of [project, other]) {
		configureRunWorkspace(p, {
			kind: "worktree",
			clone: { workspaceRoot: workspaces },
		});
	}
});

afterEach(async () => {
	clearRunWorkspace(project);
	clearRunWorkspace(other);
	await removeTree(root);
});

describe("sweeping role clones after a crash", () => {
	test("a dead run's clone goes, even one it poisoned", async () => {
		const c = await createRoleClone(project, "dead");
		mkdirSync(join(c.root, "fleet-state/locked"), { recursive: true });
		chmodSync(join(c.root, "fleet-state/locked"), 0o000);
		expect(await sweepRoleClones(project, async () => false)).toBe(1);
		expect(existsSync(c.root)).toBe(false);
	});

	test("a live run's clone stays", async () => {
		const c = await createRoleClone(project, "live");
		expect(await sweepRoleClones(project, async () => true)).toBe(0);
		expect(existsSync(c.tree)).toBe(true);
	});

	test("an unknown liveness keeps it", async () => {
		const c = await createRoleClone(project, "unknown");
		expect(await sweepRoleClones(project, async () => null)).toBe(0);
		expect(existsSync(c.tree)).toBe(true);
	});

	test("another project's clone in the shared root is left alone", async () => {
		const mine = await createRoleClone(project, "mine");
		const theirs = await createRoleClone(other, "theirs");
		expect(await sweepRoleClones(project, async () => false)).toBe(1);
		expect(existsSync(mine.root)).toBe(false);
		expect(existsSync(theirs.tree)).toBe(true);
	});

	test("a directory with no readable marker is not ours to remove", async () => {
		const stray = join(workspaces, "ro-stray");
		mkdirSync(stray, { recursive: true });
		expect(await sweepRoleClones(project, async () => false)).toBe(0);
		expect(existsSync(stray)).toBe(true);
	});
});

describe("a launch that throws after creating its clone", () => {
	test("leaves no clone behind", async () => {
		const mfwHome = join(root, "mfw");
		mkdirSync(join(mfwHome, "agents/claude"), { recursive: true });
		const stateDir = join(project, ".mfw");
		const runDir = join(stateDir, "runs/m5-throw");
		ensureRunDirLayout(runDir);
		writeFileSync(join(stateDir, "mfw.db"), "");
		const failing: AgentTmuxRunner = async () =>
			({
				exitCode: 1,
				stdout: "",
				stderr: "tmux refused",
				timedOut: false,
				truncated: false,
				signalCode: null,
			}) as never;
		const control = join(root, "control");
		mkdirSync(control, { mode: 0o700 });
		const host = new AgentHost(undefined, {
			tmuxRunner: failing,
			controlRoot: control,
			sandbox: { bwrapAvailable: async () => true },
		});
		await expect(
			host.launch({
				runId: "m5-throw",
				runDir,
				cwd: project,
				projectRoot: project,
				driverScript: "/opt/mfw/driver.ts",
				agentArgv: ["claude"],
				steer: false,
				approvalMode: "autonomous",
				isolation: { mode: "bwrap", hidePaths: [], mfwHome },
				runKind: "plan",
				providerId: "claude-cli",
			}),
		).rejects.toThrow("tmux new-session failed");
		expect(readdirSync(workspaces).filter((d) => d.startsWith("ro-"))).toEqual(
			[],
		);
	});
});
