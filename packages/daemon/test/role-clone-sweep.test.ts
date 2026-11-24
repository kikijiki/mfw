import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
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
		configureRunWorkspace(p, { workspaceRoot: workspaces });
	}
});

afterEach(async () => {
	clearRunWorkspace(project);
	clearRunWorkspace(other);
	await removeTree(root);
});

/** Rewrite who a clone says owns it, and how old it is. */
function rewriteMarker(
	clone: { root: string },
	change: {
		owner?: unknown;
		dropOwner?: boolean;
		ageMs?: number;
	},
): void {
	const file = join(clone.root, "mfw-workspace.json");
	const meta = JSON.parse(readFileSync(file, "utf8"));
	if (change.owner !== undefined) meta.owner = change.owner;
	if (change.dropOwner) {
		meta.owner = undefined;
		meta.createdAt = undefined;
	}
	if (change.ageMs !== undefined) {
		meta.createdAt = new Date(Date.now() - change.ageMs).toISOString();
	}
	writeFileSync(file, `${JSON.stringify(meta)}\n`);
}

/** What a daemon that died mid-run leaves: an owner that is gone. */
async function abandonAsCrashed(clone: { root: string }): Promise<void> {
	const dead = Bun.spawn(["true"]);
	await dead.exited;
	rewriteMarker(clone, { owner: { instance: "gone", pid: dead.pid } });
}

describe("the owner record of a role clone", () => {
	test("names this instance and process, and when it was made", async () => {
		const c = await createRoleClone(project, "owned");
		const meta = JSON.parse(
			readFileSync(join(c.root, "mfw-workspace.json"), "utf8"),
		);
		expect(meta.owner.pid).toBe(process.pid);
		expect(typeof meta.owner.instance).toBe("string");
		expect(meta.owner.instance.length).toBeGreaterThan(8);
		expect(typeof meta.owner.startTicks).toBe("string");
		expect(Number.isFinite(Date.parse(meta.createdAt))).toBe(true);
		expect(meta.primaryRoot).toBe(project);
	});
});

describe("sweeping role clones is owner-aware", () => {
	test("a clone this process just made is spared even if its session is not up yet", async () => {
		const c = await createRoleClone(project, "launching");
		expect(await sweepRoleClones(project, async () => false)).toBe(0);
		expect(existsSync(c.tree)).toBe(true);
	});

	test("this process's clone goes once it is past the launch grace and its session is dead", async () => {
		const c = await createRoleClone(project, "old-own");
		rewriteMarker(c, { ageMs: 60 * 60_000 });
		expect(await sweepRoleClones(project, async () => true)).toBe(0);
		expect(await sweepRoleClones(project, async () => false)).toBe(1);
		expect(existsSync(c.root)).toBe(false);
	});

	test("a clone another live daemon owns is spared until the age bound", async () => {
		const c = await createRoleClone(project, "theirs");
		// Another process that is alive: this test's parent.
		rewriteMarker(c, {
			owner: { instance: "other", pid: process.ppid },
			ageMs: 60 * 60_000,
		});
		expect(await sweepRoleClones(project, async () => false)).toBe(0);
		expect(existsSync(c.tree)).toBe(true);
		expect(
			await sweepRoleClones(project, async () => false, { orphanAgeMs: 0 }),
		).toBe(1);
	});

	test("a pid that was reused by another process does not keep a clone", async () => {
		const c = await createRoleClone(project, "reused");
		rewriteMarker(c, {
			owner: { instance: "gone", pid: process.ppid, startTicks: "1" },
		});
		expect(await sweepRoleClones(project, async () => false)).toBe(1);
	});

	test("an owner record with no creation time and a clone from before records are swept after the grace", async () => {
		const c = await createRoleClone(project, "legacy");
		rewriteMarker(c, { dropOwner: true });
		expect(await sweepRoleClones(project, async () => false)).toBe(0);
		expect(
			await sweepRoleClones(project, async () => false, { launchGraceMs: 0 }),
		).toBe(1);
	});

	test("liveness still has the last word: a live session keeps a crashed owner's clone", async () => {
		const c = await createRoleClone(project, "survivor");
		await abandonAsCrashed(c);
		expect(await sweepRoleClones(project, async () => true)).toBe(0);
		expect(await sweepRoleClones(project, async () => null)).toBe(0);
		expect(existsSync(c.tree)).toBe(true);
	});
});

describe("sweeping role clones after a crash", () => {
	test("a dead run's clone goes, even one it poisoned", async () => {
		const c = await createRoleClone(project, "dead");
		await abandonAsCrashed(c);
		mkdirSync(join(c.root, "fleet-state/locked"), { recursive: true });
		chmodSync(join(c.root, "fleet-state/locked"), 0o000);
		expect(await sweepRoleClones(project, async () => false)).toBe(1);
		expect(existsSync(c.root)).toBe(false);
	});

	test("a live run's clone stays", async () => {
		const c = await createRoleClone(project, "live");
		await abandonAsCrashed(c);
		expect(await sweepRoleClones(project, async () => true)).toBe(0);
		expect(existsSync(c.tree)).toBe(true);
	});

	test("an unknown liveness keeps it", async () => {
		const c = await createRoleClone(project, "unknown");
		await abandonAsCrashed(c);
		expect(await sweepRoleClones(project, async () => null)).toBe(0);
		expect(existsSync(c.tree)).toBe(true);
	});

	test("another project's clone in the shared root is left alone", async () => {
		const mine = await createRoleClone(project, "mine");
		const theirs = await createRoleClone(other, "theirs");
		await abandonAsCrashed(mine);
		await abandonAsCrashed(theirs);
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
